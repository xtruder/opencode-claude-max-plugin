import Anthropic from "@anthropic-ai/sdk"
import { AnthropicSDKModel } from "./model.js"
import { readClaudeCredentials, isExpired } from "./credentials.js"
import type { LanguageModelV2 } from "@ai-sdk/provider"

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

/**
 * Resolve authentication: API key, explicit auth token, or Claude Code credentials.
 *
 * Priority order:
 * 1. Explicit apiKey option
 * 2. ANTHROPIC_API_KEY env var
 * 3. Explicit authToken option
 * 4. Claude Code credentials file (~/.claude/.credentials.json)
 */
/**
 * The beta flag that enables OAuth token authentication on the Anthropic API.
 * Without this, Bearer tokens are rejected with "OAuth authentication is
 * currently not supported". Claude Code sends this on every OAuth request.
 */
const OAUTH_BETA = "oauth-2025-04-20"

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
  // OAuth tokens must be sent as Authorization: Bearer with the
  // "oauth-2025-04-20" beta header — this is how Claude Code does it.
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

  // No auth found — let the SDK handle the error
  return { isOAuth: false }
}

/**
 * Create an Anthropic SDK provider for use with OpenCode / Vercel AI SDK.
 *
 * This provider uses @anthropic-ai/sdk directly for all API calls,
 * which is the officially sanctioned way to access Claude models
 * with an Anthropic subscription.
 *
 * Authentication (in priority order):
   * 1. `apiKey` option or `ANTHROPIC_API_KEY` env var
   * 2. Auto-read from Claude Code credentials (~/.claude/.credentials.json)
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

  const betaFlags = [
    "interleaved-thinking-2025-05-14",
    "fine-grained-tool-streaming-2025-05-14",
    // Required for OAuth Bearer tokens to work with all models
    ...(auth.isOAuth ? [OAUTH_BETA, "claude-code-20250219"] : []),
  ].join(",")

  const client = new Anthropic({
    apiKey: auth.apiKey ?? null,
    authToken: auth.authToken ?? null,
    baseURL,
    defaultHeaders: {
      ...headers,
      "anthropic-beta": betaFlags,
    },
    fetch: customFetch,
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
