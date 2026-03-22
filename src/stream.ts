import type {
  LanguageModelV2StreamPart,
  LanguageModelV2FinishReason,
} from "@ai-sdk/provider"
import type Anthropic from "@anthropic-ai/sdk"
import { toOpencodeToolName } from "./tool-names.js"

type MessageStreamEvent = Anthropic.MessageStreamEvent

interface ContentBlockState {
  type: "text" | "tool_use" | "thinking"
  id: string // generated ID for the AI SDK stream parts
  // tool_use specific
  toolUseId?: string
  toolName?: string
  argsText?: string
}

let idCounter = 0
function generateId(): string {
  return `block-${Date.now()}-${idCounter++}`
}

function mapFinishReason(stopReason: string | null | undefined): LanguageModelV2FinishReason {
  switch (stopReason) {
    case "end_turn":
      return "stop"
    case "stop_sequence":
      return "stop"
    case "max_tokens":
      return "length"
    case "tool_use":
      return "tool-calls"
    default:
      return "unknown"
  }
}

export function convertStream(
  anthropicStream: AsyncIterable<MessageStreamEvent>,
  modelId: string,
): ReadableStream<LanguageModelV2StreamPart> {
  const blockStates = new Map<number, ContentBlockState>()
  let inputTokens: number | undefined
  let outputTokens: number | undefined

  return new ReadableStream<LanguageModelV2StreamPart>({
    async start(controller) {
      try {
        for await (const event of anthropicStream) {
          const parts = processEvent(event, blockStates, modelId)
          if (event.type === "message_start" && event.message.usage) {
            inputTokens = event.message.usage.input_tokens
          }
          if (event.type === "message_delta") {
            const delta = event as any
            outputTokens = delta.usage?.output_tokens
            const finishReason = mapFinishReason(delta.delta?.stop_reason)
            controller.enqueue({
              type: "finish",
              finishReason,
              usage: {
                inputTokens: inputTokens ?? 0,
                outputTokens: outputTokens ?? 0,
                totalTokens: (inputTokens ?? 0) + (outputTokens ?? 0),
              },
            })
          }
          for (const part of parts) {
            controller.enqueue(part)
          }
        }
      } catch (error) {
        controller.enqueue({ type: "error", error })
      } finally {
        controller.close()
      }
    },
  })
}

function processEvent(
  event: MessageStreamEvent,
  blockStates: Map<number, ContentBlockState>,
  modelId: string,
): LanguageModelV2StreamPart[] {
  const parts: LanguageModelV2StreamPart[] = []

  switch (event.type) {
    case "message_start": {
      parts.push({
        type: "response-metadata",
        id: event.message.id,
        modelId: event.message.model ?? modelId,
        timestamp: new Date(),
      })
      break
    }

    case "content_block_start": {
      const index = event.index
      const block = event.content_block as any

      if (block.type === "text") {
        const id = generateId()
        blockStates.set(index, { type: "text", id })
        parts.push({ type: "text-start", id })
      } else if (block.type === "thinking") {
        const id = generateId()
        blockStates.set(index, { type: "thinking", id })
        parts.push({ type: "reasoning-start", id })
      } else if (block.type === "tool_use") {
        // Use the Anthropic tool_use ID as the stream block ID
        // so tool-input-start `id` matches tool-call `toolCallId`
        // (OpenCode's processor correlates them via this shared ID)
        const toolId = block.id as string
        const toolName = toOpencodeToolName(block.name as string)
        blockStates.set(index, {
          type: "tool_use",
          id: toolId,
          toolUseId: toolId,
          toolName,
          argsText: "",
        })
        parts.push({
          type: "tool-input-start",
          id: toolId,
          toolName,
        })
      }
      break
    }

    case "content_block_delta": {
      const index = event.index
      const state = blockStates.get(index)
      if (!state) break

      const delta = event.delta as any

      if (delta.type === "text_delta" && state.type === "text") {
        parts.push({
          type: "text-delta",
          id: state.id,
          delta: delta.text,
        })
      } else if (delta.type === "thinking_delta" && state.type === "thinking") {
        parts.push({
          type: "reasoning-delta",
          id: state.id,
          delta: delta.thinking,
        })
      } else if (delta.type === "input_json_delta" && state.type === "tool_use") {
        state.argsText = (state.argsText ?? "") + delta.partial_json
        parts.push({
          type: "tool-input-delta",
          id: state.id,
          delta: delta.partial_json,
        })
      }
      break
    }

    case "content_block_stop": {
      const index = event.index
      const state = blockStates.get(index)
      if (!state) break

      if (state.type === "text") {
        parts.push({ type: "text-end", id: state.id })
      } else if (state.type === "thinking") {
        parts.push({ type: "reasoning-end", id: state.id })
      } else if (state.type === "tool_use") {
        parts.push({ type: "tool-input-end", id: state.id })
        // Emit the complete tool call
        parts.push({
          type: "tool-call",
          toolCallId: state.toolUseId!,
          toolName: state.toolName!,
          input: state.argsText || "{}",
        })
      }

      blockStates.delete(index)
      break
    }

    // message_delta and message_stop are handled in the main loop
  }

  return parts
}
