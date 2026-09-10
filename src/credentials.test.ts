/**
 * Tests for credentials.ts — unit tests (mocked) + integration tests (real CLI).
 *
 * Run with: bun test src/credentials.test.ts
 *
 * Unit tests use temp directories with fake credential files and mock execSync
 * (including the macOS `security` CLI used for keychain lookups).
 * Integration tests use the real Claude CLI and ~/.claude/.credentials.json —
 * they are skipped automatically if either is unavailable.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import * as child_process from "node:child_process"
import { execSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type ClaudeOAuthCredentials,
  clearCredentialCache,
  getCachedCredentials,
  getCredentialsPath,
  isExpired,
  readClaudeCredentials,
  readKeychainCredentials,
  refreshIfNeeded,
  refreshViaCli,
} from "./credentials.ts"

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TEST_DIR = join(tmpdir(), `creds-test-${Date.now()}`)

function makeCreds(overrides: Partial<ClaudeOAuthCredentials> = {}): ClaudeOAuthCredentials {
  return {
    accessToken: "test-access-token",
    refreshToken: "test-refresh-token",
    expiresAt: Date.now() + 3600_000, // 1 hour from now
    scopes: ["default"],
    subscriptionType: "max",
    ...overrides,
  }
}

function writeCredsFile(dir: string, creds: ClaudeOAuthCredentials): string {
  const filePath = join(dir, ".credentials.json")
  mkdirSync(dir, { recursive: true })
  writeFileSync(filePath, JSON.stringify({ claudeAiOauth: creds }))
  return filePath
}

// ─── Prerequisite checks (for integration tests) ────────────────────────────

let hasClaudeCli = false
let hasCredentials = false

try {
  execSync("claude --version", { timeout: 5_000, stdio: "ignore" })
  hasClaudeCli = true
} catch {
  // Claude CLI not available
}

const credPath = getCredentialsPath()
hasCredentials = existsSync(credPath)

function skipUnless(condition: boolean, reason: string) {
  if (!condition) {
    test.skip(`SKIPPED: ${reason}`, () => {})
    return true
  }
  return false
}

// ─── Setup / Teardown ────────────────────────────────────────────────────────

beforeEach(() => {
  clearCredentialCache()
})

afterAll(() => {
  clearCredentialCache()
  try {
    rmSync(TEST_DIR, { recursive: true, force: true })
  } catch {
    // ignore
  }
})

// ═════════════════════════════════════════════════════════════════════════════
//  UNIT TESTS (mocked — no real CLI or credentials needed)
// ═════════════════════════════════════════════════════════════════════════════

// ─── readClaudeCredentials ───────────────────────────────────────────────────

describe("readClaudeCredentials", () => {
  test("returns null for non-existent file", () => {
    const result = readClaudeCredentials("/tmp/does-not-exist-credentials.json")
    expect(result).toBeNull()
  })

  test("reads valid credentials file", () => {
    const dir = join(TEST_DIR, "read-valid")
    const creds = makeCreds()
    const filePath = writeCredsFile(dir, creds)

    const result = readClaudeCredentials(filePath)
    expect(result).not.toBeNull()
    expect(result!.accessToken).toBe("test-access-token")
    expect(result!.refreshToken).toBe("test-refresh-token")
    expect(result!.expiresAt).toBe(creds.expiresAt)
  })

  test("returns null for malformed JSON", () => {
    const dir = join(TEST_DIR, "read-malformed")
    mkdirSync(dir, { recursive: true })
    const filePath = join(dir, ".credentials.json")
    writeFileSync(filePath, "not valid json{{{")

    const result = readClaudeCredentials(filePath)
    expect(result).toBeNull()
  })

  test("returns null when claudeAiOauth is missing", () => {
    const dir = join(TEST_DIR, "read-missing-oauth")
    mkdirSync(dir, { recursive: true })
    const filePath = join(dir, ".credentials.json")
    writeFileSync(filePath, JSON.stringify({ someOtherKey: true }))

    const result = readClaudeCredentials(filePath)
    expect(result).toBeNull()
  })

  test("returns null when accessToken is missing", () => {
    const dir = join(TEST_DIR, "read-no-token")
    mkdirSync(dir, { recursive: true })
    const filePath = join(dir, ".credentials.json")
    writeFileSync(
      filePath,
      JSON.stringify({
        claudeAiOauth: { refreshToken: "rt", expiresAt: Date.now() + 3600000 },
      }),
    )

    const result = readClaudeCredentials(filePath)
    expect(result).toBeNull()
  })
})

// ─── isExpired ───────────────────────────────────────────────────────────────

describe("isExpired", () => {
  test("returns false for token expiring in 1 hour", () => {
    const creds = makeCreds({ expiresAt: Date.now() + 3600_000 })
    expect(isExpired(creds)).toBe(false)
  })

  test("returns true for token expiring in 30 seconds (within 60s buffer)", () => {
    const creds = makeCreds({ expiresAt: Date.now() + 30_000 })
    expect(isExpired(creds)).toBe(true)
  })

  test("returns true for already expired token", () => {
    const creds = makeCreds({ expiresAt: Date.now() - 10_000 })
    expect(isExpired(creds)).toBe(true)
  })

  test("returns false for token expiring in exactly 2 minutes", () => {
    const creds = makeCreds({ expiresAt: Date.now() + 120_000 })
    expect(isExpired(creds)).toBe(false)
  })
})

// ─── getCredentialsPath ──────────────────────────────────────────────────────

describe("getCredentialsPath", () => {
  test("returns path under home directory", () => {
    const path = getCredentialsPath()
    expect(path).toContain(".claude")
    expect(path).toContain(".credentials.json")
  })
})

// ─── refreshViaCli (mocked) ─────────────────────────────────────────────────

describe("refreshViaCli (mocked)", () => {
  test("returns true when CLI succeeds", () => {
    const execSyncSpy = spyOn(child_process, "execSync").mockImplementation((() =>
      Buffer.from("")) as any)

    const result = refreshViaCli()
    expect(result).toBe(true)
    expect(execSyncSpy).toHaveBeenCalledTimes(1)

    execSyncSpy.mockRestore()
  })

  test("retries once and returns true if second attempt succeeds", () => {
    let callCount = 0
    const execSyncSpy = spyOn(child_process, "execSync").mockImplementation((() => {
      callCount++
      if (callCount === 1) throw new Error("first attempt fails")
      return Buffer.from("")
    }) as any)

    const result = refreshViaCli()
    expect(result).toBe(true)
    expect(execSyncSpy).toHaveBeenCalledTimes(2)

    execSyncSpy.mockRestore()
  })

  test("returns false after 2 failed attempts", () => {
    const execSyncSpy = spyOn(child_process, "execSync").mockImplementation((() => {
      throw new Error("CLI not found")
    }) as any)

    const result = refreshViaCli()
    expect(result).toBe(false)
    expect(execSyncSpy).toHaveBeenCalledTimes(2)

    execSyncSpy.mockRestore()
  })
})

// ─── refreshIfNeeded (mocked) ────────────────────────────────────────────────

describe("refreshIfNeeded (mocked)", () => {
  test("returns credentials as-is when token is fresh", () => {
    const dir = join(TEST_DIR, "refresh-fresh")
    const creds = makeCreds({ expiresAt: Date.now() + 3600_000 })
    const filePath = writeCredsFile(dir, creds)

    const execSyncSpy = spyOn(child_process, "execSync")

    const result = refreshIfNeeded(filePath)
    expect(result).not.toBeNull()
    expect(result!.accessToken).toBe("test-access-token")
    // Should NOT have called CLI since token is fresh
    expect(execSyncSpy).not.toHaveBeenCalled()

    execSyncSpy.mockRestore()
  })

  test("calls CLI when token is near expiry", () => {
    const dir = join(TEST_DIR, "refresh-expiring")
    const creds = makeCreds({ expiresAt: Date.now() + 30_000 })
    const filePath = writeCredsFile(dir, creds)

    const freshCreds = makeCreds({
      accessToken: "refreshed-token",
      expiresAt: Date.now() + 3600_000,
    })
    const execSyncSpy = spyOn(child_process, "execSync").mockImplementation((() => {
      writeFileSync(filePath, JSON.stringify({ claudeAiOauth: freshCreds }))
      return Buffer.from("")
    }) as any)

    const result = refreshIfNeeded(filePath)
    expect(result).not.toBeNull()
    expect(result!.accessToken).toBe("refreshed-token")
    expect(execSyncSpy).toHaveBeenCalled()

    execSyncSpy.mockRestore()
  })

  test("returns stale creds when CLI refresh fails", () => {
    const dir = join(TEST_DIR, "refresh-fail")
    const creds = makeCreds({ expiresAt: Date.now() + 30_000 })
    const filePath = writeCredsFile(dir, creds)

    const execSyncSpy = spyOn(child_process, "execSync").mockImplementation((() => {
      throw new Error("CLI failed")
    }) as any)

    const result = refreshIfNeeded(filePath)
    expect(result).not.toBeNull()
    expect(result!.accessToken).toBe("test-access-token")

    execSyncSpy.mockRestore()
  })

  test("returns null for non-existent file", () => {
    const result = refreshIfNeeded("/tmp/no-such-creds-file.json")
    expect(result).toBeNull()
  })
})

// ─── getCachedCredentials (mocked) ───────────────────────────────────────────

describe("getCachedCredentials (mocked)", () => {
  test("caches credentials in memory", () => {
    const dir = join(TEST_DIR, "cache-basic")
    const creds = makeCreds()
    const filePath = writeCredsFile(dir, creds)

    const execSyncSpy = spyOn(child_process, "execSync")

    const result1 = getCachedCredentials(filePath)
    expect(result1).not.toBeNull()
    expect(result1!.accessToken).toBe("test-access-token")

    // Write different creds to disk
    const newCreds = makeCreds({ accessToken: "new-token" })
    writeFileSync(filePath, JSON.stringify({ claudeAiOauth: newCreds }))

    // Second call should return cached (old) value within TTL
    const result2 = getCachedCredentials(filePath)
    expect(result2).not.toBeNull()
    expect(result2!.accessToken).toBe("test-access-token")

    execSyncSpy.mockRestore()
  })

  test("re-reads after cache is cleared", () => {
    const dir = join(TEST_DIR, "cache-clear")
    const creds = makeCreds()
    const filePath = writeCredsFile(dir, creds)

    const execSyncSpy = spyOn(child_process, "execSync")

    getCachedCredentials(filePath)

    const newCreds = makeCreds({ accessToken: "after-clear-token" })
    writeFileSync(filePath, JSON.stringify({ claudeAiOauth: newCreds }))
    clearCredentialCache()

    const result = getCachedCredentials(filePath)
    expect(result).not.toBeNull()
    expect(result!.accessToken).toBe("after-clear-token")

    execSyncSpy.mockRestore()
  })

  test("triggers refresh when cached token is near expiry", () => {
    const dir = join(TEST_DIR, "cache-refresh")
    const almostExpired = makeCreds({ expiresAt: Date.now() + 30_000 })
    const filePath = writeCredsFile(dir, almostExpired)

    const freshCreds = makeCreds({
      accessToken: "cache-refreshed-token",
      expiresAt: Date.now() + 3600_000,
    })
    const execSyncSpy = spyOn(child_process, "execSync").mockImplementation((() => {
      writeFileSync(filePath, JSON.stringify({ claudeAiOauth: freshCreds }))
      return Buffer.from("")
    }) as any)

    const result = getCachedCredentials(filePath)
    expect(result).not.toBeNull()
    expect(result!.accessToken).toBe("cache-refreshed-token")
    expect(execSyncSpy).toHaveBeenCalled()

    execSyncSpy.mockRestore()
  })

  test("returns null for missing credentials", () => {
    const result = getCachedCredentials("/tmp/nonexistent-creds.json")
    expect(result).toBeNull()
  })
})

// ─── Keychain helpers ────────────────────────────────────────────────────────

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!

/** Override `process.platform` for the duration of a test. */
function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: platform })
}

