/**
 * Web-only accept/reject cue player for the mobile-web scanner (F30 /
 * REG-B202 PR1 commit 2): a short WebAudio beep plus `navigator.vibrate`,
 * pitched/patterned differently for accepted vs rejected so an operator
 * scanning fast can tell them apart WITHOUT looking at the screen —
 * silent drops used to happen exactly when they weren't. `cueForOutcome`
 * (`scan-feedback.ts`) already made the only decision that matters; this
 * file just makes noise about it, and it is provably total: every export
 * is wrapped in its own try/catch and NEVER throws.
 *
 * Deliberately NOT importing `safePlay` from `./scan-cue` (this file's
 * native sibling) even though the shape is identical: `ScanCamera.web.tsx`
 * imports this seam by its BARE name (`"../lib/scan-cue"`) so the bundler
 * can pick the right platform file, and that same bare-specifier resolution
 * applies to every import site — including one written from inside this
 * very file. A same-directory, same-basename import written as `"./scan-cue"`
 * from `scan-cue.web.ts` risks re-resolving to `scan-cue.web.ts` ITSELF on a
 * web build (a silent self-import that would leave `safePlay` undefined),
 * so this file stays fully self-contained instead. Being self-contained, this
 * file's OWN swallow contract is pinned directly (REG-B202/CUE10-14): node
 * Jest installs a host whose AudioContext constructor throws, because merely
 * calling these exports in a bare node env proves nothing — with no `window`
 * the beep returns early and `navigator.vibrate?.()` optional-chains away, so
 * such a test passes even with the try/catch deleted (confirmed by mutation).
 */
import type { ScanCue } from "./scan-feedback";

/**
 * Lazily created, reused across every scan — a fresh `AudioContext` per
 * scan exhausts the browser's context limit (Chrome caps concurrent
 * contexts well under what a single scanning session would create) long
 * before an operator finishes a single case.
 */
let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (audioCtx) return audioCtx;
  if (typeof window === "undefined") return null;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  audioCtx = new Ctor();
  return audioCtx;
}

/**
 * One short oscillator blip. The gain is ramped down to near-zero (an
 * exponential ramp can't target exactly 0) rather than stopped abruptly, to
 * avoid the click a hard stop would produce; the oscillator disconnects
 * itself once it's done so nodes don't accumulate across a scanning session.
 */
function beep(frequencyHz: number, durationMs: number): void {
  const ctx = getAudioContext();
  if (!ctx) return;
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = "sine";
  oscillator.frequency.value = frequencyHz;
  oscillator.connect(gain);
  gain.connect(ctx.destination);

  const now = ctx.currentTime;
  const durationSec = durationMs / 1000;
  gain.gain.setValueAtTime(0.2, now);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + durationSec);

  oscillator.start(now);
  oscillator.stop(now + durationSec);
  oscillator.onended = () => {
    oscillator.disconnect();
    gain.disconnect();
  };
}

/**
 * Browsers suspend a freshly created `AudioContext` until a user gesture.
 * Lazily creating the context here (rather than waiting for the first beep)
 * means it has the best chance of already being resumed by the time a scan
 * actually needs to play a sound. Safe to call repeatedly and from
 * anywhere — never throws.
 */
export function unlockScanCue(): void {
  try {
    const ctx = getAudioContext();
    if (ctx && ctx.state === "suspended") void ctx.resume().catch(() => undefined);
  } catch {
    // No AudioContext, no autoplay permission, whatever — never surface.
  }
}

/**
 * Plays the accept/reject cue. `"none"` does nothing at all. The rest runs
 * inside one try/catch, so no AudioContext, an autoplay-blocked context, a
 * missing `vibrate`, or a permissions error can ever propagate into the
 * scan resolve chain that calls this.
 */
export function playScanCue(cue: ScanCue): void {
  if (cue === "none") return;
  try {
    if (cue === "accepted") {
      beep(1000, 80);
      navigator.vibrate?.(50);
    } else {
      beep(300, 180);
      navigator.vibrate?.([40, 60, 40]);
    }
  } catch {
    // A cue failure must never reach the caller — see file header.
  }
}
