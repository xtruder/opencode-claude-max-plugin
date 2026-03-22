/**
 * Integration tests for opencode-anthropic-sdk-provider
 *
 * Run with: ANTHROPIC_API_KEY=sk-... bun run src/test.ts
 */
import { createAnthropicSDK, readClaudeCredentials, isExpired } from "./index.js"
import { streamText, generateText, tool } from "ai"
import { z } from "zod"
import { writeFileSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const apiKey = process.env.ANTHROPIC_API_KEY
const claudeCreds = readClaudeCredentials()
if (!apiKey && !claudeCreds) {
  console.error("ERROR: ANTHROPIC_API_KEY env var or ~/.claude/.credentials.json required")
  process.exit(1)
}
const authSource = apiKey ? "ANTHROPIC_API_KEY" : "~/.claude/.credentials.json"
console.log(`  Auth: ${authSource}\n`)

const provider = createAnthropicSDK(apiKey ? { apiKey } : {})
// Use a small, cheap model for testing
const model = provider.languageModel("claude-haiku-4-5-20251001")

let passed = 0
let failed = 0

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    console.log(`  PASS: ${name}`)
    passed++
  } catch (error: any) {
    console.error(`  FAIL: ${name}`)
    console.error(`        ${error.message ?? error}`)
    if (error.stack) {
      const lines = error.stack.split("\n").slice(1, 3)
      for (const line of lines) console.error(`        ${line.trim()}`)
    }
    failed++
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

// ─── Test 1: doGenerate (non-streaming) ──────────────────────────────────────
await test("doGenerate returns text", async () => {
  const result = await model.doGenerate({
    prompt: [
      { role: "user", content: [{ type: "text", text: "Say hello in exactly 3 words." }] },
    ],
    maxOutputTokens: 100,
  } as any)

  assert(result.content.length > 0, "content should not be empty")
  const textContent = result.content.find((c) => c.type === "text")
  assert(textContent != null, "should contain text content")
  assert((textContent as any).text.length > 0, "text should not be empty")
  assert(result.finishReason === "stop", `finishReason should be stop, got ${result.finishReason}`)
  assert(result.usage.inputTokens! > 0, "inputTokens should be > 0")
  assert(result.usage.outputTokens! > 0, "outputTokens should be > 0")
  console.log(`        Response: "${(textContent as any).text.trim()}"`)
})

// ─── Test 2: doStream (streaming) ────────────────────────────────────────────
await test("doStream produces text-delta events", async () => {
  const result = await model.doStream({
    prompt: [
      { role: "user", content: [{ type: "text", text: "Count from 1 to 5." }] },
    ],
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

  assert(eventTypes.has("stream-start"), "should have stream-start event")
  assert(eventTypes.has("response-metadata"), "should have response-metadata event")
  assert(eventTypes.has("text-start"), "should have text-start event")
  assert(eventTypes.has("text-delta"), "should have text-delta events")
  assert(eventTypes.has("text-end"), "should have text-end event")
  assert(eventTypes.has("finish"), "should have finish event")
  assert(fullText.length > 0, "accumulated text should not be empty")
  console.log(`        Event types: ${[...eventTypes].join(", ")}`)
  console.log(`        Streamed text: "${fullText.trim().slice(0, 80)}..."`)
})

// ─── Test 3: Tool calls ─────────────────────────────────────────────────────
await test("doGenerate with tool call", async () => {
  const result = await model.doGenerate({
    prompt: [
      {
        role: "user",
        content: [{ type: "text", text: "What's the weather in San Francisco? Use the get_weather tool." }],
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
  assert(toolCall != null, "should contain a tool call")
  assert((toolCall as any).toolName === "get_weather", `tool name should be get_weather, got ${(toolCall as any).toolName}`)
  assert(result.finishReason === "tool-calls", `finishReason should be tool-calls, got ${result.finishReason}`)
  const args = JSON.parse((toolCall as any).input)
  console.log(`        Tool: ${(toolCall as any).toolName}(${JSON.stringify(args)})`)
})

// ─── Test 4: streamText integration ──────────────────────────────────────────
await test("works with AI SDK streamText()", async () => {
  const result = streamText({
    model,
    prompt: "What is 2 + 2? Reply with just the number.",
    maxTokens: 50,
  })

  let text = ""
  for await (const chunk of result.textStream) {
    text += chunk
  }

  assert(text.includes("4"), `response should contain "4", got: "${text.trim()}"`)
  console.log(`        streamText result: "${text.trim()}"`)
})

// ─── Test 5: generateText integration ────────────────────────────────────────
await test("works with AI SDK generateText()", async () => {
  const result = await generateText({
    model,
    prompt: "What is the capital of France? Reply with just the city name.",
    maxTokens: 50,
  })

  assert(result.text.includes("Paris"), `response should contain "Paris", got: "${result.text.trim()}"`)
  console.log(`        generateText result: "${result.text.trim()}"`)
})

// ─── Test 6: Multi-turn conversation ─────────────────────────────────────────
await test("multi-turn conversation", async () => {
  const result = await model.doGenerate({
    prompt: [
      { role: "user", content: [{ type: "text", text: "My name is Alice." }] },
      { role: "assistant", content: [{ type: "text", text: "Hello Alice! Nice to meet you." }] },
      { role: "user", content: [{ type: "text", text: "What is my name?" }] },
    ],
    maxOutputTokens: 100,
  } as any)

  const textContent = result.content.find((c) => c.type === "text")
  assert(textContent != null, "should contain text content")
  assert((textContent as any).text.includes("Alice"), `response should mention Alice`)
  console.log(`        Response: "${(textContent as any).text.trim().slice(0, 80)}"`)
})

// ─── Test 7: Streaming tool call ─────────────────────────────────────────────
await test("doStream with tool call", async () => {
  const result = await model.doStream({
    prompt: [
      {
        role: "user",
        content: [{ type: "text", text: "What's the weather in Tokyo? Use the get_weather tool." }],
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

  assert(eventTypes.has("tool-input-start"), "should have tool-input-start event")
  assert(eventTypes.has("tool-call"), "should have tool-call event")
  assert(toolCallName === "get_weather", `tool name should be get_weather, got ${toolCallName}`)
  console.log(`        Event types: ${[...eventTypes].join(", ")}`)
})

// ─── Test 8: tool-input-start id matches tool-call toolCallId ────────────────
await test("tool-input-start id matches tool-call toolCallId", async () => {
  const result = await model.doStream({
    prompt: [
      {
        role: "user",
        content: [{ type: "text", text: "What's the weather in Berlin? Use the get_weather tool." }],
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

  assert(toolInputStartId != null, "should have tool-input-start event with id")
  assert(toolCallId != null, "should have tool-call event with toolCallId")
  assert(
    toolInputStartId === toolCallId,
    `tool-input-start id "${toolInputStartId}" must match tool-call toolCallId "${toolCallId}" (OpenCode correlates them)`,
  )
  assert(toolCallId!.startsWith("toolu_"), `toolCallId should be an Anthropic tool ID, got "${toolCallId}"`)
  console.log(`        tool-input-start id: ${toolInputStartId}`)
  console.log(`        tool-call toolCallId: ${toolCallId}`)
  console.log(`        Match: true`)
})

// ─── Test 9: streamText tool execution round-trip ────────────────────────────
await test("streamText executes tools end-to-end", async () => {
  let toolWasExecuted = false
  const result = streamText({
    model,
    prompt: "What's the weather in London? Use the get_weather tool, then tell me the result.",
    maxTokens: 500,
    tools: {
      get_weather: tool({
        description: "Get the current weather in a given location",
        parameters: z.object({
          location: z.string().describe("City name"),
        }),
        execute: async ({ location }) => {
          toolWasExecuted = true
          return { temperature: 15, condition: "cloudy", location }
        },
      }),
    },
    maxSteps: 3,
  })

  let text = ""
  for await (const chunk of result.textStream) {
    text += chunk
  }

  assert(toolWasExecuted, "tool execute function should have been called")
  assert(text.length > 0, "should have generated text after tool execution")
  console.log(`        Tool executed: true`)
  console.log(`        Response: "${text.trim().slice(0, 100)}..."`)
})

// ─── Test 10: readClaudeCredentials parses valid file ────────────────────────
await test("readClaudeCredentials parses valid credentials file", async () => {
  const tmpDir = join(tmpdir(), `test-creds-${Date.now()}`)
  mkdirSync(tmpDir, { recursive: true })
  const credPath = join(tmpDir, "credentials.json")

  const mockCreds = {
    claudeAiOauth: {
      accessToken: "sk-ant-oat01-test-access-token",
      refreshToken: "sk-ant-ort01-test-refresh-token",
      expiresAt: Date.now() + 3600000, // 1 hour from now
      scopes: ["user:inference"],
      subscriptionType: null,
    },
  }
  writeFileSync(credPath, JSON.stringify(mockCreds))

  const creds = readClaudeCredentials(credPath)
  assert(creds != null, "should parse credentials")
  assert(creds!.accessToken === "sk-ant-oat01-test-access-token", "should read accessToken")
  assert(creds!.refreshToken === "sk-ant-ort01-test-refresh-token", "should read refreshToken")
  assert(!isExpired(creds!), "token should not be expired")
  console.log(`        accessToken: ${creds!.accessToken.slice(0, 20)}...`)
  console.log(`        expired: false`)

  rmSync(tmpDir, { recursive: true })
})

// ─── Test 11: readClaudeCredentials returns null for missing file ─────────────
await test("readClaudeCredentials returns null for missing file", async () => {
  const creds = readClaudeCredentials("/nonexistent/path/credentials.json")
  assert(creds === null, "should return null for missing file")
  console.log(`        result: null (correct)`)
})

// ─── Test 12: isExpired detects expired tokens ───────────────────────────────
await test("isExpired detects expired tokens", async () => {
  const expired = {
    accessToken: "test",
    refreshToken: "test",
    expiresAt: Date.now() - 60000, // 1 minute ago
    scopes: [],
    subscriptionType: null,
  }
  assert(isExpired(expired), "token with past expiresAt should be expired")

  const almostExpired = {
    ...expired,
    expiresAt: Date.now() + 2 * 60 * 1000, // 2 minutes from now (within 5min buffer)
  }
  assert(isExpired(almostExpired), "token expiring within 5min buffer should be expired")

  const valid = {
    ...expired,
    expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes from now
  }
  assert(!isExpired(valid), "token with 10min left should not be expired")
  console.log(`        past token: expired=true`)
  console.log(`        2min token: expired=true (within 5min buffer)`)
  console.log(`        10min token: expired=false`)
})

// ─── Test 13: createAnthropicSDK falls back to Claude Code credentials ───────
await test("createAnthropicSDK falls back to Claude Code credentials", async () => {
  const tmpDir = join(tmpdir(), `test-creds-fallback-${Date.now()}`)
  mkdirSync(tmpDir, { recursive: true })
  const credPath = join(tmpDir, "credentials.json")

  const oauthToken = "sk-ant-oat01-test-fallback-token"
  writeFileSync(credPath, JSON.stringify({
    claudeAiOauth: {
      accessToken: oauthToken,
      refreshToken: "sk-ant-ort01-unused",
      expiresAt: Date.now() + 3600000,
      scopes: ["user:inference"],
      subscriptionType: null,
    },
  }))

  // Create provider without apiKey or env var, only credentials file
  const savedKey = process.env.ANTHROPIC_API_KEY
  delete process.env.ANTHROPIC_API_KEY
  try {
    const provider = createAnthropicSDK({ credentialsPath: credPath })
    const m = provider.languageModel("claude-haiku-4-5-20251001")
    assert(m.specificationVersion === "v2", "model should be v2 spec")
    assert(m.modelId === "claude-haiku-4-5-20251001", "modelId should match")

    // Call with fake OAuth token — should get 401 "invalid x-api-key"
    // (NOT "missing auth" which would mean credentials weren't read)
    try {
      await m.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        maxOutputTokens: 10,
      } as any)
      assert(false, "expected auth error with fake token")
    } catch (err: any) {
      const msg = (err?.message ?? String(err)).toLowerCase()
      assert(
        msg.includes("401") || msg.includes("authentication") || msg.includes("api_key") || msg.includes("invalid"),
        `expected 401 auth error (credentials were used as x-api-key), got: ${msg.slice(0, 120)}`,
      )
      console.log(`        Provider created with credentials file: true`)
      console.log(`        OAuth token sent as x-api-key: true (got expected 401)`)
    }
  } finally {
    process.env.ANTHROPIC_API_KEY = savedKey
    rmSync(tmpDir, { recursive: true })
  }
})

// ─── Test 14: doStream with thinking (extended thinking + signature) ──────────
await test("doStream with thinking produces reasoning events with signature", async () => {
  // Use Sonnet which supports thinking
  const thinkingModel = provider.languageModel("claude-sonnet-4-6")
  const result = await thinkingModel.doStream({
    prompt: [
      { role: "user", content: [{ type: "text", text: "What is 7 * 8?" }] },
    ],
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

  assert(eventTypes.has("reasoning-start"), "should have reasoning-start event")
  assert(eventTypes.has("reasoning-delta"), "should have reasoning-delta events")
  assert(eventTypes.has("reasoning-end"), "should have reasoning-end event")
  assert(eventTypes.has("text-delta"), "should have text-delta events")
  assert(reasoningText.length > 0, "reasoning text should not be empty")
  assert(hasSignature, "reasoning-end should include signature in providerMetadata")
  console.log(`        Event types: ${[...eventTypes].join(", ")}`)
  console.log(`        Reasoning length: ${reasoningText.length} chars`)
  console.log(`        Signature present: true`)
})

// ─── Test 15: doGenerate with thinking returns reasoning content ──────────────
await test("doGenerate with thinking returns reasoning content with signature", async () => {
  const thinkingModel = provider.languageModel("claude-sonnet-4-6")
  const result = await thinkingModel.doGenerate({
    prompt: [
      { role: "user", content: [{ type: "text", text: "What is 12 * 12?" }] },
    ],
    maxOutputTokens: 4096,
    providerOptions: {
      anthropic: {
        thinking: { type: "enabled", budgetTokens: 5000 },
      },
    },
  } as any)

  const reasoning = result.content.filter((c) => c.type === "reasoning")
  const text = result.content.find((c) => c.type === "text")

  assert(reasoning.length > 0, "should contain reasoning content")
  assert((reasoning[0] as any).text.length > 0, "reasoning text should not be empty")
  assert(text != null, "should contain text content")

  const sig = (reasoning[0] as any).providerMetadata?.anthropic?.signature
  assert(sig && sig.length > 0, "reasoning should include signature in providerMetadata")

  console.log(`        Reasoning: "${(reasoning[0] as any).text.slice(0, 80)}..."`)
  console.log(`        Answer: "${(text as any).text.trim().slice(0, 50)}"`)
  console.log(`        Signature: ${sig?.slice(0, 30)}...`)
})

// ─── Test 16: thinking signature roundtrip in conversation history ────────────
await test("thinking signature survives conversation roundtrip", async () => {
  const thinkingModel = provider.languageModel("claude-sonnet-4-6")

  // First turn: get a response with thinking
  const first = await thinkingModel.doGenerate({
    prompt: [
      { role: "user", content: [{ type: "text", text: "What is 3 + 4?" }] },
    ],
    maxOutputTokens: 4096,
    providerOptions: {
      anthropic: {
        thinking: { type: "enabled", budgetTokens: 5000 },
      },
    },
  } as any)

  // Second turn: send the thinking back in history — this should NOT error
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
  assert(text != null, "should get a response in second turn")
  assert(
    (text as any).text.includes("14"),
    `second turn should reference 14, got: "${(text as any).text.trim().slice(0, 80)}"`,
  )
  console.log(`        Second turn: "${(text as any).text.trim().slice(0, 80)}"`)
  console.log(`        Signature roundtrip: success (no API error)`)
})

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(60)}`)
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`)
if (failed > 0) {
  process.exit(1)
}
