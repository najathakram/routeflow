/**
 * SA-1035: a Claude response can START with a thinking block (Haiku 5.5 thinks adaptively by default, Opus 5.5 always),
 * so the answer is the first TEXT block, never `content[0]`. Thinking also counts toward `max_tokens`, so the scans leave
 * room for it.
 */

/** The text of the first text block, or null when the response has none. */
export function firstText(
  content: ReadonlyArray<{ type: string; text?: string }> | null | undefined,
): string | null {
  const block = (content ?? []).find((b) => b?.type === "text" && typeof b.text === "string");
  return block ? (block.text as string) : null;
}

/** `max_tokens` for the document scans: the JSON answer plus the thinking that is counted against the same limit. */
export const AI_SCAN_MAX_TOKENS = 8192;
