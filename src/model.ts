import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
  SharedV3Warning,
} from "@ai-sdk/provider"
import type Anthropic from "@anthropic-ai/sdk"
import { APIError, RateLimitError } from "@anthropic-ai/sdk"
import { createHash, randomBytes } from "node:crypto"
import { convertPrompt } from "./prompt.ts"
import { convertStream } from "./stream.ts"
import { toOpencodeToolName } from "./tool-names.ts"
import { convertToolChoice, convertTools } from "./tools.ts"

type DoGenerateResult = LanguageModelV3GenerateResult
type DoStreamResult = LanguageModelV3StreamResult

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
    const h = (error as any).headers
    const getHeader = (name: string): string | null => h?.get?.(name) ?? h?.[name] ?? null
    const errorMsg = (error as any).error?.error?.message ?? (error as any).message ?? ""

    // Check for long context billing requirement (needs "extra usage" enabled)
    if (errorMsg.includes("Extra usage is required for long context")) {
      throw new Error(
        `Long context request requires "Extra usage" to be enabled in your Claude subscription. ` +
          `Go to claude.ai/settings and enable Extra usage, or reduce context size.`,
      )
    }

    // Use anthropic-ratelimit-unified-status (same method as Claude Code) to
    // precisely identify subscription exhaustion. "over_limit" = subscription
    // limit, anything else = transient API overload.
    // Fallback: retry-after > 120s means hours-long reset = subscription limit.
    const unifiedStatus = getHeader("anthropic-ratelimit-unified-status") ?? ""
    const retryAfter = parseInt(getHeader("retry-after") ?? "0")
    const isSubscriptionLimit = unifiedStatus === "over_limit" || retryAfter > 120

    if (isSubscriptionLimit) {
      const resetInfo = retryAfter > 0 ? ` Resets in ~${Math.ceil(retryAfter / 60)} minutes.` : ""
      throw new Error(
        `Claude subscription rate limit reached.${resetInfo} ` +
          `Use /rate-limit-options in Claude Code to check your options, ` +
          `or wait for your limit to reset.`,
      )
    }

    // Transient rate limit — the SDK already retried, still failing
    throw new Error(
      `Anthropic API rate limit exceeded after retries. ` +
        (retryAfter > 0 ? `Retry after ${retryAfter}s.` : `Please try again shortly.`),
    )
  }
  throw error
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
const DEVICE_ID = createHash("sha256").update(randomBytes(32)).digest("hex")

function buildMetadata(): { user_id: string } {
  return {
    user_id: JSON.stringify({ device_id: DEVICE_ID }),
  }
}

/**
 * Whether the model supports the context-management beta (Claude 4+ models).
 * Matches Claude Code's modelSupportsContextManagement().
 */
function supportsContextManagement(apiModelId: string): boolean {
  return !apiModelId.includes("claude-3-")
}

export class AnthropicSDKModel implements LanguageModelV3 {
  readonly specificationVersion = "v3" as const
  readonly provider: string
  readonly modelId: string
  readonly supportedUrls: Record<string, RegExp[]> = {}

  /** Model ID sent to the Anthropic API (without our -1m suffix). */
  private readonly apiModelId: string
  /** Whether this is a 1M context variant (affects only compaction threshold, not API calls). */
  private readonly is1MContext: boolean

  constructor(
    modelId: string,
    private client: Anthropic,
    private providerName: string,
    private isOAuth: boolean = false,
  ) {
    this.modelId = modelId
    this.provider = providerName
    // Strip our -1m suffix — it's a virtual variant, not a real model ID
    this.is1MContext = modelId.endsWith("-1m")
    this.apiModelId = this.is1MContext ? modelId.replace(/-1m$/, "") : modelId
  }

