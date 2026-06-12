#!/usr/bin/env bun
/**
 * Logging proxy for the Anthropic Messages API.
 *
 * Forwards requests to https://api.anthropic.com while logging per-request
 * cache_control placement and per-response token usage. Useful for diagnosing
 * prompt-cache misses caused by prefix-byte mutation across turns
 * (CCH placeholder, message shape, tool_result content, etc.).
 *
 * Usage:
 *   bun scripts/cache-proxy.ts [options]
 *   ANTHROPIC_BASE_URL=http://localhost:19827 opencode
 *   ANTHROPIC_BASE_URL=http://localhost:19827 claude
 *
 * Options:
 *   -p, --port <n>          listen port (default: 19827)
 *   -o, --out-dir <dir>     output directory (default: /tmp/opencode/cache-proxy)
 *   -d, --dump-requests     dump every request body to <out>/req-NNN-<model>.json
 *   -D, --dump-responses    dump every response body too
 *       --no-clear          do not clear out-dir on startup
 *       --upstream <url>    upstream API base (default: https://api.anthropic.com)
 *   -q, --quiet             do not echo log lines to stdout
 *   -h, --help              show this help
 *
 * Default behavior: writes a human-readable summary to <out>/proxy.log and
 * echoes it to stdout. Bodies are NOT dumped unless --dump-requests is set.
 */
import * as fs from "node:fs"
import * as http from "node:http"
import * as path from "node:path"
import { parseArgs } from "node:util"

const HELP = `Usage: bun scripts/cache-proxy.ts [options]

Options:
  -p, --port <n>          listen port (default: 19827)
  -o, --out-dir <dir>     output directory (default: /tmp/opencode/cache-proxy)
  -d, --dump-requests     dump every request body to <out>/req-NNN-<model>.json
  -D, --dump-responses    dump every response body to <out>/resp-NNN.txt
      --no-clear          do not clear out-dir on startup
      --upstream <url>    upstream API base (default: https://api.anthropic.com)
  -q, --quiet             do not echo log lines to stdout
  -h, --help              show this help

Outputs:
  <out>/proxy.log         human-readable per-request summary
  <out>/req-NNN-...json   request bodies (with -d)
  <out>/resp-NNN.txt      response bodies, SSE-decoded (with -D)`

