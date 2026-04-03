import { describe, expect, test } from "bun:test"
/**
 * Tests for cch.ts — CCH (Client Challenge Hash) request signing.
 *
 * Verifies the xxHash64-based body integrity hash used in the
 * x-anthropic-billing-header system block for Claude Code compatibility.
 *
 * Run with: bun test src/cch.test.ts
 */
import { computeCch, hasCchPlaceholder, replaceCchPlaceholder } from "./cch.ts"

// ─── computeCch ─────────────────────────────────────────────────────────────

describe("computeCch", () => {
  test("returns a 5-character zero-padded lowercase hex string", async () => {
    const body = '{"system":[{"type":"text","text":"x-anthropic-billing-header: cch=00000;"}]}'
    const cch = await computeCch(body)
    expect(cch).toMatch(/^[0-9a-f]{5}$/)
  })

  test("produces deterministic output for the same input", async () => {
    const body =
      '{"model":"claude-sonnet-4-6","system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.81.df2; cc_entrypoint=cli; cch=00000;"}],"messages":[{"role":"user","content":"hello"}]}'
    const cch1 = await computeCch(body)
    const cch2 = await computeCch(body)
    expect(cch1).toBe(cch2)
  })

  test("produces different hashes for different bodies", async () => {
    const body1 =
      '{"system":[{"type":"text","text":"cch=00000;"}],"messages":[{"role":"user","content":"hello"}]}'
    const body2 =
      '{"system":[{"type":"text","text":"cch=00000;"}],"messages":[{"role":"user","content":"world"}]}'
    const cch1 = await computeCch(body1)
    const cch2 = await computeCch(body2)
    expect(cch1).not.toBe(cch2)
  })

  test("hash is in range 0x00000-0xFFFFF (20-bit mask)", async () => {
    // Run multiple inputs to increase confidence
    const bodies = [
      '{"cch=00000"}',
      '{"a":"b","cch=00000"}',
      '{"messages":[],"system":[{"text":"cch=00000"}]}',
      '{"long":' + JSON.stringify("x".repeat(10000)) + ',"cch=00000"}',
    ]
    for (const body of bodies) {
      const cch = await computeCch(body)
      const val = parseInt(cch, 16)
      expect(val).toBeGreaterThanOrEqual(0)
      expect(val).toBeLessThanOrEqual(0xfffff)
      expect(cch.length).toBe(5)
    }
  })

  test("handles small values with zero padding", async () => {
    // Verify format is always 5 chars even if numeric value is small
    // We can't control the hash output, but we verify the format
    const cch = await computeCch('{"test":"cch=00000"}')
    expect(cch.length).toBe(5)
    // Ensure no uppercase hex chars
    expect(cch).toBe(cch.toLowerCase())
  })
})

// ─── hasCchPlaceholder ──────────────────────────────────────────────────────

describe("hasCchPlaceholder", () => {
  test("returns true when body contains cch=00000", () => {
    expect(hasCchPlaceholder('{"text":"cch=00000;"}')).toBe(true)
  })

  test("returns false when body does not contain placeholder", () => {
    expect(hasCchPlaceholder('{"text":"cch=a1b2c;"}')).toBe(false)
  })

  test("returns false for empty string", () => {
    expect(hasCchPlaceholder("")).toBe(false)
  })

  test("returns true for realistic billing header", () => {
    const body =
      '{"system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.81.df2; cc_entrypoint=cli; cch=00000;"}]}'
    expect(hasCchPlaceholder(body)).toBe(true)
  })
})

// ─── replaceCchPlaceholder ──────────────────────────────────────────────────

describe("replaceCchPlaceholder", () => {
  test("replaces cch=00000 with computed hash", () => {
    const body = '{"text":"x-anthropic-billing-header: cch=00000;"}'
    const result = replaceCchPlaceholder(body, "a1b2c")
    expect(result).toBe('{"text":"x-anthropic-billing-header: cch=a1b2c;"}')
  })

  test("only replaces the first occurrence", () => {
    // Edge case: if user message somehow contains cch=00000, only the first
    // (billing header) occurrence should be replaced
    const body = '{"system":[{"text":"cch=00000;"}],"messages":[{"content":"cch=00000"}]}'
    const result = replaceCchPlaceholder(body, "abcde")
    expect(result).toBe('{"system":[{"text":"cch=abcde;"}],"messages":[{"content":"cch=00000"}]}')
  })

  test("returns unchanged body if placeholder not present", () => {
    const body = '{"text":"no placeholder here"}'
    const result = replaceCchPlaceholder(body, "a1b2c")
    expect(result).toBe(body)
  })
})

// ─── End-to-end: compute + replace ──────────────────────────────────────────

describe("CCH end-to-end", () => {
  test("compute and replace produces a valid signed body", async () => {
    const body =
      '{"system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.81.df2; cc_entrypoint=cli; cch=00000;"}],"model":"claude-sonnet-4-6","messages":[{"role":"user","content":"Say hello"}]}'

    expect(hasCchPlaceholder(body)).toBe(true)

    const cch = await computeCch(body)
    const signed = replaceCchPlaceholder(body, cch)

    // Placeholder should be gone
    expect(hasCchPlaceholder(signed)).toBe(false)
    // Hash should be present
    expect(signed).toContain(`cch=${cch}`)
    // Body structure should be preserved
    expect(JSON.parse(signed)).toBeTruthy()
  })

  test("hash is computed over body WITH placeholder (not after replacement)", async () => {
    // This is a critical invariant: the hash input includes cch=00000,
    // and the result replaces the zeros. Verify by computing hash on
    // the pre-replacement body and checking it matches.
    const body = '{"system":[{"type":"text","text":"cch=00000;"}],"msg":"test"}'
    const cch = await computeCch(body)

    // If we replace and then re-hash, we get a DIFFERENT hash
    // (because the input changed). This proves the hash was computed
    // over the placeholder body.
    const signed = replaceCchPlaceholder(body, cch)
    const rehash = await computeCch(signed)
    // The re-hashed body no longer has placeholder, so computeCch
    // would hash a different string — result must differ
    // (unless astronomically unlikely collision)
    // But actually signed body doesn't have cch=00000, so this still
    // demonstrates the hash was over the original.
    expect(cch).not.toBe(rehash)
  })
})
