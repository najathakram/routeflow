/**
 * Scanner steady-read check (owner ruling 2026-09-24, see project memory
 * `project_scan_aimbox_hold_to_scan_2026-09-24`): DEFAULT ON alongside the aim box — a
 * decode counts only once the SAME value has been read at least `STEADY_READ_MIN_FRAMES`
 * times, each no more than `STEADY_READ_MAX_GAP_MS` after the PREVIOUS one. A single
 * flicker frame (a passing glance, a partially-occluded code) never counts; a genuinely
 * held code clears this well under a second at typical camera frame rates.
 *
 * #2131 review (round 1) found the original design — a fixed `STEADY_READ_WINDOW_MS`
 * window measured from the streak's FIRST frame — broken two ways:
 *
 *   1. A CONTINUOUSLY HELD code at ~10fps reached the 3-frame threshold near the end of
 *      its 300ms window, then the NEXT frame (window already elapsed from frame 1) reset
 *      the streak to count 1 — steady flipped back to false for two more frames while it
 *      re-accumulated, over and over, every ~300ms, for as long as the code stayed in
 *      view. Each reset is a frame the caller must (per the design below) skip feeding to
 *      the dedupe gate's `lastSeenAt` clock, and enough of those in a row reads as the
 *      code having LEFT the frame — a 5s hold at 10Hz produced 7 accepts, not 1.
 *   2. A window measured from the FIRST frame is a hard ceiling on total elapsed time
 *      regardless of gap size, so a genuinely slow decoder can never clear it: iOS
 *      expo-camera decodes Code 39 via ZXing at ≤6fps, and `CameraView` itself throttles
 *      repeated identical-code events to at most one per ~500ms — three reads of the same
 *      Code 39 label are then AT LEAST ~1000ms apart, which can never fit inside a 300ms
 *      window measured from the first of them. That label could never scan at all.
 *
 * The fix is a ROLLING gap, not a fixed window: a streak continues as long as each new
 * frame arrives within `STEADY_READ_MAX_GAP_MS` of the PREVIOUS frame of the same code —
 * there is no ceiling on the streak's total duration, only on the GAP between consecutive
 * reads. A continuously held code (any frame rate) never resets once it first reaches the
 * threshold, because consecutive same-code frames are always well under the gap tolerance
 * — fixing (1). `STEADY_READ_MAX_GAP_MS` is set above the 500ms identical-event throttle
 * (with headroom for jitter), so three Code 39 reads ~500ms apart now accumulate into one
 * steady streak — fixing (2).
 *
 * PER-CODE, not a single shared streak (#2131 review, point 4): expo-camera reports every
 * code it decodes in a frame, so two DIFFERENT codes genuinely present at once (e.g. an
 * ITF-14 case code and an EAN-13 item code on the same carton face) interleave in the
 * event stream even though neither one is actually flickering. A single shared `code`
 * field would see every OTHER code's frame as "a different code" and reset to count 1,
 * so neither one could ever reach the threshold. Tracking one streak per code (mirroring
 * `scan-loop.ts`'s own multi-slot `ScanSlot` design) lets each accumulate independently.
 *
 * Deliberately RAW string equality, NOT the existing gate's symbology-normalized candidate
 * matching (`scan-loop.ts`'s `ScanCandidates`) — this check answers "is the camera holding
 * still on one value," not "is this the same physical item as one seen before." A label
 * that flickers between symbologies mid-hold resets that ONE slot's streak, which is an
 * acceptable, rare cost for a filter whose job is rejecting RANDOM passing reads — cross-
 * symbology item identity is `scan-loop.ts`'s own, separate, downstream job.
 *
 * `steady` is true for EVERY frame once a code's streak reaches the threshold, not just
 * the one frame that first crosses it — see `scan-engine.ts`'s `continuousFrameScanned`
 * for why every in-box frame (steady or not) must still reach the gate's `lastSeenAt`
 * clock.
 */