let parsed
try {
  parsed = parseArgs({
    options: {
      port: { type: "string", short: "p", default: "19827" },
      "out-dir": { type: "string", short: "o", default: "/tmp/opencode/cache-proxy" },
      "dump-requests": { type: "boolean", short: "d", default: false },
      "dump-responses": { type: "boolean", short: "D", default: false },
      "no-clear": { type: "boolean", default: false },
      upstream: { type: "string", default: "https://api.anthropic.com" },
      quiet: { type: "boolean", short: "q", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: false,
  })
} catch (e) {
  console.error(`error: ${(e as Error).message}`)
  console.error(HELP)
  process.exit(2)
}

if (parsed.values.help) {
  console.log(HELP)
  process.exit(0)
}

const opts = {
  port: Number(parsed.values.port),
  outDir: parsed.values["out-dir"] as string,
  dumpReq: parsed.values["dump-requests"] as boolean,
  dumpResp: parsed.values["dump-responses"] as boolean,
  clear: !parsed.values["no-clear"],
  upstream: parsed.values.upstream as string,
  quiet: parsed.values.quiet as boolean,
}

if (!Number.isFinite(opts.port) || opts.port <= 0 || opts.port > 65535) {
  console.error(`error: invalid --port value: ${parsed.values.port}`)
  process.exit(2)
}

const LOG = path.join(opts.outDir, "proxy.log")

fs.mkdirSync(opts.outDir, { recursive: true })
if (opts.clear) {
  for (const f of fs.readdirSync(opts.outDir)) {
    try {
      fs.unlinkSync(path.join(opts.outDir, f))
    } catch {}
  }
}
fs.writeFileSync(LOG, "")

let turn = 0

function log(line: string) {
  fs.appendFileSync(LOG, line + "\n")
  if (!opts.quiet) console.log(line)
}

function parseSSEUsage(
  text: string,
): { input: number; output: number; cacheRead: number; cacheWrite: number } | null {
  let input = 0,
    output = 0,
    cacheRead = 0,
    cacheWrite = 0
  let found = false
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue
    const payload = line.slice(6).trim()
    if (!payload || payload === "[DONE]") continue
    try {
      const ev = JSON.parse(payload)
      const u = ev.usage ?? ev.message?.usage
      if (!u) continue
      found = true
      if (u.input_tokens != null) input = u.input_tokens
      if (u.output_tokens != null) output = u.output_tokens
      if (u.cache_read_input_tokens != null) cacheRead = u.cache_read_input_tokens
      if (u.cache_creation_input_tokens != null) cacheWrite = u.cache_creation_input_tokens
    } catch {}
  }
  return found ? { input, output, cacheRead, cacheWrite } : null
}

function pad(n: number) {
  return String(n).padStart(3, "0")
}

http
  .createServer(async (req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (d) => chunks.push(d))
    req.on("end", async () => {
      const body = Buffer.concat(chunks).toString("utf8")
      let reqJson: any = {}
      try {
        reqJson = JSON.parse(body)
      } catch {}

      turn++
      const t = turn
      const model = reqJson.model ?? "?"

      // Inspect cache_control placement
      const topLevelCC = reqJson.cache_control ?? null
      const sysBlocks = Array.isArray(reqJson.system) ? reqJson.system : []
      const sysCC = sysBlocks
        .map((b: any, i: number) => (b.cache_control ? i : -1))
        .filter((x: number) => x >= 0)
      const msgs = reqJson.messages ?? []
      const msgCC: string[] = []
      let totalBlocks = 0
      msgs.forEach((m: any, i: number) => {
        if (Array.isArray(m.content)) {
          totalBlocks += m.content.length
          m.content.forEach((c: any, j: number) => {
            if (c.cache_control) msgCC.push(`msg[${i}].content[${j}](${c.type})`)
          })
        } else {
          totalBlocks += 1
        }
      })

      if (opts.dumpReq) {
        try {
          fs.writeFileSync(path.join(opts.outDir, `req-${pad(t)}-${model}.json`), body)
        } catch {}
      }

      log(
        `\n=== REQ #${t} model=${model} ===\n` +
          `  bodyBytes=${body.length} msgs=${msgs.length} totalContentBlocks=${totalBlocks} sysBlocks=${sysBlocks.length}\n` +
          `  top-level cache_control: ${topLevelCC ? JSON.stringify(topLevelCC) : "(none)"}\n` +
          `  system blocks with cache_control: [${sysCC.join(", ")}]\n` +
          `  message blocks with cache_control: ${msgCC.length ? msgCC.join("; ") : "(none)"}`,
      )

      const headers = Object.fromEntries(
        Object.entries(req.headers).filter(
          ([k]) =>
            k !== "host" && k !== "content-length" && k !== "accept-encoding" && k !== "connection",
        ),
      )
      const upstream = await fetch(opts.upstream + req.url, {
        method: req.method,
        headers: headers as any,
        body,
      })

      const respHeaders = Object.fromEntries(
        [...upstream.headers.entries()].filter(
          ([k]) =>
            k.toLowerCase() !== "content-encoding" &&
            k.toLowerCase() !== "content-length" &&
            k.toLowerCase() !== "transfer-encoding",
        ),
      )
      res.writeHead(upstream.status, respHeaders)

      const respChunks: Buffer[] = []
      const reader = upstream.body!.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        respChunks.push(Buffer.from(value))
        res.write(Buffer.from(value))
      }
      res.end()

      const respText = Buffer.concat(respChunks).toString("utf8")

      if (opts.dumpResp) {
        try {
          fs.writeFileSync(path.join(opts.outDir, `resp-${pad(t)}.txt`), respText)
        } catch {}
      }

      const u = parseSSEUsage(respText)
      if (u) {
        log(
          `  RESP #${t} status=${upstream.status} input=${u.input} output=${u.output} ` +
            `cache_read=${u.cacheRead} cache_write=${u.cacheWrite}`,
        )
      } else {
        log(`  RESP #${t} status=${upstream.status} (no usage)`)
      }
    })
  })
  .listen(opts.port, () => {
    console.log(`cache-proxy listening on :${opts.port} → ${opts.upstream}`)
    console.log(`  log:     ${LOG}`)
    if (opts.dumpReq) console.log(`  reqs:    ${opts.outDir}/req-*.json`)
    if (opts.dumpResp) console.log(`  resps:   ${opts.outDir}/resp-*.txt`)
    if (!opts.dumpReq && !opts.dumpResp) {
      console.log(`  (no body dumping — pass -d for requests, -D for responses)`)
    }
  })
