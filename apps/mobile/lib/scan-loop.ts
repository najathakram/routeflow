import { normalizeScanCode } from "./barcode-normalize";

/**
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

export const SCAN_COOLDOWN_MS = 600;
/** How long a tracked code must be absent from frame before a repeat counts as a re-present. */
export const ABSENCE_GAP_MS = 300;
/** How many recently-seen codes keep their own cooldown (spec R1: at least 4). */
export const SCAN_SLOTS = 4;

function intersectsCandidates(candidates: Set<string>, code: string): boolean {
  return normalizeScanCode(code).some((c) => candidates.has(c));
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
): { accept: boolean; state: ScanGateState } {
  if (!code.trim()) {
    return {
      accept: false,
      state: state ?? { lastCode: code, lastAcceptAt: now, lastSeenAt: now, slots: [] },
    };
  }

  const slots = state ? readSlots(state) : [];
  const candidates = new Set(normalizeScanCode(code));
  const matched = slots.findIndex((slot) => intersectsCandidates(candidates, slot.code));
  const slot = matched >= 0 ? slots[matched] : null;
  const accept =
    !slot || (now - slot.lastAcceptAt >= cooldownMs && now - slot.lastSeenAt >= ABSENCE_GAP_MS);

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

/** A call-to-action rendered inside the scanner's feedback pill. */
export interface ScanFeedbackAction {
  label: string;
  onPress: () => void;
}

/** Feedback shown inside the scanner overlay after each continuous scan. */
export interface ScanFeedback {
  kind: "added" | "error";
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
