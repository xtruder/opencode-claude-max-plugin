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
import { toOpencodeToolName, rewriteToolNamesInText } from "./tool-names.js"
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
 * Claude Code identity block — always sent as system[1].
 * Matches what Claude Code sends on every request.
 */
const IDENTITY_SYSTEM_BLOCK = {
  type: "text" as const,
  text: "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
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

    // For OAuth subscription tokens, match Claude Code's request structure:
    // system[0]: billing header (no cache — tiny, fixed)
    // system[1]: Claude agent identity (no cache — tiny, fixed)
    // system[2]: main system prompt — CACHED with global scope + 1h TTL
    //            matches Claude Code's exact cache_control on system[2]
    if (this.isOAuth) {
      const rewrite = (s: string) => rewriteToolNamesInText(s)
      // Cache control for the main system prompt — matches Claude Code exactly
      const SYSTEM_CACHE: Record<string, any> = {
        type: "ephemeral",
        ttl: "1h",
        scope: "global",
      }
      if (system) {
        const contentBlocks = typeof system === "string"
          ? [{ type: "text" as const, text: rewrite(system), cache_control: SYSTEM_CACHE }]
          : (Array.isArray(system)
              ? system.map((b: any, i: number) =>
                  b.type === "text"
                    // Only cache the last system block (the main prompt)
                    ? { ...b, text: rewrite(b.text), ...(i === system.length - 1 ? { cache_control: SYSTEM_CACHE } : {}) }
                    : b
                )
              : [{ ...(system as object), cache_control: SYSTEM_CACHE }])
        params.system = [BILLING_SYSTEM_BLOCK, IDENTITY_SYSTEM_BLOCK, ...contentBlocks]
      } else {
        params.system = [BILLING_SYSTEM_BLOCK, IDENTITY_SYSTEM_BLOCK]
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

    // Cache conversation history for OAuth — Claude Code caches the penultimate
    // user message (everything except the latest turn) with ttl: "1h"
    if (this.isOAuth && params.messages && params.messages.length > 1) {
      const msgs = params.messages as any[]
      // Cache the last message before the final user turn
      // This makes Anthropic cache the accumulated conversation context
      const cacheIdx = msgs.length >= 2 ? msgs.length - 2 : 0
      const msg = msgs[cacheIdx]
      if (msg && Array.isArray(msg.content) && msg.content.length > 0) {
        const lastContent = msg.content[msg.content.length - 1]
        if (lastContent && !lastContent.cache_control) {
          lastContent.cache_control = { type: "ephemeral", ttl: "1h" }
        }
      } else if (msg && typeof msg.content === "string") {
        msgs[cacheIdx] = {
          ...msg,
          content: [{ type: "text", text: msg.content, cache_control: { type: "ephemeral", ttl: "1h" } }],
        }
      }
    }
    if (options.temperature != null) params.temperature = options.temperature
    if (options.topP != null) params.top_p = options.topP
    if (options.topK != null) params.top_k = options.topK
    if (options.stopSequences && options.stopSequences.length > 0) {
      params.stop_sequences = options.stopSequences
    }

    // Merge provider options (e.g. thinking config, cache control)
    // OpenCode sends providerOptions keyed by providerID ("anthropic-sdk"),
    // but also check "anthropic" for direct AI SDK usage
    const anthropicOptions = (
      options.providerOptions?.["anthropic-sdk"]
      ?? options.providerOptions?.anthropic
    ) as Record<string, any> | undefined
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
