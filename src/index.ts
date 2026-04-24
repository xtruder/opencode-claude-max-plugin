import type { LanguageModelV3 } from "@ai-sdk/provider"
import type { Plugin } from "@opencode-ai/plugin"
import Anthropic from "@anthropic-ai/sdk"
import { computeCch, hasCchPlaceholder, replaceCchPlaceholder } from "./cch.ts"
import CLAUDE_MAIN_SYSTEM_PROMPT from "./claudecode-system.txt" with { type: "text" }
import { getCachedCredentials } from "./credentials.ts"
import { AnthropicSDKModel } from "./model.ts"
import { cachedUsage, persistCachedUsage } from "./usage.ts"

export const CLAUDE_CODE_SYSTEM_PROMPT = CLAUDE_MAIN_SYSTEM_PROMPT

/**
 * Claude Code CLI version to impersonate.
 * Used in user-agent, billing header, and x-stainless-package-version.
 */
const CLAUDE_CODE_VERSION = "2.1.81"

/**
 * Beta flags that Claude Code sends on every OAuth request.
 * Order and exact values must match what Claude Code sends.
 */
const OAUTH_BETAS = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
  "effort-2025-11-24",
]

/**
 * Beta flags for regular API key auth (no OAuth).
 */
const API_KEY_BETAS = ["interleaved-thinking-2025-05-14", "fine-grained-tool-streaming-2025-05-14"]

const PACKAGE_NAME = "@xtruder/opencode-claude-max-plugin"
const PROVIDER_ID = "anthropic-sdk"

/**
 * Per-token pricing in USD per million tokens.
 * Used when authenticating with an API key. OAuth/subscription users
 * pay a flat monthly fee — their cost fields are zeroed out at
 * registration time.
 */
const API_KEY_COSTS = {
  haiku: { input: 1.0, output: 5.0, cache_read: 0.1, cache_write: 1.25 },
  sonnet: { input: 3.0, output: 15.0, cache_read: 0.3, cache_write: 3.75 },
  opus: { input: 5.0, output: 25.0, cache_read: 0.5, cache_write: 6.25 },
} as const

const ZERO_COST = { input: 0, output: 0, cache_read: 0, cache_write: 0 }

/**
 * Base model definitions. Context and output limits match Anthropic's
 * official specs (context-windows doc + models overview).
 *
 * - Haiku 4.5:       200K context, 64K output
 * - Sonnet 4.6:      200K context, 64K output
 * - Opus 4.6:        200K context, 128K output  (conservative, matches Claude Code default)
 * - Opus 4.6 (1M):  1M context,  128K output  (empirically confirmed: hard 1M token limit)
 *
 * The 200K default context matches Claude Code's MODEL_CONTEXT_WINDOW_DEFAULT.
 * Opus 4.6 natively accepts up to 1M tokens on Max subscription without any
 * special beta header — confirmed empirically (fails at exactly 1,000,000 tokens).
 *
 * OAuth/subscription users pay $0 per-token (flat monthly fee).
 * API key users pay real Anthropic rates.
 */
