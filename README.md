# @xtruder/opencode-claude-max-plugin

An [OpenCode](https://opencode.ai/) plugin that enables Claude Pro/Max subscription access via the official [`@anthropic-ai/sdk`](https://github.com/anthropics/anthropic-sdk-typescript), using OAuth credentials from Claude Code (`~/.claude/.credentials.json`).

## Why?

- **Use your Claude subscription** — Automatically reads OAuth credentials from Claude Code, no separate API key needed
- **Matches Claude Code exactly** — Same headers, billing, tool names, and request format as Claude Code CLI
- **Prompt caching** — 98% of input tokens served from cache (system prompt + tools cached globally)
- **All Claude models** — Opus 4.6, Sonnet 4.6, Haiku 4.5
- **Extended thinking** — Full reasoning support with thinking variants (high/max)
- **Usage tracking** — Built-in `/usage` command shows subscription utilization

## Installation

You do not need to install the package manually — OpenCode auto-installs it when it first loads your config.

Just add the following to `.opencode/opencode.json` in your project (or `~/.config/opencode/opencode.json` globally):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "anthropic-sdk": {
      "npm": "@xtruder/opencode-claude-max-plugin",
      "name": "Anthropic SDK",
      "models": {
        "claude-sonnet-4-6": {
          "name": "Claude Sonnet 4.6",
          "attachment": false,
          "reasoning": true,
          "tool_call": true,
          "temperature": true,
          "limit": { "context": 200000, "output": 64000 },
          "options": {
            "thinking": { "type": "enabled", "budgetTokens": 1024 }
          },
          "variants": {
            "high": { "thinking": { "type": "enabled", "budgetTokens": 10000 } },
            "max":  { "thinking": { "type": "enabled", "budgetTokens": 32000 } }
          }
        },
        "claude-opus-4-6": {
          "name": "Claude Opus 4.6",
          "attachment": false,
          "reasoning": true,
          "tool_call": true,
          "temperature": true,
          "limit": { "context": 1000000, "output": 64000 },
          "options": {
            "thinking": { "type": "adaptive" }
          },
          "variants": {
            "high": { "thinking": { "type": "enabled", "budgetTokens": 10000 } },
            "max":  { "thinking": { "type": "enabled", "budgetTokens": 32000 } }
          }
        },
        "claude-haiku-4-5-20251001": {
          "name": "Claude Haiku 4.5",
          "attachment": false,
          "reasoning": false,
          "tool_call": true,
          "temperature": true,
          "limit": { "context": 200000, "output": 8192 }
        }
      }
    }
  }
}
```

Then open OpenCode and run `/connect` → Other → `anthropic-sdk`. If Claude Code is installed and you're logged in, credentials are read automatically from `~/.claude/.credentials.json` — no API key needed.

## Authentication

Credentials are resolved in order:

1. **`ANTHROPIC_API_KEY` env var** or **`apiKey` provider option**
2. **Claude Code credentials** — auto-read from `~/.claude/.credentials.json`

For Claude Code credentials, log in via `claude` CLI first (`claude auth login`).

## Features

- Streaming and non-streaming completions
- Tool/function calling with Claude Code tool name mapping (`task` → `Agent`, etc.)
- MCP tool name remapping (`server_tool` → `mcp__server__tool`)
- Extended thinking with signature passthrough for multi-turn conversations
- Prompt caching (98% cache hit rate with full OpenCode tool set)
- Subscription rate limit detection — fails fast with clear message instead of hanging
- Long context auto-detection — adds `context-1m` beta header when request body is large
- `/usage` slash command — shows current session and weekly utilization

## Usage Command

After adding the config, run `/usage` inside OpenCode to see your subscription usage:

```
  Claude Subscription Usage
  ────────────────────────────────────────────────────
  Current session
  ████████████████████████████████░░░░░░░░░░░░░░░░░░  67% used
  Resets 7:00 PM GMT+1

  Current week (all models)
  ████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  8% used
  Resets Mar 30, 7:00 AM GMT+2
```

## With Vercel AI SDK

The plugin also works as a standalone Vercel AI SDK provider:

```typescript
import { createAnthropicSDK } from "@xtruder/opencode-claude-max-plugin";
import { streamText } from "ai";

// Uses ~/.claude/.credentials.json automatically
const provider = createAnthropicSDK();
const model = provider.languageModel("claude-sonnet-4-6");

const result = streamText({ model, prompt: "Hello!" });
for await (const chunk of result.textStream) {
  process.stdout.write(chunk);
}
```

## Development

```bash
bun install
bun run build
bun run test    # 17 integration tests (requires ANTHROPIC_API_KEY or Claude Code credentials)
```

See [RESEARCH.md](RESEARCH.md) for detailed reverse-engineering findings on how we matched Claude Code's request format.

## License

MIT