/**
 * Mock execSync so `security ...` commands return the current keychain payload
 * and every other command (e.g. the `claude` CLI refresh) runs `onOtherCommand`.
 */
function mockKeychain(getPayload: () => string, onOtherCommand: () => void = () => {}) {
  return spyOn(child_process, "execSync").mockImplementation(((command: string) => {
    if (command.startsWith("security ")) return getPayload()
    onOtherCommand()
    return Buffer.from("")
  }) as any)
}

// ─── readKeychainCredentials (mocked) ────────────────────────────────────────

describe("readKeychainCredentials (mocked)", () => {
  afterEach(() => {
    mock.restore()
    Object.defineProperty(process, "platform", originalPlatform)
  })

  test("reads credentials from the macOS keychain", () => {
    setPlatform("darwin")
    const creds = makeCreds({ accessToken: "keychain-token" })
    const execSyncSpy = mockKeychain(() => JSON.stringify({ claudeAiOauth: creds }))

    const result = readKeychainCredentials()
    expect(result).not.toBeNull()
    expect(result!.accessToken).toBe("keychain-token")
    expect(execSyncSpy).toHaveBeenCalledTimes(1)
    expect(String(execSyncSpy.mock.calls[0]![0])).toContain("Claude Code-credentials")
  })

  test("returns null on non-macOS platforms without calling security", () => {
    setPlatform("linux")
    const execSyncSpy = mockKeychain(() => JSON.stringify({ claudeAiOauth: makeCreds() }))

    expect(readKeychainCredentials()).toBeNull()
    expect(execSyncSpy).not.toHaveBeenCalled()
  })

  test("returns null when the keychain entry is missing", () => {
    setPlatform("darwin")
    mockKeychain(() => {
      throw new Error("security: The specified item could not be found in the keychain.")
    })

    expect(readKeychainCredentials()).toBeNull()
  })

  test("returns null for malformed keychain payload", () => {
    setPlatform("darwin")
    mockKeychain(() => "not valid json{{{")

    expect(readKeychainCredentials()).toBeNull()
  })

  test("returns null when keychain payload has no accessToken", () => {
    setPlatform("darwin")
    mockKeychain(() => JSON.stringify({ claudeAiOauth: { refreshToken: "rt" } }))

    expect(readKeychainCredentials()).toBeNull()
  })
})

