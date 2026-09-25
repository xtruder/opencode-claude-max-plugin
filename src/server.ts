import type { Plugin } from "@opencode/plugin"
import { buildPluginModels, PROVIDER_ID, resolveAuth, selectClaudePromptForModel } from "./index.ts"

// Adapted from feature/opencode-v2-compatibility. The stable V2 API splits
// catalog into provider/model domains; aisdk: retains our existing transport.
export default {
  id: "anthropic-sdk",
  async setup(ctx) {
    const isOAuth = resolveAuth(ctx.options).isOAuth
    // Resolve the executable entry at runtime; Vite must not inline it as an asset.
    const providerPackage = `aisdk:${new URL(/* @vite-ignore */ "./index.js", import.meta.url).href}`
    await ctx.provider.transform((editor) => {
      type Registration = Parameters<typeof editor.add>[0]
      const models = Object.entries(buildPluginModels(isOAuth)).map(([id, definition]) => ({
        id,
        modelID: id,
        providerID: PROVIDER_ID,
        name: definition.name,
        package: providerPackage,
        capabilities: {
          tools: definition.tool_call,
          input: definition.modalities.input,
          output: definition.modalities.output,
        },
        limit: definition.limit,
        cost: [
          {
            input: definition.cost.input,
            output: definition.cost.output,
            cache: { read: definition.cost.cache_read, write: definition.cost.cache_write },
          },
        ],
        settings: "options" in definition ? definition.options : {},
        variants: Object.entries("variants" in definition ? definition.variants : {}).map(
          ([variantID, settings]) => ({ id: variantID, settings }),
        ),
        time: { released: 0 },
        status: "active",
        enabled: true,
      }))
      editor.add({
        info: {
          id: PROVIDER_ID,
          name: "Anthropic SDK",
          activation: "enabled",
          package: providerPackage,
          settings: { ...ctx.options },
        },
        models,
      } as unknown as Registration)
    })
    await ctx.session.hook(
      "context",
      (event) => {
        const first = event.system[0]
        const markers = [
          "You are powered by the model named",
          "Here is some useful information about the environment",
        ]
        const index =
          first &&
          markers
            .map((marker) => first.text.indexOf(marker))
            .filter((position) => position >= 0)
            .toSorted((a, b) => a - b)[0]
        const tail =
          index != null
            ? [{ ...first, text: first.text.slice(index) }, ...event.system.slice(1)]
            : event.system.slice(1)
        event.system.splice(
          0,
          event.system.length,
          { type: "text", text: selectClaudePromptForModel(event.model.id) },
          ...tail.map((part) =>
            Object.assign({}, part, {
              text: part.text
                .replace("Is directory a git repo: yes", "Is a git repository: true")
                .replace("Is directory a git repo: no", "Is a git repository: false"),
            }),
          ),
        )
        event.options.maxTokens ??= 64_000
        // Tool names and billing/identity blocks are handled bidirectionally by
        // the existing AI SDK model. Doing it again here breaks tool execution.
      },
      { providerID: PROVIDER_ID },
    )
  },
} satisfies Plugin.Plugin
