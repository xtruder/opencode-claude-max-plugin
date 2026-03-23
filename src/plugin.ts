/**
 * OpenCode Plugin entry point for @xtruder/opencode-claude-max-plugin.
 *
 * Registers a /usage command that fetches Claude subscription usage directly
 * from the Anthropic OAuth API — no bash, no markdown file required.
 *
 * Register in opencode.json:
 *   "plugin": ["@xtruder/opencode-claude-max-plugin/plugin"]
 */
import type { Plugin } from "@opencode-ai/plugin"
import { fetchUsage, formatUsage } from "./usage.js"

const COMMAND_NAME = "usage"

/**
 * Build the display text for the LLM to echo verbatim.
 * Instruction-style so the LLM outputs it without commentary.
 */
async function buildUsageText(credentialsPath?: string): Promise<string> {
  const data = await fetchUsage(credentialsPath)
  if (!data) {
    return (
      "Display this message verbatim to the user:\n\n" +
      "  Could not fetch Claude usage. " +
      "Make sure you are logged into Claude Code (~/.claude/.credentials.json)."
    )
  }
  return (
    "Display the following Claude subscription usage verbatim to the user. " +
    "Do not add any commentary, formatting changes, or explanation:\n\n" +
    "  Claude Subscription Usage\n" +
    "  " + "─".repeat(52) + "\n" +
    formatUsage(data)
  )
}

/**
 * Replace the text content of an existing text part, preserving all other
 * fields (id, sessionID, messageID, etc.) that OpenCode's Zod schema requires.
 * If no text part exists, mutate the first part or push a minimal one.
 */
function replaceTextInParts(
  parts: Array<Record<string, any>>,
  text: string,
): void {
  const idx = parts.findIndex((p) => p.type === "text")
  if (idx >= 0) {
    // Preserve the original part object — only overwrite the text field
    parts[idx] = { ...parts[idx], text }
  } else if (parts.length > 0) {
    parts[0] = { ...parts[0], text }
  } else {
    parts.push({ type: "text", text })
  }
}

const UsagePlugin: Plugin = async (_ctx) => {
  return {
    /**
     * Primary hook: fires when OpenCode resolves a slash command.
     * Intercepts /usage and injects the pre-fetched usage data.
     */
    "command.execute.before": async (input, output) => {
      if (input.command.toLowerCase() !== COMMAND_NAME) return

      const text = await buildUsageText()
      replaceTextInParts(output.parts as Array<Record<string, any>>, text)
    },

    /**
     * Fallback hook: fires for every user chat message.
     * Catches /usage typed directly as text (some OpenCode versions route
     * unknown commands through chat rather than command.execute.before).
     */
    "chat.message": async (_input, output) => {
      const parts = output.parts as Array<Record<string, any>>
      const idx = parts.findIndex(
        (p) =>
          p.type === "text" &&
          typeof p.text === "string" &&
          p.text.trim().toLowerCase().startsWith(`/${COMMAND_NAME}`),
      )
      if (idx < 0) return

      const text = await buildUsageText()
      parts[idx] = { ...parts[idx], text }
    },
  }
}

export default UsagePlugin
export { UsagePlugin }
