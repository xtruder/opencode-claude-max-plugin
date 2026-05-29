# Agent Guidelines — @xtruder/opencode-claude-max-plugin

An OpenCode provider plugin that routes requests through `@anthropic-ai/sdk` using Claude Code's OAuth credentials and exact request format.

---

## Build, Test, and Release

### Build

```bash
bun run build
```

Bundles `src/index.ts` and `src/server.ts` to `build/` via Bun, then emits TypeScript declarations with `tsc`. The TUI plugin (`src/tui.tsx`) is loaded as raw source by Bun — no build step needed. Always rebuild after any source change before testing via OpenCode.

### Type check only (fast)

```bash
npx tsc --noEmit
```

### Run all tests

```bash
bun test src/*.test.ts
# or with API key
ANTHROPIC_API_KEY=sk-ant-... bun test src/*.test.ts
```

Tests use `bun:test` (`describe` / `test` / `expect`). Unit tests (CCH, credentials, factory) run without network. `model.test.ts` hits the real API and consumes OAuth quota — requires either `ANTHROPIC_API_KEY` env var or valid `~/.claude/.credentials.json` from Claude Code.

### Run a single test or file

```bash
bun test src/cch.test.ts                          # one file
bun test src/cch.test.ts -t "billing"             # filter by name pattern
bun test src/*.test.ts --bail                     # stop at first failure
```

### Skip the API-hitting tests

```bash
bun test src/cch.test.ts src/credentials.test.ts src/index.test.ts   # unit only
```

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

Generate local dev config files that point to the build output and TUI source:

```bash
bun run dev:config
```

This creates `.opencode/opencode.json` (server plugin + provider) and `.opencode/tui.json` (TUI plugin) with absolute `file://` paths. Since it uses local paths, rebuilding (`bun run build`) is enough — no reinstall needed.

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

In the TUI, type `/usage` to open the usage dialog. The sidebar also shows live usage bars when the TUI plugin is loaded.

### Debug with logs

```bash
opencode run --print-logs --log-level DEBUG -m "anthropic-sdk/claude-haiku-4-5-20251001" "Say OK" 2>&1 | grep -E "install|error|ERROR"
```

### Intercept API requests (compare with Claude Code)

Use the bundled logging proxy at `scripts/cache-proxy.ts`. It forwards to `api.anthropic.com` while logging per-request `cache_control` placement and per-response token usage (input, output, cache_read, cache_write). Useful for diagnosing prompt-cache regressions.

```bash
# Terminal 1: start proxy (defaults to :19827)
bun scripts/cache-proxy.ts                       # summary only
bun scripts/cache-proxy.ts -d                    # also dump request bodies
bun scripts/cache-proxy.ts -d -D -p 9000         # dump request + response bodies on :9000
bun scripts/cache-proxy.ts --help                # all options

# If port is stuck from a previous run:
fuser -k 19827/tcp                               # or: kill -9 $(lsof -ti :19827)

# Terminal 2: run OpenCode through proxy
ANTHROPIC_BASE_URL=http://localhost:19827 opencode run -m "anthropic-sdk/claude-haiku-4-5-20251001" "Say OK"

# Or run Claude Code through it (same env var)
ANTHROPIC_BASE_URL=http://localhost:19827 claude

# Inspect captures (with -d): byte-diff prefixes across consecutive turns to
# track down what's mutating in the cached prefix
python3 -c "
import json
def strip(o):
    if isinstance(o, dict):
        o.pop('cache_control', None)
        for v in o.values(): strip(v)
    elif isinstance(o, list):
        for v in o: strip(v)
a = json.load(open('/tmp/opencode/cache-proxy/req-001-claude-opus-4-7.json'))
b = json.load(open('/tmp/opencode/cache-proxy/req-002-claude-opus-4-7.json'))
strip(a); strip(b)
sa = json.dumps({'system':a['system'],'tools':a['tools'],'messages':a['messages'][:5]}, sort_keys=True)
sb = json.dumps({'system':b['system'],'tools':b['tools'],'messages':b['messages'][:5]}, sort_keys=True)
i = next((k for k in range(min(len(sa),len(sb))) if sa[k]!=sb[k]), -1)
print('first diff at', i, repr(sa[max(0,i-30):i+80]) if i>=0 else 'IDENTICAL')
"

# Quick per-turn cache summary across all captures:
grep -E "REQ|RESP" /tmp/opencode/cache-proxy/proxy.log | grep -v "haiku\|429"
```

### Continue or fork an existing OpenCode session from CLI

`opencode run` supports session continuation without touching the TUI — useful for reproducing cache behavior on long sessions or running scripted multi-turn tests.

```bash
# Continue the last session (any model — model gets switched per invocation)
opencode run -m "anthropic-sdk/claude-opus-4-8" -c "Just say OK"

# Continue a specific session by id
opencode run -m "anthropic-sdk/claude-opus-4-8" --session ses_XXXX "Just say OK"

# Fork before continuing (creates a new session branched from the target)
opencode run -m "anthropic-sdk/claude-opus-4-8" --session ses_XXXX --fork "Just say OK"

# Pin a fresh session to a title (otherwise opencode auto-generates one)
opencode run -m "anthropic-sdk/claude-opus-4-8" --title "cache-repro" "First message"
```

