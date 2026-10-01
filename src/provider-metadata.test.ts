import { describe, expect, test } from "vitest"
import { convertPrompt } from "./prompt.ts"
import { convertStream } from "./stream.ts"

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

async function* events(...list: any[]) {
  for (const event of list) yield event
}

describe("thinking signature round trip through OpenCode v2", () => {
  test("reasoning-end carries the signature under the providerID key OpenCode persists", async () => {
    const stream = convertStream(
      events(
        { type: "message_start", message: { id: "msg_1", model: "claude-sonnet-5-5" } },
        { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "hm" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: "sig" },
        },
        { type: "content_block_stop", index: 0 },
        { type: "message_stop" },
      ) as any,
      "claude-sonnet-5-5",
      { apiModelId: "claude-sonnet-5-5", fallbacksEnabled: false },
    )

    const reasoningEnd = (await collect(stream)).find((p) => p.type === "reasoning-end")
    expect(reasoningEnd.providerMetadata["anthropic-sdk"].signature).toBe("sig")
    expect(reasoningEnd.providerMetadata.anthropic.signature).toBe("sig")
  })

  test("replays a thinking block from OpenCode's providerID-keyed providerOptions", () => {
    const { messages } = convertPrompt([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "hm",
            providerOptions: { "anthropic-sdk": { signature: "sig" } },
          },
          { type: "text", text: "hello" },
        ],
      },
    ] as any)

    expect(messages[1].content).toEqual([
      { type: "thinking", thinking: "hm", signature: "sig" },
      { type: "text", text: "hello" },
    ])
  })
})
