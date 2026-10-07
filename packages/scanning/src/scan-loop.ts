/**
 * Single source of the continuous-scan engine, shared by apps/mobile and apps/web
 * (`@routeflow/scanning`, owner ruling 2026-09-19: one source, no mirror pair). Pure TypeScript,
 * no platform imports — the audio/haptic side effects stay in each app's own `scan-cue`.
 *
 * Continuous-scan gate. Camera decoders (expo-camera, BarcodeDetector, zxing)
 * fire the same barcode every frame while it stays in view; this decides which
 * detections count as intentional scans.
 *
 * Rules (F30 / R1, closing B190 + B191):
 * - The gate tracks the last `SCAN_SLOTS` codes, MRU-first, each with its OWN
 *   pair of clocks. A detection is matched to a slot when its
 *   `normalizeScanCode` candidate set INTERSECTS that slot's — matching on the
 *   normalized set, not the raw decode string, so one physical label that
 *   flickers between symbologies (UPC-A/EAN-13 on the same scan) is one item.
 * - A code with no slot is a genuinely new item and is accepted immediately.
 * - A code WITH a slot is rejected until BOTH of that slot's clocks clear:
 *   `lastAcceptAt` (last time this item was accepted) is at least
 *   `SCAN_COOLDOWN_MS` in the past, AND `lastSeenAt` (last time this item was
 *   decoded AT ALL, accept or reject) is at least `ABSENCE_GAP_MS` in the
 *   past. `lastAcceptAt` moves ONLY on accept — a rejected per-frame repeat
 *   must never extend the suppression window, or a deliberate re-scan at
 *   natural pace (the exact case `SCAN_COOLDOWN_MS` was tuned for) gets
 *   swallowed into the first scan's count. `lastSeenAt` moves on EVERY frame,
 *   so a code still visibly in the frame can never re-trigger the accept just
 *   because the cooldown elapsed (frame-spam protection) — it also has to
 *   actually leave the frame for `ABSENCE_GAP_MS`.
 *
 * WHY MULTIPLE SLOTS AND NOT ONE. A single slot only remembers the most recent
 * item, so ANY alternation resets it: a carton face printed with two genuinely
 * different codes (an ITF-14 case code with a non-zero packaging indicator does
 * NOT normalize to its inner EAN-13) decoding A,B,A,B while the operator holds
 * it in frame is a different code from the slot every time, so every flip is
 * accepted — and `scanUnitKind` routes the case code to `incrementLine` and the
 * item code to `incrementLinePiece`, which is exactly B190's runaway
 * "N cs + M loose". Per-code clocks make each code carry its own cooldown, so
 * the flip is suppressed while a real alternation between two items — which
 * cannot physically happen faster than the cooldown — still counts every pass.
 *
 * The cooldown is the "how long since the last ACCEPT to count as an
 * intentional re-present". 1500ms was too long — an operator re-presenting the same
 * item at a natural pace saw the qty NOT go up (desktop's keyboard-wedge scanner has
 * discrete events with no such gap). 700ms was the first cut at that number, but the
 * pace B191 was actually reported at is BELOW it ("5 units of one SKU at <700ms gaps
 * yields qty 1", ~0.6s apart), and at 700 only every SECOND presentation clears —
 * the under-count survives at half strength. 600ms is the re-scan pace the spec's
 * oracle names, so that is the floor. Frame-spam protection no longer rides on this
 * number at all: `ABSENCE_GAP_MS` is what stops a held item from re-adding, which
 * frees the cooldown to sit at the operator's real re-present pace.
 * `ABSENCE_GAP_MS` only needs to clear one ~30fps frame interval (>33ms) so a
 * held code can't re-add mid-hold, and stays low enough (<=350ms) that lifting
 * an item out of frame and back registers as the deliberate re-scan it is.
 */
/** One tracked code and its two clocks. */
export interface ScanSlot {
  code: string;
  /** When this code last ACCEPTED. Refreshed only on accept. */
  lastAcceptAt: number;
  /** When this code was last SEEN (accepted or rejected). Refreshed every detection. */
  lastSeenAt: number;
}

export interface ScanGateState {
  /** The most recently seen code. Mirrors `slots[0].code`. */
  lastCode: string;
  /**
   * Legacy single clock. Optional so callers outside this batch's scope that
   * still construct `{ lastCode, lastAt }` directly (the web camera fallback,
   * `ScanCamera.web.tsx`, not touched by this package) keep compiling; read as
   * the fallback for BOTH clocks below when they're absent.
   */
  lastAt?: number;
  /** Mirror of `slots[0].lastAcceptAt`; an external write RE-ANCHORS that slot. */
  lastAcceptAt?: number;
  /** Mirror of `slots[0].lastSeenAt`; an external write RE-ANCHORS that slot. */
  lastSeenAt?: number;
  /**
   * The LRU itself, MRU-first, capped at `SCAN_SLOTS`. Absent on states built
   * outside this module — those read as a single slot from the mirrors above.
   */
  slots?: ScanSlot[];
}