  private buildParams(options: LanguageModelV3CallOptions) {
    const { system, messages } = convertPrompt(options.prompt)
    const warnings: SharedV3Warning[] = []

    // Handle unsupported settings
    if (options.presencePenalty != null) {
      warnings.push({ type: "compatibility", feature: "presencePenalty" })
    }
    if (options.frequencyPenalty != null) {
      warnings.push({ type: "compatibility", feature: "frequencyPenalty" })
    }
    if (options.seed != null) {
      warnings.push({ type: "compatibility", feature: "seed" })
    }

    const tools = options.toolChoice?.type === "none" ? undefined : convertTools(options.tools)
    const toolChoice =
      options.toolChoice?.type === "none" ? undefined : convertToolChoice(options.toolChoice)

    // Build base params
    // Claude Code always streams with 64000 max_tokens. For non-streaming
    // (doGenerate), the Anthropic SDK enforces a timeout limit that rejects
    // max_tokens > 4096 when not streaming. We use 64000 as streaming default
    // but allow doGenerate to set a lower value if needed.
    const params: Record<string, any> = {
      model: this.apiModelId,
      max_tokens: options.maxOutputTokens ?? 64000,
      messages,
    }

    // Build system blocks and apply cache_control matching Claude Code's pattern:
    //
    // OAuth (subscription) mode:
    //   system[0]: billing header         (no cache)
    //   system[1]: identity block         (no cache)
    //   system[2]: main prompt            cache_control: { type: "ephemeral", ttl: "1h", scope: "global" }
    //
    // API key mode (matches Claude Code with --api-key):
    //   system[0]: identity block         cache_control: { type: "ephemeral" }
    //   system[1]: main prompt            cache_control: { type: "ephemeral" }
    //
    // Claude Code observed sending plain { type: "ephemeral" } without ttl/scope for API key auth.
    // The ttl/scope fields require the prompt-caching-scope-2026-01-05 beta and OAuth routing.

    if (this.isOAuth) {
      const SYSTEM_CACHE: Record<string, any> = { type: "ephemeral", ttl: "1h", scope: "global" }
      if (system) {
        const contentBlocks =
          typeof system === "string"
            ? [{ type: "text" as const, text: system, cache_control: SYSTEM_CACHE }]
            : Array.isArray(system)
              ? system.map((b: any, i: number) =>
                  b.type === "text"
                    ? {
                        ...b,
                        ...(i === system.length - 1 ? { cache_control: SYSTEM_CACHE } : {}),
                      }
                    : b,
                )
              : [{ ...(system as object), cache_control: SYSTEM_CACHE }]
        params.system = [BILLING_SYSTEM_BLOCK, IDENTITY_SYSTEM_BLOCK, ...contentBlocks]
      } else {
        params.system = [BILLING_SYSTEM_BLOCK, IDENTITY_SYSTEM_BLOCK]
      }

      // Claude Code always sends metadata with user_id
      params.metadata = buildMetadata()

      // Claude Code sends temperature: 1 and output_config for models that support it
      // Haiku and older models don't support the effort parameter
      const supportsEffort =
        !this.apiModelId.includes("haiku") && !this.apiModelId.includes("claude-3-")
      if (supportsEffort) {
        if (options.temperature == null) {
          params.temperature = 1
        }
        // Read effort from providerOptions (set by OpenCode variants or user config).
        // providerOptions is keyed by providerID ("anthropic-sdk") since this plugin
        // isn't in OpenCode's sdkKey map; also check "anthropic" for direct usage.
        const providerOpts = (options.providerOptions?.["anthropic-sdk"] ??
          options.providerOptions?.anthropic) as Record<string, any> | undefined
        const effort = providerOpts?.effort ?? "medium"
        params.output_config = { effort }
      }
    } else if (system) {
      // API key mode — add plain ephemeral cache_control matching Claude Code
      const CACHE: Record<string, any> = { type: "ephemeral" }
      if (typeof system === "string") {
        params.system = [
          { ...IDENTITY_SYSTEM_BLOCK, cache_control: CACHE },
          { type: "text", text: system, cache_control: CACHE },
        ]
      } else if (Array.isArray(system)) {
        const blocks = system.map((b: any, i: number) =>
          b.type === "text" && i === system.length - 1 ? { ...b, cache_control: CACHE } : b,
        )
        params.system = [{ ...IDENTITY_SYSTEM_BLOCK, cache_control: CACHE }, ...blocks]
      } else {
        params.system = [
          { ...IDENTITY_SYSTEM_BLOCK, cache_control: CACHE },
          { ...(system as object), cache_control: CACHE },
        ]
      }
    }

    if (tools && tools.length > 0) params.tools = tools
    if (toolChoice) params.tool_choice = toolChoice

    // Cache conversation history — applies to both OAuth and API key modes.
    //
    // Strategy per Anthropic docs:
    // - Cache the last tool_result block when present — this caches the full
    //   accumulated context (system + messages + thinking + tool results)
    //   and keeps thinking blocks in cache on subsequent tool-only turns.
    // - Otherwise cache the last content block of the penultimate message.
    //
    // Per docs: cache stays valid when new user content is ONLY tool results.
    // Cache invalidates (and thinking blocks are stripped) when regular user
    // text is added — this is expected and unavoidable.
    if (params.messages && params.messages.length > 1) {
      const msgs = params.messages as any[]
      const msgCache = this.isOAuth ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" }

      // Find the last user message that contains tool_result blocks
      let cachedSomething = false
      for (let i = msgs.length - 1; i >= 0; i--) {
        const msg = msgs[i]
        if (msg.role !== "user" || !Array.isArray(msg.content)) continue
        // Find last tool_result in this message
        for (let j = msg.content.length - 1; j >= 0; j--) {
          const block = msg.content[j]
          if (block.type === "tool_result" && !block.cache_control) {
            block.cache_control = msgCache
            cachedSomething = true
            break
          }
        }
        if (cachedSomething) break
      }

      // Fallback: cache the last content block of the penultimate message
      if (!cachedSomething) {
        const msg = msgs[msgs.length - 2]
        if (msg && Array.isArray(msg.content) && msg.content.length > 0) {
          const lastContent = msg.content[msg.content.length - 1]
          if (lastContent && !lastContent.cache_control) {
            lastContent.cache_control = msgCache
          }
        } else if (msg && typeof msg.content === "string") {
          msgs[msgs.length - 2] = {
            ...msg,
            content: [{ type: "text", text: msg.content, cache_control: msgCache }],
          }
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
    const anthropicOptions = (options.providerOptions?.["anthropic-sdk"] ??
      options.providerOptions?.anthropic) as Record<string, any> | undefined
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

    // Context management: preserve thinking blocks in context for better
    // cache performance, matching Claude Code's behavior for non-internal users.
    //
    // When extended thinking is active, the API default (without explicit config)
    // strips thinking to only the last 1 turn. Claude Code sends keep: "all"
    // to preserve all thinking blocks, which maintains prompt cache validity.
    //
    // For OAuth requests where context-management beta is present, we send:
    //   clear_thinking_20251015 with keep: "all"
    // This matches Claude Code's getAPIContextManagement() for non-ant users.
    if (this.isOAuth && supportsContextManagement(this.apiModelId)) {
      const edits: any[] = []
      const hasThinking = params.thinking?.type === "enabled"
      if (hasThinking) {
        edits.push({
          type: "clear_thinking_20251015",
          keep: "all",
        })
      }
      if (edits.length > 0) {
        params.context_management = { edits }
      }
    }

    return { params, warnings }
  }

  /**
   * Build per-request SDK options (headers, signal).
   * The -1m suffix only controls OpenCode's compaction threshold — no extra
   * beta header is needed since Opus 4.6 natively supports 1M tokens.
   */
  private buildRequestOptions(signal?: AbortSignal): Record<string, any> {
    const opts: Record<string, any> = {}
    if (signal) opts.signal = signal
    return opts
  }

  async doGenerate(options: LanguageModelV3CallOptions): Promise<DoGenerateResult> {
    const { params, warnings } = this.buildParams(options)

    // Non-streaming has a 10min SDK timeout enforced when max_tokens > threshold.
    // Cap to 4096 if not explicitly set (doGenerate is only used in tests/simple cases).
    if (!options.maxOutputTokens && params.max_tokens > 4096) {
      params.max_tokens = 4096
    }

    let response: Anthropic.Message
    try {
      response = (await this.client.messages.create(
        {
          ...params,
          stream: false,
        } as Anthropic.MessageCreateParamsNonStreaming,
        this.buildRequestOptions(options.abortSignal),
      )) as Anthropic.Message
    } catch (error) {
      handleApiError(error)
    }

    const content: LanguageModelV3Content[] = []

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

    const cacheReadTokens = (response.usage as any).cache_read_input_tokens ?? 0
    const cacheCreateTokens = (response.usage as any).cache_creation_input_tokens ?? 0

    return {
      content,
      finishReason: mapFinishReason(response.stop_reason),
      usage: {
        inputTokens: {
          total: response.usage.input_tokens + cacheReadTokens + cacheCreateTokens,
          noCache: response.usage.input_tokens,
          cacheRead: cacheReadTokens,
          cacheWrite: cacheCreateTokens,
        },
        outputTokens: {
          total: response.usage.output_tokens,
          text: undefined,
          reasoning: undefined,
        },
      },
      providerMetadata: {
        anthropic: {
          cacheCreationInputTokens: cacheCreateTokens,
        },
      },
      response: {
        id: response.id,
        modelId: response.model,
        timestamp: new Date(),
      },
      warnings,
    }
  }

  async doStream(options: LanguageModelV3CallOptions): Promise<DoStreamResult> {
    const { params, warnings } = this.buildParams(options)

    let anthropicStream
    try {
      anthropicStream = await this.client.messages.create(
        {
          ...params,
          stream: true,
        } as Anthropic.MessageCreateParamsStreaming,
        this.buildRequestOptions(options.abortSignal),
      )
    } catch (error) {
      // Anthropic rejects assistant message prefill on OAuth-routed requests.
      // This happens in OpenCode's agentic loop when it re-sends the previous
      // assistant response. Swallow this specific error silently — the loop
      // will exit via its own error/stop handling.
      if (
        error instanceof APIError &&
        error.status === 400 &&
        error.message?.includes("must end with a user message")
      ) {
        return {
          stream: new ReadableStream<LanguageModelV3StreamPart>({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings })
              controller.enqueue({
                type: "finish",
                finishReason: { unified: "stop", raw: undefined },
                usage: {
                  inputTokens: {
                    total: 0,
                    noCache: undefined,
                    cacheRead: undefined,
                    cacheWrite: undefined,
                  },
                  outputTokens: { total: 0, text: undefined, reasoning: undefined },
                },
              })
              controller.close()
            },
          }),
          request: { body: params },
        }
      }
      handleApiError(error)
    }

    const stream = convertStream(anthropicStream as any, this.modelId)

    const wrappedStream = new ReadableStream<LanguageModelV3StreamPart>({
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
