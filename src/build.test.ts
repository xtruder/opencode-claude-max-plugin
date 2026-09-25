import { existsSync, readFileSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { loadConfigFromFile } from "vite"
import { expect, test } from "vitest"

test("package root exports an OpenCode server plugin", async () => {
  const { default: plugin } = await import("@xtruder/opencode-claude-max-plugin")
  expect(plugin.id).toBe("anthropic-sdk")
  expect(typeof plugin.setup).toBe("function")
})

test("built server registers the executable provider file, not an inline asset", async () => {
  const { default: plugin } = await import(pathToFileURL(resolve("build/server.js")).href)
  let providerPackage = ""
  await plugin.setup({
    options: {},
    provider: {
      transform: async (register: (editor: unknown) => void) =>
        register({
          add: (provider: { info: { package: string } }) => {
            providerPackage = provider.info.package
          },
        }),
    },
    session: { hook: async () => {} },
  })
  expect(providerPackage).toBe(`aisdk:${pathToFileURL(resolve("build/index.js")).href}`)
  const provider = await import(providerPackage.slice("aisdk:".length))
  expect(typeof provider.createAnthropicSDK).toBe("function")
})

test("Vite builds the three Node ESM entrypoints with external runtime dependencies", async () => {
  expect(existsSync("vite.config.ts")).toBe(true)
  const loaded = await loadConfigFromFile({ command: "build", mode: "production" })
  expect(loaded?.config.build?.lib).toMatchObject({
    entry: { index: "src/index.ts", server: "src/server.ts", tui: "src/tui.tsx" },
    formats: ["es"],
    fileName: "[name]",
  })
  const pkg = JSON.parse(readFileSync("package.json", "utf8"))
  expect(pkg.scripts.build).toMatch(/^vite build && tsc /)
  expect(pkg.scripts.dev).toBe("vite build --watch")
  expect(pkg.devDependencies.esbuild).toBeUndefined()
  expect(existsSync("scripts/build.mjs")).toBe(false)
  for (const name of ["index", "server", "tui"]) {
    expect(existsSync(`build/${name}.js`)).toBe(true)
    expect(existsSync(`build/${name}.d.ts`)).toBe(true)
  }
  const output = readdirSync("build", { recursive: true })
    .filter((file) => String(file).endsWith(".js"))
    .map((file) => readFileSync(`build/${file}`, "utf8"))
    .join("\n")
  expect(output).toMatch(/from ["']@opentui\/solid["']/)
  expect(output).toMatch(/from ["']solid-js["']/)
  expect(output).toMatch(/from ["']@anthropic-ai\/sdk["']/)
  expect(output).not.toMatch(/solid-js\/web|react\/jsx-runtime|document\.createElement/)
  for (const name of [
    "claudecode-system",
    "claudecode-system-sonnet5",
    "claudecode-system-opus5",
    "claudecode-system-fable5",
  ]) {
    // Prompt bytes must be embedded as text, never Vite asset URLs.
    const prompt = readFileSync(`src/${name}.txt`, "utf8")
    expect(output).toContain(prompt.split("\n").find((line) => line.length > 40))
  }
})
