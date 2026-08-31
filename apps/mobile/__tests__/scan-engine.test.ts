/**
 * F30 / REG-B192 / REG-B202 — `scan-engine.ts` is the sequencing seam
 * `ScanCamera.web.tsx` is rewired through so it can stop owning its own
 * mutex. Native (`ScanCamera.tsx`) already threads a decoded frame through
 * `scan-loop.ts`'s gate and then `scan-pending-buffer.ts`'s buffer by hand;
 * this module is that same threading extracted into one pure, jest-speccable
 * unit so the web adapter's decode loop and resolve chain can stay thin.
 *
 * `scan-engine.ts` doesn't exist yet beyond a signature-only stub (every
 * export returns `undefined`), so every assertion below compares a WHOLE
 * returned value via `toEqual` — never a property read off the stub's
 * result — so the suite fails on a clean assertion mismatch, not a crash.
 *
 * The expected gate shapes below are hand-traced against the real
 * `gateScan` (`scan-loop.ts`) rules — per-code slots, `SCAN_COOLDOWN_MS`
 * (600ms since last ACCEPT) and `ABSENCE_GAP_MS` (300ms since last SEEN),
 * `SCAN_SLOTS` (4) — not invented; see the inline trace in each test.
 */
import {
  createScanEngine,
  frameScanned,
  manualScanned,
  scanSettled,
  type ScanEngineState,
} from "../lib/scan-engine";

