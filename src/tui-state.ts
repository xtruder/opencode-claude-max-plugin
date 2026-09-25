import { createSignal } from "solid-js"
import {
  bestUsageFromCache,
  fetchUsage,
  readUsageCache,
  shouldFetchApi,
  writeUsageCache,
  type UsageData,
} from "./usage.ts"

const defaults = { read: readUsageCache, write: writeUsageCache, fetch: fetchUsage }
export function createUsageStore(intervalMs = 60_000, io = defaults, credentialsPath?: string) {
  const [usage, setUsage] = createSignal<UsageData | null>(null)
  const [status, setStatus] = createSignal("loading")
  let pending: Promise<void> | undefined
  let disposed = false
  const controller = new AbortController()
  const unavailable = (message: string) =>
    setStatus(usage() ? `Showing cached usage. ${message}` : message)
  const refresh = (): Promise<void> => {
    if (disposed) return Promise.resolve()
    if (pending) return pending
    pending = (async () => {
      try {
        const cache = io.read()
        const cached = bestUsageFromCache(cache)
        if (cached) setUsage(cached)
        if (!shouldFetchApi(cache)) {
          if (cache.apiRateLimitUntil > Date.now()) unavailable("Rate limited; retrying later.")
          else setStatus(cached ? "ready" : "Usage temporarily unavailable; retrying later.")
          return
        }
        const result = await io.fetch(
          credentialsPath,
          AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
        )
        if (disposed) return
        if (result.data) {
          setUsage(result.data)
          setStatus("ready")
          io.write({ api: result.data, apiFetchedAt: Date.now(), apiRateLimitUntil: 0 })
        } else if (result.retryAfterMs > 0) {
          io.write({ apiRateLimitUntil: Date.now() + result.retryAfterMs })
          unavailable("Rate limited; retrying later.")
        } else unavailable("Usage unavailable. Check Claude login: claude auth login")
      } catch {
        if (!disposed) unavailable("Usage request failed; retrying later.")
      }
    })().finally(() => {
      pending = undefined
    })
    return pending
  }
  void refresh()
  const timer = setInterval(() => void refresh(), intervalMs)
  return {
    usage,
    status,
    refresh,
    dispose: () => {
      disposed = true
      clearInterval(timer)
      controller.abort()
    },
  }
}
