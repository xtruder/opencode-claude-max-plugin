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
npm version patch   # bumps version in package.json
git add package.json
git commit -m "chore: bump version to X.Y.Z"
git push origin main
git tag vX.Y.Z && git push origin vX.Y.Z
# GitHub Actions (.github/workflows/release.yml) handles npm publish automatically
```

### Test the installed package in OpenCode cache
```bash
# After build, the file: symlink in ~/.cache/opencode picks up changes automatically
opencode run -m "anthropic-sdk/claude-haiku-4-5-20251001" "Say OK"
```

---

## Project Structure

```
src/
├── index.ts        # createAnthropicSDK() factory, auth resolution, fetch wrapper
├── model.ts        # AnthropicSDKModel — LanguageModelV2 (doGenerate + doStream)
├── prompt.ts       # AI SDK prompt → Anthropic Messages API converter
├── stream.ts       # Anthropic SSE events → AI SDK LanguageModelV2StreamPart
├── tools.ts        # AI SDK tools → Anthropic format + schema cleanup
├── tool-names.ts   # Bidirectional tool name mapping (OpenCode ↔ Claude Code)
├── credentials.ts  # Claude Code OAuth credentials reader
├── usage.ts        # /api/oauth/usage API client + formatter
├── usage-cli.ts    # Standalone CLI for displaying usage
├── agent-index.ts  # Alternate entry using @anthropic-ai/claude-agent-sdk
├── agent-model.ts  # Agent SDK model wrapper
├── test.ts         # 17 integration tests (excluded from build)
└── fixtures/       # Captured OpenCode request data for caching tests
    ├── opencode-system.txt
    └── opencode-tools.json
```

---

## Code Style

### Language and Runtime
- **TypeScript** with `strict: true`, targeting ESNext, module resolution `bundler`
- **Bun** runtime for building and running tests
- All imports use `.js` extension (ESM, bundler resolves to `.ts`)

### Imports
```typescript
// 1. Third-party packages
import Anthropic from "@anthropic-ai/sdk"
import type { LanguageModelV2 } from "@ai-sdk/provider"

// 2. Node built-ins — always use "node:" prefix
import { readFileSync } from "node:fs"
import { join } from "node:path"

// 3. Local modules — always .js extension
import { convertPrompt } from "./prompt.js"
import type { ConvertedPrompt } from "./prompt.js"

// Use `import type` for type-only imports
```

### Naming Conventions
- **Variables/functions**: `camelCase`
- **Classes**: `PascalCase` (e.g. `AnthropicSDKModel`)
- **Constants**: `SCREAMING_SNAKE_CASE` for module-level constants (e.g. `OAUTH_BETAS`, `BILLING_SYSTEM_BLOCK`)
- **Types/interfaces**: `PascalCase` (e.g. `AnthropicSDKProviderOptions`)
- **Files**: `kebab-case` (e.g. `tool-names.ts`)

### Types
- Prefer explicit types on exported functions and class methods
- Use `type` aliases and `interface` for object shapes
- Avoid `any` except when bridging between AI SDK and Anthropic SDK types (use `as any` with a comment explaining why)
- Derive types from SDK return values where possible: `type DoGenerateResult = Awaited<ReturnType<LanguageModelV2["doGenerate"]>>`

### Formatting
- 2-space indentation
- Double quotes for strings
- No trailing semicolons (omit them)
- Arrow functions for callbacks and short helpers
- Descriptive section comments with box-drawing characters: `// ─── Section name ───`

### Error Handling
- Catch and rethrow with context using `handleApiError()` in `model.ts`
- Distinguish subscription rate limits (`anthropic-ratelimit-unified-status: over_limit`) from transient 429s
- Never match error messages with broad string includes — use specific header values
- Detect "Extra usage required for long context" by exact substring match in `model.ts`

### Comments
- JSDoc on all exported functions and classes
- Inline comments for non-obvious logic, especially anything related to Claude Code compatibility
- When matching Claude Code behaviour, cite the source: `// Claude Code: found in cli.js as al1=1024`

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
