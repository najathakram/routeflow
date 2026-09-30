/**
 * Native counterpart to `scan-cue.web.ts` (F30 / REG-B202 PR1 commit 2).
 * `ScanCamera.web.tsx` imports this module by its BARE name
 * (`"../lib/scan-cue"`); the bundler resolves it to `scan-cue.web.ts` on
 * web and to this file everywhere else, the same platform-suffix
 * convention `location-tracker.ts`/`location-tracker.web.ts` already use.
 *
 * Native's own beep/vibrate pair (via expo-haptics/expo-av, once a native
 * caller actually wants one) is a recorded follow-up, not this commit —
 * `ScanCamera.tsx` (native) doesn't call into this seam today, and native
 * already has an UNRELATED haptic path for scan outcomes: `lib/haptics.ts`'s
 * `scanHaptic`, wired through `ScanOrderSheet`'s `handleOutcome`. This file
 * exists only so `playScanCue`/`unlockScanCue` resolve to something safe —
 * a total no-op — if any platform-shared code ever imports this seam
 * directly.
 *
 * `safePlay` lives here (not `scan-feedback.ts`, which stays DOM/side-effect
 * free) because it's the one piece of the "never throws" contract that is
 * actually node-Jest-testable: this file has no AudioContext/`window`
 * dependency, so `__tests__/scan-feedback.test.ts` can import it directly
 * and pin the swallow behavior without touching a DOM API at all.
 */
import type { ScanCue } from "./scan-feedback";

/** Runs `fn`, swallowing anything it throws. A cue is pure ergonomics — it
 * must never be able to propagate a failure into its caller. */
export function safePlay(fn: () => void): void {
  try {
    fn();
  } catch {
    // A cue failure must never surface — see file header.
  }
}

export function playScanCue(cue: ScanCue): void {
  safePlay(() => {
    // No native player yet — see file header. The parameter is kept (and
    // explicitly discarded) so this module's signature stays identical to
    // `scan-cue.web.ts`'s: the two are resolved interchangeably by the
    // bundler, so they must not drift apart.
    void cue;
  });
}

export function unlockScanCue(): void {
  safePlay(() => {
    // Nothing to unlock — no AudioContext exists on this platform.
  });
}
