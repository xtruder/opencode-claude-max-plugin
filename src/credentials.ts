import { readFileSync, existsSync } from "node:fs"
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
 * Default path to Claude Code credentials file.
 */
export function getCredentialsPath(): string {
  return join(homedir(), ".claude", ".credentials.json")
}

/**
 * Read OAuth credentials from Claude Code's credentials file.
 * Returns null if the file doesn't exist or can't be parsed.
 */
export function readClaudeCredentials(
  path?: string,
): ClaudeOAuthCredentials | null {
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
 * Check if credentials are expired (with 5 minute buffer).
 */
export function isExpired(creds: ClaudeOAuthCredentials): boolean {
  const buffer = 5 * 60 * 1000 // 5 minutes
  return Date.now() > creds.expiresAt - buffer
}
