/**
 * Tests for the Fable 5 server-side fallback handling — fallback block
 * round-trip (prompt.ts), stream metadata attachment (stream.ts), and
 * refusal error wording.
 *
 * Run with: bun test src/fallback.test.ts
 */
import { describe, expect, test } from "bun:test"
import { convertPrompt } from "./prompt.ts"
import { convertStream } from "./stream.ts"

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

const FALLBACK_BLOCK = {
  type: "fallback",
  from: { model: "claude-fable-5" },
  to: { model: "claude-opus-4-8" },
}

// ─── prompt.ts: fallback block echo ──────────────────────────────────────────

describe("convertPrompt fallback block echo", () => {
  test("re-inserts a fallback block before the part carrying the metadata", () => {
    const { messages } = convertPrompt([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "partial output from fable" },
          {
            type: "text",
            text: "served by opus",
            providerOptions: {
              anthropic: {
                fallback: { from: { model: "claude-fable-5" }, to: { model: "claude-opus-4-8" } },
                servedBy: { from: "claude-fable-5", to: "claude-opus-4-8", kind: "fallback" },
              },
            },
          } as any,
        ],
      },
    ] as any)

    const assistant = messages[1]
    expect(assistant.role).toBe("assistant")
    const types = (assistant.content as any[]).map((b) => b.type)
    expect(types).toEqual(["text", "fallback", "text"])
    const block = (assistant.content as any[])[1]
    expect(block.from).toEqual({ model: "claude-fable-5" })
    expect(block.to).toEqual({ model: "claude-opus-4-8" })
  })

  test("does not emit a block for servedBy-only metadata (sticky turns)", () => {
    const { messages } = convertPrompt([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "sticky-served",
            providerOptions: {
              anthropic: {
                servedBy: { from: "claude-fable-5", to: "claude-opus-4-8", kind: "sticky" },
              },
            },
          } as any,
        ],
      },
    ] as any)

    const types = (messages[1].content as any[]).map((b) => b.type)
    expect(types).toEqual(["text"])
  })
})

// ─── stream.ts: fallback block + sticky detection ───────────────────────────

describe("convertStream fallback handling", () => {
  test("attaches fallback + servedBy metadata to the first block after the boundary", async () => {
    const stream = convertStream(
      events(
        {
          type: "message_start",
          message: { id: "msg_1", model: "claude-fable-5", usage: { input_tokens: 10 } },
        },
        { type: "content_block_start", index: 0, content_block: FALLBACK_BLOCK },
        { type: "content_block_stop", index: 0 },
        { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "hello" } },
        { type: "content_block_stop", index: 1 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 5 },
        },
        { type: "message_stop" },
      ) as any,
      "claude-fable-5",
      { apiModelId: "claude-fable-5", fallbacksEnabled: true, fallbackModel: "claude-opus-4-8" },
    )

    const parts = await collect(stream)
    const textStart = parts.find((p) => p.type === "text-start")
    expect(textStart.providerMetadata.anthropic.fallback).toEqual({
      from: { model: "claude-fable-5" },
      to: { model: "claude-opus-4-8" },
    })
    expect(textStart.providerMetadata.anthropic.servedBy).toEqual({
      from: "claude-fable-5",
      to: "claude-opus-4-8",
      kind: "fallback",
    })
    // No error part — fallback means the turn succeeded
    expect(parts.find((p) => p.type === "error")).toBeUndefined()
  })

  test("merges fallback metadata with the thinking signature on reasoning-end", async () => {
    const stream = convertStream(
      events(
        {
          type: "message_start",
          message: { id: "msg_1", model: "claude-fable-5", usage: { input_tokens: 10 } },
        },
        { type: "content_block_start", index: 0, content_block: FALLBACK_BLOCK },
        { type: "content_block_stop", index: 0 },
        { type: "content_block_start", index: 1, content_block: { type: "thinking" } },
        {
          type: "content_block_delta",
          index: 1,
          delta: { type: "signature_delta", signature: "sig123" },
        },
        { type: "content_block_stop", index: 1 },
        { type: "message_stop" },
      ) as any,
      "claude-fable-5",
      { apiModelId: "claude-fable-5", fallbacksEnabled: true, fallbackModel: "claude-opus-4-8" },
    )

    const parts = await collect(stream)
    const reasoningEnd = parts.find((p) => p.type === "reasoning-end")
    expect(reasoningEnd.providerMetadata.anthropic.signature).toBe("sig123")
    expect(reasoningEnd.providerMetadata.anthropic.fallback).toBeDefined()
    expect(reasoningEnd.providerMetadata.anthropic.servedBy.kind).toBe("fallback")
  })

  test("flags sticky-routed turns from the message_start model mismatch", async () => {
    const stream = convertStream(
      events(
        {
          type: "message_start",
          message: { id: "msg_1", model: "claude-opus-4-8", usage: { input_tokens: 10 } },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_stop" },
      ) as any,
      "claude-fable-5",
      { apiModelId: "claude-fable-5", fallbacksEnabled: true, fallbackModel: "claude-opus-4-8" },
    )

    const parts = await collect(stream)
    const textStart = parts.find((p) => p.type === "text-start")
    expect(textStart.providerMetadata.anthropic.servedBy).toEqual({
      from: "claude-fable-5",
      to: "claude-opus-4-8",
      kind: "sticky",
    })
    // Sticky turns carry no fallback block — nothing to echo
    expect(textStart.providerMetadata.anthropic.fallback).toBeUndefined()
  })

  test("does not flag model mismatch when fallbacks were not sent", async () => {
    const stream = convertStream(
      events(
        {
          type: "message_start",
          message: { id: "msg_1", model: "claude-opus-4-8", usage: { input_tokens: 10 } },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_stop" },
      ) as any,
      "claude-fable-5",
      { apiModelId: "claude-fable-5", fallbacksEnabled: false },
    )

    const parts = await collect(stream)
    const textStart = parts.find((p) => p.type === "text-start")
    expect(textStart.providerMetadata).toBeUndefined()
  })

  test("surfaces a chain-exhausted refusal with fallback model in the message", async () => {
    const stream = convertStream(
      events(
        {
          type: "message_start",
          message: { id: "msg_1", model: "claude-fable-5", usage: { input_tokens: 10 } },
        },
        {
          type: "message_delta",
          delta: {
            stop_reason: "refusal",
            stop_details: { type: "refusal", category: "cyber", explanation: "Declined." },
          },
          usage: { output_tokens: 0 },
        },
        { type: "message_stop" },
      ) as any,
      "claude-fable-5",
      { apiModelId: "claude-fable-5", fallbacksEnabled: true, fallbackModel: "claude-opus-4-8" },
    )

    const parts = await collect(stream)
    const error = parts.find((p) => p.type === "error")
    expect(error).toBeDefined()
    expect(String(error.error)).toContain("category: cyber")
    expect(String(error.error)).toContain("claude-opus-4-8")
    expect(String(error.error)).toContain("also refused")
  })
})
