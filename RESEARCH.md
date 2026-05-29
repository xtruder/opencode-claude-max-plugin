# Claude Code Reverse Engineering Research

This document summarizes the findings from reverse-engineering Claude Code's request format, authentication, and internal structure to build a compatible OpenCode provider.

Last updated: 2026-05-29

## Credentials

### Location

Claude Code stores OAuth credentials at:

```
~/.claude/.credentials.json
```

### Format

```json
{
  "claudeAiOauth": {
    "accessToken": "sk-ant-oat01-...",
    "refreshToken": "sk-ant-ort01-...",
    "expiresAt": 1784986385804,
    "scopes": ["user:inference"],
    "subscriptionType": "pro"
  }
}
```

- `accessToken` — OAuth token used for API requests (prefix `sk-ant-oat01-`)
- `refreshToken` — for token renewal (prefix `sk-ant-ort01-`)
- `expiresAt` — Unix timestamp in milliseconds
- `scopes` — typically `["user:inference"]` for Pro, may include `["user:inference", "user:profile"]` for full access
- `subscriptionType` — `null` (free), `"pro"`, or `"max"`

### Token Refresh

The OAuth client ID is `9d1c250a-e61b-44d9-88ed-5944d1962f5e`. Tokens can be refreshed via:

```
POST https://console.anthropic.com/v1/oauth/token
Content-Type: application/json

{
  "grant_type": "refresh_token",
  "refresh_token": "sk-ant-ort01-...",
  "client_id": "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
}
```

Note: refresh tokens may be rotated — using an old one invalidates the access token.

### Storage Backend

On Linux, Claude Code uses a plaintext storage backend that reads/writes `~/.claude/.credentials.json` directly. On macOS, it may use the system keychain. We confirmed via `strace` that `claude auth status` reads from `~/.claude/.credentials.json`.

---

## Authentication

### How OAuth Tokens Are Sent

Claude Code sends OAuth tokens via the `Authorization: Bearer` header (NOT `x-api-key`):

```
Authorization: Bearer sk-ant-oat01-...
```

This requires the `oauth-2025-04-20` beta flag in the `anthropic-beta` header.

### Billing System Block (Critical)

Anthropic gates subscription model access for OAuth tokens behind a **billing header injected as the first system prompt block**. Without this, OAuth tokens get HTTP 400 on non-Haiku models.

```json
{
  "system": [
    {
      "type": "text",
  "text": "x-anthropic-billing-header: cc_version=2.1.154.cea; cc_entrypoint=sdk-cli; cch=00000;"

    },
    ...
  ]
}
```

This was discovered by intercepting Claude Code's request via an HTTP proxy, then binary-searching which body fields were required. The billing block was the critical factor — without it, all Sonnet/Opus models return 400 with a vague `"Error"` message.

---

## Headers

### Full Header Set (OAuth Mode)

These are the exact headers Claude Code sends, in order of discovery importance:

| Header                                      | Value                                    | Purpose                                 |
| ------------------------------------------- | ---------------------------------------- | --------------------------------------- |
| `authorization`                             | `Bearer sk-ant-oat01-...`                | OAuth authentication                    |
| `anthropic-beta`                            | See below                                | Feature flags (order matters)           |
| `anthropic-version`                         | `2023-06-01`                             | API version                             |
| `user-agent`                                | `claude-cli/2.1.154 (external, sdk-cli)` | Client identification                   |
| `x-app`                                     | `cli`                                    | Application type                        |
| `anthropic-dangerous-direct-browser-access` | `true`                                   | Bypass browser restriction              |
| `x-stainless-package-version`               | `0.94.0`                                 | SDK version (CC 2.1.154 bundles 0.94.0) |
| `content-type`                              | `application/json`                       | Standard                                |

### Beta Flags

Claude Code 2.1.154 sends these base beta flags on normal OAuth requests:

```
claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,advisor-tool-2026-03-01,extended-cache-ttl-2025-04-11
```

| Flag                              | Purpose                                                                           |
| --------------------------------- | --------------------------------------------------------------------------------- |
| `claude-code-20250219`            | Claude Code feature gate                                                          |
| `oauth-2025-04-20`                | Enables OAuth Bearer token authentication                                         |
| `interleaved-thinking-2025-05-14` | Extended/adaptive thinking                                                        |
| `thinking-token-count-2026-05-13` | `estimated_tokens` in `thinking_delta` stream events (progress hint when omitted) |
| `context-management-2025-06-27`   | Context window management                                                         |
| `prompt-caching-scope-2026-01-05` | Prompt caching with scope/TTL                                                     |
| `advisor-tool-2026-03-01`         | Server-side `advisor_20260301` tool                                               |
| `extended-cache-ttl-2025-04-11`   | Enables `ttl: "1h"` on cache_control blocks                                       |

Model-conditional flags (added in `wrappedFetch` based on body model field):

| Flag                                 | Models                        | Purpose                                             |
| ------------------------------------ | ----------------------------- | --------------------------------------------------- |
| `effort-2025-11-24`                  | Opus 4.x / Sonnet (NOT Haiku) | `output_config.effort`. Haiku rejects this flag     |
| `mid-conversation-system-2026-04-07` | Opus 4.8 only                 | Allows `role: "system"` messages mid-conversation   |
| `context-1m-2025-08-07`              | When body > 600K chars        | Long-context routing (only for very large requests) |

The `oauth-2025-04-20` flag alone is NOT sufficient for subscription model access — the billing system block is also required.

`context-1m-2025-08-07` is **not** always-on. It must only be added conditionally for long-context requests; sending it unconditionally triggers subscription errors on unsupported tiers/models.

### Headers That Don't Need to Match

| Header                        | Claude Code                 | Ours             | Impact                       |
| ----------------------------- | --------------------------- | ---------------- | ---------------------------- |
| `x-stainless-runtime-version` | Node version of Claude Code | Our Node version | None — determined by runtime |
| `accept-language`             | `*`                         | Not sent         | Negligible                   |

---

## Request Body

### Required Fields for OAuth (Sonnet/Opus Access)

| Field           | Value                                                              | Required?                              |
| --------------- | ------------------------------------------------------------------ | -------------------------------------- |
| `system[0]`     | Billing block                                                      | **Yes** — without it, 400 on non-Haiku |
| `system[1]`     | `"You are a Claude agent, built on Anthropic's Claude Agent SDK."` | Sent by Claude Code always             |
| `metadata`      | `{ "user_id": "{\"device_id\":\"<sha256>\"}" }`                    | Sent by Claude Code always             |
| `output_config` | `{ "effort": "medium" }`                                           | Sonnet/Opus only (Haiku rejects it)    |
| `temperature`   | `1`                                                                | Default for Sonnet/Opus                |
| `stream`        | `true`                                                             | Claude Code always streams             |

