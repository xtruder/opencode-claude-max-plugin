# Agent Guidelines — @xtruder/opencode-claude-max-plugin

An OpenCode provider plugin that routes requests through `@anthropic-ai/sdk` using Claude Code's OAuth credentials and exact request format.

---

## Build, Test, and Release

### Build

Requires Node.js 26.4+ and npm. Bun is only used to run `scripts/cache-proxy.ts`.

```bash
npm run build       # vite build + tsc declarations → build/
npm run dev         # vite build --watch (no declarations)
```

Vite bundles three ESM entrypoints — `build/index.js` (AI SDK provider), `build/server.js` (OpenCode plugin), `build/tui.js` (TUI) — plus shared chunks; keep `build/` together. Prompt `.txt` files are embedded as strings by the `prompt-text` plugin in `vite.config.ts` (it must return `moduleType: "js"`, otherwise Rolldown re-wraps the module and the prompt ships as `export default "..."` source; `build.test.ts` guards this). Always rebuild after any source change before testing via OpenCode.

### Type check, lint, format

```bash
npm run typecheck
npm run lint
npm run format:check     # npm run format to fix
```

### Run tests

```bash
npm test                                   # builds, then runs offline Vitest suite
npx vitest run src/cch.test.ts             # one file (build first if it touches build/)
npx vitest run src/cch.test.ts -t billing  # filter by name pattern
npm run test:live                          # also runs model.test.ts against the real API
npm run test:tui-smoke                     # isolated TUI check; needs opencode, uv
```

Tests use Vitest (`describe` / `test` / `expect` from `vitest`). `model.test.ts` is excluded unless `CLAUDE_LIVE_TESTS=1`; it consumes OAuth quota and requires `ANTHROPIC_API_KEY` or valid `~/.claude/.credentials.json`.

### Release

```bash
npm version patch                # bumps version, commits, and creates git tag automatically
git push origin main             # push the version commit
git push origin vX.Y.Z           # push the tag (use the version printed by npm version)
# GitHub Actions (.github/workflows/release.yml) publishes to npm; it can take
# a few minutes after the workflow succeeds before `npm view` shows the version
```

Installed copies update with `opencode plugin update`, then restart the server (`systemctl --user restart opencode.service`).

---

## Testing Locally with OpenCode

### Setup: load the local build

OpenCode v2 loads plugins as packages: point `plugins[].package` at the `build/` directory. Plain `opencode run` attaches to the background service, which runs the _installed_ npm plugin; use `--standalone` to get a private server that reads your config. The global config usually also loads the published `@xtruder/opencode-claude-max-plugin`, which wins over a local copy, so use an isolated config dir:

```bash
mkdir -p /tmp/opencode/xdg/opencode
echo "{\"plugins\":[{\"package\":\"file://$PWD/build\"}]}" > /tmp/opencode/xdg/opencode/opencode.json
export XDG_CONFIG_HOME=/tmp/opencode/xdg   # for the commands below
```

Rebuilding (`npm run build`) is enough between runs — no reinstall needed. A stale v1-style `.opencode/opencode.json` (`"plugin": [".../build/server.js"]`) is ignored by v2 with a "configured plugin path must be a directory" warning.

### Test a single prompt via CLI

```bash
# Uses ~/.claude/.credentials.json automatically
opencode run --standalone -m "anthropic-sdk/claude-haiku-4-5" "Say OK"
opencode run --standalone -m "anthropic-sdk/claude-sonnet-5" "What is 2+2?"
opencode run --standalone -m "anthropic-sdk/claude-opus-5-5" "What model are you?"
```

### Test with tool use

```bash
opencode run --standalone -m "anthropic-sdk/claude-haiku-4-5" "Read package.json and tell me the package name"
```

### Check usage

In the TUI, type `/usage` to open the usage dialog. The sidebar also shows live usage bars when the TUI plugin is loaded.

### Debug with logs

```bash
opencode run --standalone --print-logs --log-level debug -m "anthropic-sdk/claude-haiku-4-5" "Say OK" 2>&1 | grep -E "level=(WARN|ERROR)"
```

`--print-logs` only includes server logs with `--standalone`. "Model unavailable: anthropic-sdk/…" means the plugin did not load — check the WARN lines for the plugin path.

### Intercept API requests (compare with Claude Code)

Use the bundled logging proxy at `scripts/cache-proxy.ts`. It forwards to `api.anthropic.com` while logging per-request `cache_control` placement and per-response token usage (input, output, cache_read, cache_write). Useful for diagnosing prompt-cache regressions.

