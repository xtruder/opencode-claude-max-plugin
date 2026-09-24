/**
 * Tests for index.ts — createAnthropicSDK factory, auth resolution.
 *
 * Run with: bun test src/index.test.ts
 */
import { describe, expect, spyOn, test } from "bun:test"
import * as child_process from "node:child_process"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { clearCredentialCache } from "./credentials.ts"
import {
  CLAUDE_CODE_FABLE5_SYSTEM_PROMPT,
  CLAUDE_CODE_NEW_SYSTEM_PROMPT,
  CLAUDE_CODE_OPUS5_SYSTEM_PROMPT,
  CLAUDE_CODE_SONNET5_SYSTEM_PROMPT,
  CLAUDE_CODE_SYSTEM_PROMPT,
  anthropicSDKPlugin,
  createAnthropicSDK,
  selectClaudePromptForModel,
} from "./index.ts"

// ─── createAnthropicSDK ─────────────────────────────────────────────────────

describe("createAnthropicSDK", () => {
  test("creates a provider with API key", () => {
    const provider = createAnthropicSDK({ apiKey: "sk-ant-test" })
    const model = provider.languageModel("claude-haiku-4-5-20251001")
    expect(model.specificationVersion).toBe("v3")
    expect(model.modelId).toBe("claude-haiku-4-5-20251001")
  })

  test("falls back to Claude Code credentials file", async () => {
    const tmpDir = join(tmpdir(), `test-creds-fallback-${Date.now()}`)
    mkdirSync(tmpDir, { recursive: true })
    const credPath = join(tmpDir, "credentials.json")

    const oauthToken = "sk-ant-oat01-test-fallback-token"
    writeFileSync(
      credPath,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: oauthToken,
          refreshToken: "sk-ant-ort01-unused",
          expiresAt: Date.now() + 3600000,
          scopes: ["user:inference"],
          subscriptionType: null,
        },
      }),
    )

    // Temporarily clear ANTHROPIC_API_KEY so createAnthropicSDK falls through
    // to the credentials file. Save and restore immediately to minimize
    // interference with parallel test files.
    const savedKey = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    clearCredentialCache()
    try {
      const provider = createAnthropicSDK({ credentialsPath: credPath })
      const m = provider.languageModel("claude-haiku-4-5-20251001")
      expect(m.specificationVersion).toBe("v3")
      expect(m.modelId).toBe("claude-haiku-4-5-20251001")

      // Call with fake OAuth token — should get 401 (NOT "missing auth"),
      // proving the credentials file was read and used.
      try {
        await m.doGenerate({
          prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
          maxOutputTokens: 10,
        } as any)
        expect(false).toBe(true) // should not reach here
      } catch (err: any) {
        const msg = (err?.message ?? String(err)).toLowerCase()
        expect(
          msg.includes("401") ||
            msg.includes("authentication") ||
            msg.includes("api_key") ||
            msg.includes("invalid"),
        ).toBe(true)
      }
    } finally {
      // Restore env var BEFORE clearing cache
      if (savedKey) {
        process.env.ANTHROPIC_API_KEY = savedKey
      }
      clearCredentialCache()
      rmSync(tmpDir, { recursive: true })
    }
  })

  test("defers OAuth token refresh until the first request", async () => {
    const tmpDir = join(tmpdir(), `test-creds-lazy-refresh-${Date.now()}`)
    mkdirSync(tmpDir, { recursive: true })
    const credPath = join(tmpDir, "credentials.json")
    const refreshedToken = "sk-ant-oat01-refreshed-token"
    writeFileSync(
      credPath,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "sk-ant-oat01-expired-token",
          refreshToken: "sk-ant-ort01-test-token",
          expiresAt: Date.now() - 60_000,
          scopes: ["user:inference"],
          subscriptionType: "max",
        },
      }),
    )

    const savedKey = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    clearCredentialCache()
    let requestAuthorization: string | null = null
    let requestUserAgent: string | null = null
    let requestBody = ""
    const execSyncSpy = spyOn(child_process, "execSync").mockImplementation((() => {
      writeFileSync(
        credPath,
        JSON.stringify({
          claudeAiOauth: {
            accessToken: refreshedToken,
            refreshToken: "sk-ant-ort01-test-token",
            expiresAt: Date.now() + 3_600_000,
            scopes: ["user:inference"],
            subscriptionType: "max",
          },
        }),
      )
      return Buffer.from("")
    }) as any)

    try {
      const provider = createAnthropicSDK({
        credentialsPath: credPath,
        fetch: (async (_url, init) => {
          const headers = new Headers(init?.headers)
          requestAuthorization = headers.get("authorization")
          requestUserAgent = headers.get("user-agent")
          requestBody = String(init?.body)
          return new Response('{"error":{"type":"authentication_error","message":"test"}}', {
            status: 401,
            headers: { "content-type": "application/json" },
          })
        }) as typeof fetch,
      })
      expect(execSyncSpy).not.toHaveBeenCalled()

      const model = provider.languageModel("claude-haiku-4-5-20251001")
      try {
        await model.doGenerate({
          prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
          maxOutputTokens: 10,
        } as any)
      } catch {}

      expect(execSyncSpy).toHaveBeenCalledTimes(1)
      expect(requestAuthorization).toBe(`Bearer ${refreshedToken}`)
      expect(requestUserAgent).toBe("claude-cli/2.1.280 (external, sdk-cli)")
      expect(requestBody).toContain("cc_version=2.1.280.790")
    } finally {
      execSyncSpy.mockRestore()
      if (savedKey) process.env.ANTHROPIC_API_KEY = savedKey
      clearCredentialCache()
      rmSync(tmpDir, { recursive: true })
    }
  })
})

