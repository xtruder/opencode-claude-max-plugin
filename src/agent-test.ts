/**
 * Integration tests for Agent SDK provider
 *
 * Run with: bun run src/agent-test.ts
 */
import { createAgentSDK } from "./agent-index.js"
import { streamText, generateText, tool } from "ai"
import { z } from "zod"

let passed = 0
let failed = 0

// Create a fresh model for each test to avoid session state pollution
function getModel() {
  return createAgentSDK().languageModel("claude-haiku-4-5-20251001")
}

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

// ─── Test 1: Simple text generation ──────────────────────────────────────────
await test("doGenerate returns text", async () => {
  const model = getModel()
  const result = await model.doGenerate({
    prompt: [
      { role: "user", content: [{ type: "text", text: "Say hello in exactly 3 words." }] },
    ],
    maxOutputTokens: 100,
  } as any)

  const textContent = result.content.find((c) => c.type === "text")
  assert(textContent != null, "should contain text content")
  assert((textContent as any).text.length > 0, "text should not be empty")
  console.log(`        Response: "${(textContent as any).text.trim()}"`)
})

// ─── Test 2: Streaming ──────────────────────────────────────────────────────
await test("doStream produces text events", async () => {
  const model = getModel()
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
  assert(eventTypes.has("text-delta"), "should have text-delta events")
  assert(eventTypes.has("finish"), "should have finish event")
  assert(fullText.length > 0, "accumulated text should not be empty")
  console.log(`        Event types: ${[...eventTypes].join(", ")}`)
  console.log(`        Streamed text: "${fullText.trim().slice(0, 80)}..."`)
})

// Note: Tool call tests are not included in this suite because the Agent SDK
// is designed to run within Claude Code where tools are provided by the environment.
// Tool registration through the API is not supported. Use the standard Anthropic SDK
// provider (in index.ts) for tool support.


// ─── Test 5: streamText integration ──────────────────────────────────────────
await test("works with AI SDK streamText()", async () => {
  // Create a fresh model instance for this test to avoid context accumulation
  const freshModel = getModel()
  const result = streamText({
    model: freshModel,
    prompt: "What is 2 + 2?",
    maxOutputTokens: 50,
  })

  let text = ""
  for await (const chunk of result.textStream) {
    text += chunk
  }

  assert(text.length > 0, `response should not be empty, got: "${text.trim()}"`)
  console.log(`        streamText result: "${text.trim()}"`)
})

// ─── Test 6: generateText integration ────────────────────────────────────────
await test("works with AI SDK generateText()", async () => {
  // Create a fresh model instance for this test
  const freshModel = getModel()
  const result = await generateText({
    model: freshModel,
    prompt: "What is the capital of France?",
    maxOutputTokens: 50,
  })

  assert(result.text.length > 0, `response should not be empty, got: "${result.text.trim()}"`)
  console.log(`        generateText result: "${result.text.trim()}"`)
})


// ─── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(60)}`)
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`)

if (failed > 0) process.exit(1)
