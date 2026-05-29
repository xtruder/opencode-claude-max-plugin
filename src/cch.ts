/**
 * CCH (Client Challenge Hash) — request signing for Claude Code compatibility.
 *
 * The `cch` field in the `x-anthropic-billing-header` system block is an
 * xxHash64-based integrity hash over the serialized request body. Anthropic's
 * servers verify it to gate features like fast mode.
 *
 * Algorithm (from reverse-engineering research):
 * 1. Build the complete request body JSON with `cch=00000` as placeholder
 * 2. Compute xxHash64(body_bytes, seed) & 0xFFFFF
 * 3. Format as zero-padded 5-character lowercase hex
 * 4. Replace `cch=00000` with `cch=<computed>` in the body
 *
 * Seed constant: 0x6E52736AC806831E (extracted from Claude Code's Bun binary)
 */
import xxhashInit from "xxhash-wasm"

const CCH_SEED = 0x6e52736ac806831en
const CCH_MASK = 0xfffffn

/** Lazy-initialized xxhash WASM instance */
let hasherPromise: ReturnType<typeof xxhashInit> | null = null

function getHasher() {
  if (!hasherPromise) {
    hasherPromise = xxhashInit()
  }
  return hasherPromise
}

/**
 * Compute the 5-char hex CCH hash for a request body containing the
 * `cch=00000` placeholder.
 */
export async function computeCch(body: string): Promise<string> {
  const hasher = await getHasher()
  const hash = hasher.h64Raw(new TextEncoder().encode(body), CCH_SEED)
  return (hash & CCH_MASK).toString(16).padStart(5, "0")
}

const BILLING_HEADER_PREFIX = "x-anthropic-billing-header:"

/**
 * Replace `cch=00000` in the billing system block with the computed hash.
 *
 * Parses the body as JSON, locates the system block whose text starts with
 * `x-anthropic-billing-header:`, replaces `cch=00000` inside that block's
 * `text` field only, and re-serializes. Targeting the billing block at the
 * JSON level avoids mutating other places the literal placeholder can appear:
 * tool_result content (when Claude reads this repo's source), system[2] (when
 * AGENTS.md / RESEARCH.md text gets spliced into the prompt), or user input.
 * Any of those mutations would break prefix caching for the affected block
 * across turns.
 */
export function replaceCchPlaceholder(body: string, cch: string): string {
  let parsed: any
  try {
    parsed = JSON.parse(body)
  } catch {
    return body
  }
  const system = parsed?.system
  if (!Array.isArray(system)) return body
  const block = system.find(
    (b: any) => typeof b?.text === "string" && b.text.startsWith(BILLING_HEADER_PREFIX),
  )
  if (!block) return body
  block.text = block.text.replace("cch=00000", `cch=${cch}`)
  return JSON.stringify(parsed)
}

/** Check whether the body's billing system block contains the CCH placeholder. */
export function hasCchPlaceholder(body: string): boolean {
  let parsed: any
  try {
    parsed = JSON.parse(body)
  } catch {
    return false
  }
  const system = parsed?.system
  if (!Array.isArray(system)) return false
  const block = system.find(
    (b: any) => typeof b?.text === "string" && b.text.startsWith(BILLING_HEADER_PREFIX),
  )
  return block?.text?.includes("cch=00000") ?? false
}
