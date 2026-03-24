/**
 * Generates .opencode/opencode.json with absolute file:// paths
 * pointing to the local build output. Run via `bun run dev:config`.
 */
import { writeFileSync, mkdirSync } from "node:fs"
import { resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const buildEntry = `file://${root}/build/index.js`

const config = {
  $schema: "https://opencode.ai/config.json",
  plugin: [buildEntry],
  provider: {
    "anthropic-sdk": {
      npm: buildEntry,
    },
  },
}

mkdirSync(resolve(root, ".opencode"), { recursive: true })
writeFileSync(resolve(root, ".opencode/opencode.json"), JSON.stringify(config, null, 2) + "\n")

console.log(`Wrote .opencode/opencode.json → ${buildEntry}`)
