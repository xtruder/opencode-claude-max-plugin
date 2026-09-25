import { testRender } from "@opentui/solid"
import { createSignal, onCleanup } from "solid-js"
import { expect, test } from "vitest"
// Test the shipped OpenTUI-compiled artifact, not a JSX mock.
import plugin, { UsageView } from "../build/tui.js"
import { headerUsageToUsageData } from "./usage.ts"

test("v2 plugin exposes setup and disabled mode creates no registrations", () => {
  expect(plugin.id).toBe("anthropic-sdk-usage")
  expect(plugin.setup({ options: { enabled: false } })).toBeUndefined()
})

test("commands mount under the app slot in global mode and cleanup releases slots", async () => {
  const claims: any[] = []
  let layer: any
  let commandDisposed = false
  let released = 0
  const dispose = plugin.setup({
    options: { credentialsPath: "/nonexistent/claude-tui-test-credentials.json" },
    keymap: {
      layer: (fn: any) => {
        layer = fn()
        onCleanup(() => {
          commandDisposed = true
        })
      },
    },
    ui: {
      slot: (claim: any) => {
        claims.push(claim)
        return () => {
          released++
        }
      },
    },
  } as any)
  expect(layer).toBeUndefined()
  expect(claims.map((c) => c.append)).toEqual(["app", "sidebar.content"])
  const mounted = await testRender(claims[0].render, { width: 30, height: 10 })
  try {
    expect(layer.mode).toBe("global")
    expect(layer.commands[0].slash.name).toBe("usage")
  } finally {
    mounted.renderer.destroy()
    dispose?.()
  }
  expect(commandDisposed).toBe(true)
  expect(released).toBe(2)
})

test("sidebar renders quota bars and updates reactively; dialog adds model detail", async () => {
  const [usage, setUsage] = createSignal(
    headerUsageToUsageData({ fiveHourUtil: 0.25, sevenDayUtil: 0.6 }),
  )
  const [status, setStatus] = createSignal("ready")
  const props = {
    store: { usage, status },
    theme: {
      text: { base: "#ffffff", muted: "#888888", action: { primary: { base: "#00ffff" } } },
    },
  }
  const view = await testRender(() => UsageView(props), { width: 50, height: 20 })
  try {
    await view.renderOnce()
    expect(view.captureCharFrame()).toContain("Claude Usage")
    expect(view.captureCharFrame()).toContain("25%")
    setUsage({ ...usage(), five_hour: { utilization: 90, resets_at: null } })
    setStatus("Showing cached usage. Rate limited; retrying later.")
    await view.renderOnce()
    expect(view.captureCharFrame()).toContain("90%")
    expect(view.captureCharFrame()).toContain("cached")
  } finally {
    view.renderer.destroy()
  }
  setUsage({
    ...usage(),
    seven_day_sonnet: { utilization: 42, resets_at: null },
    extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
  })
  const dialog = await testRender(() => UsageView({ ...props, detail: true }), {
    width: 70,
    height: 24,
  })
  try {
    await dialog.renderOnce()
    expect(dialog.captureCharFrame()).toContain("Claude Subscription Usage")
    expect(dialog.captureCharFrame()).toContain("Sonnet (7d)")
    expect(dialog.captureCharFrame()).toContain("42%")
    expect(dialog.captureCharFrame()).toContain("Extra usage: disabled")
  } finally {
    dialog.renderer.destroy()
  }
})

test("bars fill available sidebar and padded dialog width and resize both ways", async () => {
  for (const detail of [false, true]) {
    const view = await testRender(
      () =>
        UsageView({
          detail,
          theme: {
            text: { base: "#ffffff", muted: "#888888", action: { primary: { base: "#00ffff" } } },
          },
          store: {
            usage: () => headerUsageToUsageData({ fiveHourUtil: 0.25 }),
            status: () => "ready",
          },
        }),
      { width: 50, height: 12 },
    )
    try {
      for (const width of [50, 32, 80]) {
        view.resize(width, 12)
        await view.flush()
        const line = view
          .captureCharFrame()
          .split("\n")
          .find((row) => row.includes("5h ["))!
        expect(line).toBeDefined()
        expect(line.trim().length).toBe(width - (detail ? 2 : 0))
        expect(line.trim()).toMatch(/25%$/)
      }
    } finally {
      view.renderer.destroy()
    }
  }
})

test("empty and loading states are visible instead of hiding the sidebar", async () => {
  const view = await testRender(
    () =>
      UsageView({
        theme: {
          text: { base: "#ffffff", muted: "#888888", action: { primary: { base: "#00ffff" } } },
        },
        store: { usage: () => null, status: () => "loading" },
      }),
    { width: 50, height: 10 },
  )
  try {
    await view.renderOnce()
    expect(view.captureCharFrame()).toContain("Loading usage")
  } finally {
    view.renderer.destroy()
  }
})
