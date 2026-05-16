/** @jsxImportSource @opentui/solid */
import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
  TuiThemeCurrent,
} from "@opencode-ai/plugin/tui"
import { type Accessor, Show, createMemo, createSignal } from "solid-js"
import {
  type UsageData,
  bestUsageFromCache,
  fetchUsage,
  formatReset,
  readUsageCache,
  shouldFetchApi,
  writeUsageCache,
} from "./usage.ts"

const id = "anthropic-sdk-usage"

type Api = TuiPluginApi

// ─── Config ──────────────────────────────────────────────────────────

type Cfg = {
  enabled: boolean
  sidebar: boolean
  poll_interval: number
}

const bool = (value: unknown, fallback: boolean) => {
  if (typeof value === "boolean") return value
  if (typeof value === "string") return value === "true"
  return fallback
}

const num = (value: unknown, fallback: number) => {
  if (typeof value === "number") return value
  if (typeof value === "string" && value.length > 0) {
    const n = Number(value)
    if (!Number.isNaN(n)) return n
  }
  return fallback
}

const rec = (value: unknown) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return Object.fromEntries(Object.entries(value))
}

const cfg = (opts: Record<string, unknown> | undefined): Cfg => ({
  enabled: bool(opts?.enabled, true),
  sidebar: bool(opts?.sidebar, true),
  poll_interval: Math.max(10, num(opts?.poll_interval, 60)),
})

// ─── Usage store ─────────────────────────────────────────────────────

type UsageStatus = "idle" | "loading" | "ready" | "no-credentials" | "error"