export const STEADY_READ_MIN_FRAMES = 3;
/**
 * How long a gap between two consecutive frames of the SAME code may be and still
 * continue its streak. Set above `CameraView`'s ~500ms identical-event throttle (the
 * slowest realistic consecutive-read gap for a held code) with headroom for jitter —
 * NOT a ceiling on the streak's total duration (see the module doc above).
 */
export const STEADY_READ_MAX_GAP_MS = 700;
/** How many recently-seen codes keep their own streak (mirrors scan-loop's SCAN_SLOTS). */
export const STEADY_READ_SLOTS = 4;

/** One tracked code's streak. */
export interface SteadyReadSlot {
  code: string;
  /** When this code was last read, of ANY streak length. */
  lastSeenAt: number;
  /** Consecutive frames (each within the gap tolerance of the last) that read `code`. */
  count: number;
  /**
   * The caller's mark, set when this streak (re)started: the code had been absent before it.
   * Carried for the life of the streak until the caller clears it (`clearAfterAbsence`).
   */
  afterAbsence?: boolean;
}

/** MRU-first, capped at `STEADY_READ_SLOTS` — one entry per recently-seen code. */
export type SteadyReadState = SteadyReadSlot[];

export interface SteadyReadResult {
  /** True once THIS code's streak has reached `STEADY_READ_MIN_FRAMES`, and stays true
   *  for every further frame of the same held code. */
  steady: boolean;
  /** This code's current streak began after an absence (see `SteadyReadSlot.afterAbsence`). */
  afterAbsence: boolean;
  next: SteadyReadState;
}

/** The empty/idle state — no streaks started. */
export function createSteadyReadState(): SteadyReadState {
  return [];
}

/**
 * A frame decoded `code` at `now`. If `code` already has a slot and the gap since its
 * `lastSeenAt` is within `STEADY_READ_MAX_GAP_MS`, its streak continues; otherwise it
 * (re)starts at count 1. Every OTHER code's slot is left untouched, so an interleaved
 * second code's frames never disturb this one's streak.
 */
export function trackSteadyRead(
  state: SteadyReadState,
  code: string,
  now: number,
  /** Used only if this frame (re)starts the streak: mark it `afterAbsence`. */
  absentIfRestarted: boolean = false,
): SteadyReadResult {
  const idx = state.findIndex((slot) => slot.code === code);
  const prev = idx >= 0 ? state[idx] : null;
  const continuesStreak = !!prev && now - prev.lastSeenAt <= STEADY_READ_MAX_GAP_MS;
  const count = continuesStreak ? prev!.count + 1 : 1;
  const afterAbsence = continuesStreak ? !!prev!.afterAbsence : absentIfRestarted;
  const head: SteadyReadSlot = {
    code,
    lastSeenAt: now,
    count,
    ...(afterAbsence && { afterAbsence }),
  };
  const rest = state.filter((_, i) => i !== idx).slice(0, STEADY_READ_SLOTS - 1);
  return { steady: count >= STEADY_READ_MIN_FRAMES, afterAbsence, next: [head, ...rest] };
}

/**
 * Clears the `afterAbsence` mark once the caller has honoured it (one accept per absence) — on
 * `code`'s slot AND on every slot whose raw code is a gate candidate of it (SA-384a): the gate
 * treats a UPC-A and its EAN-13 form as one item, so a variant slot keeping its own mark could
 * re-accept that item once the cooldown ends. `candidatesOf` defaults to raw equality.
 */
export function clearAfterAbsence(
  state: SteadyReadState,
  code: string,
  candidatesOf: (code: string) => readonly string[] = (c) => [c],
): SteadyReadState {
  const accepted = new Set(candidatesOf(code));
  const sameItem = (other: string) =>
    other === code || candidatesOf(other).some((c) => accepted.has(c));
  return state.map((slot) =>
    slot.afterAbsence && sameItem(slot.code)
      ? { code: slot.code, lastSeenAt: slot.lastSeenAt, count: slot.count }
      : slot,
  );
}
