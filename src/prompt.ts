import type { LanguageModelV2Prompt, LanguageModelV2Message } from "@ai-sdk/provider"
import type Anthropic from "@anthropic-ai/sdk"
import { toClaudeToolName } from "./tool-names.ts"

type AnthropicMessage = Anthropic.MessageCreateParams["messages"][number]
type AnthropicContentBlock = Anthropic.ContentBlockParam
type AnthropicSystemParam = Anthropic.MessageCreateParams["system"]

export interface ConvertedPrompt {
  system: AnthropicSystemParam
  messages: AnthropicMessage[]
}

export function convertPrompt(prompt: LanguageModelV2Prompt): ConvertedPrompt {
  const systemParts: string[] = []
  const messages: AnthropicMessage[] = []

  for (const message of prompt) {
    switch (message.role) {
      case "system":
        systemParts.push(message.content)
        break
      case "user":
        messages.push(convertUserMessage(message))
        break
      case "assistant":
        messages.push(convertAssistantMessage(message))
        break
      case "tool":
        messages.push(convertToolMessage(message))
        break
    }
  }

  return {
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    messages,
  }
}

function convertUserMessage(
  message: Extract<LanguageModelV2Message, { role: "user" }>,
): AnthropicMessage {
  const content: AnthropicContentBlock[] = []

  for (const part of message.content) {
    switch (part.type) {
      case "text":
        content.push({ type: "text", text: part.text })
        break
      case "file":
        // Handle image files
        if (typeof part.data === "string" && part.mediaType?.startsWith("image/")) {
          content.push({
            type: "image",
            source: {
              type: "base64",
              media_type: part.mediaType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
              data: part.data,
            },
          })
        } else if (part.data instanceof URL) {
          content.push({
            type: "image",
            source: {
              type: "url",
              url: part.data.toString(),
            },
          })
        }
        break
    }
  }

  // If only one text part, simplify
  if (content.length === 1 && content[0].type === "text") {
    return { role: "user", content: (content[0] as { type: "text"; text: string }).text }
  }

  return { role: "user", content }
}

function convertAssistantMessage(
  message: Extract<LanguageModelV2Message, { role: "assistant" }>,
): AnthropicMessage {
  const content: AnthropicContentBlock[] = []

  for (const part of message.content) {
    switch (part.type) {
      case "text":
        if (part.text.length > 0) {
          content.push({ type: "text", text: part.text })
        }
        break
      case "reasoning":
        {
          // Map reasoning to Anthropic thinking blocks
          // Signature comes from providerMetadata (set by us in stream.ts/model.ts)
          // or providerOptions (set by the caller)
          const signature =
            (part as any).providerMetadata?.anthropic?.signature ??
            (part as any).providerOptions?.anthropic?.signature ??
            ""
          if (signature) {
            content.push({
              type: "thinking",
              thinking: part.text,
              signature,
            } as any)
          }
          // No signature → skip the block entirely. Anthropic rejects both
          // empty signatures and empty redacted_thinking data.
          break
        }
        break
      case "tool-call":
        content.push({
          type: "tool_use",
          id: part.toolCallId,
          name: toClaudeToolName(part.toolName),
          input: typeof part.input === "string" ? JSON.parse(part.input as string) : part.input,
        })
        break
      case "file":
        // Skip file parts in assistant messages
        break
      case "tool-result":
        // Tool results in assistant messages shouldn't happen but handle gracefully
        break
    }
  }

  return { role: "assistant", content }
}

function convertToolMessage(
  message: Extract<LanguageModelV2Message, { role: "tool" }>,
): AnthropicMessage {
  const content: AnthropicContentBlock[] = []

  for (const part of message.content) {
    const resultContent = formatToolResultContent(part.output)
    content.push({
      type: "tool_result",
      tool_use_id: part.toolCallId,
      content: resultContent,
      is_error:
        part.output.type === "error-text" || part.output.type === "error-json" ? true : undefined,
    } as any)
  }

  return { role: "user", content }
}

function formatToolResultContent(output: {
  type: string
  value: any
}): string | Array<{ type: "text"; text: string }> {
  switch (output.type) {
    case "text":
    case "error-text":
      return output.value
    case "json":
    case "error-json":
      return JSON.stringify(output.value)
    case "content": {
      // Convert content array to text parts (skip media for now)
      const parts: Array<{ type: "text"; text: string }> = []
      for (const item of output.value) {
        if (item.type === "text") {
          parts.push({ type: "text", text: item.text })
        }
      }
      return parts.length === 1 ? parts[0].text : parts
    }
    default:
      return String(output.value)
  }
}
