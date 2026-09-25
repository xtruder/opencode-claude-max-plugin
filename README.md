# @xtruder/opencode-claude-max-plugin

Use Claude Pro/Max subscription credentials in OpenCode, with a subscription-usage sidebar and `/usage` dialog. The plugin uses the official Anthropic SDK through OpenCode's AI SDK adapter.

**Requires OpenCode 2.0.16 or later. OpenCode v1 is not supported.** Model availability depends on your account.

## Installation

Sign in to Claude Code, then add the plugin to `~/.config/opencode/opencode.json` or your existing `opencode.jsonc`:

```sh
claude auth login
```

```json
{
  "plugins": ["@xtruder/opencode-claude-max-plugin"]
}
```

OpenCode installs the package and discovers both its provider and terminal UI. No separate provider configuration is needed. Restart OpenCode after changing the configuration; if you use a shared server, restart it and the terminal client.

When migrating from v1, replace the old `plugin` entry with the v2 `plugins` configuration and remove any separate registration of `src/tui.tsx`. Use a v2-compatible plugin release; version 0.4.6 predates this migration.

## Authentication

For subscription access, sign in with Claude Code:

```sh
claude auth login
```

The plugin reads `~/.claude/.credentials.json`. Credential refresh is deferred until an inference request needs it.

Authentication is selected in this order:

1. An explicit `apiKey` plugin option.
2. The `ANTHROPIC_API_KEY` environment variable.
3. Claude Code's OAuth credentials.

If you intend to use your subscription, make sure an API key is not overriding it. API-key requests use API billing rather than subscription access.

For a custom credentials file, supply server plugin options:

```json
{
  "plugins": [
    {
      "package": "@xtruder/opencode-claude-max-plugin",
      "options": {
        "credentialsPath": "/absolute/path/to/.credentials.json"
      }
    }
  ]
}
```

The credentials must be accessible to the process running the provider. The usage TUI reads credentials on the machine running the terminal client.

## Usage

Choose a model from the `anthropic-sdk` provider in OpenCode, or run:

```sh
opencode run --standalone -m anthropic-sdk/claude-haiku-4-5 'Reply with exactly OK.'
opencode run --standalone -m 'anthropic-sdk/claude-sonnet-5#high' 'Explain this code.'
```

Registered models (each row is a separate selectable entry):

| Model            | OpenCode model ID  |
| ---------------- | ------------------ |
| Claude Haiku 4.5 | `claude-haiku-4-5` |
| Claude Sonnet 5  | `claude-sonnet-5`  |
| Claude Opus 4.8  | `claude-opus-4-8`  |
| Claude Opus 5    | `claude-opus-5`    |
| Claude Opus 5.5  | `claude-opus-5-5`  |
| Claude Fable 5   | `claude-fable-5`   |
| Claude Fable 5.1 | `claude-fable-5-1` |

[Claude Opus 5](https://platform.claude.com/docs/en/models/opus-5/overview) remains available as a legacy model; it is not an alias for [Opus 5.5](https://platform.claude.com/docs/en/models/opus-5-5/overview). Anthropic names it “Claude Opus 5”, not “Claude Opus 5.0”.

Sonnet 4.6, Opus 4.6 (including the `-1m` variant), and Opus 4.7 are no longer registered by this plugin. Select a supported model when continuing sessions that used them.

Registration does not guarantee account access to a model. Use these OpenCode IDs rather than dated API aliases.

### Model settings

Use OpenCode v2's `providers` configuration for model overrides. For example, to disable refusal fallback for a model:

```json
{
  "providers": {
    "anthropic-sdk": {
      "models": {
        "claude-fable-5": {
          "settings": { "refusalFallback": false }
        }
      }
    }
  }
}
```

The provider supports model-specific prompts, prompt caching, thinking, tool calls, pause-turn continuation, and server-side refusal fallbacks. See [RESEARCH.md](RESEARCH.md) for request-format details.

## Subscription usage

The terminal sidebar shows available 5-hour and 7-day usage windows and reset times. Run `/usage` or select it from the command palette for additional model-specific windows and extra-usage status. Press Escape to close the dialog.

Usage comes from subscription data, not estimates derived from token counts. It is separate from OpenCode's native token/cost statistics.

The display checks its shared cache every 60 seconds by default. Usage API results are cached for five minutes; opening `/usage` does not bypass that cache or rate-limit backoff. Failed requests retain cached values with a status notice. Fetching usage does not send an inference request or launch Claude Code to refresh credentials.

### TUI settings

Defaults work with the server plugin registration alone. To customize the terminal UI, add an entry to `~/.config/opencode/cli.json`:

```json
{
  "plugins": [
    {
      "package": "@xtruder/opencode-claude-max-plugin",
      "options": {
        "enabled": true,
        "sidebar": true,
        "poll_interval": 60
      }
    }
  ]
}
```

| Option            | Default                       | Description                                                |
| ----------------- | ----------------------------- | ---------------------------------------------------------- |
| `enabled`         | `true`                        | Enable the usage TUI.                                      |
| `sidebar`         | `true`                        | Show sidebar usage. Disabling it keeps `/usage` available. |
| `poll_interval`   | `60`                          | Cache polling interval in seconds; minimum 10.             |
| `credentialsPath` | `~/.claude/.credentials.json` | Credentials file used by the usage TUI.                    |

Server plugin options are not automatically passed to the TUI. Set a custom TUI credentials path in `cli.json`, even if it is already configured for the server. The usage cache is shared within an XDG state directory, not separated by credentials file or account.

## Development

Building and testing require **Node.js 26.4+ and npm**. Bun is not required for this workflow. Run these commands from a checkout of the repository:

```sh
npm ci
npm run build
npm run dev              # rebuild on changes
npm run typecheck
npm run lint
npm run format:check
npm test
```

Vite builds three ESM entrypoints: `build/index.js` (AI SDK provider), `build/server.js` (OpenCode registration), and `build/tui.js` (terminal UI). It compiles Solid JSX for OpenTUI and embeds prompt `.txt` files into JavaScript. Keep the entire `build/` directory together, including shared chunks.

The build currently also runs TypeScript declaration generation for the exported provider API. `npm run typecheck` checks types without emitting files. `npm run dev` watches JavaScript and prompt changes; run the full build before packaging to refresh declarations.

The `aisdk:` prefix is applied internally to the provider's runtime file URL. Do not add it to the plugin name in your configuration. Runtime packages remain external to the bundle; the plugin uses OpenCode's adapter rather than maintaining a second transport implementation.

### Testing

`npm test` builds the plugin and runs offline tests with Vitest. It does not perform Claude inference.

For a real terminal integration check:

```sh
npm run test:tui-smoke
```

This requires OpenCode, Python, and `uv`. It starts an isolated OpenCode instance with fixture usage data and checks the sidebar, dialog, resizing, polling, and error states. It does not attach to your running server or send model prompts.

Live Claude tests are explicit opt-in:

```sh
npm run test:live
```

These tests can consume quota and refresh credentials.

Native Node rendering uses OpenTUI's experimental `node:ffi` backend, which requires Node 26.4+ and may print an experimental warning. Standalone Node TUI harnesses must select Solid's reactive runtime with `--conditions=browser`. The plugin has also been tested in the Bun-compiled OpenCode 2.0.16 host; using npm to build the plugin does not change the host's runtime.

## License

MIT
