/**
 * Auto-continuation for `stop_reason: "pause_turn"`.
 *
 * The Messages API pauses long-running turns and expects the client to
 * resend the conversation — with the paused turn's partial assistant
 * content appended — to let the model continue the same turn. Observed in
 * the wild with Claude Fable 5 when the safety-refusal fallback hop runs
 * long: the server returns `pause_turn` after ~1 output token and no
 * content. Without auto-continuation that surfaces as a silent empty
 * response (finish reason "unknown").
 *
 * The wrapper is transport-agnostic: it consumes streaming events,
 * reconstructs the raw wire content blocks, and re-issues the request via
 * the provided `request` callback whenever a segment ends with
 * `pause_turn`. The paused segment's `message_delta` and `message_stop`
 * events are suppressed so downstream conversion sees one continuous turn.
 */
import type { MessageStreamEvent } from "@anthropic-ai/sdk/resources/messages"

export const MAX_PAUSE_TURN_CONTINUATIONS = 5

type RawBlock = Record<string, any>

export function isPauseTurn(stopReason: string | null | undefined): boolean {
  return stopReason === "pause_turn"
}

/**
 * Reconstructs raw wire content blocks from streaming events so a paused
 * turn's partial content can be echoed back verbatim in the continuation
 * request (including thinking signatures and fallback blocks).
 */
class BlockAccumulator {
  readonly blocks: RawBlock[] = []
  private readonly open = new Map<number, { block: RawBlock; argsText?: string }>()

  push(event: MessageStreamEvent) {
    switch (event.type) {
      case "content_block_start": {
        this.open.set(event.index, {
          block: JSON.parse(JSON.stringify(event.content_block)),
        })
        break
      }
      case "content_block_delta": {
        const entry = this.open.get(event.index)
        if (!entry) break
        const delta = event.delta as any
        if (delta.type === "text_delta") {
          entry.block.text = (entry.block.text ?? "") + delta.text
        } else if (delta.type === "thinking_delta") {
          entry.block.thinking = (entry.block.thinking ?? "") + delta.thinking
        } else if (delta.type === "signature_delta") {
          entry.block.signature = (entry.block.signature ?? "") + delta.signature
        } else if (delta.type === "input_json_delta") {
          entry.argsText = (entry.argsText ?? "") + delta.partial_json
        }
        break
      }
      case "content_block_stop": {
        const entry = this.open.get(event.index)
        if (!entry) break
        this.open.delete(event.index)
        if (entry.argsText !== undefined) {
          try {
            entry.block.input = JSON.parse(entry.argsText || "{}")
          } catch {
            entry.block.input = {}
          }
        }
        this.blocks.push(entry.block)
        break
      }
    }
  }
}

/**
 * Continuation request params: the original conversation with the paused
 * turn's partial content appended as an assistant message. With no partial
 * content (the observed Fable 5 case) the request is resent unchanged —
 * an empty assistant content array would be rejected by the API.
 */
export function continuationParams(
  params: Record<string, any>,
  blocks: RawBlock[],
): Record<string, any> {
  if (blocks.length === 0) return params
  return {
    ...params,
    messages: [...(params.messages ?? []), { role: "assistant", content: blocks }],
  }
}

/**
 * Wrap a stream of Anthropic events with pause_turn auto-continuation.
 * After `maxContinuations` pauses the pause_turn `message_delta` is passed
 * through so stream conversion can surface a clear error.
 */
export async function* withPauseTurnContinuation(
  initial: AsyncIterable<MessageStreamEvent>,
  params: Record<string, any>,
  request: (params: Record<string, any>) => Promise<AsyncIterable<MessageStreamEvent>>,
  maxContinuations = MAX_PAUSE_TURN_CONTINUATIONS,
): AsyncGenerator<MessageStreamEvent> {
  const acc = new BlockAccumulator()
  let stream = initial
  let continuations = 0

  outer: while (true) {
    for await (const event of stream) {
      if (
        event.type === "message_delta" &&
        isPauseTurn((event as any).delta?.stop_reason) &&
        continuations < maxContinuations
      ) {
        continuations++
        // Abandoning the for-await closes the paused segment's iterator;
        // its trailing message_stop is suppressed along with this delta.
        stream = await request(continuationParams(params, acc.blocks))
        continue outer
      }
      acc.push(event)
      yield event
    }
    return
  }
}
