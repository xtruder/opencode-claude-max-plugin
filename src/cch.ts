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
const CCH_PLACEHOLDER = "cch=00000"
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

/**
 * Replace the `cch=00000` placeholder in the body with the computed hash.
 * Only replaces the first occurrence to avoid mutating user message content.
 */
export function replaceCchPlaceholder(body: string, cch: string): string {
  return body.replace(CCH_PLACEHOLDER, `cch=${cch}`)
}

/** Check whether the body contains the CCH placeholder. */
export function hasCchPlaceholder(body: string): boolean {
  return body.includes(CCH_PLACEHOLDER)
}