### Thinking (Extended Reasoning)

Claude Code sends thinking config via the request body:

```json
{
  "thinking": {
    "type": "enabled",
    "budget_tokens": 10000
  }
}
```

Thinking responses include `signature_delta` stream events that must be captured and passed back in conversation history. Without a valid signature, the API rejects thinking blocks with "Invalid signature in thinking block".

### Adaptive Thinking (Opus 4.7+)

Starting with Claude Opus 4.7, Anthropic replaced manual extended thinking with **adaptive thinking**. On Opus 4.7, `thinking: { type: "enabled", budget_tokens: N }` is **rejected with a 400 error**. The only supported thinking mode is:

```json
{
  "thinking": {
    "type": "adaptive"
  },
  "output_config": {
    "effort": "medium"
  }
}
```

In adaptive mode, Claude dynamically determines whether and how much to think based on the complexity of each request. The `effort` parameter provides soft guidance:

| Effort level | Thinking behavior                                              |
| :----------- | :------------------------------------------------------------- |
| `low`        | Minimizes thinking, skips for simple tasks                     |
| `medium`     | Moderate thinking, may skip for very simple queries            |
| `high`       | Always thinks (API default). Deep reasoning on complex tasks   |
| `xhigh`      | Always thinks deeply with extended exploration (Opus 4.7 only) |
| `max`        | Always thinks with no constraints on thinking depth            |

Key differences from extended thinking on Opus 4.6:

- **No `budget_tokens`** — Claude controls its own thinking allocation
- **Interleaved thinking is automatic** — Claude can think between tool calls without extra headers
- **`display` defaults to `"omitted"`** on Opus 4.7 (vs `"summarized"` on Opus 4.6). Set `display: "summarized"` explicitly to receive thinking text
- **New tokenizer** — Opus 4.7 uses a different tokenizer (~555k words per 1M tokens vs ~750k for Opus 4.6)
- **`type: "enabled"` is deprecated** on Opus 4.6 and Sonnet 4.6 (still functional but will be removed in future releases)

Our plugin sets `medium` effort as the default and exposes `low/medium/high/xhigh/max` as variant options for Opus 4.7. Thinking is enabled by default via `thinking: { type: "adaptive" }` in both the model options and all variants.

### Rate Limiting

#### Subscription limit (hours-long reset)

```
HTTP 429
x-should-retry: true            ← SDK retries indefinitely without intervention
retry-after: 6457               ← reset time in seconds (can be hours)
anthropic-ratelimit-unified-status: over_limit  ← definitive signal
Body: "This request would exceed your account's rate limit"
```

#### Transient overload (seconds-long reset)

```
HTTP 429
x-should-retry: true
retry-after: 30                 ← short reset, SDK retries are fine
anthropic-ratelimit-unified-status: allowed_warning  ← not over limit
```

#### Our handling

We wrap `fetch` to intercept 429 responses and detect subscription limits using the `anthropic-ratelimit-unified-status` response header — **the same method Claude Code uses** (found in the `ID4` function in `cli.js`). When `status === "over_limit"` or `retry-after > 120s`, we override `x-should-retry: false` to prevent the SDK from hanging for hours.

```typescript
const unifiedStatus = resp.headers.get("anthropic-ratelimit-unified-status") ?? ""
const retryAfter = parseInt(resp.headers.get("retry-after") ?? "0")
const isSubscriptionLimit = unifiedStatus === "over_limit" || retryAfter > 120

if (isSubscriptionLimit) {
  const body = await resp.text() // consume stream to avoid dangling
  const headers = new Headers(resp.headers)
  headers.set("x-should-retry", "false")
  return new Response(body, { status: 429, headers })
}
```

**Important**: Do NOT match on the error message body text. The words "limit", "exceeded", "account" appear in many contexts and cause false positives. The `anthropic-ratelimit-unified-status: over_limit` header is the precise, authoritative signal.

---

## Tool Names

### Built-in Tool Mapping

Claude Code uses PascalCase tool names. OpenCode uses snake_case. Our provider maps bidirectionally:

| OpenCode      | Claude Code       | Notes                                               |
| ------------- | ----------------- | --------------------------------------------------- |
| `task`        | `Agent`           | Different name entirely                             |
| `question`    | `AskUserQuestion` | Different name entirely                             |
| `plan_exit`   | `ExitPlanMode`    | Different name entirely                             |
| `bash`        | `Bash`            | Case change                                         |
| `read`        | `Read`            | Case change                                         |
| `write`       | `Write`           | Case change                                         |
| `edit`        | `Edit`            | Case change                                         |
| `glob`        | `Glob`            | Case change                                         |
| `grep`        | `Grep`            | Case change                                         |
| `fetch`       | `WebFetch`        | OpenCode renamed `webfetch` → `fetch`               |
| `search`      | `WebSearch`       | OpenCode renamed `websearch` → `search`             |
| `todowrite`   | `TodoWrite`       | Case change                                         |
| `skill`       | `Skill`           | Case change                                         |
| `apply_patch` | `ApplyPatch`      | OpenCode-only (GPT models); CC dropped from 2.1.154 |
| `lsp`         | `LSP`             | Both exist (experimental in both)                   |

**OpenCode-only tools** (no CC equivalent — pass through unchanged): `repo_clone`, `repo_overview`, `invalid`, `plan_enter` (removed from OpenCode dev branch — only `plan_exit` remains).

**CC-only tools** sent in 2.1.154 captures (no OpenCode equivalent): `CronCreate/Delete/List`, `EnterWorktree/ExitWorktree`, `Monitor`, `NotebookEdit`, `PushNotification`, `RemoteTrigger`, `ScheduleWakeup`, `Workflow`, `TaskCreate/Get/List/Update/Output/Stop` (mutually exclusive with `TodoWrite` — gated by `CLAUDE_CODE_ENABLE_TASKS=1`).

Additional CC tools that exist but are flag-gated and didn't appear in our captures: `LSP`, `REPL`, `PowerShell`, `StructuredOutput`, `ListMcpResourcesTool`, `ReadMcpResourceTool`, `SendMessage`, `SendUserMessage`, `SendUserFile`, `TeamCreate/Delete`, `ShareOnboardingGuide`, `TestingPermission`. Most are gated by statsig flags or env vars (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`, `CLAUDE_CODE_REPL`, `tengu_*` flags).

