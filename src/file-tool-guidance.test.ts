import { describe, expect, test } from "vitest"
import {
  FILE_TOOL_REMINDER,
  FILE_TOOL_REMINDER_INTERVAL,
  registerFileToolReminders,
} from "./file-tool-guidance.ts"

async function harness() {
  type Delivery = { event: any; done: () => void }
  let pending = Promise.withResolvers<Delivery | undefined>()
  let hook: (event: any) => void
  let subscription: any
  const cleanup = await registerFileToolReminders(
    {
      event: {
        subscribe(options: any) {
          subscription = options
          return (async function* () {
            const abort = () => pending.resolve(undefined)
            options.signal.addEventListener("abort", abort, { once: true })
            try {
              while (true) {
                const delivery = await pending.promise
                pending = Promise.withResolvers<Delivery | undefined>()
                if (!delivery) return
                yield delivery.event
                delivery.done()
              }
            } finally {
              options.signal.removeEventListener("abort", abort)
            }
          })()
        },
      },
      tool: {
        hook: async (name: string, callback: typeof hook) => {
          expect(name).toBe("execute.after")
          hook = callback
        },
      },
    } as any,
    "anthropic-sdk",
  )
  const emit = (type: string, data: any) =>
    new Promise<void>((done) => pending.resolve({ event: { type, data }, done }))
  let step = 0
  const messages = new Map<string, string>()
  const usage = async (
    total: number,
    sessionID = "session-a",
    providerID = "anthropic-sdk",
    cache = { read: 0, write: 0 },
  ) => {
    const assistantMessageID = `step-${++step}`
    messages.set(sessionID, assistantMessageID)
    await emit("session.step.started", {
      sessionID,
      assistantMessageID,
      model: { providerID },
    })
    await emit("session.step.ended", {
      sessionID,
      assistantMessageID,
      tokens: { input: total - cache.read - cache.write, cache },
    })
    return assistantMessageID
  }
  const tool = (name = "shell", sessionID = "session-a", content: any = "command output") => {
    const result = { content, output: { exitCode: 0 }, metadata: { outputPath: "/log" } }
    const event = {
      tool: name,
      status: "completed",
      sessionID,
      messageID: messages.get(sessionID),
      result,
    }
    hook(event)
    return { event, result }
  }
  const reminded = (sessionID?: string) =>
    tool("shell", sessionID).event.result.content.includes(FILE_TOOL_REMINDER)
  return { cleanup, usage, emit, tool, reminded, hook: (event: any) => hook(event), subscription }
}

