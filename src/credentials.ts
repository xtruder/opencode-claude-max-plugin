import { readFileSync, existsSync } from "node:fs"
import { execSync } from "node:child_process"
import { join } from "node:path"
import { homedir } from "node:os"

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
 * How long to cache credentials in memory before re-reading from disk.
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
 * Read OAuth credentials from Claude Code's credentials file.
 * Returns null if the file doesn't exist or can't be parsed.
 */
export function readClaudeCredentials(path?: string): ClaudeOAuthCredentials | null {
  const credPath = path ?? getCredentialsPath()

  if (!existsSync(credPath)) return null

  try {
    const raw = readFileSync(credPath, "utf-8")
    const parsed: CredentialsFile = JSON.parse(raw)
    if (!parsed.claudeAiOauth?.accessToken) return null
    return parsed.claudeAiOauth
  } catch {
    return null
  }
}

/**
 * Check if credentials are expired (with 60s buffer).
 */
export function isExpired(creds: ClaudeOAuthCredentials): boolean {
  return Date.now() > creds.expiresAt - EXPIRY_BUFFER_MS
}

/**
 * Run the Claude CLI to trigger an OAuth token refresh.
 * The CLI writes refreshed credentials to ~/.claude/.credentials.json.
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

  // Re-read from disk after CLI refresh
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
 * hitting the filesystem on every request.
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
 * Forces the next getCachedCredentials() call to re-read from disk.
 */
export function clearCredentialCache(): void {
  cachedCreds = null
  cachedAt = 0
  cachedPath = undefined
}