describe("scan-engine (REG-B202)", () => {
  it("REG-B202/W1: three distinct codes arriving while the first resolves all land, in order", () => {
    const state0 = createScanEngine();

    // Frame A: nothing in flight — starts resolving immediately.
    const step1 = frameScanned(state0, "AAA", 1000);
    expect(step1).toEqual({
      next: {
        gate: {
          lastCode: "AAA",
          lastAcceptAt: 1000,
          lastSeenAt: 1000,
          slots: [{ code: "AAA", lastAcceptAt: 1000, lastSeenAt: 1000 }],
        },
        buffer: { isResolving: true, current: "AAA", pending: [] },
      },
      startResolving: "AAA",
      indicator: "on",
    });

    // Frame B: AAA still resolving — a genuinely new code is gate-accepted
    // and buffered behind it, not started and not dropped.
    const step2 = frameScanned(step1.next, "BBB", 1010);
    expect(step2).toEqual({
      next: {
        gate: {
          lastCode: "BBB",
          lastAcceptAt: 1010,
          lastSeenAt: 1010,
          slots: [
            { code: "BBB", lastAcceptAt: 1010, lastSeenAt: 1010 },
            { code: "AAA", lastAcceptAt: 1000, lastSeenAt: 1000 },
          ],
        },
        buffer: { isResolving: true, current: "AAA", pending: ["BBB"] },
      },
      startResolving: null,
      indicator: null,
    });

    // Frame C: a third distinct code, same story — buffered behind AAA.
    const step3 = frameScanned(step2.next, "CCC", 1020);
    expect(step3).toEqual({
      next: {
        gate: {
          lastCode: "CCC",
          lastAcceptAt: 1020,
          lastSeenAt: 1020,
          slots: [
            { code: "CCC", lastAcceptAt: 1020, lastSeenAt: 1020 },
            { code: "BBB", lastAcceptAt: 1010, lastSeenAt: 1010 },
            { code: "AAA", lastAcceptAt: 1000, lastSeenAt: 1000 },
          ],
        },
        buffer: { isResolving: true, current: "AAA", pending: ["BBB", "CCC"] },
      },
      startResolving: null,
      indicator: null,
    });

    // AAA's resolve settles: BBB (oldest queued) starts next.
    const step4 = scanSettled(step3.next);
    expect(step4).toEqual({
      next: {
        gate: step3.next.gate,
        buffer: { isResolving: true, current: "BBB", pending: ["CCC"] },
      },
      startResolving: "BBB",
      indicator: null,
    });

    // BBB settles: CCC starts.
    const step5 = scanSettled(step4.next);
    expect(step5).toEqual({
      next: {
        gate: step3.next.gate,
        buffer: { isResolving: true, current: "CCC", pending: [] },
      },
      startResolving: "CCC",
      indicator: null,
    });

    // CCC settles: nothing left queued. All three distinct codes were
    // resolved, in the order they were detected, none dropped.
    const step6 = scanSettled(step5.next);
    expect(step6).toEqual({
      next: {
        gate: step3.next.gate,
        buffer: { isResolving: false, current: null, pending: [] },
      },
      startResolving: null,
      indicator: "off",
    });
  });

  it("REG-B202/W2: alternating A,B,A,B a few ms apart — each code is gate-accepted once, the repeat is rejected (not re-added as new)", () => {
    // This drives frameScanned with a FAST synchronous settle between each
    // frame (scan-ladder's local-catalog fast path resolves in ~0ms), so the
    // buffer is idle again before the next frame arrives — isolating what
    // this test actually pins: the GATE's per-code cooldown, not the
    // buffer's queueing. Only a few ms separate frames, well under both
    // SCAN_COOLDOWN_MS (600) and ABSENCE_GAP_MS (300), so the multi-slot
    // gate must recognize each repeat as the SAME tracked code and reject
    // it — never mistake it for an unrelated new code and re-add a slot.
    const state0 = createScanEngine();

    // t=0: AAA, never seen before — accepted, starts resolving.
    const a1 = frameScanned(state0, "AAA", 0);
    expect(a1).toEqual({
      next: {
        gate: {
          lastCode: "AAA",
          lastAcceptAt: 0,
          lastSeenAt: 0,
          slots: [{ code: "AAA", lastAcceptAt: 0, lastSeenAt: 0 }],
        },
        buffer: { isResolving: true, current: "AAA", pending: [] },
      },
      startResolving: "AAA",
      indicator: "on",
    });

    // Fast settle: back to idle immediately.
    const aSettled = scanSettled(a1.next);
    expect(aSettled).toEqual({
      next: { gate: a1.next.gate, buffer: { isResolving: false, current: null, pending: [] } },
      startResolving: null,
      indicator: "off",
    });

    // t=5: BBB, also never seen before — accepted, starts resolving.
    const b1 = frameScanned(aSettled.next, "BBB", 5);
    expect(b1).toEqual({
      next: {
        gate: {
          lastCode: "BBB",
          lastAcceptAt: 5,
          lastSeenAt: 5,
          slots: [
            { code: "BBB", lastAcceptAt: 5, lastSeenAt: 5 },
            { code: "AAA", lastAcceptAt: 0, lastSeenAt: 0 },
          ],
        },
        buffer: { isResolving: true, current: "BBB", pending: [] },
      },
      startResolving: "BBB",
      indicator: "on",
    });

    const bSettled = scanSettled(b1.next);
    expect(bSettled).toEqual({
      next: { gate: b1.next.gate, buffer: { isResolving: false, current: null, pending: [] } },
      startResolving: null,
      indicator: "off",
    });

    // t=10: AAA again, only 10ms after its own accept — well under the
    // 600ms cooldown. The gate MUST find AAA's existing slot and reject it,
    // not treat it as a new code. Rejected: no resolve starts, buffer stays
    // idle, indicator has no edge.
    const a2 = frameScanned(bSettled.next, "AAA", 10);
    expect(a2).toEqual({
      next: {
        gate: {
          lastCode: "AAA",
          lastAcceptAt: 0, // unchanged — a rejected repeat never extends the cooldown
          lastSeenAt: 10,
          slots: [
            { code: "AAA", lastAcceptAt: 0, lastSeenAt: 10 },
            { code: "BBB", lastAcceptAt: 5, lastSeenAt: 5 },
          ],
        },
        buffer: { isResolving: false, current: null, pending: [] },
      },
      startResolving: null,
      indicator: null,
    });

    // t=15: BBB again, only 10ms after its own accept — same story.
    const b2 = frameScanned(a2.next, "BBB", 15);
    expect(b2).toEqual({
      next: {
        gate: {
          lastCode: "BBB",
          lastAcceptAt: 5,
          lastSeenAt: 15,
          slots: [
            { code: "BBB", lastAcceptAt: 5, lastSeenAt: 15 },
            { code: "AAA", lastAcceptAt: 0, lastSeenAt: 10 },
          ],
        },
        buffer: { isResolving: false, current: null, pending: [] },
      },
      startResolving: null,
      indicator: null,
    });
  });

  it("REG-B202/W3: a manual submit mid-resolve is buffered, and lands on the subsequent settle", () => {
    const state0 = createScanEngine();
    const frame = frameScanned(state0, "AAA", 100);
    expect(frame).toEqual({
      next: {
        gate: {
          lastCode: "AAA",
          lastAcceptAt: 100,
          lastSeenAt: 100,
          slots: [{ code: "AAA", lastAcceptAt: 100, lastSeenAt: 100 }],
        },
        buffer: { isResolving: true, current: "AAA", pending: [] },
      },
      startResolving: "AAA",
      indicator: "on",
    });

    // A deliberate manual entry arrives while AAA is still resolving. It
    // must be buffered — not dropped, and not started early.
    const manual = manualScanned(frame.next, "ZZZ");
    expect(manual).toEqual({
      next: {
        gate: frame.next.gate,
        buffer: { isResolving: true, current: "AAA", pending: ["ZZZ"] },
      },
      startResolving: null,
      indicator: null,
    });

    // AAA settles: the buffered manual code is what starts next.
    const settled = scanSettled(manual.next);
    expect(settled).toEqual({
      next: {
        gate: frame.next.gate,
        buffer: { isResolving: true, current: "ZZZ", pending: [] },
      },
      startResolving: "ZZZ",
      indicator: null,
    });
  });

  it("REG-B202/W3: manualScanned never consults the gate — the same code twice in a row both land", () => {
    // No `now` argument exists on manualScanned's signature at all: a
    // deliberate submit is never subject to the cooldown/absence-gap that
    // would reject a second frameScanned of the same code this close
    // together (see W2). Submitting "QQQ" twice back-to-back must queue
    // BOTH — never silently coalesce the second as a repeat.
    const state0 = createScanEngine();
    const first = manualScanned(state0, "QQQ");
    expect(first).toEqual({
      next: { gate: null, buffer: { isResolving: true, current: "QQQ", pending: [] } },
      startResolving: "QQQ",
      indicator: "on",
    });

    const second = manualScanned(first.next, "QQQ");
    expect(second).toEqual({
      next: { gate: null, buffer: { isResolving: true, current: "QQQ", pending: ["QQQ"] } },
      startResolving: null,
      indicator: null,
    });

    // Both instances of "QQQ" actually get resolved — the second is not
    // dropped, it starts on the next settle exactly like any other queued code.
    const settled = scanSettled(second.next);
    expect(settled).toEqual({
      next: { gate: null, buffer: { isResolving: true, current: "QQQ", pending: [] } },
      startResolving: "QQQ",
      indicator: null,
    });
  });

  it("REG-B202/W3: a manual submit of a code the gate is already suppressing still lands", () => {
    // The pin above compares gate STATE, which a bypass that consults the gate
    // without persisting its result would still satisfy. This one pins the
    // BEHAVIOUR instead: seed the gate by scanning "QQQ" off the camera, let it
    // settle, then manually submit the SAME code 10ms later — deep inside the
    // 600ms cooldown that makes W2's camera repeat a rejection. The operator
    // typed it on purpose (very often BECAUSE the camera just refused it), so
    // it must resolve; any gate consultation at all would swallow it here.
    const scanned = frameScanned(createScanEngine(), "QQQ", 0);
    const idle = scanSettled(scanned.next);
    expect(idle).toEqual({
      next: { gate: scanned.next.gate, buffer: { isResolving: false, current: null, pending: [] } },
      startResolving: null,
      indicator: "off",
    });

    const typed = manualScanned(idle.next, "QQQ");
    expect(typed).toEqual({
      next: {
        // The gate is carried through untouched — not consulted, not advanced.
        gate: scanned.next.gate,
        buffer: { isResolving: true, current: "QQQ", pending: [] },
      },
      startResolving: "QQQ",
      indicator: "on",
    });
  });

  it("REG-B202/W4: the resolving indicator edges exactly once each way", () => {
    const state0 = createScanEngine();

    // idle -> resolving: "on", exactly once.
    const step1 = frameScanned(state0, "AAA", 0);
    expect(step1).toEqual({
      next: {
        gate: {
          lastCode: "AAA",
          lastAcceptAt: 0,
          lastSeenAt: 0,
          slots: [{ code: "AAA", lastAcceptAt: 0, lastSeenAt: 0 }],
        },
        buffer: { isResolving: true, current: "AAA", pending: [] },
      },
      startResolving: "AAA",
      indicator: "on",
    });

    // still resolving, a second code is buffered behind it: no edge.
    const step2 = frameScanned(step1.next, "BBB", 5);
    expect(step2).toEqual({
      next: {
        gate: {
          lastCode: "BBB",
          lastAcceptAt: 5,
          lastSeenAt: 5,
          slots: [
            { code: "BBB", lastAcceptAt: 5, lastSeenAt: 5 },
            { code: "AAA", lastAcceptAt: 0, lastSeenAt: 0 },
          ],
        },
        buffer: { isResolving: true, current: "AAA", pending: ["BBB"] },
      },
      startResolving: null,
      indicator: null,
    });

    // AAA settles into BBB starting: buffer stays resolving throughout, no edge.
    const step3 = scanSettled(step2.next);
    expect(step3).toEqual({
      next: { gate: step2.next.gate, buffer: { isResolving: true, current: "BBB", pending: [] } },
      startResolving: "BBB",
      indicator: null,
    });

    // BBB settles with nothing left queued: resolving -> idle, "off", exactly once.
    const step4 = scanSettled(step3.next);
    expect(step4).toEqual({
      next: { gate: step2.next.gate, buffer: { isResolving: false, current: null, pending: [] } },
      startResolving: null,
      indicator: "off",
    });
  });

  it("REG-B202: buffer depth overflow follows scan-pending-buffer.ts's cap verbatim — a 4th distinct code is gate-accepted but buffer-dropped", () => {
    // Three scans already in flight (one resolving + PENDING_BUFFER_DEPTH=2
    // queued) is the buffer's documented cap (scan-pending-buffer.ts). A 4th
    // genuinely new code is still a fresh gate slot (the gate has no notion
    // of buffer depth), but the buffer must silently hold its ground rather
    // than growing past the cap.
    const state0 = createScanEngine();
    const p1 = frameScanned(state0, "P1", 2000);
    expect(p1).toEqual({
      next: {
        gate: {
          lastCode: "P1",
          lastAcceptAt: 2000,
          lastSeenAt: 2000,
          slots: [{ code: "P1", lastAcceptAt: 2000, lastSeenAt: 2000 }],
        },
        buffer: { isResolving: true, current: "P1", pending: [] },
      },
      startResolving: "P1",
      indicator: "on",
    });

    const p2 = frameScanned(p1.next, "P2", 2010);
    expect(p2).toEqual({
      next: {
        gate: {
          lastCode: "P2",
          lastAcceptAt: 2010,
          lastSeenAt: 2010,
          slots: [
            { code: "P2", lastAcceptAt: 2010, lastSeenAt: 2010 },
            { code: "P1", lastAcceptAt: 2000, lastSeenAt: 2000 },
          ],
        },
        buffer: { isResolving: true, current: "P1", pending: ["P2"] },
      },
      startResolving: null,
      indicator: null,
    });

    const p3 = frameScanned(p2.next, "P3", 2020);
    expect(p3).toEqual({
      next: {
        gate: {
          lastCode: "P3",
          lastAcceptAt: 2020,
          lastSeenAt: 2020,
          slots: [
            { code: "P3", lastAcceptAt: 2020, lastSeenAt: 2020 },
            { code: "P2", lastAcceptAt: 2010, lastSeenAt: 2010 },
            { code: "P1", lastAcceptAt: 2000, lastSeenAt: 2000 },
          ],
        },
        buffer: { isResolving: true, current: "P1", pending: ["P2", "P3"] },
      },
      startResolving: null,
      indicator: null,
    });

    const p4 = frameScanned(p3.next, "P4", 2030);
    expect(p4).toEqual({
      next: {
        gate: {
          lastCode: "P4",
          lastAcceptAt: 2030,
          lastSeenAt: 2030,
          slots: [
            { code: "P4", lastAcceptAt: 2030, lastSeenAt: 2030 },
            { code: "P3", lastAcceptAt: 2020, lastSeenAt: 2020 },
            { code: "P2", lastAcceptAt: 2010, lastSeenAt: 2010 },
            { code: "P1", lastAcceptAt: 2000, lastSeenAt: 2000 },
          ],
        },
        // Unchanged from p3 — P4 was accepted by the gate but dropped by the
        // buffer's depth cap, exactly like scan-pending-buffer.ts's own
        // "holds the depth-2 cap" test.
        buffer: { isResolving: true, current: "P1", pending: ["P2", "P3"] },
      },
      startResolving: null,
      indicator: null,
    });
  });

  it("REG-B202: a rejected frame still advances the gate's clock (regression pin against the frozen-clock bug)", () => {
    // ScanCamera.web.tsx's old `finally` block re-anchored the gate to
    // `{ lastCode, lastAt: Date.now() }` only AFTER a resolve completed —
    // while busyRef held, every mid-resolve detection short-circuited before
    // reaching the gate at all, so its clock was frozen at scan-start for the
    // whole resolve. Here the gate is called on EVERY frame regardless of
    // buffer state, so even a REJECTED repeat must move `lastSeenAt` forward.
    const state0 = createScanEngine();
    const r1 = frameScanned(state0, "XYZ", 50);
    expect(r1).toEqual({
      next: {
        gate: {
          lastCode: "XYZ",
          lastAcceptAt: 50,
          lastSeenAt: 50,
          slots: [{ code: "XYZ", lastAcceptAt: 50, lastSeenAt: 50 }],
        },
        buffer: { isResolving: true, current: "XYZ", pending: [] },
      },
      startResolving: "XYZ",
      indicator: "on",
    });

    // 10ms later, well under the 600ms cooldown: rejected, but lastSeenAt
    // must still read 60, not the frozen 50.
    const r2 = frameScanned(r1.next, "XYZ", 60);
    expect(r2).toEqual({
      next: {
        gate: {
          lastCode: "XYZ",
          lastAcceptAt: 50,
          lastSeenAt: 60,
          slots: [{ code: "XYZ", lastAcceptAt: 50, lastSeenAt: 60 }],
        },
        buffer: { isResolving: true, current: "XYZ", pending: [] },
      },
      startResolving: null,
      indicator: null,
    });
  });
});

/**
 * Type-level sanity that ScanEngineState is exactly {gate, buffer} — guards
 * against a future edit widening the shape and silently invalidating the
 * `toEqual` pins above (an extra field would make every expected literal
 * above fail loudly, which is the point, but this also documents the
 * contract for a reader who lands here first).
 */
describe("scan-engine shape", () => {
  it("REG-B202: createScanEngine returns an idle engine", () => {
    const state: ScanEngineState = createScanEngine();
    expect(state).toEqual({
      gate: null,
      buffer: { isResolving: false, current: null, pending: [] },
    });
  });
});
