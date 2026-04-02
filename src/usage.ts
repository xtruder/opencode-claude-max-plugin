/**
 * Claude subscription usage tracking.
 *
 * Two data sources:
 * 1. Usage API (GET /api/oauth/usage) — full per-model breakdown, rate limited
 * 2. Response headers (anthropic-ratelimit-unified-*) — 5h/7d only, every inference call
 *
 * Both are persisted to a shared cache file (~/.local/state/opencode/usage-cache.json)
 * so the TUI plugin (main process) can read data written by the server plugin (worker process).
 */
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
  openSync,
  closeSync,
  renameSync,
  constants as fsConstants,
} from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { readClaudeCredentials } from "./credentials.ts"

// ─── Types ───────────────────────────────────────────────────────────

export interface UsageWindow {
  utilization: number // percentage (0-100)
  resets_at: string | null // ISO timestamp
}

export interface UsageData {
  five_hour: UsageWindow | null
  seven_day: UsageWindow | null
  seven_day_sonnet: UsageWindow | null
  seven_day_opus: UsageWindow | null
  seven_day_oauth_apps: UsageWindow | null
  seven_day_cowork: UsageWindow | null
  extra_usage: {
    is_enabled: boolean
    monthly_limit: number | null
    used_credits: number | null
    utilization: number | null
  } | null
}

/**
 * Lightweight usage from response headers (5h/7d only).
 * Updated by the server plugin's wrappedFetch on every inference call.
 */
export interface HeaderUsage {
  fiveHourUtil?: number // 0-1 ratio
  sevenDayUtil?: number // 0-1 ratio
  fiveHourReset?: number // epoch seconds
  sevenDayReset?: number // epoch seconds
  overageStatus?: string
}

/**
 * Shared cache file format. Contains the best available data from
 * both the API and response headers, plus metadata for rate-limit-aware polling.
 */
export interface UsageCache {
  /** Full API response (null if never fetched or no credentials) */
  api: UsageData | null
  /** Lightweight header data (null if no inference has run yet) */
  headers: HeaderUsage | null
  /** When the cache was last written (epoch ms) */
  updatedAt: number
  /** When the API was last successfully fetched (epoch ms, 0 = never) */
  apiFetchedAt: number
  /** When the API rate limit expires (epoch ms, 0 = not rate limited) */
  apiRateLimitUntil: number
}

// ─── In-memory state (server plugin, worker process) ─────────────────

/**
 * In-memory header usage, updated on every inference call.
 * Only meaningful in the server/worker process.
 */
export const cachedUsage: HeaderUsage = {}

// ─── Cache file ──────────────────────────────────────────────────────

const XDG_STATE = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state")
const USAGE_CACHE_DIR = join(XDG_STATE, "opencode")
const USAGE_CACHE_FILE = join(USAGE_CACHE_DIR, "usage-cache.json")

function emptyCache(): UsageCache {
  return { api: null, headers: null, updatedAt: 0, apiFetchedAt: 0, apiRateLimitUntil: 0 }
}

const USAGE_LOCK_FILE = USAGE_CACHE_FILE + ".lock"
const USAGE_TMP_FILE = USAGE_CACHE_FILE + ".tmp"

/** Max time a lock can be held before we consider it stale (ms). */
const LOCK_STALE_MS = 5_000

/**
 * Acquire an exclusive lock using O_CREAT|O_EXCL (atomic on all filesystems).
 * Returns true if acquired, false if another process holds it.
 * Stale locks (older than LOCK_STALE_MS) are automatically broken.
 */
function acquireLock(): boolean {
  try {
    mkdirSync(USAGE_CACHE_DIR, { recursive: true })
    const fd = openSync(
      USAGE_LOCK_FILE,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
    )
    // Write PID + timestamp so we can detect stale locks
    writeFileSync(fd, `${process.pid}\n${Date.now()}`)
    closeSync(fd)
    return true
  } catch (err: any) {
    if (err?.code !== "EEXIST") return false
    // Lock file exists — check if it's stale
    try {
      const text = readFileSync(USAGE_LOCK_FILE, "utf-8")
      const ts = parseInt(text.split("\n")[1] ?? "0")
      if (Date.now() - ts > LOCK_STALE_MS) {
        // Stale lock — break it and retry
        unlinkSync(USAGE_LOCK_FILE)
        return acquireLock()
      }
    } catch {
      // Can't read lock file — try to break it
      try {
        unlinkSync(USAGE_LOCK_FILE)
      } catch {}
      return acquireLock()
    }
    return false
  }
}

function releaseLock(): void {
  try {
    unlinkSync(USAGE_LOCK_FILE)
  } catch {}
}

/**
 * Read the shared cache file. Returns empty cache if not found.
 */
export function readUsageCache(): UsageCache {
  try {
    const text = readFileSync(USAGE_CACHE_FILE, "utf-8")
    const data = JSON.parse(text)
    if (data && typeof data.updatedAt === "number") return data as UsageCache
  } catch {
    // File doesn't exist yet or is invalid
  }
  return emptyCache()
}

/**
 * Transactional read-modify-write of the cache file.
 * Uses a lockfile for mutual exclusion and write-to-tmp+rename for atomicity.
 */
