/**
 * Claude subscription usage tracking.
 *
 * Fetches usage data from the /api/oauth/usage endpoint
 * (same endpoint Claude Code's /usage command uses).
 */
import { readClaudeCredentials, isExpired } from "./credentials.js"

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

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage"

/**
 * Fetch current Claude subscription usage.
 * Returns null if not using OAuth credentials.
 */
export async function fetchUsage(credentialsPath?: string): Promise<UsageData | null> {
  const creds = readClaudeCredentials(credentialsPath)
  if (!creds) return null
  if (isExpired(creds)) return null

  const resp = await fetch(USAGE_URL, {
    headers: {
      "authorization": `Bearer ${creds.accessToken}`,
      "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
      "content-type": "application/json",
      "user-agent": "claude-cli/2.1.81 (external, sdk-cli)",
      "x-app": "cli",
    },
  })

  if (!resp.ok) {
    const body = await resp.text().catch(() => "")
    const msg = body.includes("message")
      ? JSON.parse(body)?.error?.message ?? body
      : `HTTP ${resp.status}`
    throw new Error(`Usage API error: ${msg}`)
  }
  return resp.json() as Promise<UsageData>
}

/**
 * Format a progress bar like Claude Code's /usage display.
 */
function progressBar(utilization: number, width: number = 50): string {
  const filled = Math.round((utilization / 100) * width)
  const bar = "█".repeat(filled) + " ".repeat(width - filled)
  return bar
}

/**
 * Format a reset timestamp as relative time.
 */
function formatReset(resetsAt: string | null): string {
  if (!resetsAt) return ""
  const reset = new Date(resetsAt)
  const now = new Date()
  const diffMs = reset.getTime() - now.getTime()

  if (diffMs <= 0) return "Reset now"

  const diffMin = Math.floor(diffMs / 60000)
  const diffHour = Math.floor(diffMin / 60)

  // Format reset time in local timezone
  const timeStr = reset.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  })
  const dateStr = reset.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  })

  if (diffHour < 24) {
    return `Resets ${timeStr}`
  }
  return `Resets ${dateStr}, ${timeStr}`
}

/**
 * Format usage data as a display string matching Claude Code's /usage output.
 */
export function formatUsage(data: UsageData): string {
  const lines: string[] = []

  if (data.five_hour) {
    const pct = Math.round(data.five_hour.utilization)
    lines.push("  Current session")
    lines.push(`  ${progressBar(pct)}  ${pct}% used`)
    lines.push(`  ${formatReset(data.five_hour.resets_at)}`)
    lines.push("")
  }

  if (data.seven_day) {
    const pct = Math.round(data.seven_day.utilization)
    lines.push("  Current week (all models)")
    lines.push(`  ${progressBar(pct)}  ${pct}% used`)
    lines.push(`  ${formatReset(data.seven_day.resets_at)}`)
    lines.push("")
  }

  if (data.seven_day_sonnet) {
    const pct = Math.round(data.seven_day_sonnet.utilization)
    lines.push("  Current week (Sonnet only)")
    lines.push(`  ${progressBar(pct)}  ${pct}% used`)
    if (data.seven_day_sonnet.resets_at) {
      lines.push(`  ${formatReset(data.seven_day_sonnet.resets_at)}`)
    }
    lines.push("")
  }

  if (data.seven_day_opus) {
    const pct = Math.round(data.seven_day_opus.utilization)
    lines.push("  Current week (Opus only)")
    lines.push(`  ${progressBar(pct)}  ${pct}% used`)
    if (data.seven_day_opus.resets_at) {
      lines.push(`  ${formatReset(data.seven_day_opus.resets_at)}`)
    }
    lines.push("")
  }

  if (data.extra_usage) {
    if (data.extra_usage.is_enabled) {
      const pct = Math.round(data.extra_usage.utilization ?? 0)
      lines.push("  Extra usage")
      lines.push(`  ${progressBar(pct)}  ${pct}% used`)
      if (data.extra_usage.monthly_limit != null) {
        lines.push(`  $${data.extra_usage.used_credits?.toFixed(2) ?? "0.00"} / $${data.extra_usage.monthly_limit.toFixed(2)}`)
      }
    } else {
      lines.push("  Extra usage: disabled")
    }
    lines.push("")
  }

  return lines.join("\n")
}