function buildPluginModels(isOAuth: boolean) {
  const cost = (tier: keyof typeof API_KEY_COSTS) => (isOAuth ? ZERO_COST : API_KEY_COSTS[tier])

  const opusVariants = {
    variants: {
      low: { effort: "low" },
      medium: { effort: "medium" },
      high: { effort: "high" },
      max: { effort: "max" },
    },
  }

  const opus47Variants = {
    variants: {
      low: { effort: "low" },
      medium: { effort: "medium" },
      high: { effort: "high" },
      xhigh: { effort: "xhigh" },
      max: { effort: "max" },
    },
  }

  return {
    "claude-haiku-4-5": {
      name: "Claude Haiku 4.5",
      reasoning: false,
      tool_call: true,
      attachment: true,
      temperature: true,
      limit: { context: 200_000, output: 64_000 },
      cost: cost("haiku"),
      modalities: {
        input: ["text", "image"] as Array<"text" | "image">,
        output: ["text"] as Array<"text">,
      },
    },
    "claude-sonnet-4-6": {
      name: "Claude Sonnet 4.6",
      reasoning: true,
      tool_call: true,
      attachment: true,
      temperature: true,
      limit: { context: 200_000, output: 64_000 },
      cost: cost("sonnet"),
      modalities: {
        input: ["text", "image", "pdf"] as Array<"text" | "image" | "pdf">,
        output: ["text"] as Array<"text">,
      },
      options: { effort: "medium" },
      variants: {
        low: { effort: "low" },
        medium: { effort: "medium" },
        high: { effort: "high" },
      },
    },
    "claude-opus-4-6": {
      name: "Claude Opus 4.6",
      reasoning: true,
      tool_call: true,
      attachment: true,
      temperature: true,
      limit: { context: 200_000, output: 128_000 },
      cost: cost("opus"),
      modalities: {
        input: ["text", "image", "pdf"] as Array<"text" | "image" | "pdf">,
        output: ["text"] as Array<"text">,
      },
      options: { effort: "medium" },
      ...opusVariants,
    },
    /**
     * Opus 4.6 with full 1M context window.
     *
     * Empirically confirmed: Opus 4.6 accepts up to exactly 1,000,000 input tokens
     * on Max subscription with no special beta header. The model ID sent to the API
     * is identical ("claude-opus-4-6") — only the OpenCode context limit differs,
     * which controls when compaction triggers.
     */
    "claude-opus-4-6-1m": {
      name: "Claude Opus 4.6 (1M)",
      reasoning: true,
      tool_call: true,
      attachment: true,
      temperature: true,
      limit: { context: 1_000_000, output: 128_000 },
      cost: cost("opus"),
      modalities: {
        input: ["text", "image", "pdf"] as Array<"text" | "image" | "pdf">,
        output: ["text"] as Array<"text">,
      },
      options: { effort: "medium" },
      ...opusVariants,
    },
    /**
     * Opus 4.7 — most capable generally available model.
     *
     * Step-change improvement in agentic coding over Opus 4.6.
     * Natively supports 1M context window (new tokenizer ~555k words).
     * Supports adaptive thinking (effort) but NOT extended thinking.
     */
    "claude-opus-4-7": {
      name: "Claude Opus 4.7",
      reasoning: true,
      tool_call: true,
      attachment: true,
      temperature: true,
      limit: { context: 1_000_000, output: 128_000 },
      cost: cost("opus"),
      modalities: {
        input: ["text", "image", "pdf"] as Array<"text" | "image" | "pdf">,
        output: ["text"] as Array<"text">,
      },
      options: { effort: "medium" },
      ...opus47Variants,
    },
  }
}

export interface AnthropicSDKProviderOptions {
  /**
   * Anthropic API key. Defaults to ANTHROPIC_API_KEY env var.
   */
  apiKey?: string

  /**
   * Custom base URL for the Anthropic API.
   */
  baseURL?: string

  /**
   * Additional default headers to send with requests.
   */
  headers?: Record<string, string>

  /**
   * Custom fetch implementation.
   */
  fetch?: typeof globalThis.fetch

  /**
   * Provider name for logging. Set automatically by OpenCode.
   */
  name?: string

  /**
   * Path to Claude Code credentials file.
   * Defaults to ~/.claude/.credentials.json.
   */
  credentialsPath?: string

  /**
   * Any additional options (passed through by OpenCode).
   */
  [key: string]: unknown
}

export interface AnthropicSDKProvider {
  /**
   * Get a language model by model ID.
   */
  languageModel(modelId: string): LanguageModelV3
}

function resolveAuth(options: AnthropicSDKProviderOptions): {
  apiKey?: string | null
  authToken?: string | null
  isOAuth: boolean
} {
  // 1. Explicit API key
  if (options.apiKey) {
    return { apiKey: options.apiKey as string, isOAuth: false }
  }

  // 2. Environment variable
  if (process.env.ANTHROPIC_API_KEY) {
    return { apiKey: process.env.ANTHROPIC_API_KEY, isOAuth: false }
  }

  // 3. Claude Code credentials file (with automatic CLI refresh)
  const credentialsPath =
    typeof options.credentialsPath === "string" ? options.credentialsPath : undefined
  const creds = getCachedCredentials(credentialsPath)
  if (creds) {
    return { apiKey: null, authToken: creds.accessToken, isOAuth: true }
  }

  return { isOAuth: false }
}

