import Anthropic from "@anthropic-ai/sdk"
import { AnthropicSDKModel } from "./model.ts"
import { getCachedCredentials } from "./credentials.ts"
import { cachedUsage } from "./usage-cache.ts"
import { computeCch, hasCchPlaceholder, replaceCchPlaceholder } from "./cch.ts"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import type { Plugin } from "@opencode-ai/plugin"

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
 * Beta flag that enables 1M context window. Only sent when request body
 * exceeds the standard context threshold (~600K chars).
 */
const CONTEXT_1M_BETA = "context-1m-2025-08-07"

/**
 * Beta flags for regular API key auth (no OAuth).
 */
const API_KEY_BETAS = ["interleaved-thinking-2025-05-14", "fine-grained-tool-streaming-2025-05-14"]

const PACKAGE_NAME = "@xtruder/opencode-claude-max-plugin"
const PROVIDER_ID = "anthropic-sdk"

/**
 * Models registered by the plugin. Only the three stable aliases —
 * users on Claude Max do not pay per-token, but real pricing is listed
 * for informational purposes in the model picker.
 *
 * Costs are in USD per million tokens.
 */
const PLUGIN_MODELS = {
  "claude-haiku-4-5": {
    name: "Claude Haiku 4.5",
    reasoning: false,
    tool_call: true,
    attachment: true,
    temperature: true,
    limit: { context: 200_000, output: 8_192 },
    cost: { input: 0.8, output: 4.0, cache_read: 0.08, cache_write: 1.0 },
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
    limit: { context: 200_000, output: 16_000 },
    cost: { input: 3.0, output: 15.0, cache_read: 0.3, cache_write: 3.75 },
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
    limit: { context: 200_000, output: 32_000 },
    cost: { input: 15.0, output: 75.0, cache_read: 1.5, cache_write: 18.75 },
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

  /**
   * Approximate body size threshold (in bytes) for switching to 1M context.
   * Standard context is ~200K tokens ≈ ~800K chars. We trigger at ~600K chars
   * (~150K tokens) to give headroom before hitting the standard limit.
   */
  const CONTEXT_1M_BODY_THRESHOLD = 600_000

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

    // Auto-enable 1M context when the request body is large enough.
    if (
      init?.body &&
      typeof init.body === "string" &&
      init.body.length > CONTEXT_1M_BODY_THRESHOLD
    ) {
      const betaHeaders = new Headers(init.headers)
      const existingBetas = betaHeaders.get("anthropic-beta") ?? ""
      if (!existingBetas.includes(CONTEXT_1M_BETA)) {
        betaHeaders.set("anthropic-beta", existingBetas + "," + CONTEXT_1M_BETA)
        init = { ...init, headers: betaHeaders }
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
      cachedUsage.timestamp = Date.now()
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
        models: PLUGIN_MODELS,
        ...cfg.provider[PROVIDER_ID],
      }
    },
  }
}

// Default export — used by OpenCode as the AI SDK provider factory.
// OpenCode finds this via: mod[Object.keys(mod).find(k => k.startsWith("create"))]
export default createAnthropicSDK
