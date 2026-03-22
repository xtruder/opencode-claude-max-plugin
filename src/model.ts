import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2Content,
  LanguageModelV2FinishReason,
  LanguageModelV2StreamPart,
  LanguageModelV2CallWarning,
} from "@ai-sdk/provider"
import type Anthropic from "@anthropic-ai/sdk"
import { convertPrompt } from "./prompt.js"
import { convertTools, convertToolChoice } from "./tools.js"
import { convertStream } from "./stream.js"

type DoGenerateResult = Awaited<ReturnType<LanguageModelV2["doGenerate"]>>
type DoStreamResult = Awaited<ReturnType<LanguageModelV2["doStream"]>>

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

/**
 * Anthropic gates subscription model access (Opus, Sonnet, etc.) for OAuth
 * tokens behind this billing header in the system prompt. Without it, OAuth
 * tokens get 400 on non-Haiku models. This is how Claude Code authenticates.
 */
const BILLING_SYSTEM_BLOCK = {
  type: "text" as const,
  text: "x-anthropic-billing-header: cc_version=2.1.81.df2; cc_entrypoint=sdk-cli; cch=00000;",
}

export class AnthropicSDKModel implements LanguageModelV2 {
  readonly specificationVersion = "v2" as const
  readonly provider: string
  readonly modelId: string
  readonly supportedUrls: Record<string, RegExp[]> = {}

  constructor(
    modelId: string,
    private client: Anthropic,
    private providerName: string,
    private isOAuth: boolean = false,
  ) {
    this.modelId = modelId
    this.provider = providerName
  }

  private buildParams(options: LanguageModelV2CallOptions) {
    const { system, messages } = convertPrompt(options.prompt)
    const warnings: LanguageModelV2CallWarning[] = []

    // Handle unsupported settings
    if (options.presencePenalty != null) {
      warnings.push({ type: "unsupported-setting", setting: "presencePenalty" as any })
    }
    if (options.frequencyPenalty != null) {
      warnings.push({ type: "unsupported-setting", setting: "frequencyPenalty" as any })
    }
    if (options.seed != null) {
      warnings.push({ type: "unsupported-setting", setting: "seed" as any })
    }

    const tools = options.toolChoice?.type === "none"
      ? undefined
      : convertTools(options.tools)
    const toolChoice = options.toolChoice?.type === "none"
      ? undefined
      : convertToolChoice(options.toolChoice)

    // Build base params
    const params: Record<string, any> = {
      model: this.modelId,
      max_tokens: options.maxOutputTokens ?? 4096,
      messages,
    }

    // For OAuth subscription tokens, inject the billing system block
    // that Anthropic requires for access to non-Haiku models
    if (this.isOAuth) {
      if (system) {
        // Prepend billing block to existing system content
        const systemBlocks = typeof system === "string"
          ? [BILLING_SYSTEM_BLOCK, { type: "text" as const, text: system }]
          : [BILLING_SYSTEM_BLOCK, ...(Array.isArray(system) ? system : [system])]
        params.system = systemBlocks
      } else {
        params.system = [BILLING_SYSTEM_BLOCK]
      }
    } else if (system) {
      params.system = system
    }
    if (tools && tools.length > 0) params.tools = tools
    if (toolChoice) params.tool_choice = toolChoice
    if (options.temperature != null) params.temperature = options.temperature
    if (options.topP != null) params.top_p = options.topP
    if (options.topK != null) params.top_k = options.topK
    if (options.stopSequences && options.stopSequences.length > 0) {
      params.stop_sequences = options.stopSequences
    }

    // Merge provider options (e.g. thinking config, cache control)
    const anthropicOptions = options.providerOptions?.anthropic as Record<string, any> | undefined
    if (anthropicOptions) {
      // Pass through known Anthropic-specific options
      if (anthropicOptions.thinking) params.thinking = anthropicOptions.thinking
      if (anthropicOptions.metadata) params.metadata = anthropicOptions.metadata
    }

    return { params, warnings }
  }

  async doGenerate(options: LanguageModelV2CallOptions): Promise<DoGenerateResult> {
    const { params, warnings } = this.buildParams(options)

    const response = await this.client.messages.create({
      ...params,
      stream: false,
    } as Anthropic.MessageCreateParamsNonStreaming,
      { signal: options.abortSignal },
    ) as Anthropic.Message

    const content: LanguageModelV2Content[] = []

    for (const block of response.content) {
      switch (block.type) {
        case "text":
          content.push({ type: "text", text: block.text })
          break
        case "tool_use":
          content.push({
            type: "tool-call",
            toolCallId: block.id,
            toolName: block.name,
            input: JSON.stringify(block.input),
          })
          break
        default: {
          // Handle thinking blocks
          const anyBlock = block as any
          if (anyBlock.type === "thinking" && anyBlock.thinking) {
            content.push({
              type: "reasoning",
              text: anyBlock.thinking,
              providerMetadata: anyBlock.signature
                ? { anthropic: { signature: anyBlock.signature } }
                : undefined,
            })
          }
          break
        }
      }
    }

    return {
      content,
      finishReason: mapFinishReason(response.stop_reason),
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        totalTokens: response.usage.input_tokens + response.usage.output_tokens,
        cachedInputTokens: (response.usage as any).cache_read_input_tokens,
      },
      response: {
        id: response.id,
        modelId: response.model,
        timestamp: new Date(),
      },
      warnings,
    }
  }

  async doStream(options: LanguageModelV2CallOptions): Promise<DoStreamResult> {
    const { params, warnings } = this.buildParams(options)

    const anthropicStream = await this.client.messages.create({
      ...params,
      stream: true,
    } as Anthropic.MessageCreateParamsStreaming,
      { signal: options.abortSignal },
    )

    const stream = convertStream(anthropicStream as any, this.modelId)

    // Prepend stream-start with warnings
    const wrappedStream = new ReadableStream<LanguageModelV2StreamPart>({
      async start(controller) {
        controller.enqueue({
          type: "stream-start",
          warnings,
        })

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
      request: { body: params },
    }
  }
}
