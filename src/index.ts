import Anthropic from "@anthropic-ai/sdk"
import { AnthropicSDKModel } from "./model.js"
import { readClaudeCredentials, isExpired } from "./credentials.js"
import type { LanguageModelV2 } from "@ai-sdk/provider"

/**
 * Claude Code CLI version to impersonate.
 * Used in user-agent, billing header, and x-stainless-package-version.
 */
const CLAUDE_CODE_VERSION = "2.1.81"

/**
 * Beta flags that Claude Code sends on every OAuth request.
 * Order and exact values must match what Claude Code sends.
 */
export const OAUTH_BETAS = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
  "effort-2025-11-24",
]

/**
 * Beta flag that enables 1M context window. Only sent when model ID
 * includes [1m] suffix — e.g. "claude-sonnet-4-6[1m]".
 * Claude Code checks: /\[1m\]/i.test(modelId) before including this.
 */
export const CONTEXT_1M_BETA = "context-1m-2025-08-07"

/**
 * Beta flags for regular API key auth (no OAuth).
 */
export const API_KEY_BETAS = [
  "interleaved-thinking-2025-05-14",
  "fine-grained-tool-streaming-2025-05-14",
]

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
  languageModel(modelId: string): LanguageModelV2
}

function resolveAuth(options: AnthropicSDKProviderOptions): {
  apiKey?: string | null
  authToken?: string | null
  isOAuth: boolean
} {
  // 1. Explicit API key
  if (options.apiKey) {
    return { apiKey: options.apiKey, isOAuth: false }
  }

  // 2. Environment variable
  if (process.env.ANTHROPIC_API_KEY) {
    return { apiKey: process.env.ANTHROPIC_API_KEY, isOAuth: false }
  }

  // 3. Claude Code credentials file
  const creds = readClaudeCredentials(options.credentialsPath)
  if (creds) {
    if (isExpired(creds)) {
      console.warn(
        "[anthropic-sdk-provider] Claude Code OAuth token is expired. " +
        "Run 'claude' to re-authenticate, then restart.",
      )
    }
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
 */
export function createAnthropicSDK(
  options: AnthropicSDKProviderOptions = {},
): AnthropicSDKProvider {
  const {
    apiKey,
    baseURL,
    headers,
    fetch: customFetch,
    name = "anthropic-sdk",
    credentialsPath,
    ...rest
  } = options

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

  // Wrap fetch to detect subscription rate limits and stop SDK from retrying
  // indefinitely. Claude Code uses the anthropic-ratelimit-unified-status
  // response header to detect this — "over_limit" means subscription exhausted.
  // We also check retry-after > 120s as a fallback (subscription limits reset
  // in hours, transient overloads in seconds).
  /**
   * Approximate body size threshold (in bytes) for switching to 1M context.
   * Standard context is ~200K tokens ≈ ~800K chars. We trigger at ~600K chars
   * (~150K tokens) to give headroom before hitting the standard limit.
   */
  const CONTEXT_1M_BODY_THRESHOLD = 600_000

  const baseFetch = customFetch ?? globalThis.fetch
  const wrappedFetch = async (url: string | URL | Request, init?: RequestInit) => {
    // Auto-enable 1M context when the request body is large enough.
    // This avoids needing [1m] model suffixes — just sends the beta
    // when the context exceeds the standard window threshold.
    if (init?.body && typeof init.body === "string" && init.body.length > CONTEXT_1M_BODY_THRESHOLD) {
      const headers = new Headers(init.headers)
      const existingBetas = headers.get("anthropic-beta") ?? ""
      if (!existingBetas.includes(CONTEXT_1M_BETA)) {
        headers.set("anthropic-beta", existingBetas + "," + CONTEXT_1M_BETA)
        init = { ...init, headers }
      }
    }

    const resp = await baseFetch(url, init)
    if (resp.status === 429) {
      const unifiedStatus = resp.headers.get("anthropic-ratelimit-unified-status") ?? ""
      const retryAfter = parseInt(resp.headers.get("retry-after") ?? "0")
      const isSubscriptionLimit = unifiedStatus === "over_limit"
        || retryAfter > 120

      if (isSubscriptionLimit) {
        // Read body to avoid dangling stream, then disable SDK retries
        const body = await resp.text()
        const headers = new Headers(resp.headers)
        headers.set("x-should-retry", "false")
        return new Response(body, {
          status: resp.status,
          statusText: resp.statusText,
          headers,
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
    languageModel(modelId: string): LanguageModelV2 {
      return new AnthropicSDKModel(modelId, client, name, auth.isOAuth)
    },
  }
}

// Default export for convenience
export default createAnthropicSDK

// Re-export types
export { AnthropicSDKModel } from "./model.js"
export type { ConvertedPrompt } from "./prompt.js"
export {
  readClaudeCredentials,
  isExpired,
  getCredentialsPath,
  type ClaudeOAuthCredentials,
} from "./credentials.js"