describe("Bash reminders based on context growth", () => {
  test("waits for 32K new context tokens, including cached input, then rebases", async () => {
    const h = await harness()
    try {
      expect(FILE_TOOL_REMINDER_INTERVAL).toBe(32_000)
      await h.usage(200_000, undefined, undefined, { read: 190_000, write: 5_000 })
      for (let i = 0; i < 20; i++) expect(h.reminded()).toBe(false)
      await h.usage(231_999, undefined, undefined, { read: 220_000, write: 5_000 })
      expect(h.reminded()).toBe(false)
      await h.usage(232_000, undefined, undefined, { read: 225_000, write: 5_000 })
      expect(h.reminded()).toBe(true)
      expect(h.reminded()).toBe(false)
      await h.usage(263_999)
      expect(h.reminded()).toBe(false)
      await h.usage(264_000)
      expect(h.reminded()).toBe(true)
    } finally {
      h.cleanup()
    }
  })

  test("keeps sessions independent, ignores other tools, and isolates providers", async () => {
    const h = await harness()
    try {
      await h.usage(10_000)
      await h.usage(100_000, "session-b")
      await h.usage(42_000)
      expect(h.reminded("session-b")).toBe(false)
      for (const name of ["read", "edit", "write", "grep", "mcp_example_tool"]) {
        const { event, result } = h.tool(name)
        expect(event.result).toBe(result)
      }
      expect(h.reminded()).toBe(true)
      await h.usage(200_000, "session-b", "openai")
      expect(h.reminded("session-b")).toBe(false)
      await h.usage(250_000, "session-b")
      expect(h.reminded("session-b")).toBe(false)
    } finally {
      h.cleanup()
    }
  })

  test("does not mistake repeated context usage for cumulative growth", async () => {
    const h = await harness()
    try {
      await h.usage(100_000)
      for (let i = 0; i < 10; i++) {
        await h.usage(100_000, undefined, undefined, { read: 99_000, write: 0 })
        expect(h.reminded()).toBe(false)
      }
      await h.usage(200_000)
      expect(h.reminded()).toBe(true)
      expect(h.reminded()).toBe(false)
    } finally {
      h.cleanup()
    }
  })

  test("keeps accumulated growth through small context-size fluctuations", async () => {
    const h = await harness()
    try {
      await h.usage(90_000)
      await h.usage(121_999)
      await h.usage(121_998)
      expect(h.reminded()).toBe(false)
      await h.usage(122_000)
      expect(h.reminded()).toBe(true)
    } finally {
      h.cleanup()
    }
  })

  test("ignores stale usage, unrelated tool calls, and failed calls", async () => {
    const h = await harness()
    try {
      await h.usage(10_000)
      const messageID = await h.usage(42_000)
      await h.emit("session.step.ended", {
        sessionID: "session-a",
        assistantMessageID: "stale",
        tokens: { input: 1, cache: { read: 0, write: 0 } },
      })
      const unrelated = {
        tool: "shell",
        status: "completed",
        sessionID: "session-a",
        messageID: "unrelated",
        result: { content: "output" },
      }
      h.hook(unrelated)
      expect(unrelated.result.content).toBe("output")
      const failed = { ...unrelated, messageID, status: "error", error: { message: "failed" } }
      h.hook(failed)
      expect(failed.error.message).toBe("failed")
      expect(h.reminded()).toBe(true)
    } finally {
      h.cleanup()
    }
  })

  test("resets after compaction or a shrinking context", async () => {
    const h = await harness()
    try {
      await h.usage(10_000)
      await h.usage(50_000)
      await h.emit("session.compaction.ended", { sessionID: "session-a" })
      expect(h.reminded()).toBe(false)
      await h.usage(100_000)
      expect(h.reminded()).toBe(false)
      await h.usage(132_000)
      expect(h.reminded()).toBe(true)
      await h.usage(20_000)
      await h.usage(51_999)
      expect(h.reminded()).toBe(false)
      await h.usage(52_000)
      expect(h.reminded()).toBe(true)
    } finally {
      h.cleanup()
    }
  })

  test("preserves original content, structured output, and metadata", async () => {
    const h = await harness()
    try {
      expect(h.reminded()).toBe(false)
      await h.usage(10_000)
      await h.usage(42_000)
      const plain = h.tool()
      expect(plain.event.result.content).toBe(`command output\n\n${FILE_TOOL_REMINDER}`)
      expect(plain.result.content).toBe("command output")
      await h.usage(74_000)
      const content = [
        { type: "text", text: "output" },
        { type: "file", uri: "file:///image", mime: "image/png" },
      ]
      const { event, result } = h.tool("shell", "session-a", content)
      expect(event.result.output).toBe(result.output)
      expect(event.result.metadata).toBe(result.metadata)
      expect(event.result.content).toEqual([...content, { type: "text", text: FILE_TOOL_REMINDER }])
      expect(result.content).toBe(content)
      expect(content).toHaveLength(2)
      expect(h.reminded()).toBe(false)
    } finally {
      h.cleanup()
    }
  })

  test("ignores invalid usage and forgets deleted sessions on cleanup", async () => {
    const h = await harness()
    try {
      await h.usage(10_000)
      for (const size of [0, -1, NaN, Infinity]) {
        await h.usage(size)
        expect(h.reminded()).toBe(false)
      }
      await h.usage(42_000)
      expect(h.reminded()).toBe(true)
      await h.usage(74_000)
      await h.emit("session.deleted", { sessionID: "session-a" })
      expect(h.reminded()).toBe(false)
    } finally {
      h.cleanup()
    }
    expect(h.subscription.signal.aborted).toBe(true)
  })
})
