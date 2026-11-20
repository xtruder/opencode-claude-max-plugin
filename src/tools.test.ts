import { describe, expect, test } from "vitest"
import {
  FILE_TOOL_GUIDANCE,
  FILE_TOOL_REMINDER,
  fileToolDescription,
} from "./file-tool-guidance.ts"
import { convertTools } from "./tools.ts"

describe("native file-tool descriptions", () => {
  test("reinforces Edit and Bash without changing schemas or original descriptions", () => {
    const schema = {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    }
    const tools = ["edit", "shell", "read", "write"].map((name) => ({
      type: "function" as const,
      name,
      description: `Original ${name} description.`,
      inputSchema: schema,
    }))
    const converted = convertTools(tools)!

    expect(converted.map((tool) => tool.name)).toEqual(["Edit", "Bash", "Read", "Write"])
    expect(converted[0].description).toContain("Original edit description.")
    expect(converted[0].description).toContain("not sed, awk, Python, Perl")
    expect(converted[0].description).toContain("Read")
    expect(converted[1].description).toContain("Original shell description.")
    expect(converted[1].description).toContain("Read files with Read.")
    expect(converted[1].description).toContain("instead of cat, sed, awk, Python, Perl")
    expect(converted[1].description).toContain("Edit")
    expect(converted[1].description).toContain("Write")
    expect(converted[1].description).toContain("Bash remains available for other commands")
    expect(converted[2].description).toBe("Original read description.")
    expect(converted[3].description).toBe("Original write description.")
    for (const tool of converted) expect(tool.input_schema).toEqual(schema)
    expect(tools[0].description).toBe("Original edit description.")
    expect(convertTools(tools)).toEqual(converted)
  })

  test("adds guidance when descriptions are absent, leaving unrelated tools alone", () => {
    const converted = convertTools(
      ["edit", "shell", "other"].map((name) => ({
        type: "function",
        name,
        inputSchema: { type: "object", properties: {} },
      })),
    )!

    expect(converted[0].description).toMatch(/^Use Edit/)
    expect(converted[1].description).toMatch(/^Read files with Read\./)
    expect(converted[2].description).toBe("")
  })

  test("explains visibility without limiting Bash to a list of command types", () => {
    expect(FILE_TOOL_GUIDANCE).toContain("must use dedicated file tools, not Bash commands")
    expect(FILE_TOOL_GUIDANCE).not.toContain("Read files with Read.")
    for (const guidance of [
      FILE_TOOL_GUIDANCE,
      FILE_TOOL_REMINDER,
      fileToolDescription("Edit"),
      fileToolDescription("Bash"),
    ]) {
      expect(guidance).toContain("visible to the user")
      expect(guidance).not.toContain("Bash is for builds")
    }
  })
})
