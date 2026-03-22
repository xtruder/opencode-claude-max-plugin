/**
 * Maps OpenCode tool names ↔ Claude Code tool names.
 *
 * Built-in tools: OpenCode uses snake_case, Claude Code uses PascalCase.
 * MCP tools: OpenCode uses `<server>_<tool>`, Claude Code uses `mcp__<server>__<tool>`.
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

/**
 * All known OpenCode built-in tool names → Claude Code equivalents.
 */
const BUILTIN_OPENCODE_TO_CLAUDE: Record<string, string> = {
  task: "Agent",
  question: "AskUserQuestion",
  plan_exit: "ExitPlanMode",
  plan_enter: "EnterPlanMode",
  bash: "Bash",
  glob: "Glob",
  grep: "Grep",
  read: "Read",
  edit: "Edit",
  write: "Write",
  webfetch: "WebFetch",
  websearch: "WebSearch",
  todowrite: "TodoWrite",
  todoread: "TodoRead",
  skill: "Skill",
  multiedit: "MultiEdit",
  list: "List",
  apply_patch: "ApplyPatch",
  batch: "Batch",
  codesearch: "CodeSearch",
  lsp: "LSP",
}

/** Set of all known built-in OpenCode tool names for quick lookup. */
const BUILTIN_OPENCODE_NAMES = new Set(Object.keys(BUILTIN_OPENCODE_TO_CLAUDE))

/** Reverse map: Claude Code → OpenCode for built-in tools. */
const BUILTIN_CLAUDE_TO_OPENCODE: Record<string, string> = {}
for (const [oc, cc] of Object.entries(BUILTIN_OPENCODE_TO_CLAUDE)) {
  BUILTIN_CLAUDE_TO_OPENCODE[cc] = oc
}

/**
 * Known MCP server names, sorted longest-first for greedy matching.
 * Auto-populated from OpenCode config on first use.
 */
let mcpServerNames: string[] | null = null

/**
 * Explicitly set known MCP server names.
 */
export function setKnownMcpServers(servers: string[]): void {
  mcpServerNames = [...servers].sort((a, b) => b.length - a.length)
}

/**
 * Auto-detect MCP server names from OpenCode config files.
 * Searches: .opencode/opencode.json (project) and ~/.config/opencode/opencode.jsonc (global)
 */
function detectMcpServers(): string[] {
  const servers = new Set<string>()

  const paths = [
    join(process.cwd(), ".opencode", "opencode.json"),
    join(homedir(), ".config", "opencode", "opencode.json"),
    join(homedir(), ".config", "opencode", "opencode.jsonc"),
  ]

  for (const p of paths) {
    try {
      if (!existsSync(p)) continue
      let raw = readFileSync(p, "utf-8")
      // Strip JSONC comments
      raw = raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")
      const config = JSON.parse(raw)
      if (config.mcp && typeof config.mcp === "object") {
        for (const name of Object.keys(config.mcp)) {
          servers.add(name.replace(/[^a-zA-Z0-9_-]/g, "_"))
        }
      }
    } catch {
      // Ignore parse errors
    }
  }

  return [...servers].sort((a, b) => b.length - a.length)
}

function getMcpServers(): string[] {
  if (mcpServerNames === null) {
    mcpServerNames = detectMcpServers()
  }
  return mcpServerNames
}

/**
 * Split an OpenCode MCP tool name `<server>_<tool>` into parts.
 */
function splitMcpToolName(name: string): { server: string; tool: string } | null {
  const servers = getMcpServers()

  // Try known server names first (longest match wins)
  for (const server of servers) {
    if (name.startsWith(server + "_")) {
      return { server, tool: name.slice(server.length + 1) }
    }
  }

  // Fallback: split at first underscore
  const idx = name.indexOf("_")
  if (idx > 0) {
    return { server: name.slice(0, idx), tool: name.slice(idx + 1) }
  }

  return null
}

/**
 * Convert an OpenCode tool name to a Claude Code tool name.
 *
 * Built-in: `bash` → `Bash`, `task` → `Agent`, etc.
 * MCP: `context7_query-docs` → `mcp__context7__query-docs`
 */
export function toClaudeToolName(opencodeName: string): string {
  // Check built-in first
  const builtin = BUILTIN_OPENCODE_TO_CLAUDE[opencodeName]
  if (builtin) return builtin

  // Must be an MCP tool — convert to Claude Code format
  const parts = splitMcpToolName(opencodeName)
  if (parts) {
    return `mcp__${parts.server}__${parts.tool}`
  }

  return opencodeName
}

/**
 * Convert a Claude Code tool name back to an OpenCode tool name.
 *
 * Built-in: `Bash` → `bash`, `Agent` → `task`, etc.
 * MCP: `mcp__context7__query-docs` → `context7_query-docs`
 */
export function toOpencodeToolName(claudeName: string): string {
  // Check built-in first
  const builtin = BUILTIN_CLAUDE_TO_OPENCODE[claudeName]
  if (builtin) return builtin

  // Check MCP prefix
  if (claudeName.startsWith("mcp__")) {
    const rest = claudeName.slice(5) // remove "mcp__"
    const idx = rest.indexOf("__")
    if (idx > 0) {
      const server = rest.slice(0, idx)
      const tool = rest.slice(idx + 2)
      return `${server}_${tool}`
    }
  }

  return claudeName
}
