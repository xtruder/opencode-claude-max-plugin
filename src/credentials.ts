import { execSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export interface ClaudeOAuthCredentials {
  accessToken: string
  refreshToken: string
  expiresAt: number
  scopes: string[]
  subscriptionType: string | null
}

interface CredentialsFile {
  claudeAiOauth?: ClaudeOAuthCredentials
}

/**
 * How long to cache credentials in memory before re-reading them.
 */
const CREDENTIAL_CACHE_TTL_MS = 30_000

/**
 * Buffer before expiry at which we consider the token "near expiry"
 * and trigger a CLI refresh. 60 seconds matches opencode-claude-auth.
 */
const EXPIRY_BUFFER_MS = 60_000

let cachedCreds: ClaudeOAuthCredentials | null = null
let cachedAt = 0
let cachedPath: string | undefined

/**
 * Default path to Claude Code credentials file.
 */
export function getCredentialsPath(): string {
  return join(homedir(), ".claude", ".credentials.json")
}

/**
 * macOS keychain service under which Claude Code stores its OAuth credentials.
 */
const KEYCHAIN_SERVICE = "Claude Code-credentials"

/**
 * Parse a Claude Code credentials payload (same JSON shape in the file and the keychain).
 * Returns null if the payload is malformed or has no access token.
 */
function parseCredentials(raw: string): ClaudeOAuthCredentials | null {
  try {
    const parsed: CredentialsFile = JSON.parse(raw)
    if (!parsed.claudeAiOauth?.accessToken) return null
    return parsed.claudeAiOauth
  } catch {
    return null
  }
}

/**
 * Read OAuth credentials from the macOS keychain, where Claude Code stores them
 * instead of ~/.claude/.credentials.json.
 * Returns null on other platforms, or if the entry is missing or can't be parsed.
 */
export function readKeychainCredentials(): ClaudeOAuthCredentials | null {
  if (process.platform !== "darwin") return null

  try {
    const raw = execSync(`security find-generic-password -s "${KEYCHAIN_SERVICE}" -w`, {
      timeout: 5_000,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    })
    return parseCredentials(raw)
  } catch {
    return null
  }
}

/**
 * Read OAuth credentials from Claude Code's credentials file, falling back to
 * the macOS keychain when the default file doesn't exist.
 * An explicit `path` restricts the lookup to that file only.
 * Returns null if no credentials are found or they can't be parsed.
 */
export function readClaudeCredentials(path?: string): ClaudeOAuthCredentials | null {
  const credPath = path ?? getCredentialsPath()

  if (existsSync(credPath)) {
    try {
      return parseCredentials(readFileSync(credPath, "utf-8"))
    } catch {
      return null
    }
  }

  // Explicit path: don't silently pick up credentials from somewhere else
  if (path !== undefined) return null

  return readKeychainCredentials()
}

/**
 * Check if credentials are expired (with 60s buffer).
 */
export function isExpired(creds: ClaudeOAuthCredentials): boolean {
  return Date.now() > creds.expiresAt - EXPIRY_BUFFER_MS
}

/**
 * Run the Claude CLI to trigger an OAuth token refresh.
 * The CLI writes refreshed credentials to ~/.claude/.credentials.json
 * (or to the keychain on macOS).
 * Retries once on failure (matching opencode-claude-auth behavior).
 */
export function refreshViaCli(): boolean {
  const maxAttempts = 2
  for (let i = 0; i < maxAttempts; i++) {
    try {
      execSync("claude -p . --model haiku", {
        timeout: 60_000,
        encoding: "utf-8",
        env: { ...process.env, TERM: "dumb" },
        stdio: "ignore",
      })
      return true
    } catch {
      // Non-fatal: retry once, then give up
    }
  }
  return false
}

/**
 * Read credentials, refreshing via Claude CLI if the token is near expiry.
 * Returns null only if credentials are completely unavailable.
 */
export function refreshIfNeeded(path?: string): ClaudeOAuthCredentials | null {
  const creds = readClaudeCredentials(path)
  if (!creds) return null

  // Token still fresh
  if (!isExpired(creds)) return creds

  // Token near expiry — run Claude CLI to refresh
  console.warn("[anthropic-sdk-provider] OAuth token near expiry, refreshing via Claude CLI...")
  const refreshed = refreshViaCli()
  if (!refreshed) {
    console.warn("[anthropic-sdk-provider] CLI refresh failed. Token may be expired.")
    // Return the existing creds anyway — they might still work for a bit
    return creds
  }

  // Re-read (file or keychain) after CLI refresh
  const fresh = readClaudeCredentials(path)
  if (fresh && !isExpired(fresh)) {
    console.warn("[anthropic-sdk-provider] Token refreshed successfully.")
    return fresh
  }

  // CLI ran but didn't produce a fresh token — return what we have
  return fresh ?? creds
}

/**
 * Get cached credentials with automatic refresh.
 * Uses in-memory caching with a 30-second TTL to avoid
 * hitting the filesystem or keychain on every request.
 * When the cached token is near expiry, triggers a CLI refresh.
 */
export function getCachedCredentials(path?: string): ClaudeOAuthCredentials | null {
  const now = Date.now()
  const resolvedPath = path ?? cachedPath

  // Return cached if still fresh and not near expiry
  if (cachedCreds && now - cachedAt < CREDENTIAL_CACHE_TTL_MS && !isExpired(cachedCreds)) {
    return cachedCreds
  }

  // Read and potentially refresh
  const fresh = refreshIfNeeded(resolvedPath)
  if (fresh) {
    cachedCreds = fresh
    cachedAt = now
    cachedPath = resolvedPath
  } else {
    cachedCreds = null
  }

  return cachedCreds
}

/**
 * Clear the in-memory credential cache.
 * Forces the next getCachedCredentials() call to re-read credentials.
 */
export function clearCredentialCache(): void {
  cachedCreds = null
  cachedAt = 0
  cachedPath = undefined
}