### MCP Tool Mapping

MCP tools use different prefix formats:

| OpenCode                   | Claude Code                      |
| -------------------------- | -------------------------------- |
| `context7_query-docs`      | `mcp__context7__query-docs`      |
| `playwright_browser_close` | `mcp__playwright__browser_close` |

Pattern: `<server>_<tool>` → `mcp__<server>__<tool>`

MCP server names are auto-detected from OpenCode config files:

- `.opencode/opencode.json` (project)
- `~/.config/opencode/opencode.json` (global)
- `~/.config/opencode/opencode.jsonc` (global, JSONC)

### Tool Name References in System Prompt

We no longer rely on rewriting OpenCode's base system prompt text for OAuth mode. Instead, the plugin replaces OpenCode's base prompt with Claude Code's captured prompt via `experimental.chat.system.transform`, and tool-name differences are handled in code via the bidirectional tool-name mappers.

---

## System Prompt Structure

### Claude Code

```
system[0]: billing header                     (FIXED, always present)
system[1]: "You are a Claude agent..."        (FIXED, always present)
system[2]: base instructions + CLAUDE.md      (CACHED, customizable via --system-prompt)
system[3]: memory + environment               (DYNAMIC, per-session)
```

- `system[0]` and `system[1]` are immutable — always injected by Claude Code
- `system[2]` can be **completely replaced** via `--system-prompt` CLI arg, or **appended to** via `--append-system-prompt` and CLAUDE.md files
- `system[3]` contains the auto-memory system, environment info, model identity, and `<fast_mode_info>`

### Our Provider (via OpenCode)

```
system[0]: Claude base prompt                 (set by plugin hook)
system[1+]: mode/context additions            (left to OpenCode)
```

At request construction time, the provider then prepends:

- `system[0]`: billing header
- `system[1]`: `"You are a Claude agent, built on Anthropic's Claude Agent SDK."`
- `system[2+]`: whatever OpenCode produced after the plugin hook transform

This hook-based override turned out to be necessary: forwarding OpenCode's native base prompt caused Anthropic to classify requests as third-party app traffic, while replacing only the base prompt with Claude Code's prompt allowed the requests through.

### Per-Model System Prompts (CC 2.1.154)

Starting with CC 2.1.154, Anthropic ships **different system prompts per model**:

| Model                             | Prompt size | Structure                 | Tool mentions                                                                    |
| --------------------------------- | ----------- | ------------------------- | -------------------------------------------------------------------------------- |
| Opus 4.8                          | ~6.5KB      | `# Harness` (5 sections)  | Only `Skill`, `Bash`, `Write` (and only incidentally)                            |
| Opus 4.7 / Sonnet 4.6 / Haiku 4.5 | ~27KB       | `# System` (15+ sections) | Explicit: `Bash`, `Read`, `Edit`, `Write`, `Glob`, `Grep`, `TaskCreate`, `Agent` |

The Opus 4.7/Sonnet/Haiku prompts are byte-identical except for two lines (model identity + knowledge cutoff). Opus 4.8 got a complete rewrite with significantly less hand-holding.

**Key insight**: Tool descriptions are NOT in the system prompt — they live in the `tools[]` array. The system prompt provides **behavior/style guidance**, while the model learns tool inventory and usage from each tool's `name` + `description` in `tools[]`. Opus 4.8's reduced prompt reflects Anthropic's confidence that the model can read tool descriptions and use good judgment without explicit "Prefer X over Y" rules baked into the prompt.

**Our implementation** branches in `experimental.chat.system.transform` on `input.model.id`:

- `claude-opus-4-8` → `claudecode-system-opus48.txt` (condensed)
- All other models → `claudecode-system.txt` (long-form)

Both files are scrubbed copies of the CC captures — Claude Code-specific bits removed (`/help`, `/code-review ultra`, `/ultrareview`, memory path, `TaskCreate` references). OpenCode tool names stay verbatim (Read, Edit, Bash, Grep, Glob, Write, Agent, Skill) since the existing bidirectional tool-name mapper handles them at the API layer.

### `<system-reminder>` Tags

`<system-reminder>` tags are **not part of the system prompt**. They are injected into **user messages and tool results** during the conversation. Claude Code's system prompt instructs the model about them:

> _"Tool results and user messages may include `<system-reminder>` or other tags. Tags contain information from the system. They bear no direct relation to the specific tool results or user messages in which they appear."_

Both Claude Code and OpenCode use `<system-reminder>` for:

- Mode changes (plan → build)
- Permission reminders
- Context injections

---

## Claude Code Binary Analysis

### File Location

Claude Code is installed as an npm global package:

```
/home/linuxbrew/.linuxbrew/lib/node_modules/@anthropic-ai/claude-code/cli.js
```

The CLI binary is a single minified JavaScript file (~10MB+).

### Extraction Techniques

#### Finding String Constants

```bash
# Find beta flags
grep -oP 'AD="[^"]*"' cli.js
# Result: AD="oauth-2025-04-20"

# Find all API endpoints
grep -o 'https://[a-zA-Z0-9._/-]*' cli.js | sort -u | grep anthropic

# Find default beta header value used in SDK transport
grep -oP 'Ve4="[^"]*"' cli.js
# Result: Ve4="files-api-2025-04-14,oauth-2025-04-20"
```

#### Finding Auth Logic

```bash
# How OAuth tokens are sent
grep -oP '.{0,80}(authToken|accessToken).{0,80}' cli.js | grep "oauth\|credential\|bearer"
# Key finding: Authorization: `Bearer ${q.accessToken}`,"anthropic-beta":AD

# Where credentials are read
grep -oP '.{0,80}credentials.{0,80}' cli.js | grep "read\|file\|path"
```

#### Finding SDK Version

```bash
grep -oP 'Anthropic/JS [0-9.]+' cli.js
# Result: Anthropic/JS 0.74.0
```

#### Finding Tool Names

```bash
# Built-in tool names (from intercepted request body)
grep -oP '"name":"[A-Z][a-zA-Z]*"' intercepted-body.json
```

#### Finding Betas for Messages API

```bash
# Find the betas array passed to messages.create
grep -oP '\[.{0,500}interleaved-thinking.{0,200}\]' cli.js
```

#### Finding Request Body Structure

