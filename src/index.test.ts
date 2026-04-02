/**
 * Tests for index.ts — createAnthropicSDK factory, auth resolution.
 *
 * Run with: bun test src/index.test.ts
 */
import { describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { clearCredentialCache } from "./credentials.ts"
import { createAnthropicSDK } from "./index.ts"
import { join } from "node:path"
import { tmpdir } from "node:os"

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
})
