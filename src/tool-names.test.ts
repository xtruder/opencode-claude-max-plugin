import { describe, expect, test } from "vitest"
import { setKnownMcpServers, toClaudeToolName, toOpencodeToolName } from "./tool-names.ts"

describe("tool name mapping", () => {
  setKnownMcpServers(["context7"])

  test("maps OpenCode v2 built-in tool IDs to Claude Code names and back", () => {
    for (const [oc, cc] of [
      ["shell", "Bash"],
      ["subagent", "Agent"],
      ["webfetch", "WebFetch"],
      ["websearch", "WebSearch"],
      ["read", "Read"],
      ["edit", "Edit"],
      ["grep", "Grep"],
    ]) {
      expect(toClaudeToolName(oc)).toBe(cc)
      expect(toOpencodeToolName(cc)).toBe(oc)
    }
  })

  test("maps MCP tools", () => {
    expect(toClaudeToolName("context7_query-docs")).toBe("mcp__context7__query-docs")
    expect(toOpencodeToolName("mcp__context7__query-docs")).toBe("context7_query-docs")
  })
})
