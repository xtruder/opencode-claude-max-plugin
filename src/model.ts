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
import { toOpencodeToolName } from "./tool-names.js"
import { randomBytes, createHash } from "node:crypto"
import { APIError, RateLimitError } from "@anthropic-ai/sdk"

type DoGenerateResult = Awaited<ReturnType<LanguageModelV2["doGenerate"]>>
type DoStreamResult = Awaited<ReturnType<LanguageModelV2["doStream"]>>

/**
 * Handle Anthropic API errors with clear messages.
 *
 * Subscription rate limits ("you've hit your limit") can last minutes/hours
 * and are distinct from transient API rate limits. The SDK retries
 * automatically on transient 429s — if we still get one here, it's likely
 * a subscription limit.
 */
function handleApiError(error: unknown): never {
  if (error instanceof RateLimitError || (error instanceof APIError && error.status === 429)) {
    const msg = (error as any).error?.error?.message ?? error.message ?? ""
    const retryAfter = (error.headers as any)?.get?.("retry-after")
      ?? (error.headers as any)?.["retry-after"]

    // Check if this is a subscription/account limit vs transient rate limit
    const isSubscriptionLimit = msg.includes("account")
      || msg.includes("limit")
      || msg.includes("exceeded")
      || (retryAfter && parseInt(retryAfter) > 60)

    if (isSubscriptionLimit) {
      const resetInfo = retryAfter ? ` Resets in ~${Math.ceil(parseInt(retryAfter) / 60)} minutes.` : ""
      throw new Error(
        `Claude subscription rate limit reached.${resetInfo} ` +
        `Use /rate-limit-options in Claude Code to check your options, ` +
        `or wait for your limit to reset.`
      )
    }

    // Transient rate limit — the SDK already retried, still failing
    throw new Error(
      `Anthropic API rate limit exceeded after retries. ` +
      (retryAfter ? `Retry after ${retryAfter}s.` : `Please try again shortly.`)
    )
  }
  throw error
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

/**
 * Anthropic gates subscription model access (Opus, Sonnet, etc.) for OAuth
 * tokens behind this billing header in the system prompt. Without it, OAuth
 * tokens get 400 on non-Haiku models. This is how Claude Code authenticates.
 */
const BILLING_SYSTEM_BLOCK = {
  type: "text" as const,
  text: "x-anthropic-billing-header: cc_version=2.1.81.df2; cc_entrypoint=sdk-cli; cch=00000;",
}

/**
 * Generate a device_id-like hash for the metadata user_id field.
 * Claude Code sends a deterministic device hash; we generate a stable one per process.
 */
const DEVICE_ID = createHash("sha256")
  .update(randomBytes(32))
  .digest("hex")

function buildMetadata(): { user_id: string } {
  return {
    user_id: JSON.stringify({ device_id: DEVICE_ID }),
  }
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

    // For OAuth subscription tokens, match Claude Code's request structure
    if (this.isOAuth) {
      // Prepend billing block to system content
      if (system) {
        const systemBlocks = typeof system === "string"
          ? [BILLING_SYSTEM_BLOCK, { type: "text" as const, text: system }]
          : [BILLING_SYSTEM_BLOCK, ...(Array.isArray(system) ? system : [system])]
        params.system = systemBlocks
      } else {
        params.system = [BILLING_SYSTEM_BLOCK]
      }

      // Claude Code always sends metadata with user_id
      params.metadata = buildMetadata()

      // Claude Code sends temperature: 1 and output_config for models that support it
      // Haiku and older models don't support the effort parameter
      const supportsEffort = !this.modelId.includes("haiku") && !this.modelId.includes("claude-3-")
      if (supportsEffort) {
        if (options.temperature == null) {
          params.temperature = 1
        }
        params.output_config = { effort: "medium" }
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
      // Handle thinking config — map AI SDK format to Anthropic SDK format
      if (anthropicOptions.thinking) {
        const t = anthropicOptions.thinking
        if (t.type === "enabled" && t.budgetTokens) {
          params.thinking = { type: "enabled", budget_tokens: t.budgetTokens }
        } else if (t.type === "adaptive") {
          params.thinking = { type: "enabled", budget_tokens: 10000 }
        } else {
          params.thinking = t
        }
      }
      if (anthropicOptions.metadata) params.metadata = anthropicOptions.metadata
    }

    return { params, warnings }
  }

  async doGenerate(options: LanguageModelV2CallOptions): Promise<DoGenerateResult> {
    const { params, warnings } = this.buildParams(options)

    let response: Anthropic.Message
    try {
      response = await this.client.messages.create({
        ...params,
        stream: false,
      } as Anthropic.MessageCreateParamsNonStreaming,
        { signal: options.abortSignal },
      ) as Anthropic.Message
    } catch (error) {
      handleApiError(error)
    }

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
            toolName: toOpencodeToolName(block.name),
            input: JSON.stringify(block.input),
          })
          break
        default: {
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

    let anthropicStream
    try {
      anthropicStream = await this.client.messages.create({
        ...params,
        stream: true,
      } as Anthropic.MessageCreateParamsStreaming,
        { signal: options.abortSignal },
      )
    } catch (error) {
      handleApiError(error)
    }

    const stream = convertStream(anthropicStream as any, this.modelId)

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
