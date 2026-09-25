import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [
    {
      name: "prompt-text",
      enforce: "pre",
      async load(id) {
        if (id.endsWith(".txt"))
          return `export default ${JSON.stringify(await readFile(id, "utf8"))}`
      },
    },
  ],
  resolve: {
    // Match OpenTUI's native Node renderer, not Solid's default SSR runtime.
    alias: [
      {
        find: /^solid-js$/,
        replacement: fileURLToPath(
          new URL("./node_modules/solid-js/dist/solid.js", import.meta.url),
        ),
      },
    ],
  },
  test: {
    include: ["src/*.test.ts"],
    exclude: process.env.CLAUDE_LIVE_TESTS === "1" ? [] : ["src/model.test.ts"],
    fileParallelism: false,
    restoreMocks: true,
  },
})
