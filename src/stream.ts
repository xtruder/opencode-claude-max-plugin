import type { LanguageModelV3FinishReason, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import type Anthropic from "@anthropic-ai/sdk"
import { toOpencodeToolName } from "./tool-names.ts"

type MessageStreamEvent = Anthropic.MessageStreamEvent

interface ContentBlockState {
  type: "text" | "tool_use" | "thinking"
  id: string // generated ID for the AI SDK stream parts
  // tool_use specific
  toolUseId?: string
  toolName?: string
  argsText?: string
  // thinking specific
  signature?: string
  // fallback metadata attached to this block (see StreamContext.pendingMeta)
  fallbackMeta?: Record<string, any>
}

/**
 * Options and mutable state for one streamed response.
 *
 * Server-side fallback (Fable 5 safety refusals → Opus 4.8) surfaces in two
 * ways that we translate into part metadata:
 *
 *   - A `fallback` content block (content_block_start/stop, no deltas) marks
 *     the hop where the declining model's output gives way to the fallback
 *     model. We don't emit a part for it; instead we carry two keys on the
 *     NEXT block's part metadata (OpenCode persists part metadata and syncs
 *     it to the TUI — the same round trip thinking signatures use):
 *       anthropic.fallback — {from, to}; prompt.ts re-inserts the block into
 *         history verbatim. Position is load-bearing for thinking
 *         verification, so it must precede exactly this block.
 *       anthropic.servedBy — {from, to, kind} display-only notice for the
 *         TUI plugin (toast + sidebar). Never echoed back.
 *   - Sticky-routed follow-up turns carry no block; message_start announcing
 *     a different model than requested is the signal. servedBy (kind
 *     "sticky") attaches to the first content block.
 */
interface StreamContext {
  /** Model ID requested by the caller (without -1m suffix). */
  apiModelId: string
  /** Whether the request carried a `fallbacks` chain. */
  fallbacksEnabled: boolean
  /** First fallback model — used for error wording when the chain refuses. */
  fallbackModel?: string
  /** Metadata waiting to be attached to the next content block. */
  pendingMeta?: Record<string, any>
}

let idCounter = 0
function generateId(): string {
  return `block-${Date.now()}-${idCounter++}`
}

/**
 * Build a clear error for a Fable 5 safety refusal observed mid-stream.
 * Mirrors model.ts:refusalError — kept local to avoid a circular import
 * (model.ts imports this module).
 */
function buildRefusalError(stopDetails: any, fallbackModel?: string): Error {
  const category = stopDetails?.category ?? null
  const explanation = stopDetails?.explanation ?? null
  const categoryNote = category ? ` (category: ${category})` : ""
  const detail = explanation
    ? explanation
    : "Claude Fable 5's safety classifiers declined this request."
  const hint = fallbackModel
    ? `The configured fallback model (${fallbackModel}) also refused.`
    : `Retry with a fallback model such as anthropic-sdk/claude-opus-4-8.`
  return new Error(`Claude Fable 5 refused this request${categoryNote}. ${detail} ${hint}`)
}

function mapFinishReason(stopReason: string | null | undefined): LanguageModelV3FinishReason {
  const unified = (() => {
    switch (stopReason) {
      case "end_turn":
      case "stop_sequence":
        return "stop" as const
      case "max_tokens":
        return "length" as const
      case "tool_use":
        return "tool-calls" as const
      default:
        return "other" as const
    }
  })()
  return { unified, raw: stopReason ?? undefined }
}

export function convertStream(
  anthropicStream: AsyncIterable<MessageStreamEvent>,
  modelId: string,
  context?: Partial<StreamContext>,
): ReadableStream<LanguageModelV3StreamPart> {
  const blockStates = new Map<number, ContentBlockState>()
  const ctx: StreamContext = {
    apiModelId: context?.apiModelId ?? modelId,
    fallbacksEnabled: context?.fallbacksEnabled ?? false,
    fallbackModel: context?.fallbackModel,
  }
  let inputTokens: number | undefined
  let outputTokens: number | undefined
  let cachedInputTokens: number | undefined
  let cacheCreationTokens: number | undefined

  return new ReadableStream<LanguageModelV3StreamPart>({
    async start(controller) {
      try {
        for await (const event of anthropicStream) {
          const parts = processEvent(event, blockStates, modelId, ctx)
          if (event.type === "message_start" && event.message.usage) {
            const u = event.message.usage as any
            inputTokens = u.input_tokens
            cachedInputTokens = u.cache_read_input_tokens ?? 0
            cacheCreationTokens = u.cache_creation_input_tokens ?? 0
          }
          if (event.type === "message_delta") {
            const delta = event as any
            outputTokens = delta.usage?.output_tokens
            // Fable 5 safety refusal arrives mid-stream as stop_reason
            // "refusal". With a fallbacks chain this only happens when every
            // hop refused. Surface it as a stream error so the caller gets a
            // clear message instead of a silently truncated/empty response.
            if (delta.delta?.stop_reason === "refusal") {
              controller.enqueue({
                type: "error",
                error: buildRefusalError(
                  delta.delta?.stop_details,
                  ctx.fallbacksEnabled ? ctx.fallbackModel : undefined,
                ),
              })
            }
            // pause_turn only reaches here when auto-continuation (see
            // pause-turn.ts) ran out of attempts. Surface it instead of
            // ending as a silent empty response.
            if (delta.delta?.stop_reason === "pause_turn") {
              controller.enqueue({
                type: "error",
                error: new Error(
                  `Anthropic kept pausing this turn (stop_reason "pause_turn") ` +
                    `after the provider's auto-continuation attempts. Retry the request.`,
                ),
              })
            }
            const finishReason = mapFinishReason(delta.delta?.stop_reason)
            controller.enqueue({
              type: "finish",
              finishReason,
              usage: {
                inputTokens: {
                  total: (inputTokens ?? 0) + (cachedInputTokens ?? 0) + (cacheCreationTokens ?? 0),
                  noCache: inputTokens ?? 0,
                  cacheRead: cachedInputTokens ?? 0,
                  cacheWrite: cacheCreationTokens ?? 0,
                },
                outputTokens: {
                  total: outputTokens ?? 0,
                  text: undefined,
                  reasoning: undefined,
                },
              },
              providerMetadata: {
                anthropic: {
                  cacheCreationInputTokens: cacheCreationTokens ?? 0,
                },
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
  ctx: StreamContext,
): LanguageModelV3StreamPart[] {
  const parts: LanguageModelV3StreamPart[] = []

  switch (event.type) {
    case "message_start": {
      // Sticky-routed fallback: the server routed this turn directly to the
      // fallback model (no fallback block follows). Surface a display-only
      // servedBy notice on the first content block.
      const servedModel = event.message.model as string | undefined
      if (ctx.fallbacksEnabled && servedModel && servedModel !== ctx.apiModelId) {
        ctx.pendingMeta = {
          servedBy: { from: ctx.apiModelId, to: servedModel, kind: "sticky" },
        }
      }
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

      // Take any pending fallback metadata — it attaches to the first
      // content block following the fallback boundary (or the first block
      // at all for sticky turns).
      const takeMeta = () => {
        const meta = ctx.pendingMeta
        ctx.pendingMeta = undefined
        return meta
      }

      if (block.type === "fallback") {
        // Boundary between the declining model's output and the fallback
        // model's. No part is emitted; the block rides the next block's
        // metadata so prompt.ts can re-insert it at the exact position
        // (load-bearing for thinking verification chains).
        ctx.pendingMeta = {
          fallback: { from: block.from, to: block.to },
          servedBy: {
            from: block.from?.model ?? ctx.apiModelId,
            to: block.to?.model ?? "unknown",
            kind: "fallback",
          },
        }
      } else if (block.type === "text") {
        const id = generateId()
        const meta = takeMeta()
        blockStates.set(index, { type: "text", id, fallbackMeta: meta })
        // Attach at text-start: OpenCode persists text part metadata from
        // the start/delta events only (not text-end).
        parts.push({
          type: "text-start",
          id,
          ...(meta ? { providerMetadata: { anthropic: meta } } : {}),
        })
      } else if (block.type === "thinking") {
        const id = generateId()
        const meta = takeMeta()
        blockStates.set(index, { type: "thinking", id, fallbackMeta: meta })
        parts.push({
          type: "reasoning-start",
          id,
          ...(meta ? { providerMetadata: { anthropic: meta } } : {}),
        })
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
          fallbackMeta: takeMeta(),
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
      } else if (delta.type === "signature_delta" && state.type === "thinking") {
        // Accumulate signature for the thinking block
        state.signature = (state.signature ?? "") + delta.signature
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
        // OpenCode's processor overwrites reasoning part metadata with the
        // reasoning-end providerMetadata, so signature and fallback metadata
        // must be emitted together here.
        const meta = {
          ...(state.signature ? { signature: state.signature } : {}),
          ...state.fallbackMeta,
        }
        parts.push({
          type: "reasoning-end",
          id: state.id,
          ...(Object.keys(meta).length > 0 ? { providerMetadata: { anthropic: meta } } : {}),
        })
      } else if (state.type === "tool_use") {
        parts.push({ type: "tool-input-end", id: state.id })
        // Emit the complete tool call
        parts.push({
          type: "tool-call",
          toolCallId: state.toolUseId!,
          toolName: state.toolName!,
          input: state.argsText || "{}",
          ...(state.fallbackMeta ? { providerMetadata: { anthropic: state.fallbackMeta } } : {}),
        })
      }

      blockStates.delete(index)
      break
    }

    // message_delta and message_stop are handled in the main loop
  }

  return parts
}