```bash
# Terminal 1: start proxy (defaults to :19827)
bun scripts/cache-proxy.ts                       # summary only
bun scripts/cache-proxy.ts -d                    # also dump request bodies
bun scripts/cache-proxy.ts -d -D -p 9000         # dump request + response bodies on :9000
bun scripts/cache-proxy.ts --help                # all options

# If port is stuck from a previous run:
pkill -f cache-proxy.ts                          # or: kill -9 $(lsof -ti :19827)

# Terminal 2: run OpenCode through proxy (--standalone so the env var reaches the server)
ANTHROPIC_BASE_URL=http://localhost:19827 opencode run --standalone -m "anthropic-sdk/claude-haiku-4-5" "Say OK"

# Or capture Claude Code's reference request (same env var). Run it from an empty
# dir; the capture is in req-NNN-<model>.json even if the CLI then stalls.
ANTHROPIC_BASE_URL=http://localhost:19827 claude -p --model claude-opus-5-5 "Say OK"

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
opencode run -m "anthropic-sdk/claude-opus-5-5" -c "Just say OK"

# Continue a specific session by id
opencode run -m "anthropic-sdk/claude-opus-5-5" --session ses_XXXX "Just say OK"

# Fork before continuing (creates a new session branched from the target)
opencode run -m "anthropic-sdk/claude-opus-5-5" --session ses_XXXX --fork "Just say OK"

# Pin a fresh session to a title (otherwise opencode auto-generates one)
opencode run -m "anthropic-sdk/claude-opus-5-5" --title "cache-repro" "First message"
```

**Caveat**: continuing a session that contains coding history will often cause the model to keep coding. For pure cache-behavior tests, either fork a clean session ("capital of France" style) or send a very explicit no-op instruction like `"Just say OK and nothing else. Do not write any code or edit any files."`

### Find sessions and inspect token usage in the OpenCode DB

OpenCode stores sessions in `~/.local/share/opencode/opencode.db` (SQLite). v2 data lives in `session_v2` and `session_message`; the v1 `session` / `message` / `part` tables only hold pre-migration history.

```bash
# List recent sessions (title, workspace directory)
sqlite3 ~/.local/share/opencode/opencode.db \
  "SELECT id, title, directory FROM session_v2 ORDER BY time_updated DESC LIMIT 30"

# Check token usage per assistant message for a session — verifies caching is hitting
sqlite3 ~/.local/share/opencode/opencode.db \
  "SELECT data FROM session_message WHERE session_id='ses_XXXX' AND type='assistant' ORDER BY seq DESC LIMIT 10" \
  | python3 -c "
import sys, json
for line in sys.stdin:
    try:
        d = json.loads(line)
        t = d.get('tokens', {}); c = t.get('cache', {}); m = d.get('model', {})
        print(f\"{m.get('providerID','?')}/{m.get('id','?')} input={t.get('input',0)} output={t.get('output',0)} cache_read={c.get('read',0)} cache_write={c.get('write',0)}\")
    except: pass
"

# Tool usage per model — e.g. to spot a model preferring Bash over Edit/Read
sqlite3 ~/.local/share/opencode/opencode.db "
  SELECT json_extract(s.data,'$.model.id'), json_extract(c.value,'$.name'), count(*)
  FROM session_message s, json_each(s.data,'$.content') c
  WHERE s.type='assistant' AND json_extract(c.value,'$.type')='tool'
  GROUP BY 1,2 ORDER BY 1, 3 DESC"

# Healthy multi-turn pattern: cache_read grows ~monotonically across turns,
# cache_write per turn is bounded by the new tail delta (hundreds–low thousands)
```

`session_message.type` is `user`, `assistant`, `system`, `synthetic`, `compaction`, or `idle`. Assistant `data` holds `model` (`{id, providerID, variant}`), `tokens`, and `content` — an array of `text` / `reasoning` / `tool` parts, where tool parts carry the OpenCode tool ID in `name` and `state.input` / `state.status`.

---

## Project Structure