function createUsageStore(pollInterval: number) {
  const [usage, setUsage] = createSignal<UsageData | null>(null)
  const [status, setStatus] = createSignal<UsageStatus>("idle")

  /**
   * Refresh usage data. Priority:
   * 1. Try the usage API (richer data, per-model breakdown) — unless rate limited
   * 2. Fall back to cache file (updated by server from response headers)
   */
  const refresh = async () => {
    const cache = readUsageCache()

    // 1. Try the API if not rate limited and TTL expired
    if (shouldFetchApi(cache)) {
      setStatus(usage() ? "ready" : "loading")
      try {
        const { data, retryAfterMs } = await fetchUsage()
        if (data) {
          setUsage(data)
          setStatus("ready")
          // Persist API data to cache so other processes can read it
          writeUsageCache({ api: data, apiFetchedAt: Date.now(), apiRateLimitUntil: 0 })
          return
        }
        if (retryAfterMs > 0) {
          // Record when we can retry using the server's Retry-After value
          writeUsageCache({ apiRateLimitUntil: Date.now() + retryAfterMs })
        }
        if (!data && retryAfterMs === 0) {
          // No credentials or expired token
          if (!bestUsageFromCache(cache)) {
            setStatus("no-credentials")
            return
          }
        }
      } catch {
        // Network error — fall through to cache
      }
    }

    // 2. Fall back to cache file (header data from server, or previous API data)
    const best = bestUsageFromCache(cache)
    if (best) {
      setUsage(best)
      setStatus("ready")
      return
    }

    // Nothing available
    setStatus(usage() ? "ready" : "error")
  }

  // Initial load
  const cache = readUsageCache()
  const initial = bestUsageFromCache(cache)
  if (initial) {
    setUsage(initial)
    setStatus("ready")
  }

  // Async refresh for fresh data
  refresh()

  // Periodic polling
  const timer = setInterval(refresh, pollInterval * 1000)

  return {
    usage,
    status,
    refresh,
    dispose: () => clearInterval(timer),
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

const clamp01 = (v: number) => Math.max(0, Math.min(1, v))

const bar = (ratio: number, width: number): string => {
  const r = clamp01(ratio)
  const size = Math.max(1, width)
  const n = Math.round(r * size)
  return "\u2588".repeat(n) + "\u2591".repeat(size - n)
}

const pct = (ratio: number): string => Math.round(clamp01(ratio) * 100) + "%"

const fillWidth = (width: number, ...parts: string[]): number => {
  return Math.max(1, width - parts.reduce((sum, p) => sum + p.length, 0) - 2)
}

function barColor(ratio: number, theme: TuiThemeCurrent) {
  if (ratio > 0.9) return theme.error
  if (ratio > 0.7) return theme.warning
  return theme.primary
}

// ─── Sidebar Component ──────────────────────────────────────────────

function UsageSidebar(props: {
  theme: TuiThemeCurrent
  usage: () => UsageData | null
  status: () => UsageStatus
}) {
  const [barWidth, setBarWidth] = createSignal(20)

  const fiveHour = createMemo(() => {
    const d = props.usage()
    if (!d?.five_hour) return null
    return {
      ratio: clamp01(d.five_hour.utilization / 100),
      reset: d.five_hour.resets_at,
    }
  })

  const sevenDay = createMemo(() => {
    const d = props.usage()
    if (!d?.seven_day) return null
    return {
      ratio: clamp01(d.seven_day.utilization / 100),
      reset: d.seven_day.resets_at,
    }
  })

  const hasData = createMemo(() => fiveHour() !== null || sevenDay() !== null)

  return (
    <Show when={hasData()}>
      <box
        onSizeChange={function () {
          const next = Math.max(1, this.width)
          setBarWidth((prev) => (prev === next ? prev : next))
        }}
        width="100%"
        flexDirection="column"
      >
        <text fg={props.theme.text}>
          <b>Claude Usage</b>
        </text>
        <Show when={fiveHour()}>
          {(data: Accessor<{ ratio: number; reset: string | null }>) => {
            const label = "5H "
            const suffix = createMemo(() => ` ${pct(data().ratio)}`)
            return (
              <>
                <text>
                  <span style={{ fg: props.theme.textMuted }}>{label}</span>
                  <span style={{ fg: barColor(data().ratio, props.theme) }}>
                    [{bar(data().ratio, fillWidth(barWidth(), label, suffix()))}]
                  </span>
                  <span style={{ fg: props.theme.text }}>{suffix()}</span>
                </text>
                <Show when={data().reset}>
                  <text fg={props.theme.textMuted}>{formatReset(data().reset)}</text>
                </Show>
              </>
            )
          }}
        </Show>
        <Show when={sevenDay()}>
          {(data: Accessor<{ ratio: number; reset: string | null }>) => {
            const label = "7D "
            const suffix = createMemo(() => ` ${pct(data().ratio)}`)
            return (
              <>
                <text>
                  <span style={{ fg: props.theme.textMuted }}>{label}</span>
                  <span style={{ fg: barColor(data().ratio, props.theme) }}>
                    [{bar(data().ratio, fillWidth(barWidth(), label, suffix()))}]
                  </span>
                  <span style={{ fg: props.theme.text }}>{suffix()}</span>
                </text>
                <Show when={data().reset}>
                  <text fg={props.theme.textMuted}>{formatReset(data().reset)}</text>
                </Show>
              </>
            )
          }}
        </Show>
      </box>
    </Show>
  )
}

// ─── Dialog Component ────────────────────────────────────────────────

function UsageDialog(props: {
  api: Api
  usage: () => UsageData | null
  status: () => UsageStatus
}) {
  const theme = () => props.api.theme.current

  const lines = createMemo(() => {
    const data = props.usage()
    const st = props.status()

    if (!data) {
      if (st === "loading" || st === "idle") return ["Loading usage data..."]
      if (st === "no-credentials")
        return ["No OAuth credentials found", "Log in via: claude auth login"]
      return ["Waiting for usage data...", "Send a message first or try again shortly"]
    }

    const result: Array<{ label: string; pct: string; reset: string }> = []

    if (data.five_hour) {
      result.push({
        label: "Current session (5h)",
        pct: `${Math.round(data.five_hour.utilization)}% used`,
        reset: formatReset(data.five_hour.resets_at),
      })
    }
    if (data.seven_day) {
      result.push({
        label: "Current week (all models)",
        pct: `${Math.round(data.seven_day.utilization)}% used`,
        reset: formatReset(data.seven_day.resets_at),
      })
    }
    if (data.seven_day_sonnet) {
      result.push({
        label: "Current week (Sonnet)",
        pct: `${Math.round(data.seven_day_sonnet.utilization)}% used`,
        reset: formatReset(data.seven_day_sonnet.resets_at),
      })
    }
    if (data.seven_day_opus) {
      result.push({
        label: "Current week (Opus)",
        pct: `${Math.round(data.seven_day_opus.utilization)}% used`,
        reset: formatReset(data.seven_day_opus.resets_at),
      })
    }

    return result
  })

  const extra = createMemo(() => {
    const data = props.usage()
    if (!data?.extra_usage) return null
    if (!data.extra_usage.is_enabled) return { enabled: false, text: "Extra usage: disabled" }
    return {
      enabled: true,
      text:
        `Extra usage: ${Math.round(data.extra_usage.utilization ?? 0)}% used` +
        (data.extra_usage.monthly_limit != null
          ? ` ($${(data.extra_usage.used_credits ?? 0).toFixed(2)} / $${data.extra_usage.monthly_limit.toFixed(2)})`
          : ""),
    }
  })

  return (
    <box flexDirection="column" paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
      <text fg={theme().text}>
        <b>Claude Subscription Usage</b>
      </text>
      <text fg={theme().textMuted}>─────────────────────────────────</text>
      {(() => {
        const items = lines()
        if (typeof items[0] === "string") {
          return (items as string[]).map((line) => <text fg={theme().textMuted}>{line}</text>)
        }
        return (items as Array<{ label: string; pct: string; reset: string }>).map((item) => (
          <box paddingTop={1}>
            <text fg={theme().text}>{item.label}</text>
            <text>
              <span style={{ fg: theme().primary }}>{item.pct}</span>
            </text>
            <Show when={item.reset}>
              <text fg={theme().textMuted}>{item.reset}</text>
            </Show>
          </box>
        ))
      })()}
      <Show when={extra()}>
        {(ex: Accessor<{ enabled: boolean; text: string }>) => (
          <box paddingTop={1}>
            <text fg={ex().enabled ? theme().warning : theme().textMuted}>{ex().text}</text>
          </box>
        )}
      </Show>
    </box>
  )
}

// ─── Plugin ──────────────────────────────────────────────────────────

const tui: TuiPlugin = async (api, options) => {
  const config = cfg(rec(options))
  if (!config.enabled) return

  const store = createUsageStore(config.poll_interval)
  api.lifecycle.onDispose(store.dispose)

  // Refresh when session goes idle (inference completed — server just wrote new headers)
  const offEvent = api.event.on("session.idle", () => {
    setTimeout(store.refresh, 1000)
  })
  api.lifecycle.onDispose(offEvent)

  // Register /usage command
  api.command?.register(() => [
    {
      title: "Claude subscription usage",
      value: "anthropic-sdk.usage",
      category: "Claude",
      slash: {
        name: "usage",
      },
      onSelect() {
        store.refresh()
        api.ui.dialog.replace(() => (
          <UsageDialog api={api} usage={store.usage} status={store.status} />
        ))
      },
    },
  ])

  // Register sidebar slot
  if (config.sidebar) {
    api.slots.register({
      order: 110,
      slots: {
        sidebar_content(ctx) {
          return (
            <UsageSidebar theme={ctx.theme.current} usage={store.usage} status={store.status} />
          )
        },
      },
    })
  }
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
