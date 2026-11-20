import type { Plugin } from "@opencode/plugin"

export const FILE_TOOL_GUIDANCE =
  "# File tools\n" +
  "File reads, writes, and edits must use dedicated file tools, not Bash commands such as cat, sed, awk, Python, Perl, or redirection. " +
  "This keeps reads and changes visible to the user. If an edit fails, re-read and retry. " +
  "Use Bash for other commands, or file scripts explicitly requested by the user."

const EDIT_GUIDANCE =
  "Use Edit for file changes, not sed, awk, Python, Perl, or redirection, so edits are visible to the user. " +
  "If matching fails, Read again and retry."
const BASH_GUIDANCE =
  "Read files with Read. Change files with Edit or Write. " +
  "Use these tools instead of cat, sed, awk, Python, Perl, or redirection so reads and edits are visible to the user. " +
  "Bash remains available for other commands and explicitly requested file scripts."

export function fileToolDescription(name: string, description = ""): string {
  const guidance = name === "Edit" ? EDIT_GUIDANCE : name === "Bash" ? BASH_GUIDANCE : undefined
  return guidance ? [description, guidance].filter(Boolean).join("\n\n") : description
}

export const FILE_TOOL_REMINDER_INTERVAL = 32_000
export const FILE_TOOL_REMINDER =
  "<system-reminder>\n" +
  "Read files with Read. Change files with Edit or Write so reads and edits are visible to the user. " +
  "Use Bash for other commands or explicitly requested file scripts.\n" +
  "</system-reminder>"

export async function registerFileToolReminders(
  ctx: Pick<Plugin.Context, "event" | "tool">,
  providerID: string,
): Promise<() => void> {
  const sessions = new Map<string, { messageID: string; tokens?: number; baseline?: number }>()
  const controller = new AbortController()

  await ctx.tool.hook("execute.after", (event) => {
    if (event.tool !== "shell" || event.status !== "completed") return
    const state = sessions.get(event.sessionID)
    if (
      state?.messageID !== event.messageID ||
      state?.tokens === undefined ||
      state.baseline === undefined ||
      state.tokens - state.baseline < FILE_TOOL_REMINDER_INTERVAL
    )
      return

    // Consume synchronously so parallel shell results cannot repeat the same reminder.
    state.baseline = state.tokens
    const content = event.result.content
    event.result = {
      ...event.result,
      content:
        typeof content === "string"
          ? [content, FILE_TOOL_REMINDER].filter(Boolean).join("\n\n")
          : [...(content ?? []), { type: "text", text: FILE_TOOL_REMINDER }],
    }
  })

  // Observe usage once per step instead of fetching or scanning the transcript.
  // Usage settles after tools, so a measurement applies to a later shell result.
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        switch (event.type) {
          case "session.step.started": {
            const { sessionID, assistantMessageID, model } = event.data
            if (model.providerID !== providerID) {
              sessions.delete(sessionID)
              break
            }
            const state = sessions.get(sessionID) ?? { messageID: assistantMessageID }
            state.messageID = assistantMessageID
            sessions.set(sessionID, state)
            break
          }
          case "session.step.ended": {
            const { sessionID, assistantMessageID, tokens } = event.data
            const state = sessions.get(sessionID)
            if (!state || state.messageID !== assistantMessageID) break
            const input = [tokens.input, tokens.cache.read, tokens.cache.write]
            if (input.some((value) => !Number.isFinite(value) || value < 0)) break
            const size = input.reduce((sum, value) => sum + value, 0)
            if (size === 0) break
            if (state.baseline === undefined || size < state.baseline) state.baseline = size
            state.tokens = size
            break
          }
          case "session.compaction.ended":
          case "session.deleted":
            sessions.delete(event.data.sessionID)
            break
        }
      }
    } catch {
      // A best-effort reminder must never fail tools or inference.
      if (!controller.signal.aborted)
        console.warn("[anthropic-sdk] File-tool reminders stopped: event subscription failed.")
    } finally {
      sessions.clear()
    }
  })()

  return () => {
    controller.abort()
    sessions.clear()
  }
}
