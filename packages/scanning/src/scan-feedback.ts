/**
 * Pure decision: given the outcome a scan resolved to, which accept/reject
 * cue (if any) should play. Deliberately kept OUT of `scan-cue(.web).ts`,
 * for two reasons:
 *
 *  1. Testability — this is the only "should we cue, and which way" logic
 *     that matters, and it has zero DOM/AudioContext/`Date.now()`
 *     dependencies, so it unit-tests in plain node Jest exactly the way
 *     `scan-engine.ts` does. The actual web player can't be exercised in
 *     that same suite (no AudioContext in node) — keeping the DECISION
 *     separate is the only way this behavior gets pinned by a real test.
 *  2. Isolation — the cue is pure ergonomics (F30 / REG-B202 PR1 commit 2:
 *     an operator scanning fast shouldn't have to watch the screen to know
 *     a scan landed). It must never be able to influence what actually
 *     happened to the scan. Splitting "what happened" (this file, a
 *     read-only view over an ALREADY-resolved `ScanOutcome`) from "make
 *     noise about it" (`scan-cue(.web).ts`, all side effect, provably total)
 *     means a broken speaker or a thrown AudioContext exception can't so
 *     much as delay, let alone corrupt, `ScanCamera.web.tsx`'s resolve chain.
 */
import type { ScanOutcome } from "./scan-loop";

/** What the operator should hear/feel after a scan resolves. */
export type ScanCue = "accepted" | "rejected" | "none";

/**
 * `feedback.kind === "added"` cues "accepted"; `"error"` cues "rejected".
 * Everything else cues "none" — nothing observable happened for the
 * operator to be told about: a `void`/`undefined` outcome (still scanning,
 * no banner shown), a `{close}`-only outcome (a hand-off, not an
 * accept/reject), or a `{}` outcome carrying neither field. `ScanFeedback`
 * has exactly two `kind`s today; the `default` branch is a total fallback,
 * not evidence a third kind exists.
 */
export function cueForOutcome(outcome: ScanOutcome): ScanCue {
  const feedback = outcome?.feedback;
  if (!feedback) return "none";
  switch (feedback.kind) {
    case "added":
      return "accepted";
    case "error":
      return "rejected";
    default:
      return "none";
  }
}
