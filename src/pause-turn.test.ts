/**
 * Tests for pause_turn auto-continuation — event-level continuation
 * (pause-turn.ts) and the exhausted-pause error surfaced by stream.ts.
 *
 * Run with: bun test src/pause-turn.test.ts
 */
import { describe, expect, test } from "bun:test"
import { continuationParams, withPauseTurnContinuation } from "./pause-turn.ts"
import { convertStream } from "./stream.ts"

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function* events(...list: any[]) {
  for (const event of list) yield event
}

async function drain(iterable: AsyncIterable<any>): Promise<any[]> {
  const out: any[] = []
  for await (const event of iterable) out.push(event)
  return out
}

async function collect(stream: ReadableStream<any>): Promise<any[]> {
  const parts: any[] = []
  const reader = stream.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
  }
  return parts
}

const MESSAGE_START = {
  type: "message_start",
  message: { id: "msg_1", model: "claude-fable-5", usage: { input_tokens: 10 } },
}

const PAUSE_DELTA = {
  type: "message_delta",
  delta: { stop_reason: "pause_turn" },
  usage: { output_tokens: 1 },
}

const PARAMS = {
  model: "claude-fable-5",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
}

// ─── pause-turn.ts ───────────────────────────────────────────────────────────

describe("withPauseTurnContinuation", () => {
  test("retries an empty paused turn with the identical request", async () => {
    const requests: any[] = []
    const result = await drain(
      withPauseTurnContinuation(
        events(MESSAGE_START, PAUSE_DELTA, { type: "message_stop" }),
        PARAMS,
        async (p) => {
          requests.push(p)
          return events(
            { type: "message_start", message: { id: "msg_2", model: "claude-fable-5" } },
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
            { type: "content_block_stop", index: 0 },
            {
              type: "message_delta",
              delta: { stop_reason: "end_turn" },
              usage: { output_tokens: 5 },
            },
            { type: "message_stop" },
          )
        },
      ),
    )

    // Continuation issued once, with the unmodified params (no empty
    // assistant message appended).
    expect(requests.length).toBe(1)
    expect(requests[0]).toBe(PARAMS)

    // The paused segment's message_delta and message_stop are suppressed —
    // exactly one finish delta flows downstream.
    const stops = result.filter((e) => e.type === "message_delta")
    expect(stops.length).toBe(1)
    expect(stops[0].delta.stop_reason).toBe("end_turn")
    expect(result.some((e) => e.delta?.stop_reason === "pause_turn")).toBe(false)
  })

  test("appends reconstructed partial content as an assistant message", async () => {
    const requests: any[] = []
    const result = await drain(
      withPauseTurnContinuation(
        events(
          MESSAGE_START,
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "thinking", thinking: "", signature: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: "let me " },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: "think" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "signature_delta", signature: "sig123" },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "content_block_start",
            index: 1,
            content_block: { type: "tool_use", id: "tu_1", name: "Bash", input: {} },
          },
          {
            type: "content_block_delta",
            index: 1,
            delta: { type: "input_json_delta", partial_json: '{"command":' },
          },
          {
            type: "content_block_delta",
            index: 1,
            delta: { type: "input_json_delta", partial_json: '"ls"}' },
          },
          { type: "content_block_stop", index: 1 },
          PAUSE_DELTA,
          { type: "message_stop" },
        ),
        PARAMS,
        async (p) => {
          requests.push(p)
          return events(
            {
              type: "message_delta",
              delta: { stop_reason: "tool_use" },
              usage: { output_tokens: 20 },
            },
            { type: "message_stop" },
          )
        },
      ),
    )

    expect(requests.length).toBe(1)
    const messages = requests[0].messages
    expect(messages.length).toBe(2)
    const appended = messages[1]
    expect(appended.role).toBe("assistant")
    expect(appended.content).toEqual([
      { type: "thinking", thinking: "let me think", signature: "sig123" },
      { type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls" } },
    ])

    // Original block events still flowed downstream before the continuation.
    expect(result.filter((e) => e.type === "content_block_start").length).toBe(2)
  })

  test("passes pause_turn through once continuations are exhausted", async () => {
    let calls = 0
    const result = await drain(
      withPauseTurnContinuation(
        events(MESSAGE_START, PAUSE_DELTA, { type: "message_stop" }),
        PARAMS,
        async () => {
          calls++
          return events(PAUSE_DELTA, { type: "message_stop" })
        },
        2,
      ),
    )

    expect(calls).toBe(2)
    const deltas = result.filter((e) => e.type === "message_delta")
    expect(deltas[deltas.length - 1].delta.stop_reason).toBe("pause_turn")
  })
})

describe("continuationParams", () => {
  test("returns params unchanged for empty content", () => {
    expect(continuationParams(PARAMS, [])).toBe(PARAMS)
  })
})

// ─── stream.ts: exhausted pause surfaces an error ────────────────────────────

describe("convertStream pause_turn error", () => {
  test("emits an error part when a pause_turn delta reaches conversion", async () => {
    const parts = await collect(
      convertStream(
        events(MESSAGE_START, PAUSE_DELTA, { type: "message_stop" }) as any,
        "claude-fable-5",
      ),
    )
    const error = parts.find((p) => p.type === "error")
    expect(error).toBeDefined()
    expect(String(error.error)).toContain("pause_turn")
    const finish = parts.find((p) => p.type === "finish")
    expect(finish.finishReason.raw).toBe("pause_turn")
  })
})
