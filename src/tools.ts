import type {
  LanguageModelV2FunctionTool,
  LanguageModelV2ProviderDefinedTool,
  LanguageModelV2ToolChoice,
} from "@ai-sdk/provider"
import type Anthropic from "@anthropic-ai/sdk"
import { toClaudeToolName } from "./tool-names.js"

type AnthropicTool = Anthropic.Tool
type AnthropicToolChoice = Anthropic.MessageCreateParams["tool_choice"]

/**
 * Strip non-standard JSON Schema fields that the Anthropic API rejects
 * (e.g. `custom` added by AI SDK's zod-to-json-schema conversion).
 */
function cleanSchema(schema: Record<string, any>): Record<string, any> {
  const cleaned: Record<string, any> = {}
  for (const [key, value] of Object.entries(schema)) {
    // Skip AI SDK internal fields
    if (key === "custom") continue
    if (value && typeof value === "object" && !Array.isArray(value)) {
      cleaned[key] = cleanSchema(value)
    } else {
      cleaned[key] = value
    }
  }
  // Ensure top-level type is present for object schemas
  if (cleaned.properties && !cleaned.type) {
    cleaned.type = "object"
  }
  return cleaned
}

export function convertTools(
  tools: Array<LanguageModelV2FunctionTool | LanguageModelV2ProviderDefinedTool> | undefined,
): AnthropicTool[] | undefined {
  if (!tools || tools.length === 0) return undefined

  return tools
    .filter((t): t is LanguageModelV2FunctionTool => t.type === "function")
    .map((tool) => ({
      name: toClaudeToolName(tool.name),
      description: tool.description ?? "",
      input_schema: cleanSchema(tool.inputSchema as Record<string, any>) as AnthropicTool["input_schema"],
    }))
}

export function convertToolChoice(
  toolChoice: LanguageModelV2ToolChoice | undefined,
): AnthropicToolChoice | undefined {
  if (!toolChoice) return undefined

  switch (toolChoice.type) {
    case "auto":
      return { type: "auto" }
    case "required":
      return { type: "any" }
    case "none":
      // Anthropic doesn't have a "none" tool choice — we handle this by omitting tools
      return undefined
    case "tool":
      return { type: "tool", name: toClaudeToolName(toolChoice.toolName) }
  }
}
