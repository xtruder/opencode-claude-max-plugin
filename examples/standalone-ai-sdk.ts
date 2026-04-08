/**
 * Standalone example: using this package as a Vercel AI SDK provider
 * WITHOUT any OpenCode dependencies.
 *
 * Run with:
 *   bun run examples/standalone-ai-sdk.ts
 *
 * Requires either:
 *   - ANTHROPIC_API_KEY env var, or
 *   - ~/.claude/.credentials.json from Claude Code
 */
import { streamText } from "ai"
import { createAnthropicSDK } from "../src/index.ts"

const systemPrompt =
  "You are an interactive agent that helps users with software engineering tasks. Use the instructions below and the tools available to you to assist the user."

const provider = createAnthropicSDK()
const model = provider.languageModel("claude-haiku-4-5-20251001")

console.log("--- streamText example ---")

const result = streamText({
  model,
  system: systemPrompt,
  prompt: "What is 2+2? Reply in one short sentence.",
})

for await (const chunk of result.textStream) {
  process.stdout.write(chunk)
}

console.log("\n--- done ---")
