import { AgentSDKModel } from "./agent-model.js"
import type { LanguageModelV2 } from "@ai-sdk/provider"

export interface AgentSDKProviderOptions {
  /**
   * Provider name for logging. Defaults to "anthropic-agent-sdk".
   */
  name?: string

  /**
   * Any additional options (passed through by OpenCode).
   */
  [key: string]: unknown
}

export interface AgentSDKProvider {
  languageModel(modelId: string): LanguageModelV2
}

/**
 * Create an Anthropic Agent SDK provider for use with OpenCode / Vercel AI SDK.
 *
 * Uses @anthropic-ai/claude-agent-sdk which handles authentication via
 * Claude Code's built-in OAuth flow — no API keys or billing headers needed.
 */
export function createAgentSDK(
  options: AgentSDKProviderOptions = {},
): AgentSDKProvider {
  const { name = "anthropic-agent-sdk", ...rest } = options

  return {
    languageModel(modelId: string): LanguageModelV2 {
      return new AgentSDKModel(modelId, name)
    },
  }
}

export default createAgentSDK
export { AgentSDKModel } from "./agent-model.js"
