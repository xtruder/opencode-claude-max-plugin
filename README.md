# opencode-anthropic-sdk-provider

A custom [OpenCode](https://opencode.ai/) / [Vercel AI SDK](https://sdk.vercel.ai/) provider that uses the official [`@anthropic-ai/sdk`](https://github.com/anthropics/anthropic-sdk-typescript) package directly for Claude model API calls, bypassing the Vercel-maintained `@ai-sdk/anthropic` wrapper.

## Why?

- **Claude subscription support** — Automatically reads OAuth credentials from Claude Code (`~/.claude/.credentials.json`), so you can use your Claude Pro/Max subscription without a separate API key.
- **Direct SDK access** — Uses the official Anthropic TypeScript SDK, the sanctioned way to access Claude models with an Anthropic subscription.
- **Latest Anthropic features** — Enables beta features like interleaved thinking and fine-grained tool streaming out of the box.
- **Full LanguageModelV2 compatibility** — Drop-in replacement for any AI SDK-compatible framework.

## Installation

```bash
npm install opencode-anthropic-sdk-provider
# or
bun add opencode-anthropic-sdk-provider
```

## Authentication

The provider resolves credentials in the following order:

1. **Explicit `apiKey` option** passed to `createAnthropicSDK()`
2. **`ANTHROPIC_API_KEY` environment variable**
3. **Claude Code credentials** — auto-read from `~/.claude/.credentials.json`

For Claude Code credentials, log in via `claude` CLI first. The OAuth token (`sk-ant-oat01-...`) is sent via `x-api-key` header.

## Usage

### With Vercel AI SDK

```typescript
import { createAnthropicSDK } from "opencode-anthropic-sdk-provider";
import { streamText, generateText } from "ai";

// Uses ANTHROPIC_API_KEY or ~/.claude/.credentials.json automatically
const provider = createAnthropicSDK();
const model = provider.languageModel("claude-sonnet-4-6");

// Streaming
const result = streamText({ model, prompt: "Hello!" });
for await (const chunk of result.textStream) {
  process.stdout.write(chunk);
}

// Non-streaming
const { text } = await generateText({ model, prompt: "Hello!" });
console.log(text);
```

### With OpenCode

Add to `.opencode/opencode.json`. OpenCode will automatically install and load the provider. If you have Claude Code credentials, no environment variable is needed.

```json
{
  "provider": {
    "anthropic-sdk": {
      "npm": "opencode-anthropic-sdk-provider",
      "name": "Anthropic SDK",
      "models": {
        "claude-sonnet-4-6":        { "name": "Claude Sonnet 4.6" },
        "claude-opus-4-6":          { "name": "Claude Opus 4.6" },
        "claude-opus-4-5-20251101": { "name": "Claude Opus 4.5" },
        "claude-sonnet-4-5-20250929": { "name": "Claude Sonnet 4.5" },
        "claude-haiku-4-5-20251001": { "name": "Claude Haiku 4.5" },
        "claude-opus-4-1-20250805": { "name": "Claude Opus 4.1" },
        "claude-opus-4-20250514":   { "name": "Claude Opus 4" },
        "claude-sonnet-4-20250514": { "name": "Claude Sonnet 4" },
        "claude-3-haiku-20240307":  { "name": "Claude 3 Haiku" }
      }
    }
  }
}
```

## API

### `createAnthropicSDK(options?)`

Creates a provider instance. Also available as the default export.

| Option | Type | Description |
|--------|------|-------------|
| `apiKey` | `string` | Anthropic API key or OAuth token. Falls back to `ANTHROPIC_API_KEY` env var, then `~/.claude/.credentials.json`. |
| `baseURL` | `string` | Custom base URL for the Anthropic API. |
| `headers` | `Record<string, string>` | Additional default headers. |
| `fetch` | `typeof globalThis.fetch` | Custom fetch implementation. |
| `name` | `string` | Provider name for logging. Defaults to `"anthropic-sdk"`. |
| `credentialsPath` | `string` | Custom path to Claude Code credentials file. Defaults to `~/.claude/.credentials.json`. |

Returns an `AnthropicSDKProvider` with a single method:

- **`languageModel(modelId: string)`** — Returns a `LanguageModelV2` instance for any Claude model ID.

### Available Models

The following models are available via the Anthropic API. Model availability depends on your subscription tier:

| Model ID | Name | Subscription |
|----------|------|-------------|
| `claude-sonnet-4-6` | Claude Sonnet 4.6 | Pro/Max |
| `claude-opus-4-6` | Claude Opus 4.6 | Pro/Max |
| `claude-opus-4-5-20251101` | Claude Opus 4.5 | Pro/Max |
| `claude-sonnet-4-5-20250929` | Claude Sonnet 4.5 | Pro/Max |
| `claude-haiku-4-5-20251001` | Claude Haiku 4.5 | Free/Pro/Max |
| `claude-opus-4-1-20250805` | Claude Opus 4.1 | Pro/Max |
| `claude-opus-4-20250514` | Claude Opus 4 | Pro/Max |
| `claude-sonnet-4-20250514` | Claude Sonnet 4 | Pro/Max |
| `claude-3-haiku-20240307` | Claude 3 Haiku | Free/Pro/Max |

> **Note:** With a free-tier Claude account, only Haiku models are accessible. Sonnet and Opus models require a Claude Pro or Max subscription.

### Features

- Streaming and non-streaming completions
- Tool/function calling (streaming and non-streaming)
- Extended thinking (reasoning) with signature passthrough
- Multi-turn conversations
- Image inputs (base64 and URL)
- Prompt caching (token usage reported)
- Temperature, topP, topK, and stop sequences
- Auto-cleanup of AI SDK `custom` schema fields for Anthropic compatibility

## Project Structure

```
src/
├── index.ts        # Provider factory, auth resolution, and exports
├── model.ts        # LanguageModelV2 implementation (doGenerate + doStream)
├── prompt.ts       # AI SDK prompt → Anthropic Messages API converter
├── stream.ts       # Anthropic stream events → AI SDK stream parts converter
├── tools.ts        # AI SDK tool definitions → Anthropic tool format converter
├── credentials.ts  # Claude Code credentials reader (~/.claude/.credentials.json)
└── test.ts         # Integration tests (13 tests)
```

## Development

### Prerequisites

- [Bun](https://bun.sh/) runtime
- Either `ANTHROPIC_API_KEY` or Claude Code credentials (`~/.claude/.credentials.json`)

### Build

```bash
bun run build
```

### Test

```bash
bun run test
```

Runs 13 integration tests against the live Anthropic API covering text generation, streaming, tool calls, multi-turn conversation, and credential handling.

## License

MIT
