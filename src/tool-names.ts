/**
 * Maps OpenCode tool names ↔ Claude Code tool names.
 *
 * Built-in tools: OpenCode uses snake_case, Claude Code uses PascalCase.
 * MCP tools: OpenCode uses `<server>_<tool>`, Claude Code uses `mcp__<server>__<tool>`.
 */
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * Maps OpenCode built-in tool IDs to their Claude Code equivalents.
 * Tools not in this map pass through unchanged (e.g. MCP tools, OpenCode-only
 * tools like repo_clone/repo_overview that have no CC equivalent).
 */
const BUILTIN_OPENCODE_TO_CLAUDE: Record<string, string> = {
  task: "Agent",
  question: "AskUserQuestion",
  plan_exit: "ExitPlanMode",
  bash: "Bash",
  glob: "Glob",
  grep: "Grep",
  read: "Read",
  edit: "Edit",
  write: "Write",
  fetch: "WebFetch",
  search: "WebSearch",
  todowrite: "TodoWrite",
  skill: "Skill",
  apply_patch: "ApplyPatch",
  lsp: "LSP",
}

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
  mcpServerNames = [...servers].toSorted((a, b) => b.length - a.length)
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

  return [...servers].toSorted((a, b) => b.length - a.length)
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

/**
 * Patterns for rewriting system prompt text to match Claude Code style.
 * Includes tool name renames and identity/opening rewrites.
 */
const SYSTEM_PROMPT_REPLACEMENTS: Array<[RegExp, string]> = [
  // Replace OpenCode identity with Claude Code-style opening
  [
    /^You are OpenCode, the best coding agent on the planet\.\s*\n\s*You are an interactive CLI tool that helps users with software engineering tasks\./m,
    "You are an interactive agent that helps users with software engineering tasks.",
  ],

  // "Task tool" / "task tool" / "the Task" → "Agent"
  [/\bTask\s+tool/g, "Agent tool"],
  [/\btask\s+tool/g, "Agent tool"],
  [/\bthe\s+Task\b/g, "the Agent"],
  // Standalone "Task" when used as tool name (after "use the" or before "tool")
  [/\buse\s+(?:the\s+)?Task\b/g, "use the Agent"],

  // "question" tool → "AskUserQuestion"
  [/\bquestion\s+tool/g, "AskUserQuestion tool"],
  [/\bthe\s+question\b(?=\s+to\s+ask)/g, "the AskUserQuestion"],

  // Lowercase tool names → PascalCase (only where used as tool references)
  [/\buse\s+(?:the\s+)?bash\b/gi, "use the Bash"],
  [/\buse\s+(?:the\s+)?read\b/gi, "use the Read"],
  [/\buse\s+(?:the\s+)?write\b/gi, "use the Write"],
  [/\buse\s+(?:the\s+)?edit\b/gi, "use the Edit"],
  [/\buse\s+(?:the\s+)?glob\b/gi, "use the Glob"],
  [/\buse\s+(?:the\s+)?grep\b/gi, "use the Grep"],
  [/\buse\s+(?:the\s+)?skill\b/gi, "use the Skill"],
  [/\buse\s+(?:the\s+)?fetch\b/gi, "use the WebFetch"],
  [/\buse\s+(?:the\s+)?search\b/gi, "use the WebSearch"],
  [/\buse\s+(?:the\s+)?todowrite\b/gi, "use the TodoWrite"],
]

/**
 * Rewrite OpenCode tool names in system prompt text to match Claude Code names.
 * This ensures the model sees tool names consistent with the tools list.
 */
export function rewriteToolNamesInText(text: string): string {
  let result = text
  for (const [pattern, replacement] of SYSTEM_PROMPT_REPLACEMENTS) {
    result = result.replace(pattern, replacement)
  }
  return result
}