**Caveat**: continuing a session that contains coding history will often cause the model to keep coding. For pure cache-behavior tests, either fork a clean session ("capital of France" style) or send a very explicit no-op instruction like `"Just say OK and nothing else. Do not write any code or edit any files."`

### Find sessions and inspect token usage in the OpenCode DB

OpenCode stores sessions and messages in `~/.local/share/opencode/opencode.db` (SQLite). The schema is stable enough to query directly.

```bash
# List recent sessions (filter out auto-generated noise)
sqlite3 ~/.local/share/opencode/opencode.db \
  "SELECT id, title FROM session ORDER BY time_updated DESC LIMIT 30" \
  | grep -iv "new session\|confirmation\|agent ready\|agent setup"

# Find a session by keyword in title
sqlite3 ~/.local/share/opencode/opencode.db \
  "SELECT id, title FROM session ORDER BY time_updated DESC LIMIT 100" \
  | grep -i "caching"

# Check token usage (input/output/cache_read/cache_write) for the last N messages
# of a specific session — useful to verify caching is actually hitting
sqlite3 ~/.local/share/opencode/opencode.db \
  "SELECT data FROM message WHERE session_id='ses_XXXX' AND data LIKE '%tokens%' ORDER BY time_created DESC LIMIT 10" \
  | python3 -c "
import sys, json
for line in sys.stdin:
    try:
        d = json.loads(line)
        t = d.get('tokens', {})
        c = t.get('cache', {})
        print(f\"{d.get('providerID','?')}/{d.get('modelID','?')} input={t.get('input',0)} output={t.get('output',0)} cache_read={c.get('read',0)} cache_write={c.get('write',0)}\")
    except: pass
"

# Healthy multi-turn pattern: cache_read grows ~monotonically across turns,
# cache_write per turn is bounded by the new tail delta (hundreds–low thousands)
```

`message.data` is the JSON-serialized assistant/user message (role, content, providerID, modelID, tokens, etc.). `session.directory` is the workspace path the session was started from. Tables: `session`, `message`, `part`, `todo`, `permission`, `event`, `account`.

---

## Project Structure

```
src/
├── index.ts              # createAnthropicSDK() factory, auth resolution, fetch wrapper
├── server.ts             # V1 plugin format wrapper (default export { id, server })
├── tui.tsx               # TUI plugin: sidebar usage widget + /usage command (SolidJS)
├── model.ts              # AnthropicSDKModel — LanguageModelV3 (doGenerate + doStream)
├── prompt.ts             # AI SDK prompt → Anthropic Messages API converter
├── stream.ts             # Anthropic SSE events → AI SDK LanguageModelV3StreamPart
├── tools.ts              # AI SDK tools → Anthropic format + schema cleanup
├── tool-names.ts         # Bidirectional tool name mapping (OpenCode ↔ Claude Code)
├── credentials.ts        # Claude Code OAuth credentials reader + CLI refresh
├── usage.ts              # Usage types, fetchUsage(), cachedUsage, formatReset()
├── cch.ts                # CCH request signing (xxHash64 body integrity hash)
├── credentials.test.ts   # Unit + integration tests for credentials
├── index.test.ts         # Tests for createAnthropicSDK factory
├── model.test.ts         # Integration tests for model (API calls)
├── cch.test.ts           # Tests for CCH computation
├── claudecode-system.txt  # Captured Claude Code base system prompt
└── fixtures/              # Captured OpenCode request data for caching tests
    └── opencode-tools.json

scripts/
├── dev-config.ts         # Generates .opencode/{opencode,tui}.json for local dev
└── cache-proxy.ts        # Logging proxy for api.anthropic.com — used to debug
                          # prompt-cache regressions (see "Intercept API requests")
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
8. **Single cache breakpoint on `messages[-1].content[-1]`** for OAuth multi-turn cache to hit. Matches Claude Code's wire format. See "Prompt Caching" in RESEARCH.md
9. **User message content must always be array-of-blocks**, never a plain string. Otherwise the same logical content gets different byte shapes turn-to-turn → cache miss

---

## Authentication Priority

1. Explicit `apiKey` option
2. `ANTHROPIC_API_KEY` env var
3. Auto-read from `~/.claude/.credentials.json` (Claude Code OAuth)

OAuth tokens use `Authorization: Bearer` with the `oauth-2025-04-20` beta. The billing system block in the system prompt is also required for Sonnet/Opus access.

---

## Testing Notes

- Integration tests use `claude-haiku-4-5-20251001` by default (cheapest model); thinking tests use `claude-sonnet-4-6`
- Prompt-caching tests require OAuth credentials with caching-capable routing (skipped under API key)
- Fixture files in `src/fixtures/` contain real captured OpenCode request data — don't modify them arbitrarily as the caching test depends on their size (~20K tokens)
- The `assert()` helper throws on failure; the `test()` wrapper catches and records

---

## Research

@RESEARCH.md
