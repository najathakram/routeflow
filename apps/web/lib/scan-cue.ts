/**
 * Accept/reject cue for the operator web scanner: a short WebAudio beep plus `navigator.vibrate`,
 * pitched differently for accepted vs rejected so an operator scanning fast can tell them apart
 * without looking at the screen. Ported from `apps/mobile/lib/scan-cue.web.ts`; the platform-free
 * decision of WHICH cue to play lives in the shared scan engine, this file only makes the noise.
 *
 * Total by construction: every export runs inside its own try/catch and never throws, so a cue
 * failure (no AudioContext, autoplay-blocked context, no `vibrate` — iOS Safari has never shipped
 * the Vibration API) can never reach the scan path that calls it.
 */
export type ScanCue = "accepted" | "rejected" | "none";

/**
 * Lazily created and reused — a fresh `AudioContext` per scan exhausts the browser's concurrent
 * context limit long before an operator finishes one delivery.
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

/** One short oscillator blip, gain ramped down (no hard-stop click), nodes released when done. */
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
 * Browsers suspend a fresh `AudioContext` until a user gesture. Call this from the tap that opens
 * the scanner so the context is already running by the time the first scan needs a sound.
 */
export function unlockScanCue(): void {
  try {
    const ctx = getAudioContext();
    if (ctx && ctx.state === "suspended") void ctx.resume().catch(() => undefined);
  } catch {
    // No AudioContext / no autoplay permission — never surface.
  }
}

/** Plays the cue. `"none"` does nothing at all. */
export function playScanCue(cue: ScanCue): void {
  if (cue === "none") return;
  const accepted = cue === "accepted";
  // Independent tries: an AudioContext that throws (autoplay-blocked, constructor refused) must
  // not also cost the operator the haptic, which is the cue that would still have worked.
  try {
    if (accepted) beep(1000, 80);
    else beep(300, 180);
  } catch {
    // A cue failure must never reach the caller.
  }
  try {
    navigator.vibrate?.(accepted ? 50 : [40, 60, 40]);
  } catch {
    // Same contract as above.
  }
}
