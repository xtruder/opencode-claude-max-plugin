/** @jsxImportSource @opentui/solid */
import type { Plugin } from "@opencode/plugin/tui"
import { For, Show, createSignal, type Accessor } from "solid-js"
import { createUsageStore } from "./tui-state.ts"
import { formatReset, type UsageWindow } from "./usage.ts"

const percent = (value: number) =>
  Math.round(Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0)))

type Store = Pick<ReturnType<typeof createUsageStore>, "usage" | "status">
export function UsageView(props: {
  store: Store
  theme: Plugin.Context["theme"]
  detail?: boolean
}) {
  const rows = (): [string, UsageWindow | null | undefined][] => {
    const data = props.store.usage()
    return [
      ["5h", data?.five_hour],
      ["7d", data?.seven_day],
      ...(props.detail
        ? ([
            ["Sonnet (7d)", data?.seven_day_sonnet],
            ["Opus (7d)", data?.seven_day_opus],
            ["OAuth apps (7d)", data?.seven_day_oauth_apps],
            ["Cowork (7d)", data?.seven_day_cowork],
          ] as [string, UsageWindow | null | undefined][])
        : []),
    ].filter(([, window]) => window) as [string, UsageWindow][]
  }
  return (
    <box width="100%" flexDirection="column" padding={props.detail ? 1 : 0} gap={0}>
      <text fg={props.theme.text.base}>
        <b>{props.detail ? "Claude Subscription Usage" : "Claude Usage"}</b>
      </text>
      <For each={rows()}>
        {([label, window]) => {
          const [width, setWidth] = createSignal(0)
          const line = () => {
            const suffix = `] ${percent(window!.utilization)}%`
            const prefix = `${label} [`
            const size = Math.max(0, width() - prefix.length - suffix.length)
            const filled = Math.round((percent(window!.utilization) * size) / 100)
            return prefix + "█".repeat(filled) + "░".repeat(size - filled) + suffix
          }
          return (
            <box
              width="100%"
              flexDirection="column"
              onSizeChange={function () {
                setWidth(this.width)
              }}
            >
              <text fg={props.theme.text.action.primary.base}>{line()}</text>
              <Show when={window?.resets_at}>
                <text fg={props.theme.text.muted}>{formatReset(window!.resets_at)}</text>
              </Show>
            </box>
          )
        }}
      </For>
      <Show when={props.detail && props.store.usage()?.extra_usage}>
        {(extra: Accessor<NonNullable<NonNullable<ReturnType<Store["usage"]>>["extra_usage"]>>) => (
          <text fg={props.theme.text.muted}>
            {extra().is_enabled
              ? `Extra usage: ${extra().utilization == null ? "enabled" : `${percent(extra().utilization!)}% used`}`
              : "Extra usage: disabled"}
          </text>
        )}
      </Show>
      <Show when={props.store.status() !== "ready"}>
        <text fg={props.theme.text.muted}>
          {props.store.status() === "loading" ? "Loading usage…" : props.store.status()}
        </text>
      </Show>
      <Show when={props.store.status() === "ready" && rows().length === 0}>
        <text fg={props.theme.text.muted}>No usage windows available.</text>
      </Show>
      <Show when={props.detail}>
        <text fg={props.theme.text.muted}>Esc to close · /usage refreshes (API cache: 5m)</text>
      </Show>
    </box>
  )
}

export default {
  id: "anthropic-sdk-usage",
  setup(ctx) {
    if (ctx.options.enabled === false || ctx.options.enabled === "false") return
    const seconds = Number(ctx.options.poll_interval ?? 60)
    const store = createUsageStore(
      (Number.isFinite(seconds) ? Math.max(10, seconds) : 60) * 1000,
      undefined,
      ctx.options.credentialsPath,
    )
    // Keymap layers require the host's mounted Keymap.Provider, not setup's owner.
    const offCommand = ctx.ui.slot({
      append: "app",
      render: () => {
        ctx.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "anthropic-sdk.usage",
              title: "Claude subscription usage",
              group: "Claude",
              palette: true,
              slash: { name: "usage" },
              run() {
                void store.refresh()
                ctx.ui.dialog.show(() => <UsageView store={store} theme={ctx.theme} detail />)
              },
            },
          ],
        }))
        return null
      },
    })
    const offSidebar =
      ctx.options.sidebar === false || ctx.options.sidebar === "false"
        ? () => {}
        : ctx.ui.slot({
            append: "sidebar.content",
            render: () => <UsageView store={store} theme={ctx.theme} />,
          })
    return () => {
      store.dispose()
      offCommand()
      offSidebar()
    }
  },
} satisfies Plugin.Definition
