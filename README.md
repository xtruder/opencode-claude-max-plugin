# @xtruder/opencode-claude-max-plugin

An [OpenCode](https://opencode.ai/) plugin that enables Claude Pro/Max subscription access via the official [`@anthropic-ai/sdk`](https://github.com/anthropics/anthropic-sdk-typescript), using OAuth credentials from Claude Code (`~/.claude/.credentials.json`).

## Why?

- **Use your Claude subscription** — Automatically reads OAuth credentials from Claude Code, no separate API key needed
- **Matches Claude Code exactly** — Same headers, billing, tool names, and request format as Claude Code CLI
- **Prompt caching** — 98% of input tokens served from cache (system prompt + tools cached globally)
- **All Claude models** — Opus 4.6, Sonnet 4.6, Sonnet 4.5, Haiku 4.5, and more
- **Extended thinking** — Full reasoning support with signature passthrough
- **Usage tracking** — Built-in `/usage` command shows subscription utilization

## Installation

```bash
npm install @xtruder/opencode-claude-max-plugin
# or
bun add @xtruder/opencode-claude-max-plugin
```

## Quick Start

### With OpenCode

Add to `.opencode/opencode.json`. If you have Claude Code credentials (`~/.claude/.credentials.json`), no environment variable is needed:

```json
{
  "provider": {
    "anthropic-sdk": {
      "npm": "@xtruder/opencode-claude-max-plugin",
      "name": "Anthropic SDK",
      "models": {
        "claude-sonnet-4-6":        { "name": "Claude Sonnet 4.6", "reasoning": true, "tool_call": true },
        "claude-opus-4-6":          { "name": "Claude Opus 4.6", "reasoning": true, "tool_call": true },
        "claude-haiku-4-5-20251001": { "name": "Claude Haiku 4.5", "tool_call": true }
      }
    }
  }
}
```

### With Vercel AI SDK

```typescript
import { createAnthropicSDK } from "@xtruder/opencode-claude-max-plugin";
import { streamText, generateText } from "ai";

// Uses ~/.claude/.credentials.json automatically
const provider = createAnthropicSDK();
const model = provider.languageModel("claude-sonnet-4-6");

const result = streamText({ model, prompt: "Hello!" });
for await (const chunk of result.textStream) {
  process.stdout.write(chunk);
}
```

## Authentication

Credentials are resolved in order:

1. **`apiKey` option** or **`ANTHROPIC_API_KEY` env var**
2. **Claude Code credentials** — auto-read from `~/.claude/.credentials.json`

For Claude Code credentials, log in via `claude` CLI first.

## Context Window Limits

| Model | Max Context (subscription, no Extra usage) |
|---|---|
| Opus 4.6 | ~615K+ tokens (native 1M) |
| Sonnet 4.6 | ~120K tokens (429 above, needs Extra usage) |
| Haiku 4.5 | 200K tokens (hard limit) |

## Features

- Streaming and non-streaming completions
- Tool/function calling with Claude Code tool name mapping
- Extended thinking with signature passthrough
- Prompt caching (98% cache hit rate with full tool set)
- Subscription rate limit detection with clear error messages
- `/usage` command for subscription utilization tracking
- MCP tool name remapping (OpenCode → Claude Code format)

## Development

```bash
bun install
bun run build
bun run test    # 17 integration tests
```

See [RESEARCH.md](RESEARCH.md) for detailed reverse-engineering findings.

## License

MIT