/**
 * Create an Anthropic SDK provider for use with OpenCode / Vercel AI SDK.
 *
 * When using OAuth credentials from Claude Code, requests are made to
 * look identical to Claude Code CLI requests — same headers, user-agent,
 * beta flags, billing system block, and body structure.
 *
 * OpenCode discovers this function by looking for an export whose name
 * starts with "create" when loading the npm package as a provider.
 */
export function createAnthropicSDK(
  options: AnthropicSDKProviderOptions = {},
): AnthropicSDKProvider {
  const { baseURL, headers, fetch: customFetch, name = "anthropic-sdk" } = options
  const credentialsPath =
    typeof options.credentialsPath === "string" ? options.credentialsPath : undefined

  const auth = resolveAuth(options)

  // Match Claude Code's exact header set for OAuth
  const defaultHeaders: Record<string, string> = {
    ...headers,
    "anthropic-beta": (auth.isOAuth ? OAUTH_BETAS : API_KEY_BETAS).join(","),
  }

  if (auth.isOAuth) {
    // Match Claude Code's exact user-agent and headers
    defaultHeaders["user-agent"] = `claude-cli/${CLAUDE_CODE_VERSION} (external, sdk-cli)`
    defaultHeaders["x-app"] = "cli"
    defaultHeaders["anthropic-dangerous-direct-browser-access"] = "true"
    // Override x-stainless version to match Claude Code's bundled SDK
    defaultHeaders["x-stainless-package-version"] = "0.74.0"
  }

  const baseFetch = customFetch ?? globalThis.fetch
  const wrappedFetch = async (url: string | URL | Request, init?: RequestInit) => {
    // For OAuth requests, re-read credentials on every call so we pick up
    // tokens refreshed by the CLI (matches opencode-claude-auth behavior).
    if (auth.isOAuth && init) {
      const freshCreds = getCachedCredentials(credentialsPath)
      if (freshCreds) {
        const reqHeaders = new Headers(init.headers)
        reqHeaders.set("authorization", `Bearer ${freshCreds.accessToken}`)
        init = { ...init, headers: reqHeaders }
      }
    }

    // CCH request signing: compute xxHash64 body integrity hash and replace
    // the cch=00000 placeholder before sending. Only applies to OAuth requests
    // hitting /v1/messages that contain the billing header placeholder.
    if (
      auth.isOAuth &&
      init?.body &&
      typeof init.body === "string" &&
      hasCchPlaceholder(init.body)
    ) {
      try {
        const cch = await computeCch(init.body)
        init = { ...init, body: replaceCchPlaceholder(init.body, cch) }
      } catch {
        // Never let CCH signing crash the fetch — send with placeholder if it fails
      }
    }

    // Claude Code only opts into long-context routing dynamically for very
    // large requests. Sending this beta unconditionally causes subscription
    // errors on normal requests for tiers/models that do not support it.
    if (auth.isOAuth && init?.body && typeof init.body === "string") {
      const reqHeaders = new Headers(init.headers)
      const betas = (reqHeaders.get("anthropic-beta") ?? "")
        .split(",")
        .map((beta) => beta.trim())
        .filter(Boolean)

      if (init.body.length > 600_000) {
        if (!betas.includes("context-1m-2025-08-07")) betas.push("context-1m-2025-08-07")
      } else {
        const filtered = betas.filter((beta) => beta !== "context-1m-2025-08-07")
        if (filtered.length !== betas.length) betas.splice(0, betas.length, ...filtered)
      }

      reqHeaders.set("anthropic-beta", betas.join(","))
      init = { ...init, headers: reqHeaders }
    }

    const resp = await baseFetch(url, init)

    // Cache ratelimit usage headers from every response
    const h5 = resp.headers.get("anthropic-ratelimit-unified-5h-utilization")
    if (h5 != null) {
      cachedUsage.fiveHourUtil = parseFloat(h5)
      cachedUsage.sevenDayUtil = parseFloat(
        resp.headers.get("anthropic-ratelimit-unified-7d-utilization") ?? "0",
      )
      cachedUsage.fiveHourReset = parseInt(
        resp.headers.get("anthropic-ratelimit-unified-5h-reset") ?? "0",
      )
      cachedUsage.sevenDayReset = parseInt(
        resp.headers.get("anthropic-ratelimit-unified-7d-reset") ?? "0",
      )
      cachedUsage.overageStatus =
        resp.headers.get("anthropic-ratelimit-unified-overage-status") ?? undefined
      persistCachedUsage()
    }

    if (resp.status === 429) {
      const unifiedStatus = resp.headers.get("anthropic-ratelimit-unified-status") ?? ""
      const retryAfter = parseInt(resp.headers.get("retry-after") ?? "0")

      // Check for long context billing error — don't retry, it won't resolve
      const bodyText = await resp.clone().text()
      const isLongContextLimit = bodyText.includes("Extra usage is required for long context")

      const isSubscriptionLimit =
        isLongContextLimit || unifiedStatus === "over_limit" || retryAfter > 120

      if (isSubscriptionLimit) {
        const retryHeaders = new Headers(resp.headers)
        retryHeaders.set("x-should-retry", "false")
        return new Response(bodyText, {
          status: resp.status,
          statusText: resp.statusText,
          headers: retryHeaders,
        })
      }
    }
    return resp
  }

  const client = new Anthropic({
    apiKey: auth.apiKey ?? null,
    authToken: auth.authToken ?? null,
    baseURL,
    defaultHeaders,
    fetch: wrappedFetch as any,
  })

  return {
    languageModel(modelId: string): LanguageModelV3 {
      return new AnthropicSDKModel(modelId, client, name as string, auth.isOAuth)
    },
  }
}

