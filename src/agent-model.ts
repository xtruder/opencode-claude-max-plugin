import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2Content,
  LanguageModelV2FinishReason,
  LanguageModelV2StreamPart,
  LanguageModelV2CallWarning,
  LanguageModelV2Prompt,
  LanguageModelV2Message,
} from "@ai-sdk/provider"
import {
  unstable_v2_createSession,
} from "@anthropic-ai/claude-agent-sdk"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"

type DoStreamResult = Awaited<ReturnType<LanguageModelV2["doStream"]>>
type DoGenerateResult = Awaited<ReturnType<LanguageModelV2["doGenerate"]>>

type Session = ReturnType<typeof unstable_v2_createSession>

function mapFinishReason(reason: string | null | undefined): LanguageModelV2FinishReason {
  switch (reason) {
    case "end_turn": return "stop"
    case "stop_sequence": return "stop"
    case "max_tokens": return "length"
    case "tool_use": return "tool-calls"
    default: return "unknown"
  }
}

/**
 * Extract system prompt text from the AI SDK prompt.
 */
function extractSystem(prompt: LanguageModelV2Prompt): string | undefined {
  const parts: string[] = []
  for (const msg of prompt) {
    if (msg.role === "system") parts.push(msg.content)
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined
}

/**
 * Extract the non-system messages from the prompt.
 */
function extractMessages(prompt: LanguageModelV2Prompt): LanguageModelV2Message[] {
  return prompt.filter((m): m is LanguageModelV2Message => m.role !== "system")
}

/**
 * Convert the last user/tool message from AI SDK format to a plain text
 * string for session.send(). For tool results, format them as structured text.
 */
function formatLastMessage(msg: LanguageModelV2Message): string {
  if (msg.role === "user") {
    return msg.content
      .map((p) => {
        if (p.type === "text") return p.text
        return ""
      })
      .filter(Boolean)
      .join("\n")
  }
  if (msg.role === "tool") {
    // Format tool results as text — the Agent SDK session already
    // has the assistant's tool_use in its history, so it just needs
    // the results fed back
    return msg.content
      .map((p) => {
        const output = p.output
        if (output.type === "text" || output.type === "error-text") return output.value
        if (output.type === "json" || output.type === "error-json") return JSON.stringify(output.value)
        return String(output.value)
      })
      .join("\n")
  }
  // Assistant messages — shouldn't be the last message, but handle gracefully
  return ""
}

/**
 * Convert Agent SDK V2 session messages to AI SDK LanguageModelV2StreamPart.
 *
 * The V2 session yields `assistant` messages with complete BetaMessage objects
 * (not raw SSE stream_events). We convert the content blocks into AI SDK parts.
 *
 * Only processes the FIRST assistant message with a stop_reason — subsequent
 * messages (from dummy MCP tool execution) are skipped.
 */
function convertAgentStream(
  stream: AsyncGenerator<SDKMessage, void>,
  modelId: string,
): ReadableStream<LanguageModelV2StreamPart> {
  let idCounter = 0

  return new ReadableStream<LanguageModelV2StreamPart>({
    async start(controller) {
      try {
        let emittedMetadata = false
        let firstAssistantTurnDone = false

        for await (const msg of stream) {
          // After the first assistant turn completes (result received),
          // skip any further messages (from dummy MCP tool execution)
          if (firstAssistantTurnDone) {
            if (msg.type === "result") break
            continue
          }

          if (msg.type === "assistant") {
            const message = msg.message as any
            const content = message.content ?? []

            // Emit response metadata once
            if (!emittedMetadata && message.id) {
              emittedMetadata = true
              controller.enqueue({
                type: "response-metadata",
                id: message.id,
                modelId: message.model ?? modelId,
                timestamp: new Date(),
              })
            }

            // V2 yields incremental assistant messages — each one has
            // new content blocks. Process them immediately.
            for (const block of content) {
              if (block.type === "text") {
                const id = `block-${idCounter++}`
                controller.enqueue({ type: "text-start", id })
                controller.enqueue({ type: "text-delta", id, delta: block.text })
                controller.enqueue({ type: "text-end", id })
              } else if (block.type === "thinking") {
                const id = `block-${idCounter++}`
                controller.enqueue({ type: "reasoning-start", id })
                controller.enqueue({ type: "reasoning-delta", id, delta: block.thinking })
                controller.enqueue({ type: "reasoning-end", id })
              }
            }
          }

          if (msg.type === "result") {
            // Emit finish with usage from the result message
            const result = msg as any
            controller.enqueue({
              type: "finish",
              finishReason: mapFinishReason(result.stop_reason),
              usage: {
                inputTokens: result.usage?.input_tokens ?? 0,
                outputTokens: result.usage?.output_tokens ?? 0,
                totalTokens: (result.usage?.input_tokens ?? 0) + (result.usage?.output_tokens ?? 0),
              },
            })
            firstAssistantTurnDone = true
            break
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

export class AgentSDKModel implements LanguageModelV2 {
  readonly specificationVersion = "v2" as const
  readonly provider: string
  readonly modelId: string
  readonly supportedUrls: Record<string, RegExp[]> = {}

  private session: Session | null = null
  private processedMessageCount = 0
  private lastSystemPrompt: string | undefined = undefined


  constructor(
    modelId: string,
    private providerName: string,
  ) {
    this.modelId = modelId
    this.provider = providerName
  }

  /**
   * Determine if we need a new session based on the prompt.
   * A new session is needed when:
   * - No session exists
   * - System prompt changed
   * - Message count decreased (new conversation)
   *
   * The session is REUSED across doStream() calls for the same conversation
   * (tool result continuations and multi-turn).
   */
  private needsNewSession(system: string | undefined, messages: LanguageModelV2Message[]): boolean {
    if (!this.session) return true
    if (system !== this.lastSystemPrompt) return true
    if (messages.length < this.processedMessageCount) return true
    return false
  }

  private createSession(
    system: string | undefined,
    tools: LanguageModelV2CallOptions["tools"],
  ): Session {
    const opts: any = {
      model: this.modelId,
      maxTurns: 100,
      includePartialMessages: true,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      persistSession: false,
      // Custom system prompt — NOT Claude Code's default preset
      systemPrompt: system ?? "You are a helpful assistant.",
      // Disable Claude Code's built-in tools — OpenCode provides its own
      tools: [] as string[],
    }

    return unstable_v2_createSession(opts)
  }

  async doStream(options: LanguageModelV2CallOptions): Promise<DoStreamResult> {
    const system = extractSystem(options.prompt)
    const messages = extractMessages(options.prompt)
    const warnings: LanguageModelV2CallWarning[] = []

    if (this.needsNewSession(system, messages)) {
      // Close existing session if any
      if (this.session) {
        try { this.session.close() } catch {}
      }
      this.session = this.createSession(system, options.tools)
      this.lastSystemPrompt = system
      this.processedMessageCount = 0
    }

    // Find the new messages to send
    // On first call: send the first user message
    // On subsequent calls: send tool results (skip assistant messages — session has them)
    let messageToSend: string | undefined

    if (this.processedMessageCount === 0) {
      // First call — find the first user message
      const firstUser = messages.find((m) => m.role === "user")
      if (firstUser) {
        messageToSend = formatLastMessage(firstUser)
        this.processedMessageCount = messages.indexOf(firstUser) + 1
      }
    } else {
      // Continuation — find new tool result messages
      const newMessages = messages.slice(this.processedMessageCount)
      // Find the last tool message (skip assistant messages, session has those)
      const toolMsg = newMessages.find((m) => m.role === "tool")
      if (toolMsg) {
        messageToSend = formatLastMessage(toolMsg)
      } else {
        // Could be a new user message in a multi-turn conversation
        const userMsg = [...newMessages].reverse().find((m) => m.role === "user")
        if (userMsg) {
          messageToSend = formatLastMessage(userMsg)
        }
      }
      this.processedMessageCount = messages.length
    }

    if (!messageToSend) {
      messageToSend = "Continue."
    }

    await this.session!.send(messageToSend)
    const stream = convertAgentStream(this.session!.stream(), this.modelId)

    // Prepend stream-start
    const wrappedStream = new ReadableStream<LanguageModelV2StreamPart>({
      async start(controller) {
        controller.enqueue({ type: "stream-start", warnings })
        const reader = stream.getReader()
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            controller.enqueue(value)
          }
        } finally {
          reader.releaseLock()
          controller.close()
        }
      },
    })

    return {
      stream: wrappedStream,
      request: { body: messageToSend },
    }
  }

  async doGenerate(options: LanguageModelV2CallOptions): Promise<DoGenerateResult> {
    // Use doStream and collect results
    const result = await this.doStream(options)
    const reader = result.stream.getReader()

    const content: LanguageModelV2Content[] = []
    let finishReason: LanguageModelV2FinishReason = "unknown"
    let usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
    let responseId = ""
    let responseModel = this.modelId
    let currentText = ""

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      switch (value.type) {
        case "text-delta":
          currentText += (value as any).delta ?? ""
          break
        case "text-end":
          if (currentText) {
            content.push({ type: "text", text: currentText })
            currentText = ""
          }
          break
        case "tool-call":
          content.push({
            type: "tool-call",
            toolCallId: (value as any).toolCallId,
            toolName: (value as any).toolName,
            input: (value as any).input,
          })
          break
        case "finish":
          finishReason = (value as any).finishReason
          usage = (value as any).usage ?? usage
          break
        case "response-metadata":
          responseId = (value as any).id ?? ""
          responseModel = (value as any).modelId ?? this.modelId
          break
      }
    }

    // Flush any remaining text
    if (currentText) {
      content.push({ type: "text", text: currentText })
    }

    return {
      content,
      finishReason,
      usage,
      response: {
        id: responseId,
        modelId: responseModel,
        timestamp: new Date(),
      },
      warnings: [],
    }
  }

  /**
   * Close the session and clean up resources.
   */
  close() {
    if (this.session) {
      try { this.session.close() } catch {}
      this.session = null
    }
  }
}
