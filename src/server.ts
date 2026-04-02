/**
 * Server-side plugin entry point (V1 plugin format).
 *
 * This module re-exports the server plugin in the format expected by
 * OpenCode's V1 plugin loader: `default export { id, server }`.
 *
 * The `./server` export in package.json points here.
 */
import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { anthropicSDKPlugin } from "./index.ts"

const id = "anthropic-sdk"

const server: Plugin = anthropicSDKPlugin

const plugin: PluginModule & { id: string } = {
  id,
  server,
}

export default plugin
