#!/usr/bin/env bun
/**
 * CLI tool to display Claude subscription usage.
 * Run directly: bun run src/usage-cli.ts
 * Or via npx: npx @xtruder/opencode-claude-max-plugin-usage
 */
import { fetchUsage, formatUsage } from "./usage.js"

let data
try {
  data = await fetchUsage()
} catch (e: any) {
  console.error(e.message ?? "Could not fetch usage.")
  process.exit(1)
}
if (!data) {
  console.error("Could not fetch usage. Make sure you're logged into Claude Code (~/.claude/.credentials.json).")
  process.exit(1)
}

console.log("")
console.log("  Claude Subscription Usage")
console.log("  " + "─".repeat(52))
console.log(formatUsage(data))
