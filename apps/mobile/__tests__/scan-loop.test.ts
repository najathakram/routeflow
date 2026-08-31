/**
 * Continuous-scan gate: camera decoders re-emit the same barcode every frame
 * while it stays in view. The gate must accept intentional scans (new code,
 * or the same code after it left the frame) and reject per-frame repeats —
 * including the "held steady past the cooldown" case, via the sliding window.
 */
import { gateScan, SCAN_COOLDOWN_MS, ScanGateState } from "../lib/scan-loop";

const t0 = 1_000_000;

/**
 * The scanner component re-anchors the gate's clocks to completion time after
 * a lookup outran the cooldown (see the re-anchoring test below). Expressed as
 * a helper so this file states WHICH clocks move without freezing the state
 * shape: F30's gate needs a second timestamp (see the model note further down),
 * and an exact-shape literal here would forbid it.
 */
function reanchorTo(state: ScanGateState, at: number): ScanGateState {
  return { ...state, lastAt: at, lastAcceptAt: at, lastSeenAt: at } as ScanGateState;
}

describe("gateScan", () => {
  it("accepts the very first scan", () => {
    const r = gateScan("111", null, t0);
    expect(r.accept).toBe(true);
    // `toMatchObject`, not `toEqual`: the slot identity is the contract, the
    // clock fields are not. F30's accept-only cooldown refresh needs to ADD a
    // timestamp to this state (lastAcceptAt / lastSeenAt), and an exact-shape
    // assertion here would forbid the very fix REG-B191 below demands.
    expect(r.state).toMatchObject({ lastCode: "111" });
  });

  it("rejects blank codes", () => {
    expect(gateScan("", null, t0).accept).toBe(false);
    expect(gateScan("   ", null, t0).accept).toBe(false);
  });

  it("accepts a different code immediately (scan the next item)", () => {
    const first = gateScan("111", null, t0);
    const r = gateScan("222", first.state, t0 + 50);
    expect(r.accept).toBe(true);
  });

  it("rejects the same code re-decoded within the cooldown (per-frame repeat)", () => {
    const first = gateScan("111", null, t0);
    const r = gateScan("111", first.state, t0 + 100);
    expect(r.accept).toBe(false);
  });

  it("accepts the same code again after a full cooldown gap (second box of the same item)", () => {
    const first = gateScan("111", null, t0);
    const r = gateScan("111", first.state, t0 + SCAN_COOLDOWN_MS);
    expect(r.accept).toBe(true);
  });

  it("slides the window while the code stays in view — holding steady never re-adds", () => {
    // Simulate ~30fps frames of the same code for 3× the cooldown.
    let state: ScanGateState | null = null;
    let accepted = 0;
    for (let t = t0; t <= t0 + SCAN_COOLDOWN_MS * 3; t += 33) {
      const r = gateScan("111", state, t);
      state = r.state;
      if (r.accept) accepted += 1;
    }
    expect(accepted).toBe(1);
  });

  it("re-anchoring to completion time blocks a re-add of an item held past the cooldown", () => {
    // Models the scanner's busy-window fix: while onScanned is awaited, camera
    // frames DON'T call gateScan, so the window can't slide. If the lookup
    // outran the cooldown, the component re-anchors state to completion time.
    const first = gateScan("111", null, t0); // accepted, processing starts
    expect(first.accept).toBe(true);
    // ... onScanned takes 1.8s (> cooldown); frames during it are dropped by
    // the busyRef guard, so the gate's clocks are still at t0. The component's
    // finally block re-anchors:
    const reanchored = reanchorTo(first.state, t0 + 1800);
    // Next in-frame decode of the same code, just after completion:
    const next = gateScan("111", reanchored, t0 + 1850);
    expect(next.accept).toBe(false); // 50ms < cooldown → not re-added
  });

  it("A → B → A counts every switch (alternating items on the bench)", () => {
    // Each code carries its OWN cooldown (F30's LRU), so A's second pass is
    // timed against A's own accept, not against B having intervened. 900ms is
    // what handling two items alternately actually costs; the sub-cooldown
    // version of this sequence is a carton showing two codes, not a bench
    // alternation, and REG-B190 below pins that it must NOT count.
    let state: ScanGateState | null = null;
    const at = [t0, t0 + 200, t0 + 900];
    const codes = ["111", "222", "111"];
    const accepted = codes.filter((c, i) => {
      const r = gateScan(c, state, at[i]);
      state = r.state;
      return r.accept;
    });
    expect(accepted).toEqual(["111", "222", "111"]);
  });
});

