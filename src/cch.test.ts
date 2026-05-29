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
  test("returns true when billing system block contains placeholder", () => {
    const body =
      '{"system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.81.df2; cc_entrypoint=sdk-cli; cch=00000;"}]}'
    expect(hasCchPlaceholder(body)).toBe(true)
  })

  test("returns false when cch=00000 only appears in messages, not billing block", () => {
    expect(hasCchPlaceholder('{"messages":[{"content":"cch=00000"}],"system":[]}')).toBe(false)
  })

  test("returns false when placeholder is not present", () => {
    expect(
      hasCchPlaceholder(
        '{"system":[{"type":"text","text":"x-anthropic-billing-header: cch=a1b2c;"}]}',
      ),
    ).toBe(false)
  })

  test("returns false for empty string", () => {
    expect(hasCchPlaceholder("")).toBe(false)
  })
})

// ─── replaceCchPlaceholder ──────────────────────────────────────────────────

describe("replaceCchPlaceholder", () => {
  test("replaces cch=00000 in billing system block", () => {
    const body =
      '{"system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=x; cc_entrypoint=sdk-cli; cch=00000;"}]}'
    const result = replaceCchPlaceholder(body, "a1b2c")
    expect(JSON.parse(result).system[0].text).toBe(
      "x-anthropic-billing-header: cc_version=x; cc_entrypoint=sdk-cli; cch=a1b2c;",
    )
  })

  test("does not replace cch=00000 in messages or other system blocks", () => {
    const body =
      '{"messages":[{"role":"user","content":[{"type":"tool_result","content":"cch=00000"}]}],' +
      '"system":[' +
      '{"type":"text","text":"x-anthropic-billing-header: cc_version=x; cc_entrypoint=sdk-cli; cch=00000;"},' +
      '{"type":"text","text":"docs mention cch=00000 verbatim"}' +
      "]}"
    const result = JSON.parse(replaceCchPlaceholder(body, "abcde"))
    expect(result.system[0].text).toBe(
      "x-anthropic-billing-header: cc_version=x; cc_entrypoint=sdk-cli; cch=abcde;",
    )
    expect(result.system[1].text).toBe("docs mention cch=00000 verbatim")
    expect(result.messages[0].content[0].content).toBe("cch=00000")
  })

  test("returns unchanged body if billing block not present", () => {
    const body = '{"system":[],"messages":[]}'
    const result = replaceCchPlaceholder(body, "a1b2c")
    expect(result).toBe(body)
  })

  // ─── Regression tests for prompt-cache bugs ──────────────────────────────
  // These reproduce the exact byte-mutation scenarios that broke multi-turn
  // prompt caching on real OpenCode sessions. See RESEARCH.md Discoveries
  // #24 and #25. The contract is: across two consecutive turns where the
  // only "real" change is appending a new user message, every byte before
  // the billing block's `cch=` value MUST be identical — otherwise
  // Anthropic's prefix-cache hash for the previous turn's write does not
  // match, and cache_read collapses to 0 for the conversation history.

  test("multi-turn: stored history bytes do not mutate across requests", async () => {
    // This is THE bug from Discovery #24/#25. The model reads a file (or
    // doc) containing the literal cch=00000 placeholder. On every later
    // turn, the body is hashed again and the placeholder re-replaced.
    // If replacement mutates anything outside the billing block, the
    // stored history bytes diverge per turn → Anthropic's prefix-cache
    // hash for the previous turn's write does not match → cache_read
    // collapses to 0 for the conversation history.
    const baseSystem = [
      {
        type: "text",
        text: "x-anthropic-billing-header: cc_version=2.1.154.cea; cc_entrypoint=sdk-cli; cch=00000;",
      },
      { type: "text", text: "docs explain cch=00000 placeholder" },
    ]
    const sharedHistory = [
      { role: "user", content: "Read src/cch.ts" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Read", input: { file: "src/cch.ts" } }],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: 'const PLACEHOLDER = "cch=00000"' },
        ],
      },
    ]
    const turn1 = JSON.stringify({ messages: sharedHistory, system: baseSystem })
    const turn2 = JSON.stringify({
      messages: [
        ...sharedHistory,
        { role: "assistant", content: "Here is the file." },
        { role: "user", content: "thanks" },
      ],
      system: baseSystem,
    })

    const signed1 = JSON.parse(replaceCchPlaceholder(turn1, await computeCch(turn1)))
    const signed2 = JSON.parse(replaceCchPlaceholder(turn2, await computeCch(turn2)))

    // The shared message prefix must be byte-identical
    for (let i = 0; i < sharedHistory.length; i++) {
      expect(JSON.stringify(signed1.messages[i])).toBe(JSON.stringify(signed2.messages[i]))
    }
    // system[1] (docs containing cch=00000) must also stay identical
    expect(signed1.system[1].text).toBe(signed2.system[1].text)
    // And system[0] must have a real signed value (not the placeholder)
    expect(signed1.system[0].text).not.toContain("cch=00000")
    expect(signed2.system[0].text).not.toContain("cch=00000")
  })

  test("billing block is signed even when cch=00000 appears in user message", () => {
    // Reproduces the case where a user pastes the literal placeholder in
    // their prompt. The billing block must still get the computed hash;
    // the user message must stay untouched.
    const body = JSON.stringify({
      messages: [{ role: "user", content: "Why does cch=00000 break caching?" }],
      system: [
        {
          type: "text",
          text: "x-anthropic-billing-header: cc_version=x; cc_entrypoint=sdk-cli; cch=00000;",
        },
      ],
    })
    const result = JSON.parse(replaceCchPlaceholder(body, "abcde"))
    expect(result.system[0].text).toContain("cch=abcde")
    expect(result.messages[0].content).toBe("Why does cch=00000 break caching?")
  })

  test("billing block is signed even when cch=00000 appears LATE in body order (lastIndexOf trap)", () => {
    // Reproduces Discovery #25: docs splice into system[2] containing
    // `cch=00000` serializes AFTER system[0] in JSON byte order, so a
    // naive lastIndexOf("cch=00000") would hit the docs occurrence and
    // leave system[0] unsigned. JSON-targeted replacement must still
    // find the billing block.
    const body = JSON.stringify({
      messages: [],
      system: [
        {
          type: "text",
          text: "x-anthropic-billing-header: cc_version=x; cc_entrypoint=sdk-cli; cch=00000;",
        },
        { type: "text", text: "identity block" },
        { type: "text", text: "RESEARCH.md says: replace cch=00000 with computed hash" },
      ],
    })
    const result = JSON.parse(replaceCchPlaceholder(body, "abcde"))
    expect(result.system[0].text).toContain("cch=abcde")
    expect(result.system[2].text).toContain("cch=00000") // docs untouched
  })

  test("billing block is signed even when cch=00000 appears in many places", () => {
    // Stress test: placeholder appears in 5+ locations. Only the billing
    // block's occurrence must change.
    const body = JSON.stringify({
      messages: [
        { role: "user", content: "cch=00000" },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: "file content with cch=00000 in it",
            },
          ],
        },
        { role: "assistant", content: "discussion of cch=00000" },
      ],
      system: [
        {
          type: "text",
          text: "x-anthropic-billing-header: cc_version=x; cc_entrypoint=sdk-cli; cch=00000;",
        },
        { type: "text", text: "more docs about cch=00000 and cch=00000 again" },
      ],
    })
    const signed = replaceCchPlaceholder(body, "abcde")
    const parsed = JSON.parse(signed)

    // Billing block: signed
    expect(parsed.system[0].text).toContain("cch=abcde")
    expect(parsed.system[0].text).not.toContain("cch=00000")

    // Everything else: untouched (cch=00000 still present where it was)
    expect(parsed.messages[0].content).toBe("cch=00000")
    expect(parsed.messages[1].content[0].content).toContain("cch=00000")
    expect(parsed.messages[2].content).toContain("cch=00000")
    expect(parsed.system[1].text).toContain("cch=00000 and cch=00000")

    // And the only occurrence of cch=abcde in the whole body is the billing block
    expect(signed.match(/cch=abcde/g)?.length).toBe(1)
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
    const body =
      '{"system":[{"type":"text","text":"x-anthropic-billing-header: cch=00000;"}],"msg":"test"}'
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