```
src/
├── index.ts              # createAnthropicSDK() factory, auth resolution, fetch wrapper
├── server.ts             # OpenCode v2 plugin: registers provider/models, system-prompt hook
├── tui.tsx               # TUI plugin: sidebar usage widget + /usage command (SolidJS)
├── tui-state.ts          # TUI usage polling state
├── model.ts              # AnthropicSDKModel — LanguageModelV3 (doGenerate + doStream)
├── prompt.ts             # AI SDK prompt → Anthropic Messages API converter
├── stream.ts             # Anthropic SSE events → AI SDK LanguageModelV3StreamPart
├── tools.ts              # AI SDK tools → Anthropic format + schema cleanup
├── tool-names.ts         # Bidirectional tool name mapping (OpenCode ↔ Claude Code)
├── credentials.ts        # Claude Code OAuth credentials reader + CLI refresh
├── usage.ts              # Usage types, fetchUsage(), cachedUsage, formatReset()
├── pause-turn.ts         # pause_turn continuation handling
├── provider-metadata.ts  # Part metadata keys OpenCode v2 persists and replays
├── cch.ts                # Legacy CCH research utility (removed from CC 2.1.220 requests)
├── *.test.ts             # Vitest suites; model.test.ts hits the real API (opt-in)
├── claudecode-system*.txt # Distilled base and model-specific Claude Code prompts
└── fixtures/              # Captured OpenCode request data for caching tests
    └── opencode-tools.json

scripts/
├── tui-smoke.py          # Isolated TUI smoke test (npm run test:tui-smoke)
└── cache-proxy.ts        # Logging proxy for api.anthropic.com — used to debug
                          # prompt-cache regressions (see "Intercept API requests")
```

---

## Key Invariants

These must be maintained — they are load-bearing for Claude Code compatibility:

1. **Billing system block must be first** in `params.system` for OAuth requests — without it, Sonnet/Opus return HTTP 400
2. **Tool name mapping** is bidirectional: OpenCode v2 tool IDs ↔ Claude Code names (`shell`→`Bash`, `subagent`→`Agent`, `webfetch`→`WebFetch`, `websearch`→`WebSearch`, `read`→`Read`, …). The `toClaudeToolName()` / `toOpencodeToolName()` functions in `tool-names.ts` handle this. Unmapped IDs reach the model as-is; when OpenCode renames a tool, verify the outgoing `tools` list via the cache proxy
3. **MCP tools** follow `server_tool` → `mcp__server__tool` format. Server names are auto-detected from OpenCode config files
4. **`tool-input-start` id must equal `tool-call` toolCallId** — OpenCode's processor correlates them; mismatch causes "Tool execution aborted"
5. **Thinking signatures** from `signature_delta` stream events must be stored in part `providerMetadata` under `anthropic-sdk` (the key OpenCode v2 persists and replays as `providerOptions`) as well as `anthropic`, and passed back in conversation history. Use `anthropicMetadata()` / `readAnthropicMetadata()` from `provider-metadata.ts`
6. **`context-1m-2025-08-07` beta** is only added dynamically in the fetch wrapper when body exceeds 600K chars — never always-on (triggers billing check)
7. **`anthropic-ratelimit-unified-status: over_limit`** is the authoritative signal for subscription exhaustion — do not match on error message text
8. **Single cache breakpoint on `messages[-1].content[-1]`** for OAuth multi-turn cache to hit. Matches Claude Code's wire format. See "Prompt Caching" in RESEARCH.md
9. **User message content must always be array-of-blocks**, never a plain string. Otherwise the same logical content gets different byte shapes turn-to-turn → cache miss
10. **Claude 5 prompts are model-specific** — Sonnet 5, Sonnet 5.5, Opus 5, and Fable 5 use distinct distilled prompt files. Do not reuse one model's prompt for another. The explicit cyber-safety directive and dynamic environment/git-status tail are intentionally excluded; OpenCode appends its own environment and project instructions.

---

## Authentication Priority

1. Explicit `apiKey` option
2. `ANTHROPIC_API_KEY` env var
3. Auto-read from `~/.claude/.credentials.json` (Claude Code OAuth)

OAuth tokens use `Authorization: Bearer` with the `oauth-2025-04-20` beta. The billing system block in the system prompt is also required for Sonnet/Opus access.

---

## Testing Notes

- Live tests (`model.test.ts`) use Haiku 4.5 (cheapest model) for most cases, including thinking; one case covers `claude-sonnet-5`
- Thinking and prompt-caching tests require OAuth credentials and are skipped under an API key
- Fixture files in `src/fixtures/` contain real captured OpenCode request data — don't modify them arbitrarily as the caching test depends on their size (~20K tokens)

---

## Research

@RESEARCH.md