/**
 * F30 rework (R1 / B190 + B191) — THE GATE MODEL THIS BATCH ENCODES.
 *
 * Written down here rather than left for the implementation to reverse-engineer,
 * because the eight assertions ABOVE (all green today) and the three below only
 * reconcile under one model:
 *
 *   state  = { lastCode, slots: [{ code, lastAcceptAt, lastSeenAt }, ...] }
 *   accept ⇔ the code is non-blank AND
 *            ( no slot's `normalizeScanCode` candidate set intersects it —
 *              a genuinely new item —
 *              OR  now - slot.lastAcceptAt >= SCAN_COOLDOWN_MS
 *               && now - slot.lastSeenAt   >= ABSENCE_GAP_MS )
 *   A slot's `lastSeenAt` moves every time THAT code is decoded; its
 *   `lastAcceptAt` only on an ACCEPT. The matched slot moves to the head.
 *
 * Two consequences, both load-bearing:
 *
 * 1. ABSENCE_GAP_MS must land in (33, 350]: strictly above one ~30fps frame
 *    interval so "holding steady never re-adds" (above) still holds, and at or
 *    below 350ms so the re-present test below — and REG-B191's 600ms gaps
 *    between presentations — register. 300ms is the recommended value.
 *    The same 600ms pace bounds SCAN_COOLDOWN_MS from the other side: at or
 *    below 600ms, because a re-present at the reported pace has to clear the
 *    accept clock too (at 700 only every SECOND presentation does, which is
 *    B191 surviving at half strength). Lowering it costs nothing, because
 *    frame-spam protection now lives entirely in ABSENCE_GAP_MS.
 *
 * 2. A per-code LRU of >=4 slots (spec R1), not one slot. A single slot only
 *    remembers the most recent item, so any alternation resets it and B190's
 *    headline case — one carton face printed with BOTH its ITF-14 case code
 *    and its EAN-13 item code, which do not normalize to each other — re-adds
 *    on every decode flip. Per-code clocks cost the "A → B → A quickly" case
 *    above: a sub-cooldown A→B→A is now one accept per code, which is the
 *    carton, not a bench alternation. That test was re-timed to 900ms (the
 *    pace two items can actually be handled at) in the same change; the
 *    alternation itself still counts every switch.
 *
 * The three tests below reproduce the diagnosis card's verified mechanism chains
 * (F30-mobile-scan-loss.md); all are red against today's single-slot,
 * raw-string, sliding-on-reject gate.
 */
