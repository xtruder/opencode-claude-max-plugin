import { setTimeout as sleep } from "node:timers/promises"
import { expect, test } from "vitest"
import { createUsageStore } from "./tui-state.ts"
import { headerUsageToUsageData, type UsageCache } from "./usage.ts"

test("polling survives errors, labels stale data, and stops on disposal", async () => {
  let calls = 0
  const cache = empty()
  cache.api = headerUsageToUsageData({ fiveHourUtil: 0.5 })
  const store = createUsageStore(5, {
    read: () => cache,
    write: () => {},
    fetch: async () => {
      calls++
      throw new Error("secret-bearing failure")
    },
  })
  await store.refresh()
  expect(store.usage()?.five_hour?.utilization).toBe(50)
  expect(store.status()).toContain("cached")
  await sleep(20)
  expect(calls).toBeGreaterThan(1)
  store.dispose()
  const stopped = calls
  await sleep(20)
  await store.refresh()
  expect(calls).toBe(stopped)
})

test("disposal ignores late responses and does not persist them", async () => {
  let resolve!: (value: any) => void
  let writes = 0
  const store = createUsageStore(60_000, {
    read: empty,
    write: () => {
      writes++
    },
    fetch: () =>
      new Promise((done) => {
        resolve = done
      }),
  })
  const done = store.refresh()
  store.dispose()
  resolve({ data: headerUsageToUsageData({ fiveHourUtil: 1 }), retryAfterMs: 0 })
  await done
  expect(writes).toBe(0)
  expect(store.usage()).toBeNull()
})

test("rate limits are persisted and no-data errors give actionable non-secret status", async () => {
  const cache = empty()
  let calls = 0
  const store = createUsageStore(60_000, {
    read: () => cache,
    write: (update) => Object.assign(cache, update),
    fetch: async () => {
      calls++
      return { data: null, retryAfterMs: 60_000 }
    },
  })
  await store.refresh()
  expect(cache.apiRateLimitUntil).toBeGreaterThan(Date.now())
  await store.refresh()
  expect(calls).toBe(1)
  expect(store.status()).toContain("retrying")
  store.dispose()
  const missing = createUsageStore(60_000, {
    read: empty,
    write: () => {},
    fetch: async () => ({ data: null, retryAfterMs: 0 }),
  })
  await missing.refresh()
  expect(missing.status()).toContain("claude auth login")
  missing.dispose()
})

test("passes a custom credential path and aborts the fetch on disposal", async () => {
  let path: string | undefined
  let signal: AbortSignal | undefined
  const store = createUsageStore(
    60_000,
    {
      read: empty,
      write: () => {},
      fetch: async (p, s) => {
        path = p
        signal = s
        return { data: null, retryAfterMs: 0 }
      },
    },
    "/missing/credentials.json",
  )
  await store.refresh()
  expect(path).toBe("/missing/credentials.json")
  expect(signal?.aborted).toBe(false)
  store.dispose()
  expect(signal?.aborted).toBe(true)
})

const empty = (): UsageCache => ({
  api: null,
  headers: null,
  updatedAt: 0,
  apiFetchedAt: 0,
  apiRateLimitUntil: 0,
})
test("loads usage once, shares concurrent refreshes, and caches the result", async () => {
  let calls = 0
  let resolve!: (value: any) => void
  const data = headerUsageToUsageData({ fiveHourUtil: 0.25 })
  const cache = empty()
  const store = createUsageStore(60_000, {
    read: () => cache,
    write: (update) => Object.assign(cache, update),
    fetch: () => {
      calls++
      return new Promise((done) => {
        resolve = done
      })
    },
  })
  expect(store.status()).toBe("loading")
  const refreshing = store.refresh()
  expect(calls).toBe(1)
  resolve({ data, retryAfterMs: 0 })
  await refreshing
  expect(store.usage()).toEqual(data)
  expect(store.status()).toBe("ready")
  expect(cache.api).toEqual(data)
  await store.refresh()
  expect(calls).toBe(1)
  store.dispose()
})