/**
 * Sentinel `lastAcceptAt` for a slot `touchSeen` created — a code seen but never actually
 * accepted. `gateScan` treats it exactly like "no slot at all" (bypasses cooldown AND
 * absence), so a code an ahead-of-gate filter is still deciding about never accrues a
 * phantom cooldown/absence window before it has ever really been accepted once.
 */
export const NEVER_ACCEPTED = -Infinity;

export const SCAN_COOLDOWN_MS = 600;
/** How long a tracked code must be absent from frame before a repeat counts as a re-present. */
export const ABSENCE_GAP_MS = 300;
/**
 * The absence gap on the steady-read path ONLY (`continuousFrameScanned`; SA-384a/b). It must
 * exceed `STEADY_READ_MAX_GAP_MS` (700) so a streak that is still continuing can never read as
 * absent: a held iOS Code 39 arrives every ~500 ms, which clears the plain 300 ms gap on every
 * event and re-accepted once per cooldown. The plain gate keeps `ABSENCE_GAP_MS` (B191).
 */
export const STEADY_ABSENCE_GAP_MS = 800;
/** How many recently-seen codes keep their own cooldown (spec R1: at least 4). */
export const SCAN_SLOTS = 4;

/**
 * Maps a raw decode to the set of strings that identify the same physical item. The default is
 * raw string equality — correct when ONE decoder runs per session (apps/web: zxing only), since
 * two frames of the same barcode are then byte-identical. apps/mobile has two decoders that can
 * disagree (native vs BarcodeDetector/zxing: an iOS 13-digit decode and a 12-digit decode of the
 * same UPC-A must be one item), so it injects `normalizeScanCode`.
 */
export type ScanCandidates = (code: string) => readonly string[];

const rawCandidates: ScanCandidates = (code) => [code];

function intersectsCandidates(
  candidates: Set<string>,
  code: string,
  candidatesOf: ScanCandidates,
): boolean {
  return candidatesOf(code).some((c) => candidates.has(c));
}

/**
 * The state's slots, with the head re-anchored from the top-level mirrors when
 * a caller wrote them directly. `ScanCamera.web.tsx` still does exactly that to
 * push the cooldown forward after a resolve outran it, and a legacy
 * `{ lastCode, lastAt }` has no slots at all.
 */
function readSlots(state: ScanGateState): ScanSlot[] {
  const mirrorAccept = state.lastAcceptAt ?? state.lastAt ?? 0;
  const mirrorSeen = state.lastSeenAt ?? state.lastAt ?? 0;
  const [head, ...rest] = state.slots ?? [];
  if (!head) {
    return state.lastCode
      ? [{ code: state.lastCode, lastAcceptAt: mirrorAccept, lastSeenAt: mirrorSeen }]
      : [];
  }
  if (head.code !== state.lastCode) return [head, ...rest];
  return [
    {
      ...head,
      lastAcceptAt: Math.max(head.lastAcceptAt, mirrorAccept),
      lastSeenAt: Math.max(head.lastSeenAt, mirrorSeen),
    },
    ...rest,
  ];
}

export function gateScan(
  code: string,
  state: ScanGateState | null,
  now: number,
  cooldownMs: number = SCAN_COOLDOWN_MS,
  candidatesOf: ScanCandidates = rawCandidates,
  /**
   * The caller already observed this code absent for `ABSENCE_GAP_MS` (see `isAbsentFromGate`)
   * before frames it had to `touchSeen` while deciding — skip the absence check; the
   * cooldown still applies (#2131 @1f8b1ea4 review, HIGH).
   */
  absenceObserved: boolean = false,
  /** The absence gap to apply; the steady-read path passes `STEADY_ABSENCE_GAP_MS`. */
  absenceGapMs: number = ABSENCE_GAP_MS,
): { accept: boolean; state: ScanGateState } {
  if (!code.trim()) {
    return {
      accept: false,
      state: state ?? { lastCode: code, lastAcceptAt: now, lastSeenAt: now, slots: [] },
    };
  }

  const slots = state ? readSlots(state) : [];
  const candidates = new Set(candidatesOf(code));
  const matched = slots.findIndex((slot) =>
    intersectsCandidates(candidates, slot.code, candidatesOf),
  );
  const slot = matched >= 0 ? slots[matched] : null;
  // `NEVER_ACCEPTED` (see `touchSeen`) is a slot that exists ONLY so a caller ahead of
  // this gate can keep `lastSeenAt` fresh for a code it hasn't decided to accept yet —
  // treat it exactly like `!slot`, bypassing cooldown AND absence, or a code that took a
  // few frames to satisfy that caller's own filter would need to wait out a cooldown/
  // absence window that never actually started (#2131 review round 1).
  const accept =
    !slot ||
    slot.lastAcceptAt === NEVER_ACCEPTED ||
    (now - slot.lastAcceptAt >= cooldownMs &&
      (absenceObserved || now - slot.lastSeenAt >= absenceGapMs));

  // The matched slot moves to the head under the code just decoded, so a label
  // read as EAN-13 this frame and UPC-A the next keeps ONE set of clocks.
  const head: ScanSlot = {
    code,
    lastAcceptAt: accept ? now : (slot?.lastAcceptAt ?? now),
    lastSeenAt: now,
  };
  const rest = slots.filter((_, i) => i !== matched).slice(0, SCAN_SLOTS - 1);

  return {
    accept,
    state: {
      lastCode: code,
      lastAcceptAt: head.lastAcceptAt,
      lastSeenAt: now,
      slots: [head, ...rest],
    },
  };
}

