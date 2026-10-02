import { expect, test } from "vitest"
import { selectClaudePromptForModel } from "./index.ts"
import plugin from "./server.ts"

test("context hook replaces the base prompt and states per-call shell directories", async () => {
  let contextHook: ((event: any) => void) | undefined
  await plugin.setup({
    options: {},
    provider: { transform: async () => {} },
    session: {
      hook: async (name: string, hook: (event: any) => void) => {
        if (name === "context") contextHook = hook
      },
    },
  } as any)

  const event = {
    model: { id: "claude-opus-5-5" },
    options: {},
    system: [
      {
        type: "text",
        text: "OpenCode base prompt\n\nHere is some useful information about the environment you are running in:\n<env>\n  Working directory: /repo\n  Is directory a git repo: yes\n</env>",
      },
    ],
  }
  contextHook!(event)

  const [base, environment] = event.system
  expect(base.text.startsWith(selectClaudePromptForModel("claude-opus-5-5"))).toBe(true)
  expect(base.text).toContain("a `cd` lasts only for that call")
  expect(base.text).not.toContain("OpenCode base prompt")
  expect(environment.text).toContain("Working directory: /repo")
  expect(environment.text).toContain("Is a git repository: true")
})