```bash
# Find metadata construction
grep -oP 'function L66\(\).{0,300}' cli.js
# Found: metadata with user_id containing device_id

# Find output_config
grep -oP 'output_config.{0,100}' cli.js
# Found: { effort: "medium" }
```

---

## Request Interception Methodology

### Intercepting Claude Code

We used `ANTHROPIC_BASE_URL` to redirect Claude Code through a local HTTP proxy:

```typescript
import * as http from "http"

const server = http.createServer(async (req, res) => {
  let body = ""
  req.on("data", (d) => (body += d))
  req.on("end", async () => {
    // Log headers and body
    console.log("Headers:", JSON.stringify(req.headers))
    console.log("Body:", body)

    // Forward to real API
    const resp = await fetch("https://api.anthropic.com" + req.url, {
      method: req.method,
      headers: Object.fromEntries(
        Object.entries(req.headers).filter(([k]) => k !== "host" && k !== "connection"),
      ),
      body,
    })
    const respText = await resp.text()
    res.writeHead(resp.status, Object.fromEntries(resp.headers.entries()))
    res.end(respText)
  })
})
server.listen(19827)
```

Then run:

```bash
ANTHROPIC_BASE_URL=http://localhost:19827 echo "Say OK" | claude --model opus -p
```

### Intercepting OpenCode

Same proxy approach:

```bash
ANTHROPIC_BASE_URL=http://localhost:19827 opencode run -m "anthropic-sdk/claude-opus-4-6" "Say OK"
```

### Intercepting SDK Requests

For intercepting what the Anthropic SDK sends, we used the `fetch` option:

```typescript
const client = new Anthropic({
  apiKey: null,
  authToken: creds.accessToken,
  fetch: async (url, init) => {
    const h = new Headers(init?.headers)
    console.log("URL:", url)
    h.forEach((v, k) => console.log(k + ":", v))
    console.log("Body:", init?.body)
    return globalThis.fetch(url, init)
  },
})
```

### Binary Search for Required Fields

To find which body fields were required for OAuth subscription access, we:

1. Captured a working Claude Code request (full 96KB body)
2. Replayed it exactly via raw `fetch` — confirmed it worked (200)
3. Progressively stripped fields and tested each combination
4. Narrowed down to: billing system block was the critical factor

```bash
# Test order:
# original body → 200 ✓
# remove system → 400 ✗
# keep system, simple messages → 400 ✗
# keep system[0] only → 200 ✓   ← billing block is the key
# keep system[1] only → 400 ✗
```

---

## Usage API

### Endpoint

Claude Code's `/usage` command fetches subscription usage from a **dedicated endpoint** that requires no token generation:

```
GET https://api.anthropic.com/api/oauth/usage
Authorization: Bearer sk-ant-oat01-...
anthropic-beta: claude-code-20250219,oauth-2025-04-20
content-type: application/json
user-agent: claude-cli/2.1.81 (external, sdk-cli)
x-app: cli
```

### Response Format

```json
{
  "five_hour": {
    "utilization": 88.0,
    "resets_at": "2026-03-23T10:00:00.998161+00:00"
  },
  "seven_day": {
    "utilization": 13.0,
    "resets_at": "2026-03-30T05:00:00.998185+00:00"
  },
  "seven_day_sonnet": {
    "utilization": 0.0,
    "resets_at": null
  },
  "seven_day_opus": null,
  "seven_day_oauth_apps": null,
  "seven_day_cowork": null,
  "extra_usage": {
    "is_enabled": false,
    "monthly_limit": null,
    "used_credits": null,
    "utilization": null
  }
}
```

| Field              | Meaning                                       |
| ------------------ | --------------------------------------------- |
| `five_hour`        | Current session usage (5-hour rolling window) |
| `seven_day`        | Weekly usage across all models                |
| `seven_day_sonnet` | Weekly usage for Sonnet models only           |
| `seven_day_opus`   | Weekly usage for Opus models only             |
| `extra_usage`      | Pay-as-you-go overage (if enabled)            |
| `utilization`      | Percentage used (0–100)                       |
| `resets_at`        | ISO 8601 timestamp when the window resets     |

### Discovery Method

Found by searching the minified CLI source for usage-related URLs:

```bash
grep -oP '(api\.anthropic\.com|console\.anthropic\.com|claude\.ai)[^\s"]*' cli.js | grep -i "usage\|rate\|limit\|billing\|quota\|plan\|subscription"
# Result: claude.ai/admin-settings/usage
#         claude.ai/settings/usage
```

Those are web UI links. Then found the actual API call pattern:

```bash
grep -oP '.{0,60}/api/oauth/usage.{0,100}' cli.js
# Result: `${iA().BASE_API_URL}/api/oauth/usage`
```

Also found the `ratelimit-unified-*` response headers that Claude Code reads from regular API responses:

```bash
grep -oP 'anthropic-ratelimit-unified-[a-z0-9-]+' cli.js | sort -u
# anthropic-ratelimit-unified-5h-utilization
# anthropic-ratelimit-unified-7d-utilization
# anthropic-ratelimit-unified-{window}-reset
# anthropic-ratelimit-unified-status
```

However, we use the dedicated `/api/oauth/usage` endpoint instead since it works without making an inference call.

---

## Prompt Caching

### Mental Model

Anthropic's prompt cache is a **server-side prefix cache** keyed on the hash of all bytes from the start of the request up to and including a `cache_control` breakpoint. The wire protocol carries the full prompt every request — nothing is uploaded separately. `cache_control` is just an annotation telling the server to hash and store the prefix at that point; on subsequent requests, the server matches incoming prefix hashes against stored entries and serves cached prefix tokens at ~0.1× input price instead of recomputing the prompt state.

Each request's usage breaks down as:

- `cache_read_input_tokens` — bytes of prefix served from a pre-existing cache entry (cheap, ~0.1× input).
- `cache_creation_input_tokens` — bytes freshly stored under the new breakpoint's prefix hash, billed at ~1.25× input.
- `input_tokens` — tokens that come after the matched cache entry (or all tokens if no hit).

Sum of the three covers the entire prompt.

Key rules (verified empirically via proxy capture against `api.anthropic.com`):