export function writeUsageCache(update: Partial<UsageCache>): void {
  if (!acquireLock()) return // Another process is writing — skip this update
  try {
    const existing = readUsageCache()
    const merged: UsageCache = {
      ...existing,
      ...update,
      updatedAt: Date.now(),
    }
    mkdirSync(USAGE_CACHE_DIR, { recursive: true })
    writeFileSync(USAGE_TMP_FILE, JSON.stringify(merged))
    renameSync(USAGE_TMP_FILE, USAGE_CACHE_FILE)
  } catch {
    // Non-fatal — clean up tmp if it exists
    try {
      unlinkSync(USAGE_TMP_FILE)
    } catch {}
  } finally {
    releaseLock()
  }
}

/**
 * Persist current in-memory header usage to the cache file.
 * Called from the server plugin's wrappedFetch after parsing response headers.
 */
export function persistCachedUsage(): void {
  if (cachedUsage.fiveHourUtil == null && cachedUsage.sevenDayUtil == null) return
  writeUsageCache({ headers: { ...cachedUsage } })
}

// ─── Usage API ───────────────────────────────────────────────────────

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage"

/**
 * Fetch current Claude subscription usage from the API.
 * Returns { data, retryAfterMs } so callers can track rate limit state.
 * retryAfterMs > 0 means the API returned 429 with a Retry-After header.
 */
export async function fetchUsage(
  credentialsPath?: string,
): Promise<{ data: UsageData | null; retryAfterMs: number }> {
  const creds = readClaudeCredentials(credentialsPath)
  if (!creds) return { data: null, retryAfterMs: 0 }
  if (creds.expiresAt && creds.expiresAt < Date.now()) return { data: null, retryAfterMs: 0 }

  const resp = await fetch(USAGE_URL, {
    headers: {
      authorization: `Bearer ${creds.accessToken}`,
      "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
      "content-type": "application/json",
      "user-agent": "claude-cli/2.1.81 (external, sdk-cli)",
      "x-app": "cli",
    },
  })

  if (resp.status === 429) {
    const retryAfter = parseInt(resp.headers.get("retry-after") ?? "60")
    // Minimum 60s backoff — the usage API often returns retry-after: 0
    // but keeps rejecting for much longer
    const retryAfterMs = Math.max(60_000, retryAfter * 1000)
    return { data: null, retryAfterMs }
  }

  if (!resp.ok) return { data: null, retryAfterMs: 0 }
  const data = (await resp.json()) as UsageData
  return { data, retryAfterMs: 0 }
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Convert HeaderUsage (from response headers) to UsageData (API format).
 * Provides a partial view — only 5h and 7d windows are available.
 */
export function headerUsageToUsageData(h: HeaderUsage): UsageData {
  return {
    five_hour:
      h.fiveHourUtil != null
        ? {
            utilization: h.fiveHourUtil * 100,
            resets_at: h.fiveHourReset ? new Date(h.fiveHourReset * 1000).toISOString() : null,
          }
        : null,
    seven_day:
      h.sevenDayUtil != null
        ? {
            utilization: h.sevenDayUtil * 100,
            resets_at: h.sevenDayReset ? new Date(h.sevenDayReset * 1000).toISOString() : null,
          }
        : null,
    seven_day_sonnet: null,
    seven_day_opus: null,
    seven_day_oauth_apps: null,
    seven_day_cowork: null,
    extra_usage: null,
  }
}

/**
 * Get the best available UsageData from the cache by merging both sources.
 * - Headers provide the freshest 5h/7d numbers (updated every inference call)
 * - API provides per-model breakdown and extra usage (updated less frequently)
 * When both exist, header 5h/7d values override API values since they're fresher.
 */
export function bestUsageFromCache(cache: UsageCache): UsageData | null {
  if (!cache.api && !cache.headers) return null

  const fromHeaders = cache.headers ? headerUsageToUsageData(cache.headers) : null
  const fromApi = cache.api

  if (!fromApi) return fromHeaders
  if (!fromHeaders) return fromApi

  // Merge: use fresh header data for 5h/7d, API data for everything else
  return {
    five_hour: fromHeaders.five_hour ?? fromApi.five_hour,
    seven_day: fromHeaders.seven_day ?? fromApi.seven_day,
    seven_day_sonnet: fromApi.seven_day_sonnet,
    seven_day_opus: fromApi.seven_day_opus,
    seven_day_oauth_apps: fromApi.seven_day_oauth_apps,
    seven_day_cowork: fromApi.seven_day_cowork,
    extra_usage: fromApi.extra_usage,
  }
}

/** How long API data is considered fresh before re-fetching (5 minutes). */
const API_TTL_MS = 5 * 60_000

/**
 * Check if the API should be called.
 * Returns true when not rate limited AND either never fetched or TTL expired.
 */
export function shouldFetchApi(cache: UsageCache): boolean {
  // Respect rate limit backoff
  if (cache.apiRateLimitUntil && Date.now() < cache.apiRateLimitUntil) return false
  // Fetch if never fetched or TTL expired
  if (!cache.apiFetchedAt) return true
  return Date.now() - cache.apiFetchedAt > API_TTL_MS
}

/**
 * Format a reset timestamp as relative time.
 */
export function formatReset(resetsAt: string | null): string {
  if (!resetsAt) return ""
  const reset = new Date(resetsAt)
  const now = new Date()
  const diffMs = reset.getTime() - now.getTime()

  if (diffMs <= 0) return "Reset now"

  const diffMin = Math.floor(diffMs / 60000)
  const diffHour = Math.floor(diffMin / 60)

  const timeStr = reset.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  })
  const dateStr = reset.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  })

  if (diffHour < 1) return `Resets in ${diffMin}m`
  if (diffHour < 24) return `Resets ${timeStr}`
  return `Resets ${dateStr}, ${timeStr}`
}
