/**
 * Integration tests for AnthropicSDKModel — generation, streaming, tools,
 * thinking, and prompt caching.
 *
 * Run with: bun test src/model.test.ts
 *
 * Requires either ANTHROPIC_API_KEY env var or ~/.claude/.credentials.json.
 * Tests that need OAuth credentials (thinking, caching) are skipped when
 * using an API key.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { readClaudeCredentials } from "./credentials.ts"
// import { streamText, generateText, tool } from "ai"  // Requires ai@6 for V3 models
// import { z } from "zod"
import { createAnthropicSDK } from "./index.ts"

// ─── Setup ───────────────────────────────────────────────────────────────────

const apiKey = process.env.ANTHROPIC_API_KEY
const claudeCreds = readClaudeCredentials()
const hasAuth = !!(apiKey || claudeCreds)
const isOAuth = !apiKey && !!claudeCreds

let provider: ReturnType<typeof createAnthropicSDK>
let model: ReturnType<typeof createAnthropicSDK>["languageModel"] extends (id: string) => infer R
  ? R
  : never

if (hasAuth) {
  provider = createAnthropicSDK(apiKey ? { apiKey } : {})
  model = provider.languageModel("claude-haiku-4-5-20251001")
}

function skipUnless(condition: boolean, reason: string) {
  if (!condition) {
    test.skip(`SKIPPED: ${reason}`, () => {})
    return true
  }
  return false
}

// ─── doGenerate ──────────────────────────────────────────────────────────────

describe("doGenerate", () => {
  if (skipUnless(hasAuth, "no API key or credentials")) return

  test("returns text", async () => {
    const result = await model.doGenerate({
      prompt: [
        { role: "user", content: [{ type: "text", text: "Say hello in exactly 3 words." }] },
      ],
      maxOutputTokens: 100,
    } as any)

    expect(result.content.length).toBeGreaterThan(0)
    const textContent = result.content.find((c) => c.type === "text")
    expect(textContent).not.toBeUndefined()
    expect((textContent as any).text.length).toBeGreaterThan(0)
    expect(result.finishReason.unified).toBe("stop")
    expect(result.usage.inputTokens.total).toBeGreaterThan(0)
    expect(result.usage.outputTokens.total).toBeGreaterThan(0)
  })

  test("multi-turn conversation", async () => {
    const result = await model.doGenerate({
      prompt: [
        { role: "user", content: [{ type: "text", text: "My name is Alice." }] },
        { role: "assistant", content: [{ type: "text", text: "Hello Alice! Nice to meet you." }] },
        { role: "user", content: [{ type: "text", text: "What is my name?" }] },
      ],
      maxOutputTokens: 100,
    } as any)

    const textContent = result.content.find((c) => c.type === "text")
    expect(textContent).not.toBeUndefined()
    expect((textContent as any).text).toContain("Alice")
  })

  test("with tool call", async () => {
    const result = await model.doGenerate({
      prompt: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "What's the weather in San Francisco? Use the get_weather tool.",
            },
          ],
        },
      ],
      maxOutputTokens: 500,
      tools: [
        {
          type: "function" as const,
          name: "get_weather",
          description: "Get the current weather in a given location",
          inputSchema: {
            type: "object" as const,
            properties: {
              location: { type: "string", description: "City name" },
            },
            required: ["location"],
          },
        },
      ],
      toolChoice: { type: "auto" as const },
    } as any)

    const toolCall = result.content.find((c) => c.type === "tool-call")
    expect(toolCall).not.toBeUndefined()
    expect((toolCall as any).toolName).toBe("get_weather")
    expect(result.finishReason.unified).toBe("tool-calls")
  })
})

// ─── doStream ────────────────────────────────────────────────────────────────

describe("doStream", () => {
  if (skipUnless(hasAuth, "no API key or credentials")) return

  test("produces text-delta events", async () => {
    const result = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "Count from 1 to 5." }] }],
      maxOutputTokens: 200,
    } as any)

    const reader = result.stream.getReader()
    const eventTypes = new Set<string>()
    let fullText = ""

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      eventTypes.add(value.type)
      if (value.type === "text-delta") {
        fullText += (value as any).delta
      }
    }

    expect(eventTypes.has("stream-start")).toBe(true)
    expect(eventTypes.has("response-metadata")).toBe(true)
    expect(eventTypes.has("text-start")).toBe(true)
    expect(eventTypes.has("text-delta")).toBe(true)
    expect(eventTypes.has("text-end")).toBe(true)
    expect(eventTypes.has("finish")).toBe(true)
    expect(fullText.length).toBeGreaterThan(0)
  })

  test("with tool call", async () => {
    const result = await model.doStream({
      prompt: [
        {
          role: "user",
          content: [
            { type: "text", text: "What's the weather in Tokyo? Use the get_weather tool." },
          ],
        },
      ],
      maxOutputTokens: 500,
      tools: [
        {
          type: "function" as const,
          name: "get_weather",
          description: "Get the current weather in a given location",
          inputSchema: {
            type: "object" as const,
            properties: {
              location: { type: "string", description: "City name" },
            },
            required: ["location"],
          },
        },
      ],
      toolChoice: { type: "auto" as const },
    } as any)

    const reader = result.stream.getReader()
    const eventTypes = new Set<string>()
    let toolCallName = ""

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      eventTypes.add(value.type)
      if (value.type === "tool-call") {
        toolCallName = (value as any).toolName
      }
    }

    expect(eventTypes.has("tool-input-start")).toBe(true)
    expect(eventTypes.has("tool-call")).toBe(true)
    expect(toolCallName).toBe("get_weather")
  })

  test("tool-input-start id matches tool-call toolCallId", async () => {
    const result = await model.doStream({
      prompt: [
        {
          role: "user",
          content: [
            { type: "text", text: "What's the weather in Berlin? Use the get_weather tool." },
          ],
        },
      ],
      maxOutputTokens: 500,
      tools: [
        {
          type: "function" as const,
          name: "get_weather",
          description: "Get the current weather in a given location",
          inputSchema: {
            type: "object" as const,
            properties: {
              location: { type: "string", description: "City name" },
            },
            required: ["location"],
          },
        },
      ],
      toolChoice: { type: "tool" as const, toolName: "get_weather" },
    } as any)

    const reader = result.stream.getReader()
    let toolInputStartId: string | null = null
    let toolCallId: string | null = null

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value.type === "tool-input-start") {
        toolInputStartId = (value as any).id
      }
      if (value.type === "tool-call") {
        toolCallId = (value as any).toolCallId
      }
    }

    expect(toolInputStartId).not.toBeNull()
    expect(toolCallId).not.toBeNull()
    expect(toolInputStartId).toBe(toolCallId)
    expect(toolCallId!).toMatch(/^toolu_/)
  })
})

// ─── AI SDK integration ─────────────────────────────────────────────────────
// NOTE: These tests are skipped because the local `ai` package is v5 which
// only supports V2 models. The plugin now implements V3. These tests would
// work with ai@6+ which has V3 support (and that's what OpenCode uses).

describe("AI SDK integration", () => {
  test.skip("streamText (requires ai@6 for V3 model support)", () => {})
  test.skip("generateText (requires ai@6 for V3 model support)", () => {})
  test.skip("streamText executes tools end-to-end (requires ai@6 for V3 model support)", () => {})
})

// ─── Thinking (extended thinking + signature) ────────────────────────────────

describe("thinking", () => {
  if (skipUnless(isOAuth, "thinking tests require OAuth credentials")) return

  const getThinkingModel = () => provider.languageModel("claude-sonnet-4-6")

  test("doStream produces reasoning events with signature", async () => {
    const thinkingModel = getThinkingModel()
    const result = await thinkingModel.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "What is 7 * 8?" }] }],
      maxOutputTokens: 4096,
      providerOptions: {
        anthropic: {
          thinking: { type: "enabled", budgetTokens: 5000 },
        },
      },
    } as any)

    const reader = result.stream.getReader()
    const eventTypes = new Set<string>()
    let hasSignature = false
    let reasoningText = ""

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      eventTypes.add(value.type)
      if (value.type === "reasoning-delta") {
        reasoningText += (value as any).delta
      }
      if (value.type === "reasoning-end") {
        const sig = (value as any).providerMetadata?.anthropic?.signature
        if (sig && sig.length > 0) hasSignature = true
      }
    }

    expect(eventTypes.has("reasoning-start")).toBe(true)
    expect(eventTypes.has("reasoning-delta")).toBe(true)
    expect(eventTypes.has("reasoning-end")).toBe(true)
    expect(eventTypes.has("text-delta")).toBe(true)
    expect(reasoningText.length).toBeGreaterThan(0)
    expect(hasSignature).toBe(true)
  })

  test("doGenerate returns reasoning content with signature", async () => {
    const thinkingModel = getThinkingModel()
    const result = await thinkingModel.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "What is 12 * 12?" }] }],
      maxOutputTokens: 4096,
      providerOptions: {
        anthropic: {
          thinking: { type: "enabled", budgetTokens: 5000 },
        },
      },
    } as any)

    const reasoning = result.content.filter((c) => c.type === "reasoning")
    const text = result.content.find((c) => c.type === "text")

    expect(reasoning.length).toBeGreaterThan(0)
    expect((reasoning[0] as any).text.length).toBeGreaterThan(0)
    expect(text).not.toBeUndefined()

    const sig = (reasoning[0] as any).providerMetadata?.anthropic?.signature
    expect(sig?.length).toBeGreaterThan(0)
  })

  test("thinking signature survives conversation roundtrip", async () => {
    const thinkingModel = getThinkingModel()

    // First turn: get a response with thinking
    const first = await thinkingModel.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "What is 3 + 4?" }] }],
      maxOutputTokens: 4096,
      providerOptions: {
        anthropic: {
          thinking: { type: "enabled", budgetTokens: 5000 },
        },
      },
    } as any)

    // Second turn: send the thinking back in history — should NOT error
    const result = await thinkingModel.doGenerate({
      prompt: [
        { role: "user", content: [{ type: "text", text: "What is 3 + 4?" }] },
        { role: "assistant", content: first.content },
        { role: "user", content: [{ type: "text", text: "And what is that times 2?" }] },
      ],
      maxOutputTokens: 4096,
      providerOptions: {
        anthropic: {
          thinking: { type: "enabled", budgetTokens: 5000 },
        },
      },
    } as any)

    const text = result.content.find((c) => c.type === "text")
    expect(text).not.toBeUndefined()
    expect((text as any).text).toContain("14")
  }, 30_000)
})

// ─── Adaptive thinking display (Opus 4.7/4.8, Fable 5) ───────────────────────
//
// These models default `thinking.display` to "omitted" on the wire, returning
// EMPTY thinking blocks (signature only) unless we explicitly request
// "summarized". Regression guard for the bug where Fable 5 showed no thinking.

describe("adaptive thinking display", () => {
  if (skipUnless(isOAuth, "adaptive thinking tests require OAuth credentials")) return

  test("fable-5 returns non-empty summarized reasoning text", async () => {
    const fableModel = provider.languageModel("claude-fable-5")
    const result = await fableModel.doStream({
      prompt: [
        {
          role: "user",
          content: [{ type: "text", text: "What is 17 * 23? Think step by step." }],
        },
      ],
      providerOptions: { "anthropic-sdk": { effort: "high" } },
    } as any)

    const reader = result.stream.getReader()
    const eventTypes = new Set<string>()
    let reasoningText = ""

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      eventTypes.add(value.type)
      if (value.type === "reasoning-delta") reasoningText += (value as any).delta
    }

    expect(eventTypes.has("reasoning-start")).toBe(true)
    expect(eventTypes.has("reasoning-delta")).toBe(true)
    // The core assertion: thinking text is actually present, not empty.
    expect(reasoningText.length).toBeGreaterThan(0)
  }, 30_000)
})

// ─── Reasoning effort ────────────────────────────────────────────────────────

describe("reasoning effort", () => {
  if (skipUnless(isOAuth, "effort tests require OAuth credentials")) return

  const getEffortModel = () => provider.languageModel("claude-sonnet-4-6")

  test("effort 'low' produces a response", async () => {
    const effortModel = getEffortModel()
    const result = await effortModel.doGenerate({
      prompt: [
        {
          role: "user",
          content: [{ type: "text", text: "What is 2 + 2? Reply with just the number." }],
        },
      ],
      maxOutputTokens: 100,
      providerOptions: {
        "anthropic-sdk": { effort: "low" },
      },
    } as any)

    const textContent = result.content.find((c) => c.type === "text")
    expect(textContent).not.toBeUndefined()
    expect((textContent as any).text).toContain("4")
    expect(result.finishReason.unified).toBe("stop")
  })

  test("effort 'high' produces a response", async () => {
    const effortModel = getEffortModel()
    const result = await effortModel.doGenerate({
      prompt: [
        {
          role: "user",
          content: [{ type: "text", text: "What is 17 * 23? Reply with just the number." }],
        },
      ],
      maxOutputTokens: 200,
      providerOptions: {
        "anthropic-sdk": { effort: "high" },
      },
    } as any)

    const textContent = result.content.find((c) => c.type === "text")
    expect(textContent).not.toBeUndefined()
    expect((textContent as any).text).toContain("391")
    expect(result.finishReason.unified).toBe("stop")
  }, 15000)

  test("effort passed via 'anthropic' key also works", async () => {
    const effortModel = getEffortModel()
    const result = await effortModel.doGenerate({
      prompt: [
        {
          role: "user",
          content: [{ type: "text", text: "What is 5 + 3? Reply with just the number." }],
        },
      ],
      maxOutputTokens: 100,
      providerOptions: {
        anthropic: { effort: "low" },
      },
    } as any)

    const textContent = result.content.find((c) => c.type === "text")
    expect(textContent).not.toBeUndefined()
    expect((textContent as any).text).toContain("8")
  })

  test("effort defaults to medium when not specified", async () => {
    const effortModel = getEffortModel()
    // No providerOptions — should default to medium and work fine
    const result = await effortModel.doGenerate({
      prompt: [
        {
          role: "user",
          content: [{ type: "text", text: "What is 1 + 1? Reply with just the number." }],
        },
      ],
      maxOutputTokens: 100,
    } as any)

    const textContent = result.content.find((c) => c.type === "text")
    expect(textContent).not.toBeUndefined()
    expect((textContent as any).text).toContain("2")
  })
})

// ─── Prompt caching ──────────────────────────────────────────────────────────

async function streamUsage(result: { stream: AsyncIterable<any> }) {
  let usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }
  for await (const chunk of result.stream) {
    if (chunk.type === "finish") {
      const u = chunk.usage as any
      usage = {
        inputTokens: u.inputTokens?.total ?? 0,
        cachedInputTokens: u.inputTokens?.cacheRead ?? 0,
        outputTokens: u.outputTokens?.total ?? 0,
      }
    }
  }
  return usage
}

describe("prompt caching", () => {
  if (skipUnless(isOAuth, "prompt caching requires OAuth credentials")) return

  test("cache hits with full-size OpenCode-like prompt", async () => {
    // Use the real captured OpenCode system prompt and tools from fixtures.
    const systemPrompt = readFileSync(new URL("./claudecode-system.txt", import.meta.url), "utf-8")
    const realTools = JSON.parse(
      readFileSync(new URL("./fixtures/opencode-tools.json", import.meta.url), "utf-8"),
    ) as Array<{ name: string; description: string; input_schema: any }>

    const tools = realTools.map((t) => ({
      type: "function" as const,
      name: t.name,
      description: t.description,
      inputSchema: t.input_schema,
    }))

    const cachingModel = provider.languageModel("claude-haiku-4-5-20251001")

    // Request 1: cold — writes cache
    const r1 = await streamUsage(
      await cachingModel.doStream({
        prompt: [
          { role: "system" as const, content: systemPrompt },
          { role: "user" as const, content: [{ type: "text" as const, text: "What is 2+2?" }] },
        ],
        tools,
        maxOutputTokens: 30,
      } as any),
    )

    // Request 2: same system+tools, different user message — should read cache
    const r2 = await streamUsage(
      await cachingModel.doStream({
        prompt: [
          { role: "system" as const, content: systemPrompt },
          { role: "user" as const, content: [{ type: "text" as const, text: "What is 3+3?" }] },
        ],
        tools,
        maxOutputTokens: 30,
      } as any),
    )

    // Either R1 or R2 must show cache activity
    const cacheActive = r1.cachedInputTokens > 0 || r2.cachedInputTokens > 0
    expect(cacheActive).toBe(true)
  })
})
