/**
 * Cached ratelimit usage from the most recent API response headers.
 * Updated on every successful inference call — same data Claude Code
 * reads for its /usage display. No extra API call needed.
 */
export interface CachedUsage {
  fiveHourUtil?: number
  sevenDayUtil?: number
  fiveHourReset?: number
  sevenDayReset?: number
  overageStatus?: string
  timestamp?: number
}

export const cachedUsage: CachedUsage = {}
