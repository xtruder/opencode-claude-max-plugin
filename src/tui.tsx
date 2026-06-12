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

// ─── Fallback store ──────────────────────────────────────────────────

/**
 * Watches for server-side model fallback (Fable 5 safety refusal → Opus 4.8).
 *
 * The provider attaches a display-only `anthropic.servedBy` object to part
 * metadata when a response was served by a fallback model (see stream.ts).
 * OpenCode persists part metadata and forwards it here via
 * `message.part.updated` — no side-channel store is needed.
 *
 * Sticky routing is keyed on the conversation prefix server-side, so the
 * fallback state is PER SESSION — a refusal in one session says nothing
 * about another.
 *
 * The sidebar state is DERIVED from the session's persisted messages (via
 * api.state, OpenCode's synced replica) rather than accumulated from live
 * events — so it is correct after a TUI restart or when opening an old
 * session. The event subscription only drives the live toast, deduped with
 * an in-memory Set (part events never replay across restarts).
 */
type FallbackInfo = {
  from: string
  to: string
  kind: "fallback" | "sticky"
  at: number
}

const shortModel = (model: string) => model.replace(/^claude-/, "")

// Absolute time — stable without periodic re-rendering ("ago" phrasing
// would freeze between reactive updates).
const atTime = (at: number) =>
  new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })

function createFallbackStore(api: Api) {
  // Dedupe the repeated part-update events that fire as a part streams.
  const seenParts = new Set<string>()

  /** Extract the servedBy marker from one assistant message's parts. */
  const markerOf = (msg: any): FallbackInfo | null => {
    let latest: FallbackInfo | null = null
    for (const part of api.state.part(msg.id)) {
      const servedBy = (part as any)?.metadata?.anthropic?.servedBy
      if (!servedBy?.to) continue
      const time = (part as any)?.time
      const at = time?.end ?? time?.start ?? msg.time?.created ?? 0
      latest = {
        from: String(servedBy.from ?? "unknown"),
        to: String(servedBy.to),
        kind: servedBy.kind === "sticky" ? "sticky" : "fallback",
        at,
      }
    }
    return latest
  }

  /**
   * Walk a session's messages newest-first, yielding real assistant turns
   * (skipping title-generation / compaction summaries, which never carry
   * routing markers and would mask the real last turn).
   */
  function* assistantTurns(sessionID: string, beforeMessageID?: string) {
    const messages = api.state.session.messages(sessionID)
    let skipping = beforeMessageID !== undefined
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i] as any
      if (skipping) {
        if (msg?.id === beforeMessageID) skipping = false
        continue
      }
      if (msg?.role !== "assistant") continue
      if (msg.summary) continue
      yield msg
    }
  }

  // Live toast — only on the TRANSITION into fallback. A conversation that
  // trips the classifier every turn would otherwise toast on every message;
  // the sidebar line covers the continuing state. Sticky follow-ups never
  // toast for the same reason.
  const off = api.event.on("message.part.updated", (event) => {
    const part = (event as any).properties?.part
    const sessionID = (event as any).properties?.sessionID ?? part?.sessionID
    const servedBy = part?.metadata?.anthropic?.servedBy
    if (!servedBy?.to || !part?.id || !part?.messageID || !sessionID) return
    if (seenParts.has(part.id)) return
    seenParts.add(part.id)
    if (servedBy.kind === "sticky") return

    // Was the previous completed assistant turn already fallback-served?
    for (const msg of assistantTurns(sessionID, part.messageID)) {
      if (markerOf(msg)) return // continuation, not a transition
      if (msg.time?.completed) break // last known state was the primary model
    }

    api.ui.toast({
      variant: "warning",
      title: "Model fallback",
      message: `${shortModel(String(servedBy.from ?? "unknown"))} refused — answered by ${shortModel(String(servedBy.to))}`,
      duration: 6000,
    })
  })

  /**
   * Fallback state for one session, derived from its message parts — a pure
   * reactive derivation that re-evaluates only when session state changes.
   *
   * Only the MOST RECENT *settled* assistant turn is consulted: sticky
   * routing re-emits a servedBy marker on every turn while active, and a
   * turn that routed back to the primary model carries no marker. Looking
   * further back would resurrect a stale fallback after the session has
   * already returned to the requested model.
   *
   * A still-streaming turn without a marker is "unknown", not "no
   * fallback" — the previous completed turn's state keeps showing until
   * the new turn settles (otherwise the line flickers off on every send
   * and back on when the refusal hits mid-stream).
   *
   * No time window: "the latest turn was served by X" is a fact that stays
   * true until the next turn says otherwise. Whether the server's sticky
   * routing is still active is unobservable — we don't guess.
   */
  const active = (sessionID: string | undefined): FallbackInfo | null => {
    if (!sessionID) return null
    for (const msg of assistantTurns(sessionID)) {
      const marker = markerOf(msg)
      if (marker) return marker
      // No marker on a finished turn → currently served by the requested
      // model. No marker on a streaming turn → not known yet, keep looking
      // at the previous turn.
      if (msg.time?.completed) return null
    }
    return null
  }

  return { active, dispose: off }
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

// ─── Fallback Sidebar Component ──────────────────────────────────────

function FallbackSidebar(props: {
  theme: TuiThemeCurrent
  sessionID: string | undefined
  active: (sessionID: string | undefined) => FallbackInfo | null
}) {
  return (
    <Show when={props.active(props.sessionID)}>
      {(info: Accessor<FallbackInfo>) => (
        <box width="100%" flexDirection="column">
          <text fg={props.theme.warning}>
            <b>Model Fallback</b>
          </text>
          <text fg={props.theme.text}>
            {shortModel(info().from)} → {shortModel(info().to)}
          </text>
          <text fg={props.theme.textMuted}>
            {info().kind === "sticky"
              ? `sticky-routed at ${atTime(info().at)}`
              : `refused at ${atTime(info().at)}`}
          </text>
        </box>
      )}
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

  // Model fallback notifications (toast) + sidebar status line
  const fallback = createFallbackStore(api)
  api.lifecycle.onDispose(fallback.dispose)

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
        sidebar_content(ctx, props) {
          return (
            <>
              <UsageSidebar theme={ctx.theme.current} usage={store.usage} status={store.status} />
              <FallbackSidebar
                theme={ctx.theme.current}
                sessionID={(props as { session_id?: string } | undefined)?.session_id}
                active={fallback.active}
              />
            </>
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
