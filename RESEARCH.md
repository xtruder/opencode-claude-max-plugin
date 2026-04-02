# Claude Code Reverse Engineering Research

This document summarizes the findings from reverse-engineering Claude Code's request format, authentication, and internal structure to build a compatible OpenCode provider.

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
      "text": "x-anthropic-billing-header: cc_version=2.1.81.df2; cc_entrypoint=sdk-cli; cch=00000;"
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

| Header                                      | Value                                   | Purpose                                  |
| ------------------------------------------- | --------------------------------------- | ---------------------------------------- |
| `authorization`                             | `Bearer sk-ant-oat01-...`               | OAuth authentication                     |
| `anthropic-beta`                            | See below                               | Feature flags (order matters)            |
| `anthropic-version`                         | `2023-06-01`                            | API version                              |
| `user-agent`                                | `claude-cli/2.1.81 (external, sdk-cli)` | Client identification                    |
| `x-app`                                     | `cli`                                   | Application type                         |
| `anthropic-dangerous-direct-browser-access` | `true`                                  | Bypass browser restriction               |
| `x-stainless-package-version`               | `0.74.0`                                | SDK version (Claude Code bundles 0.74.0) |
| `content-type`                              | `application/json`                      | Standard                                 |

### Beta Flags

Claude Code sends these beta flags (order matches what we intercepted):

```
claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05,effort-2025-11-24
```

| Flag                              | Purpose                                        |
| --------------------------------- | ---------------------------------------------- |
| `claude-code-20250219`            | Claude Code feature gate                       |
| `oauth-2025-04-20`                | Enables OAuth Bearer token authentication      |
| `interleaved-thinking-2025-05-14` | Extended thinking / reasoning                  |
| `context-management-2025-06-27`   | Context window management                      |
| `prompt-caching-scope-2026-01-05` | Prompt caching with scope/TTL                  |
| `effort-2025-11-24`               | Output effort control (`output_config.effort`) |

The `oauth-2025-04-20` flag alone is NOT sufficient for subscription model access — the billing system block is also required.

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

| OpenCode     | Claude Code       | Notes                   |
| ------------ | ----------------- | ----------------------- |
| `task`       | `Agent`           | Different name entirely |
| `question`   | `AskUserQuestion` | Different name entirely |
| `plan_enter` | `EnterPlanMode`   | Different name entirely |
| `plan_exit`  | `ExitPlanMode`    | Different name entirely |
| `bash`       | `Bash`            | Case change             |
| `read`       | `Read`            | Case change             |
| `write`      | `Write`           | Case change             |
| `edit`       | `Edit`            | Case change             |
| `glob`       | `Glob`            | Case change             |
| `grep`       | `Grep`            | Case change             |
| `webfetch`   | `WebFetch`        | Case change             |
| `todowrite`  | `TodoWrite`       | Case change             |
| `skill`      | `Skill`           | Case change             |

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

OpenCode's system prompt references tool names that we also rewrite:

- `"use the Task tool"` → `"use the Agent tool"`
- `"the question to ask"` → `"the AskUserQuestion to ask"`

Tools already matching Claude Code names (Bash, Read, Write, Edit, Glob, Grep, TodoWrite, Skill, WebFetch) are left unchanged.

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
system[0]: billing header                     (injected by provider)
system[1]: "You are a Claude agent..."        (injected by provider)
system[2]: OpenCode prompt (rewritten)        (from OpenCode, tool names + identity rewritten)
```

Rewrites applied to system[2]:

- Opening identity replaced: `"You are OpenCode, the best coding agent..."` → `"You are an interactive agent that helps users with software engineering tasks."`
- Tool names rewritten to match Claude Code names

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

### How It Works

Anthropic caches prompt content when `cache_control` is set on system blocks, tool definitions, or messages. Cache hits return `cache_read_input_tokens > 0` in the usage response.

### Claude Code's Cache Strategy

Claude Code sets `cache_control` on:

1. **`system[2]`** (main instructions) — cached globally with 1-hour TTL:

   ```json
   { "type": "ephemeral", "ttl": "1h", "scope": "global" }
   ```

   The `scope: "global"` means the cache is shared across all sessions for the same user, not just within a session.

2. **Last user message content** — cached per-session with 1-hour TTL:

   ```json
   { "type": "ephemeral", "ttl": "1h" }
   ```

3. **Tool result blocks** in multi-turn conversations — caches the accumulated context including thinking blocks.

### Our Implementation

- **OAuth mode**: Uses `{ type: "ephemeral", ttl: "1h", scope: "global" }` on `system[2]` and `{ type: "ephemeral", ttl: "1h" }` on message history
- **API key mode**: Uses plain `{ type: "ephemeral" }` without `ttl`/`scope` (matches Claude Code's non-OAuth behavior)
- **Tool results**: Cache the last `tool_result` block in conversation history (not just the penultimate message) — per Anthropic docs, this keeps thinking blocks in cache across tool-use turns

### What Triggers Caching

Caching requires a **large enough prompt** to reach the infrastructure threshold. With the full OpenCode request (22 tools with detailed schemas + 12K char system prompt ≈ 80KB body, ~20K tokens), caching works reliably:

- **R1 (cold)**: `cache_creation_input_tokens: 20499, input_tokens: 330`
- **R2 (warm)**: `cache_read_input_tokens: 20499, input_tokens: 330`
- **Savings**: 98% of input tokens served from cache

With small isolated test prompts (<2K tokens), caching is not triggered.

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

- `src/fixtures/opencode-system.txt` — actual system prompt (12.8K chars)
- `src/fixtures/opencode-tools.json` — actual 22 tool definitions (66K chars)

---

## Context Window Limits (OAuth Subscription)

### Tested limits per model (Max subscription, Extra usage disabled)

| Model          | Without `context-1m`            | With `context-1m`                                           | Notes                                                                  |
| -------------- | ------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------- |
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
  "text": "x-anthropic-billing-header: cc_version=2.1.81.df2; cc_entrypoint=sdk-cli; cch=00000;"
}
```

### Algorithm

1. Build the complete request body JSON with `cch=00000` as a placeholder
2. Compute `xxHash64(body_bytes, seed) & 0xFFFFF` (seed: `0x6E52736AC806831E`)
3. Format as zero-padded 5-character lowercase hex
4. Replace the first occurrence of `cch=00000` in the body with `cch=<computed>`

The hash covers the **entire serialized body** -- messages, tools, metadata, model, thinking config, everything. Modifying any field after hashing (swapping a session UUID, removing a tool, editing a tool description) causes a 400 rejection.

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
14. **`context-1m-2025-08-07` is conditional** → Claude Code only sends it when model ID includes `[1m]` suffix (checked via `/\[1m\]/i.test(modelId)`). Always sending it triggers the "Extra usage required" billing check even on small requests
15. **Context window limits per model** → See table below
