/**
 * OpenCode v2 persists part metadata only under the route's provider key —
 * the providerID ("anthropic-sdk") for non-@ai-sdk packages — and hands it
 * back on replay under that same key. Direct AI SDK callers use "anthropic".
 * Writing both keys keeps thinking signatures and fallback blocks alive in
 * OpenCode history without breaking direct usage.
 */
export const PROVIDER_METADATA_KEY = "anthropic-sdk"

export function anthropicMetadata(meta: Record<string, any>) {
  return { [PROVIDER_METADATA_KEY]: meta, anthropic: meta }
}

/** Read our metadata from a replayed prompt part (providerOptions) or a generated one (providerMetadata). */
export function readAnthropicMetadata(part: any): Record<string, any> | undefined {
  for (const source of [part?.providerOptions, part?.providerMetadata]) {
    const meta = source?.[PROVIDER_METADATA_KEY] ?? source?.anthropic
    if (meta) return meta
  }
  return undefined
}