/**
 * Marks `code` as SEEN at `now` WITHOUT evaluating or moving a REAL `lastAcceptAt` — for
 * a caller (`scan-engine.ts`'s `continuousFrameScanned`) that must keep a held code's
 * `lastSeenAt` fresh, so `ABSENCE_GAP_MS` never fires while a filter ahead of the gate
 * (steady-read) is still deciding whether a frame is trustworthy enough to accept, while
 * never letting that "just looking" touch start (or shorten) the code's real cooldown.
 * A first-ever touch stamps `NEVER_ACCEPTED`, which `gateScan` treats exactly like no
 * slot at all — a plain `0` here would instead read as a real (if ancient) accept
 * timestamp, arming a cooldown/absence window for an accept that was never actually
 * applied and either delaying or, for a continuously-present code, permanently blocking
 * the real first accept (#2131 review round 1).
 */
export function touchSeen(
  state: ScanGateState | null,
  code: string,
  now: number,
  candidatesOf: ScanCandidates = rawCandidates,
): ScanGateState {
  if (!code.trim()) {
    return state ?? { lastCode: code, lastAcceptAt: now, lastSeenAt: now, slots: [] };
  }
  const slots = state ? readSlots(state) : [];
  const candidates = new Set(candidatesOf(code));
  const matched = slots.findIndex((slot) =>
    intersectsCandidates(candidates, slot.code, candidatesOf),
  );
  const slot = matched >= 0 ? slots[matched] : null;
  // No prior slot ⇒ NEVER_ACCEPTED — the eventual real gateScan call for this code then
  // bypasses cooldown AND absence entirely, exactly as `!slot` would, since this code has
  // genuinely never been accepted yet. A prior REAL slot's own lastAcceptAt is preserved
  // untouched either way.
  const head: ScanSlot = {
    code,
    lastAcceptAt: slot?.lastAcceptAt ?? NEVER_ACCEPTED,
    lastSeenAt: now,
  };
  const rest = slots.filter((_, i) => i !== matched).slice(0, SCAN_SLOTS - 1);
  return {
    lastCode: code,
    lastAcceptAt: head.lastAcceptAt,
    lastSeenAt: now,
    slots: [head, ...rest],
  };
}

/** A call-to-action rendered inside the scanner's feedback pill. */
export interface ScanFeedbackAction {
  label: string;
  onPress: () => void;
}

/** Feedback shown inside the scanner overlay after each continuous scan. */
export interface ScanFeedback {
  kind: "added" | "error" | "info";
  text: string;
  /**
   * Renders a button in the pill instead of stranding the operator, and the
   * scanner STAYS OPEN — the action is expected to raise a sheet that stacks
   * above it (see ScanOrderSheet's `paused` prop).
   *
   * Prefer this over `{close:true}`. On react-native-web, Modal portals are
   * appended to document.body at mount with no z-index, so a root-mounted
   * confirm dialog renders BEHIND the opaque scan sheet — which is why the
   * old miss path had to close the scanner to be seen at all, and why the
   * first mis-read stranded the operator.
   */
  action?: ScanFeedbackAction;
}

/**
 * What a continuous `onScanned` handler tells the scanner to do next:
 * show feedback and keep scanning, or close the overlay.
 * `void` = keep scanning, no banner.
 *
 * `close` means "this hand-off REPLACES the scanner" — it is not the way to
 * surface a dialog. No order or invoice path uses it any more; prefer
 * `feedback.action`.
 */
export type ScanOutcome = { close?: boolean; feedback?: ScanFeedback } | void;

function findSlot(
  state: ScanGateState | null,
  code: string,
  candidatesOf: ScanCandidates,
): ScanSlot | null {
  if (!state || !code.trim()) return null;
  const candidates = new Set(candidatesOf(code));
  return (
    readSlots(state).find((slot) => intersectsCandidates(candidates, slot.code, candidatesOf)) ??
    null
  );
}

/** True when the gate already tracks `code` (same candidate matching as `gateScan`). */
export function isTrackedByGate(
  state: ScanGateState | null,
  code: string,
  candidatesOf: ScanCandidates = rawCandidates,
): boolean {
  return findSlot(state, code, candidatesOf) !== null;
}

/**
 * True when `code` has not been seen by the gate for at least `absenceGapMs` as of `now`
 * (or was never seen). Read it BEFORE a `touchSeen` for the same frame.
 */
export function isAbsentFromGate(
  state: ScanGateState | null,
  code: string,
  now: number,
  candidatesOf: ScanCandidates = rawCandidates,
  absenceGapMs: number = ABSENCE_GAP_MS,
): boolean {
  const slot = findSlot(state, code, candidatesOf);
  return !slot || now - slot.lastSeenAt >= absenceGapMs;
}
