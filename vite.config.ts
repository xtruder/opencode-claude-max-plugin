import { readFile } from "node:fs/promises"
import { defineConfig } from "vite"
import solid from "vite-plugin-solid"

export default defineConfig({
  plugins: [
    solid({
      hot: false,
      solid: { moduleName: "@opentui/solid", generate: "universal" },
    }),
    {
      name: "prompt-text",
      enforce: "pre",
      async load(id) {
        if (id.endsWith(".txt")) {
          this.addWatchFile(id)
          return `export default ${JSON.stringify(await readFile(id, "utf8"))}`
        }
      },
    },
  ],
  build: {
    target: "node26",
    outDir: "build",
    minify: false,
    lib: {
      entry: { index: "src/index.ts", server: "src/server.ts", tui: "src/tui.tsx" },
      formats: ["es"],
      fileName: "[name]",
    },
    rolldownOptions: {
      platform: "node",
      // Keep every bare import external, especially the host's Solid/OpenTUI singletons.
      external: (id) => !id.startsWith(".") && !id.startsWith("/") && !id.startsWith("\0"),
    },
  },
})