// ─── readClaudeCredentials keychain fallback (mocked) ────────────────────────

describe("readClaudeCredentials keychain fallback (mocked)", () => {
  afterEach(() => {
    mock.restore()
    Object.defineProperty(process, "platform", originalPlatform)
  })

  test("falls back to keychain when the default credentials file is missing", () => {
    setPlatform("darwin")
    spyOn(os, "homedir").mockReturnValue(join(TEST_DIR, "home-without-file"))
    const creds = makeCreds({ accessToken: "keychain-token" })
    mockKeychain(() => JSON.stringify({ claudeAiOauth: creds }))

    const result = readClaudeCredentials()
    expect(result).not.toBeNull()
    expect(result!.accessToken).toBe("keychain-token")
  })

  test("prefers the default credentials file over the keychain", () => {
    setPlatform("darwin")
    const home = join(TEST_DIR, "home-with-file")
    writeCredsFile(join(home, ".claude"), makeCreds())
    spyOn(os, "homedir").mockReturnValue(home)
    const execSyncSpy = mockKeychain(() =>
      JSON.stringify({ claudeAiOauth: makeCreds({ accessToken: "keychain-token" }) }),
    )

    const result = readClaudeCredentials()
    expect(result).not.toBeNull()
    expect(result!.accessToken).toBe("test-access-token")
    expect(execSyncSpy).not.toHaveBeenCalled()
  })

  test("does not consult keychain when an explicit path is given", () => {
    setPlatform("darwin")
    const execSyncSpy = mockKeychain(() => JSON.stringify({ claudeAiOauth: makeCreds() }))

    expect(readClaudeCredentials("/tmp/does-not-exist-credentials.json")).toBeNull()
    expect(execSyncSpy).not.toHaveBeenCalled()
  })

  test("refreshIfNeeded picks up a token refreshed into the keychain", () => {
    setPlatform("darwin")
    spyOn(os, "homedir").mockReturnValue(join(TEST_DIR, "home-keychain-refresh"))
    let payload = JSON.stringify({ claudeAiOauth: makeCreds({ expiresAt: Date.now() + 30_000 }) })
    const fresh = makeCreds({ accessToken: "keychain-refreshed-token" })
    const execSyncSpy = mockKeychain(
      () => payload,
      () => {
        payload = JSON.stringify({ claudeAiOauth: fresh })
      },
    )

    const result = refreshIfNeeded()
    expect(result).not.toBeNull()
    expect(result!.accessToken).toBe("keychain-refreshed-token")
    expect(execSyncSpy.mock.calls.some(([command]) => String(command).startsWith("claude "))).toBe(
      true,
    )
  })
})

