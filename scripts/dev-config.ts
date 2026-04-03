/**
 * Generates .opencode/opencode.json and .opencode/tui.json with
 * absolute file:// paths pointing to the local package root.
 * Run via `bun run dev:config`.
 *
 * - opencode.json: server plugin (build/server.js) + provider (build/index.js)
 * - tui.json: TUI plugin (src/tui.tsx)
 */
import { writeFileSync, mkdirSync } from "node:fs"
import { resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const buildEntry = `file://${root}/build/index.js`
const serverEntry = `file://${root}/build/server.js`
const packageRoot = `file://${root}`

const config = {
  $schema: "https://opencode.ai/config.json",
  plugin: [serverEntry],
  provider: {
    "anthropic-sdk": {
      npm: buildEntry,
    },
  },
}

const tuiEntry = `file://${root}/src/tui.tsx`

const tuiConfig = {
  plugin: [tuiEntry],
}

mkdirSync(resolve(root, ".opencode"), { recursive: true })
writeFileSync(resolve(root, ".opencode/opencode.json"), JSON.stringify(config, null, 2) + "\n")
writeFileSync(resolve(root, ".opencode/tui.json"), JSON.stringify(tuiConfig, null, 2) + "\n")

console.log(`Wrote .opencode/opencode.json → server plugin: ${serverEntry}`)
console.log(`Wrote .opencode/tui.json → tui plugin: ${tuiEntry}`)
console.log(`Provider npm → ${buildEntry}`)