/**
 * OpenCode plugin that self-registers the anthropic-sdk provider and its
 * supported models into the running config on startup.
 *
 * Add this package to the `plugin` array in your opencode.json:
 *
 *   { "plugin": ["@xtruder/opencode-claude-max-plugin"] }
 *
 * The plugin uses the `config` hook which is called after config is loaded
 * but before providers are initialized. We mutate the Config object in-place
 * to inject the provider definition and model list.
 *
 * OpenCode's plugin loader iterates all module exports and calls each one
 * as a Plugin function. `createAnthropicSDK` is also called — it returns
 * { languageModel } which is harmlessly pushed to the hooks list with all
 * hook slots undefined (no-ops).
 */
export const anthropicSDKPlugin: Plugin = async () => {
  // Determine auth mode once at plugin init to select the right pricing.
  // OAuth/subscription users pay $0 per-token (flat monthly fee).
  const isOAuth = resolveAuth({}).isOAuth

  return {
    config: async (cfg) => {
      // Inject the anthropic-sdk provider with its model list.
      // The config object is passed by reference — mutating it in-place
      // is the only way to register models during plugin init (before
      // the server is ready for HTTP requests).
      if (!cfg.provider) {
        cfg.provider = {}
      }
      // Plugin provides defaults; config-level settings take priority.
      // This allows .opencode/opencode.json to override npm (e.g. file://)
      // or individual model settings while the plugin provides the base.
      cfg.provider[PROVIDER_ID] = {
        npm: PACKAGE_NAME,
        models: buildPluginModels(isOAuth),
        ...cfg.provider[PROVIDER_ID],
      }
    },
    "experimental.chat.system.transform": async (_input, output) => {
      if (output.system.length === 0) {
        output.system.push(CLAUDE_CODE_SYSTEM_PROMPT)
        return
      }

      // OpenCode joins [provider_prompt, env_info, skills, instructions] into
      // a single string in system[0]. Replace the provider prompt portion with
      // Claude Code's prompt while preserving env, skills, and instructions.
      //
      // Anthropic's third-party detection matches specific OpenCode-native
      // strings. We rewrite known triggers to Claude Code equivalents.
      const ENV_MARKER = "You are powered by the model named"
      const original = output.system[0]
      const envIdx = original.indexOf(ENV_MARKER)
      if (envIdx > 0) {
        let appended = original.slice(envIdx)
        // Rewrite OpenCode env phrasing to Claude Code equivalents
        appended = appended.replace("Is directory a git repo: yes", "Is a git repository: true")
        appended = appended.replace("Is directory a git repo: no", "Is a git repository: false")
        output.system[0] = CLAUDE_CODE_SYSTEM_PROMPT + "\n" + appended
      } else {
        output.system[0] = CLAUDE_CODE_SYSTEM_PROMPT
      }
    },
  }
}

// Default export — used by OpenCode as the AI SDK provider factory.
// OpenCode finds this via: mod[Object.keys(mod).find(k => k.startsWith("create"))]
export default createAnthropicSDK