// ═════════════════════════════════════════════════════════════════════════════
//  INTEGRATION TESTS (real CLI + real credentials — auto-skipped if missing)
// ═════════════════════════════════════════════════════════════════════════════

// ─── Real credential file reading ────────────────────────────────────────────

describe("integration: readClaudeCredentials", () => {
  if (skipUnless(hasCredentials, "no credentials file at ~/.claude/.credentials.json")) return

  test("reads real credentials file", () => {
    const creds = readClaudeCredentials()
    expect(creds).not.toBeNull()
    expect(creds!.accessToken).toBeTypeOf("string")
    expect(creds!.accessToken.length).toBeGreaterThan(0)
    expect(creds!.refreshToken).toBeTypeOf("string")
    expect(creds!.refreshToken.length).toBeGreaterThan(0)
    expect(creds!.expiresAt).toBeTypeOf("number")
    expect(creds!.expiresAt).toBeGreaterThan(0)
  })

  test("credentials have expected shape", () => {
    const creds = readClaudeCredentials()
    expect(creds).not.toBeNull()
    const raw = JSON.parse(readFileSync(credPath, "utf-8"))
    expect(raw.claudeAiOauth).toBeDefined()
    expect(raw.claudeAiOauth.accessToken).toBe(creds!.accessToken)
  })
})

