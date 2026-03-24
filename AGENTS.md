# Agent Guidelines — @xtruder/opencode-claude-max-plugin

An OpenCode provider plugin that routes requests through `@anthropic-ai/sdk` using Claude Code's OAuth credentials and exact request format.

---

## Build, Test, and Release

### Build

```bash
bun run build
```

Bundles `src/index.ts`, `src/agent-index.ts`, `src/usage-cli.ts` to `build/` via Bun, then emits TypeScript declarations with `tsc`. Always rebuild after any source change before testing via OpenCode.

### Type check only (fast)

```bash
npx tsc --noEmit
```

### Run all tests

```bash
bun run src/test.ts
# or
ANTHROPIC_API_KEY=sk-ant-... bun run src/test.ts
```

Tests run sequentially top-to-bottom. Requires either `ANTHROPIC_API_KEY` env var or valid `~/.claude/.credentials.json` from Claude Code.

### Run a single test

There is no test runner with filtering. To run a single test, temporarily comment out the others or duplicate the specific `await test(...)` block at the bottom of `src/test.ts` and run the file. Tests are numbered with comments like `// ─── Test 5: ...`.

### Release

```bash
npm version patch                # bumps version, commits, and creates git tag automatically
git push origin main             # push the version commit
git push origin vX.Y.Z           # push the tag (use the version printed by npm version)
# GitHub Actions (.github/workflows/release.yml) handles npm publish automatically
```

---

## Testing Locally with OpenCode

### Setup (first time)

The plugin must be installed in the OpenCode cache. Since it's a `file:` symlink, rebuilding is enough — no reinstall needed:

```bash
# Install the local package into OpenCode's cache
cat > ~/.cache/opencode/package.json << 'EOF'
{
  "dependencies": {
    "opencode-anthropic-auth": "0.0.13",
    "@xtruder/opencode-claude-max-plugin": "file:/path/to/this/repo"
  }
}
EOF
bun install
```

Replace `/path/to/this/repo` with the actual path (e.g. `/home/user/Code/opencode-anthropic-sdk-provider`).

### Test a single prompt via CLI

```bash
# Uses ~/.claude/.credentials.json automatically
opencode run -m "anthropic-sdk/claude-haiku-4-5-20251001" "Say OK"
opencode run -m "anthropic-sdk/claude-sonnet-4-6" "What is 2+2?"
opencode run -m "anthropic-sdk/claude-opus-4-6" "What model are you?"
```

### Test with tool use (file reading)

```bash
opencode run -m "anthropic-sdk/claude-haiku-4-5-20251001" "Read package.json and tell me the package name"
```

### Check usage

```bash
opencode run -m "anthropic-sdk/claude-haiku-4-5-20251001" /usage
# or directly:
node ~/.cache/opencode/node_modules/@xtruder/opencode-claude-max-plugin/build/usage-cli.js
```

### Debug with logs

```bash
opencode run --print-logs --log-level DEBUG -m "anthropic-sdk/claude-haiku-4-5-20251001" "Say OK" 2>&1 | grep -E "install|error|ERROR"
```

### Intercept API requests (compare with Claude Code)

Start a logging proxy, then run both tools through it:

```bash
# Terminal 1: start proxy
bun -e "
import * as http from 'http';
http.createServer(async (req, res) => {
  let body = ''; req.on('data', d => body += d);
  req.on('end', async () => {
    const parsed = JSON.parse(body);
    if (parsed.tools) console.log('tools:', parsed.tools.length, '| system blocks:', parsed.system?.length);
    const resp = await fetch('https://api.anthropic.com' + req.url, {
      method: req.method,
      headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => k !== 'host')),
      body,
    });
    const text = await resp.text();
    res.writeHead(resp.status, Object.fromEntries(resp.headers.entries()));
    res.end(text);
  });
}).listen(19827, () => console.log('Proxy on 19827'));
"

# Terminal 2: run OpenCode through proxy
ANTHROPIC_BASE_URL=http://localhost:19827 opencode run -m "anthropic-sdk/claude-haiku-4-5-20251001" "Say OK"

# Terminal 2: compare with Claude Code (ANTHROPIC_BASE_URL is ignored by claude -p)
echo "Say OK" | claude -p --output-format json | python3 -c "import json,sys; d=json.load(sys.stdin); print('cache_read:', d['usage']['cache_read_input_tokens'])"
```

---

## Project Structure

```
src/
├── index.ts              # createAnthropicSDK() factory, auth resolution, fetch wrapper
├── model.ts              # AnthropicSDKModel — LanguageModelV2 (doGenerate + doStream)
├── prompt.ts             # AI SDK prompt → Anthropic Messages API converter
├── stream.ts             # Anthropic SSE events → AI SDK LanguageModelV2StreamPart
├── tools.ts              # AI SDK tools → Anthropic format + schema cleanup
├── tool-names.ts         # Bidirectional tool name mapping (OpenCode ↔ Claude Code)
├── credentials.ts        # Claude Code OAuth credentials reader + CLI refresh
├── usage.ts              # /api/oauth/usage API client + formatter
├── credentials.test.ts   # Unit + integration tests for credentials
├── index.test.ts         # Tests for createAnthropicSDK factory
├── model.test.ts         # Integration tests for model (API calls)
└── fixtures/             # Captured OpenCode request data for caching tests
    ├── opencode-system.txt
    └── opencode-tools.json
```

---

## Key Invariants

These must be maintained — they are load-bearing for Claude Code compatibility:

1. **Billing system block must be first** in `params.system` for OAuth requests — without it, Sonnet/Opus return HTTP 400
2. **Tool name mapping** is bidirectional: OpenCode snake_case ↔ Claude Code PascalCase. The `toClaudeToolName()` / `toOpencodeToolName()` functions in `tool-names.ts` handle this
3. **MCP tools** follow `server_tool` → `mcp__server__tool` format. Server names are auto-detected from OpenCode config files
4. **`tool-input-start` id must equal `tool-call` toolCallId** — OpenCode's processor correlates them; mismatch causes "Tool execution aborted"
5. **Thinking signatures** from `signature_delta` stream events must be stored in `providerMetadata.anthropic.signature` and passed back in conversation history
6. **`context-1m-2025-08-07` beta** is only added dynamically in the fetch wrapper when body exceeds 600K chars — never always-on (triggers billing check)
7. **`anthropic-ratelimit-unified-status: over_limit`** is the authoritative signal for subscription exhaustion — do not match on error message text

---

## Authentication Priority

1. Explicit `apiKey` option
2. `ANTHROPIC_API_KEY` env var
3. Auto-read from `~/.claude/.credentials.json` (Claude Code OAuth)

OAuth tokens use `Authorization: Bearer` with the `oauth-2025-04-20` beta. The billing system block in the system prompt is also required for Sonnet/Opus access.

---

## Testing Notes

- Test 17 (prompt caching) is skipped when using an API key — requires OAuth credentials with caching-capable routing
- Tests use `claude-haiku-4-5-20251001` by default (cheapest model)
- Thinking tests (14-16) use `claude-sonnet-4-6` and require OAuth credentials
- Fixture files in `src/fixtures/` contain real captured OpenCode request data — don't modify them arbitrarily as the caching test depends on their size (~20K tokens)
- The `assert()` helper throws on failure; the `test()` wrapper catches and records

---

## Research

@RESEARCH.md