describe("gateScan — normalized dedupe + accept-only cooldown (F30 rework)", () => {
  it("REG-B190: one label's alternating EAN-13/UPC-A decodes count as a single item (exactly one accept across 6 frames)", () => {
    // Same physical label; barcode-normalize.test.ts already proves these two
    // strings normalize to each other in both directions. A raw-string
    // single-slot gate sees six DIFFERENT strings and accepts every one
    // (today's bug); a candidate-set-aware gate must recognize all six as the
    // SAME item and register only the first.
    const ean13 = "0012345678905";
    const upcA = "012345678905";
    const frames = [ean13, upcA, ean13, upcA, ean13, upcA];

    let state: ScanGateState | null = null;
    const accepts: boolean[] = [];
    frames.forEach((code, i) => {
      // 100ms apart — well inside SCAN_COOLDOWN_MS, so nothing here should
      // read as an intentional re-scan.
      const r = gateScan(code, state, t0 + i * 100);
      state = r.state;
      accepts.push(r.accept);
    });

    expect(accepts.filter(Boolean).length).toBe(1);
    expect(accepts[0]).toBe(true);
  });

  it("REG-B190: a carton showing TWO different codes counts each once, not once per flip", () => {
    // The other half of B190, and the half no single-slot gate can close: an
    // ITF-14 case code with a non-zero packaging indicator does NOT normalize
    // to its inner EAN-13 (barcode-normalize's GTIN-14 hop only fires for a
    // 14-digit code starting with "0"), so these two really are different
    // items to the resolver — and both are printed on the one carton face the
    // operator is holding. A single-slot gate sees a new item on every flip
    // and accepts all six; scanUnitKind then routes the case code to
    // incrementLine and the item code to incrementLinePiece, which is the
    // "N cs + M loose" runaway B190 describes.
    const caseCode = "10012345678902";
    const itemCode = "0012345678905";
    const frames = [caseCode, itemCode, caseCode, itemCode, caseCode, itemCode];

    let state: ScanGateState | null = null;
    const accepts: boolean[] = [];
    frames.forEach((code, i) => {
      const r = gateScan(code, state, t0 + i * 100);
      state = r.state;
      accepts.push(r.accept);
    });

    // One accept per distinct code — the first sighting of each — and nothing
    // after, because each code's own cooldown is still running.
    expect(accepts).toEqual([true, true, false, false, false, false]);
  });

  it("REG-B190: the LRU keeps at least 4 codes, so a 4-item rotation cannot re-add", () => {
    // Four items rotated through the frame faster than the cooldown: with one
    // slot, every code is "new" by the time it comes round again.
    const codes = ["111", "222", "333", "444"];
    let state: ScanGateState | null = null;
    const accepts: boolean[] = [];
    for (let pass = 0; pass < 2; pass++) {
      codes.forEach((code, i) => {
        const r = gateScan(code, state, t0 + (pass * codes.length + i) * 100);
        state = r.state;
        accepts.push(r.accept);
      });
    }
    // Pass 1 accepts all four (each genuinely new); pass 2 comes round 400ms
    // after each code's own accept — inside its cooldown — so it accepts
    // nothing. A gate that tracked
    // fewer than 4 codes would have forgotten "111" by then and re-added it.
    expect(accepts.slice(0, 4)).toEqual([true, true, true, true]);
    expect(accepts.slice(4)).toEqual([false, false, false, false]);
  });

  it("REG-B191: cooldown refreshes only on ACCEPT — 5 deliberate re-scans survive interleaved per-frame noise", () => {
    const code = "999";
    let state: ScanGateState | null = null;
    const accepts: boolean[] = [];

    // 5 physical re-presentations of the same item at 600ms gaps — the pace
    // B191 was reported at ("5 units of one SKU at <700ms gaps yields qty 1")
    // and the pace the spec's re-scan oracle names — each producing 2 extra
    // per-frame re-detections ("noise", 50ms/100ms after the accepted frame —
    // the decoder still sees the code while it lingers in view). Today's gate
    // refreshes lastAt on every rejected noise frame too, so the sliding
    // window never actually clears and every presentation after the first is
    // suppressed ("all 5 into 1").
    //
    // The gap is a LITERAL, deliberately NOT SCAN_COOLDOWN_MS: timed off the
    // constant, this assertion would follow the cooldown wherever it drifts
    // and prove nothing about the pace an operator actually scans at (at 700
    // it would still pass while every second real presentation was dropped).
    // This is the assertion that fixes SCAN_COOLDOWN_MS's upper bound.
    const RE_PRESENT_GAP_MS = 600;
    expect(SCAN_COOLDOWN_MS).toBeLessThanOrEqual(RE_PRESENT_GAP_MS);

    for (let i = 0; i < 5; i++) {
      const base = t0 + i * RE_PRESENT_GAP_MS;
      for (const offset of [0, 50, 100]) {
        const r = gateScan(code, state, base + offset);
        state = r.state;
        accepts.push(r.accept);
      }
    }

    expect(accepts.filter(Boolean).length).toBe(5);
    // The accept must land on the FIRST frame of each of the 5 presentations.
    expect(accepts.filter((_, i) => i % 3 === 0)).toEqual([true, true, true, true, true]);
    expect(accepts.every((accepted, i) => (i % 3 === 0 ? accepted : !accepted))).toBe(true);

    // Pin the accept-refresh semantics on the simple case too: a genuine
    // near-duplicate well inside the cooldown still suppresses normally.
    const first = gateScan("555", null, t0);
    const second = gateScan("555", first.state, t0 + 300);
    expect(first.accept).toBe(true);
    expect(second.accept).toBe(false);
  });

  it("REG-B191: re-accepts an item that LEFT the frame, without demanding a full cooldown of silence (the absence gap)", () => {
    // Phase 1 — held steady at ~30fps for 3× the cooldown. Exactly the
    // "slides the window" case above: still one accept. Pinned again here so
    // the absence gap can never be set low enough to break frame-spam
    // protection (ABSENCE_GAP_MS > 33ms).
    let state: ScanGateState | null = null;
    let accepted = 0;
    let lastFrameAt = t0;
    for (let t = t0; t <= t0 + SCAN_COOLDOWN_MS * 3; t += 33) {
      const r = gateScan("111", state, t);
      state = r.state;
      lastFrameAt = t;
      if (r.accept) accepted += 1;
    }
    expect(accepted).toBe(1);

    // Phase 2 — the operator lifts the item out of view and re-presents it:
    // 350ms with NO frames at all, more than 3× the cooldown after the last
    // ACCEPT. That is an unambiguous second scan and its qty must go up.
    //
    // Today the window slides on every rejected frame, so the gate has no
    // memory of when it last ACCEPTED and instead demands a further full
    // SCAN_COOLDOWN_MS of silence — this genuine re-present is swallowed
    // (the B191 chain: "re-scanning the same item does nothing"). Under the
    // model above it is accepted, and this is the assertion that fixes
    // ABSENCE_GAP_MS's upper bound at 350ms.
    const rePresented = gateScan("111", state, lastFrameAt + 350);
    expect(rePresented.accept).toBe(true);
  });
});