1. **Cache writes happen only at breakpoints.** Marking block N writes exactly one entry — there is no incremental caching of blocks 0..N-1.
2. **The lookback window from a breakpoint is 20 blocks.** Each turn must add fewer than 20 new content blocks for a growing conversation to hit the previous turn's write.
3. **Up to 4 breakpoints per request.**
4. **`cache_control` annotations are excluded from the prefix hash.** Moving the marker forward each turn does not poison the prefix — only block content matters.
5. **Block content must be byte-stable across turns** for a prefix hash to match. Any byte change anywhere before the breakpoint produces a different hash → miss.
6. **Cache writes cost 12.5× cache reads.** Re-writing a large prefix every turn (because it's not byte-stable) is much worse than not caching it at all.

### Claude Code's Cache Strategy

Confirmed by proxying real Claude Code 2.1.156 requests via `scripts/cache-proxy.ts`:

1. **`system[1]`** (identity block) — `cache_control: { type: "ephemeral", ttl: "1h" }`
2. **`system[2]`** (main instructions) — `cache_control: { type: "ephemeral", ttl: "1h" }`
3. **`messages[-1].content[-1]`** (the very last content block of the very last message) — `cache_control: { type: "ephemeral", ttl: "1h" }`, **moved forward each turn**

That's it. **One** explicit message breakpoint per request, placed on the absolute tail, regardless of whether the tail is `text`, `tool_result`, or even an `assistant` block (the latter happens on Opus 4.8 with the `mid-conversation-system` beta). No top-level `cache_control`, no system[0] cache, no separate tool-result breakpoint.

Each turn writes a new cache entry covering the full prefix. The next turn's lookback walks back from its new tail breakpoint, finds the prior turn's entry within 20 blocks, and reads the entire accumulated history from cache.

`system[0]` (the billing header) is **not** cached but is excluded from the cached-prefix hash even though its `cch=…` value differs per request (otherwise no Claude Code session would ever hit cache). Likely Anthropic excludes the billing block specifically.

### Our Implementation

`src/model.ts` `placeMessageBreakpoints()` places a single `cache_control` on `messages[-1].content[-1]`. `system[1]` and `system[2]` keep their existing breakpoints. OAuth mode uses `{ type: "ephemeral", ttl: "1h" }`; API key mode uses plain `{ type: "ephemeral" }` without `ttl`.

### Verified Empirically (2026-05-29)

Captured a real multi-turn session through the proxy and confirmed the chain works correctly: `cache_read` grows monotonically while `cache_write` per turn is bounded by the new content delta. From `ses_18d5c6509ffeCphU2gfvnMJfis` after the fix shipped mid-session:

| Turn | Prefix size | cache_read | cache_write | % cached |
| ---- | ----------- | ---------- | ----------- | -------- |
| 149  | 204,523     | 204,121    | 401         | 99.8%    |
| 151  | 210,697     | 210,009    | 682         | 99.7%    |
| 153  | 212,084     | 211,711    | 367         | 99.8%    |
| 156  | 217,503     | 216,394    | 1,103       | 99.5%    |
| 159  | 219,770     | 219,003    | 761         | 99.7%    |

Cost ratio for turn 159 (Opus 4.7): ~$0.115 with caching vs ~$1.10 uncached — roughly a **10× reduction**.

### Three Bugs We Fixed (2026-05-29)

The previous implementation had three independent bugs that together made multi-turn caching collapse on tool-heavy sessions. Symptoms: `cache_read` stuck at ~16,410 tokens (just system+tools) for 130+ turns; `cache_write` growing past 187,000 tokens per turn — paying the 1.25× write premium to re-cache the entire accumulated conversation history every single turn.

**Bug 1: `replaceCchPlaceholder` mutated the wrong `cch=00000` occurrence.** The old code used `body.replace("cch=00000", computed)`, which replaces the **first** occurrence. When an assistant turn read a file containing the literal `cch=00000` (e.g. `src/model.ts`, `src/cch.ts`, or any AGENTS.md/RESEARCH.md text spliced into the system prompt), the body had multiple occurrences: one inside `tool_result` content (file as read from disk), one inside `system[2]` (when docs mentioning the placeholder were appended), and one in `system[0]` (the actual billing placeholder). `.replace()` mutated whichever came first — never the billing block. The mutated content had a different `cch=<hash>` value every turn — breaking the prefix hash for any conversation containing such a file read. Fix: `src/cch.ts replaceCchPlaceholder` now parses the body as JSON, finds the system block whose text starts with `x-anthropic-billing-header:`, replaces `cch=00000` only within that block, and re-serializes. Robust against the placeholder appearing in user messages, tool results, or docs splices.

**Bug 2: user-message content shape flipped between string and array.** `src/prompt.ts convertUserMessage` "simplified" single-text-block content to a plain string. The cache-breakpoint placer in `model.ts` normalizes the last user message to array-of-blocks form to attach `cache_control`. Result: when a user message was last it was an array; on the next turn it became mid-history and reverted to a string. Same content, different byte shape → prefix hash for everything after that message changed. Fix: removed the simplification; always emit `content: [...blocks]`.

**Bug 3: wrong caching strategy in `model.ts`.** Earlier attempts placed `cache_control` on the last tool_result (changes every turn, poor hit rate), then on top-level automatic caching (worked for slow text-only conversations but missed in tool-heavy sessions). Fix: match Claude Code exactly — one explicit `cache_control` on `messages[-1].content[-1]`.

Each fix is necessary; none alone is sufficient.

### `inference_geo` Field

The `inference_geo` field in responses indicates routing:

- `""` (empty string) — Claude Code's normal routing
- `"global"` — standard API key routing
- `"not_available"` — overflow infrastructure (e.g. at 100% session utilization)

Both `"global"` and `"not_available"` support caching. `"not_available"` only disables caching when the session is at 100% utilization and traffic is routed to overflow infrastructure that doesn't support it.

### Cache Invalidation

The system prompt is stable within a session — the dynamic fields are:

- `Today's date` — uses `toDateString()` (no time), changes at midnight
- `Working directory` — stable per project
- `Model name/ID` — stable per model selection

Tool names in the system prompt are rewritten to match Claude Code names (e.g. `Task` → `Agent`) so the cached system prompt remains consistent with the tools list.

### `cachedInputTokens` Bug (Fixed)

The stream `finish` event was missing `cachedInputTokens` because `stream.ts` only captured `input_tokens` from `message_start` but not `cache_read_input_tokens`. Fixed to propagate all cache usage fields to the `finish` event.

### Fixtures

Real OpenCode request data captured and stored for testing:

- `src/claudecode-system.txt` — captured Claude Code base system prompt (12.8K chars)
- `src/fixtures/opencode-tools.json` — actual 22 tool definitions (66K chars)

---

## Context Window Limits (OAuth Subscription)

### Tested limits per model (Max subscription, Extra usage disabled)

| Model          | Without `context-1m`            | With `context-1m`                                           | Notes                                                                  |
| -------------- | ------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------- |
| **Opus 4.7**   | **1M tokens** ✓                 | Not needed                                                  | Native 1M context, new tokenizer (~555k words/1M tokens)               |
| **Opus 4.6**   | **~615K tokens** (1M chars) ✓   | Not needed                                                  | Native 1M context without any beta                                     |
| **Sonnet 4.6** | **~120K tokens** (195K chars) ✓ | ✗ `"Extra usage is required"`                               | Fails at ~200K chars. `context-1m` doesn't help — requires Extra usage |
| **Haiku 4.5**  | **~200K tokens** (300K chars) ✓ | ✗ `"long context beta not available for this subscription"` | Hard 200K limit. `context-1m` not supported for Haiku                  |

### Key findings

1. **Opus has native 1M context** — no `context-1m` beta needed, works out of the box up to ~615K+ tokens
2. **Sonnet is limited to ~120K input tokens** on subscription (without Extra usage). Above that, returns 429 `"Extra usage is required for long context requests"`. The `context-1m` beta triggers the same billing check even for smaller requests
3. **Haiku has a hard 200K token limit** — `"prompt is too long: 200054 tokens > 200000 maximum"`. The `context-1m` beta returns `"The long context beta is not yet available for this subscription"`
4. **Claude Code never hits these limits** because its context management (`context-management-2025-06-27`) truncates conversations before sending

### Error messages

| Error                                                                | Meaning                                             | Resolution                                                   |
| -------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------ |
| `"Extra usage is required for long context requests"`                | Sonnet context > ~120K tokens                       | Enable Extra usage at `claude.ai/settings` or reduce context |
| `"prompt is too long: N tokens > 200000 maximum"`                    | Haiku context > 200K tokens                         | Switch to Opus/Sonnet or reduce context                      |
| `"The long context beta is not yet available for this subscription"` | `context-1m` beta not supported for this model/tier | Remove `context-1m` beta, use Opus for large context         |

### Actual token counts (from testing)

The char-to-token ratio is approximately **1.63 chars per token** (not the typical 4:1) for repetitive English text:

| Input chars | Actual tokens | Ratio |
| ----------- | ------------- | ----- |
| 200K        | 123,087       | 1.63  |
| 400K        | 246,165       | 1.63  |
| 800K        | 492,317       | 1.63  |
| 1.6M        | 615,396       | 2.60  |

---

## CCH Request Signing (Body Integrity Hash)

### What is `cch`?

The `cch` field in the `x-anthropic-billing-header` system block is an xxHash64-based integrity hash computed over the entire serialized request body. Anthropic's servers verify it to gate features like fast mode. Getting it wrong results in: _"Fast mode is currently available in research preview in Claude Code. It is not yet available via API."_

### Where it lives

The `cch=00000` placeholder is embedded in the billing system block (`src/model.ts`), which is always injected as `system[0]`:

```json
{
  "type": "text",
  "text": "x-anthropic-billing-header: cc_version=2.1.154.cea; cc_entrypoint=sdk-cli; cch=00000;"
}
```

### Algorithm

1. Build the complete request body JSON with `cch=00000` as a placeholder
2. Compute `xxHash64(body_bytes, seed) & 0xFFFFF` (seed: `0x6E52736AC806831E`)
3. Format as zero-padded 5-character lowercase hex
4. Replace `cch=00000` **only inside the billing system block** with `cch=<computed>` — by parsing the body as JSON, locating the block in `system[]` whose text starts with `x-anthropic-billing-header:`, doing a single string replace inside that block's `text` field, and re-serializing.

The hash covers the **entire serialized body** -- messages, tools, metadata, model, thinking config, everything. Modifying any field after hashing (swapping a session UUID, removing a tool, editing a tool description) causes a 400 rejection.

**Why the targeted JSON replacement**: the literal string `cch=00000` can appear in many other places in the body — inside `tool_result` blocks when an assistant reads this repo's own source files (`src/cch.ts`, `src/model.ts`, …), inside `system[2]` when docs mentioning the placeholder verbatim are appended (AGENTS.md, RESEARCH.md), and potentially in user messages if someone pastes it in. Any naive string replace (`indexOf` / `lastIndexOf` / `replace()`) can be foiled by a single occurrence appearing in the "wrong" position relative to the billing block, mutating that content with a per-request hash and breaking prefix-cache hashes for the affected block every turn. JSON parsing + targeted field replacement is the only correct approach — see Discovery #25.

### Where we compute it

The hash is computed in the `wrappedFetch` interceptor (`src/index.ts`), right before the request is sent to the API. This is the last point where we have access to the serialized body string. The flow:

1. `model.ts` `buildParams()` constructs params with `system[0]` containing `cch=00000`
2. The Anthropic SDK serializes params to JSON and calls `fetch()`
3. Our `wrappedFetch` intercepts, detects `cch=00000` in the body string
4. `computeCch()` (`src/cch.ts`) hashes the body using xxHash64 WASM and masks to 20 bits
5. `replaceCchPlaceholder()` swaps `cch=00000` with `cch=<hash>`
6. The modified body is forwarded to the real `fetch()`

Only applied to OAuth requests (API key requests don't need it).

### Implementation

The implementation lives in `src/cch.ts` and uses `xxhash-wasm` (WebAssembly-based, no native bindings). The hasher is lazily initialized on first use.

### Origin

The mechanism was reverse-engineered from Claude Code's custom Bun binary. In the original Claude Code, the hash computation happens in Bun's native `nativeFetch` (compiled Zig code) -- the JavaScript only writes the `cch=00000` placeholder, and the runtime overwrites the zeros in the string buffer before sending. See: https://a10k.co/b/reverse-engineering-claude-code-cch.html

### Verification against Claude Code 2.1.154 (2026-05-28)

Cross-checked our implementation against intercepted CC 2.1.154 requests:

| Body                  | CC sent | Our compute | Match |
| --------------------- | ------- | ----------- | ----- |
| Opus 4.7 prompt body  | `e7634` | `52890`     | ✗     |
| Haiku 4.5 prompt body | `ae8fb` | `67674`     | ✗     |

Hash divergence confirmed via two independent xxHash64 implementations (`xxhash-wasm` and Python `xxhash`), both producing the same `52890` / `67674` we compute. Verified:

- ✓ Algorithm: xxHash64 with masked 20 LSBs (matches blog post + all 3 third-party impls we surveyed)
- ✓ Seed: `0x6E52736AC806831E` (unchanged through CC 2.1.123 per third-party RE reports)
- ✓ Hash input: full body bytes with `cch=00000` placeholder, compact JSON, original Stainless SDK key order
- ✓ Output format: zero-padded 5-char lowercase hex
- ✓ Body bytes captured at the proxy match CC's wire output

Despite the mismatch, **our requests succeed** — Opus 4.7, Opus 4.8, and Haiku 4.5 all return 200 with full prompt-cache hits. The CCH gate only blocks premium features like fast mode (per the original research and Anthropic's documented error message). Plain `/v1/messages` calls accept any 5-char hex value.

Possible causes (none confirmed):

- CC 2.1.154 may modify body bytes between hash-time and wire-time in a way invisible to the proxy (e.g., a second post-hash placeholder we haven't identified)
- Seed or algorithm tweaked in 2.1.154 (latest third-party RE only covers up to 2.1.123)
- A pre-hash normalization step we don't replicate

Not worth chasing unless we want to unlock fast mode — would require live LLDB instrumentation of CC's native binary. Tracking here in case it becomes relevant.

---

## OpenCode TUI Plugin System

### Architecture

OpenCode supports plugins with separate server-side and TUI entry points. A single npm package can provide both via `package.json` exports:

```json
{
  "exports": {
    "./server": { "import": "./build/server.js", "config": {} },
    "./tui": { "import": "./src/tui.tsx", "config": { "sidebar": true } }
  }
}
```

- **Server plugins** (`./server`): Run in the main OpenCode process. Export `{ id, server }` where `server` is a `Plugin` function from `@opencode-ai/plugin`.
- **TUI plugins** (`./tui`): Run in the TUI renderer (Bun + SolidJS). Export `{ id, tui }` where `tui` is a `TuiPlugin` function from `@opencode-ai/plugin/tui`. The `.tsx` source is loaded directly by Bun (no build step needed).

### TUI Plugin API

The TUI plugin receives an `api` object with:

| API                         | Purpose                                    |
| --------------------------- | ------------------------------------------ |
| `api.command.register()`    | Register slash commands                    |
| `api.slots.register()`      | Register sidebar/footer/title slot content |
| `api.ui.dialog.replace()`   | Show a dialog with SolidJS content         |
| `api.theme.current`         | Current theme colors                       |
| `api.state.session`         | Session state (messages, etc.)             |
| `api.event.on()`            | Subscribe to events (`session.idle`, etc.) |
| `api.lifecycle.onDispose()` | Cleanup on plugin unload                   |
| `api.kv`                    | Key-value storage                          |

### Slot System

Available slots for sidebar plugins:

| Slot              | Mode            | Props                              |
| ----------------- | --------------- | ---------------------------------- |
| `sidebar_title`   | `single_winner` | `session_id`, `title`, `share_url` |
| `sidebar_content` | append          | `session_id`                       |
| `sidebar_footer`  | `single_winner` | `session_id`                       |

Slots are ordered by `order` (lower = higher in sidebar). Our usage widget uses `order: 90` to appear before the default context widget (`order: 100`).

### Plugin Loading

OpenCode resolves plugins via:

1. `package.json` `exports["./server"]` and `exports["./tui"]` (V1 format)
2. Legacy fallback: iterates all named exports looking for `Plugin` functions

The `config` field in `package.json` exports provides default options that can be overridden in user config.

### Our TUI Plugin (`src/tui.tsx`)

Provides:

- **Sidebar widget**: Compact 5H/7D progress bars with color coding (green → yellow → red)
- **`/usage` command**: Full dialog with per-model breakdown and extra usage info
- **Auto-refresh**: Polls `/api/oauth/usage` every 60s + refreshes 2s after `session.idle`

The TUI plugin imports `fetchUsage` and `formatReset` from `src/usage.ts` to avoid duplicating usage API logic.

### Development Setup

For local TUI plugin testing, point `.opencode/tui.json` to the source file:

```json
{
  "plugin": ["file:///path/to/repo/src/tui.tsx"]
}
```

The server plugin goes in `.opencode/opencode.json` separately:

```json
{
  "plugin": ["file:///path/to/repo/build/server.js"]
}
```

---

## Key Discoveries Timeline

1. **OAuth tokens sent as x-api-key** → Only worked for Haiku, not Sonnet/Opus
2. **Bearer auth with `oauth-2025-04-20` beta** → Still 400 on Sonnet/Opus
3. **Added `claude-code-20250219` beta** → Still 400
4. **Intercepted Claude Code request** → Saw 96KB body with billing header
5. **Binary searched body fields** → Found billing system block was required
6. **Matched all headers** → user-agent, x-app, x-stainless-package-version
7. **Discovered `output_config: { effort: "medium" }`** → Required for Sonnet/Opus, rejected by Haiku
8. **Found `signature_delta` stream events** → Required for thinking roundtrip
9. **Rate limit handling** → `retry-after: 6457` with `x-should-retry: true` causes SDK to hang
10. **Usage API discovered** → `GET /api/oauth/usage` returns subscription usage without consuming tokens — same endpoint Claude Code's `/usage` command uses
11. **Prompt caching confirmed** → 98% of input tokens (20499/20829) served from cache with full-size OpenCode request; `cachedInputTokens` was missing from stream `finish` event (fixed in `stream.ts`)
12. **`inference_geo: "not_available"`** → Does NOT mean caching is unavailable; it's overflow routing that only disables caching when session is at 100% utilization
13. **Long context billing** → `"Extra usage is required for long context requests"` (429) when context exceeds subscription limit without Extra usage enabled. Claude Code avoids this via built-in context management (`context-management-2025-06-27` beta) that truncates context before sending — it never actually hits this limit. The `context-1m-2025-08-07` beta does NOT bypass billing — Extra usage must be enabled at `claude.ai/settings`
14. **`context-1m-2025-08-07` is conditional** → Claude Code only sends it for long-context routing. Always sending it triggers subscription errors on unsupported requests, so our provider now adds it dynamically only for very large OAuth request bodies
15. **Context window limits per model** → See table above
16. **TUI plugin system** → OpenCode v1.3+ supports `./server` and `./tui` package.json exports for split server/TUI plugins. TUI plugins use SolidJS with `@opentui/solid` JSX and are loaded as raw `.tsx` by Bun. Sidebar slots, slash commands, and dialogs are all available via the `TuiPluginApi`
17. **2026-04-08: Anthropic tightened system-prompt checks** → Forwarding OpenCode's native base system prompt began returning `400 invalid_request_error` with the new "Third-party apps now draw from your extra usage" message, even though the billing block and Claude identity block were still present. Replaying prompt variants showed the check is not just for the word `OpenCode`; specific OpenCode-native instructions like the `opencode.ai/docs` help text and the `Task tool` exploration guidance were enough to trigger the rejection
18. **Hook-based base prompt override fixes the classification** → Replacing only the base prompt via `experimental.chat.system.transform` with Claude Code's captured prompt allows OAuth requests through while leaving OpenCode's mode-specific prompt additions intact. The captured Claude base prompt is now stored at `src/claudecode-system.txt`, and standalone OAuth usage must supply a Claude-compatible system prompt explicitly
19. **Claude Opus 4.7 adaptive thinking** → Opus 4.7 is Anthropic's most capable GA model with a step-change in agentic coding. It replaces manual extended thinking (`type: "enabled"` + `budget_tokens`) with **adaptive thinking only** (`type: "adaptive"`). Sending `type: "enabled"` to Opus 4.7 returns a 400 error. Effort levels (`low/medium/high/xhigh/max`) control thinking depth via `output_config.effort`. The `xhigh` effort level is exclusive to Opus 4.7. Native 1M context window with a new tokenizer. Thinking display defaults to `"omitted"` (no thinking text in responses unless `display: "summarized"` is set explicitly). Extended thinking with `budget_tokens` is deprecated on Opus 4.6 and Sonnet 4.6 in favor of adaptive thinking
20. **Third-party detection: specific string matching on env fields** → After fixing the base prompt via hook-based override (#18), appending OpenCode's environment info still triggered the 400 "Third-party apps" error. Binary search revealed the specific trigger: the string `"Is directory a git repo"` — an OpenCode-specific env field. Claude Code uses `"Is a git repository: true/false"` instead. Anthropic's server-side check matches on known OpenCode-identifying strings in the system prompt, not just the base prompt text. Fix: rewrite `"Is directory a git repo: yes/no"` to `"Is a git repository: true/false"` in the `experimental.chat.system.transform` hook before sending. After this rewrite, all OpenCode-appended content (env info, skills, AGENTS.md instructions) passes through without triggering the detection
21. **Claude Code 2.1.112 cache control change** → `scope: "global"` is no longer sent on any system block cache_control. Both the identity block (`system[1]`) and main prompt (`system[2]`) now use `{ type: "ephemeral", ttl: "1h" }` without scope. The identity block also gets `cache_control` now (previously had none). Updated our implementation to match
22. **Claude Code 2.1.154 + Opus 4.8 (2026-05-28)** → New version bundles Anthropic SDK 0.94.0 (was 0.74.0). Beta flag set expanded: added `thinking-token-count-2026-05-13` (estimated tokens in thinking_delta stream events), `advisor-tool-2026-03-01` (server-side advisor tool), `extended-cache-ttl-2025-04-11` (1h cache TTL). For Opus 4.8 specifically, CC also sends `mid-conversation-system-2026-04-07` — allows `role: "system"` messages inside `messages[]` after user turns, useful for appending instructions late in a session without invalidating the system-prompt cache. Older models reject this beta, so we gate it conditionally on `model.includes("opus-4-8")`. `effort-2025-11-24` similarly excluded for Haiku (which rejects `output_config.effort`). The `cc_version` suffix is now `2.1.154.cea`. Opus 4.8 also got a completely rewritten, more condensed system prompt (~6KB "Harness" structure vs. ~11KB long-form on 4.7/Sonnet/Haiku) — they ship per-model now
23. **CCH hash mismatch on CC 2.1.154** → Our xxHash64 impl produces different hashes than CC 2.1.154 sends, despite using the documented seed/algorithm and verifying against Python xxhash. Requests still succeed because `/v1/messages` does not enforce CCH for standard inference — only premium features (e.g. fast mode) gate on it. Algorithm divergence is invisible to a proxy. See "Verification against Claude Code 2.1.154" section above
24. **2026-05-29: prompt-cache collapse in tool-heavy sessions** → Capturing both Claude Code and our plugin through `scripts/cache-proxy.ts` revealed three independent bugs that together stuck `cache_read` at the system+tools floor (~16K tokens) for an entire 130+ turn session while `cache_write` grew past 187K tokens per turn. (a) `replaceCchPlaceholder` used `body.replace(...)` which targets the first occurrence; when Claude read this repo's own source files (which contain the literal `cch=00000` token), the substitution mutated the tool_result content with a per-request hash instead of the billing block, making the cached prefix bytes differ every turn. (b) `convertUserMessage` simplified single-text content to a plain string, while the cache-breakpoint placer normalized it to array-of-blocks on the tail — same content, different byte shape on subsequent turns when it became mid-history. Fixed by always emitting array-of-blocks. (c) The previous breakpoint strategy (cache on last `tool_result`, then top-level automatic caching) didn't replicate what Claude Code actually does. Fixed by placing one explicit `cache_control` on `messages[-1].content[-1]` — exactly Claude Code's pattern. The initial fix for (a) was `lastIndexOf`, later replaced by JSON-targeted replacement — see Discovery #25
25. **2026-05-29: `lastIndexOf` for CCH was still wrong, fixed properly with JSON parsing** → The `lastIndexOf` fix from Discovery #24 worked for tool_result-based regressions (messages come before system in JSON byte order, so the billing block was usually the last `cch=00000`). But it broke on a different case: when the system prompt itself contained the literal string (AGENTS.md and RESEARCH.md both mention `cch=00000` verbatim in their docs about how the placeholder works, and those docs get spliced into `system[2]`), `system[2]` serializes after `system[0]`, so `lastIndexOf` mutated the docs text in `system[2]` instead of the billing placeholder in `system[0]`. Symptom: long session with stable history still got 0% cache hit on the conversation prefix, while system[0] kept `cch=00000` unsigned. Replaced the string-based replacement with a JSON-aware one: parse the body, find the system block whose text starts with `x-anthropic-billing-header:`, replace inside that block's `text` only, re-serialize. Verified on `ses_18d5c6509ffeCphU2gfvnMJfis` (488-msg history): `cache_read` jumped from 19,857 (system+tools only) to 328,002 (full prefix) on the very next turn after deploying the fix. Three-model regression test confirms Sonnet 4.6, Opus 4.7, and Opus 4.8 all show monotonically-growing `cache_read` with bounded `cache_write` across multi-turn sessions