describe("selectClaudePromptForModel", () => {
  test("uses model-specific Claude 5 prompts", () => {
    expect(selectClaudePromptForModel("claude-sonnet-5")).toBe(CLAUDE_CODE_SONNET5_SYSTEM_PROMPT)
    expect(CLAUDE_CODE_SONNET5_SYSTEM_PROMPT).not.toContain(
      "Assist with authorized security testing",
    )
    expect(selectClaudePromptForModel("claude-opus-5")).toBe(CLAUDE_CODE_OPUS5_SYSTEM_PROMPT)
    expect(selectClaudePromptForModel("claude-opus-5-5")).toBe(CLAUDE_CODE_OPUS5_SYSTEM_PROMPT)
    expect(selectClaudePromptForModel("claude-opus-4-8")).toBe(CLAUDE_CODE_NEW_SYSTEM_PROMPT)
    expect(selectClaudePromptForModel("claude-fable-5")).toBe(CLAUDE_CODE_FABLE5_SYSTEM_PROMPT)
    expect(selectClaudePromptForModel("claude-fable-5-1")).toBe(CLAUDE_CODE_FABLE5_SYSTEM_PROMPT)
    expect(selectClaudePromptForModel("claude-sonnet-4-6")).toBe(CLAUDE_CODE_SYSTEM_PROMPT)
  })
})

describe("anthropicSDKPlugin model catalog", () => {
  test("registers the latest public models with current API pricing", async () => {
    const savedKey = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = "sk-ant-test"
    try {
      const hooks = await anthropicSDKPlugin({} as any)
      const config = {} as any
      await hooks.config?.(config)
      const models = config.provider["anthropic-sdk"].models

      expect(models["claude-opus-5-5"]).toMatchObject({
        name: "Claude Opus 5.5",
        limit: { context: 1_000_000, output: 128_000 },
        cost: { input: 4, output: 20, cache_read: 0.2, cache_write: 5 },
        options: { effort: "medium", refusalFallback: "default" },
      })
      expect(models["claude-fable-5-1"]).toMatchObject({
        name: "Claude Fable 5.1",
        limit: { context: 1_000_000, output: 128_000 },
        cost: { input: 10, output: 50, cache_read: 0.25, cache_write: 12.5 },
        options: { effort: "high", refusalFallback: "default" },
      })
      expect(models["claude-sonnet-5"].cost).toEqual({
        input: 2,
        output: 10,
        cache_read: 0.2,
        cache_write: 2.5,
      })
    } finally {
      if (savedKey == null) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = savedKey
    }
  })
})