// ─── Claude CLI execution ────────────────────────────────────────────────────

describe("integration: Claude CLI", () => {
  if (skipUnless(hasClaudeCli, "claude CLI not in PATH")) return

  test("claude --version returns a version string", () => {
    const output = execSync("claude --version", {
      timeout: 5_000,
      encoding: "utf-8",
    }).trim()
    expect(output).toMatch(/\d+\.\d+/)
    console.log(`        Claude CLI version: ${output}`)
  })

  test("claude CLI can run a minimal prompt", () => {
    const output = execSync('claude -p "Say OK" --model haiku', {
      timeout: 60_000,
      encoding: "utf-8",
      env: { ...process.env, TERM: "dumb" },
    }).trim()
    expect(output.length).toBeGreaterThan(0)
    console.log(`        CLI response: "${output.slice(0, 80)}"`)
  }, 120_000)
})

// ─── refreshViaCli (real) ────────────────────────────────────────────────────

describe("integration: refreshViaCli", () => {
  if (skipUnless(hasClaudeCli, "claude CLI not in PATH")) return

  test("refreshViaCli() returns true with real CLI", () => {
    const result = refreshViaCli()
    expect(result).toBe(true)
  }, 120_000)
})

describe("integration: refreshViaCli + credentials file", () => {
  if (skipUnless(hasClaudeCli && hasCredentials, "needs claude CLI and credentials file")) return

  test("credentials file still valid after CLI call", () => {
    const beforeCreds = readClaudeCredentials()
    expect(beforeCreds).not.toBeNull()

    const result = refreshViaCli()
    expect(result).toBe(true)

    // File should still exist with valid creds
    expect(existsSync(credPath)).toBe(true)
    const afterCreds = readClaudeCredentials()
    expect(afterCreds).not.toBeNull()
    expect(afterCreds!.accessToken.length).toBeGreaterThan(0)
    expect(afterCreds!.expiresAt).toBeGreaterThan(Date.now())
    console.log(`        Token expires: ${new Date(afterCreds!.expiresAt).toISOString()}`)
  }, 120_000)
})

// ─── refreshIfNeeded (real) ──────────────────────────────────────────────────

describe("integration: refreshIfNeeded", () => {
  if (skipUnless(hasClaudeCli && hasCredentials, "needs claude CLI and credentials file")) return

  test("returns valid credentials when token is fresh", () => {
    clearCredentialCache()
    const creds = refreshIfNeeded()
    expect(creds).not.toBeNull()
    expect(creds!.accessToken.length).toBeGreaterThan(0)
    expect(isExpired(creds!)).toBe(false)
  })

  test("credentials file still exists after refresh", () => {
    clearCredentialCache()
    const creds = refreshIfNeeded()
    expect(creds).not.toBeNull()
    expect(creds!.accessToken.length).toBeGreaterThan(0)
    expect(existsSync(credPath)).toBe(true)
  })
})

// ─── getCachedCredentials (real) ─────────────────────────────────────────────

describe("integration: getCachedCredentials", () => {
  if (skipUnless(hasClaudeCli && hasCredentials, "needs claude CLI and credentials file")) return

  test("returns credentials on first call", () => {
    clearCredentialCache()
    const creds = getCachedCredentials()
    expect(creds).not.toBeNull()
    expect(creds!.accessToken.length).toBeGreaterThan(0)
  })

  test("returns same object on repeated calls (cache hit)", () => {
    clearCredentialCache()
    const first = getCachedCredentials()
    const second = getCachedCredentials()
    expect(first).toBe(second)
  })

  test("returns fresh credentials after cache clear", () => {
    clearCredentialCache()
    const first = getCachedCredentials()
    clearCredentialCache()
    const second = getCachedCredentials()
    expect(first).not.toBe(second)
    expect(first!.accessToken).toBe(second!.accessToken)
  })
})
