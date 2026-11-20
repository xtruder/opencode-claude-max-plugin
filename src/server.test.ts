import { expect, test } from "vitest"
import { FILE_TOOL_GUIDANCE } from "./file-tool-guidance.ts"
import { selectClaudePromptForModel } from "./index.ts"
import plugin from "./server.ts"

test("context hook replaces the base prompt and states per-call shell directories", async () => {
  const contextHooks: Array<(event: any) => void | Promise<void>> = []
  let scope: any
  await plugin.setup({
    options: {},
    provider: { transform: async () => {} },
    event: { subscribe: async function* () {} },
    tool: { hook: async () => {} },
    session: {
      hook: async (name: string, hook: (event: any) => void, options: any) => {
        if (name === "context") {
          contextHooks.push(hook)
          scope = options
        }
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
  for (const hook of contextHooks) await hook(event)
  expect(scope).toEqual({ providerID: "anthropic-sdk" })

  const [base, environment] = event.system
  expect(base.text.startsWith(selectClaudePromptForModel("claude-opus-5-5"))).toBe(true)
  expect(base.text).toContain("a `cd` lasts only for that call")
  expect(base.text).toContain(FILE_TOOL_GUIDANCE)
  expect(base.text).not.toContain("OpenCode base prompt")
  expect(environment.text).toContain("Working directory: /repo")
  expect(environment.text).toContain("Is a git repository: true")
})
