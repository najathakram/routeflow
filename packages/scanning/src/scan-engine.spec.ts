import { createScanEngine, frameScanned, manualScanned, scanSettled } from "./scan-engine";
import type { ScanCandidates } from "./scan-loop";

const stripZeros: ScanCandidates = (code) => [code.replace(/^0+/, "")];
const T0 = 1_000_000;

describe("scan engine", () => {
  it("a fresh frame starts resolving and raises the indicator", () => {
    const step = frameScanned(createScanEngine(), "A", T0);
    expect(step.startResolving).toBe("A");
    expect(step.indicator).toBe("on");
  });

  it("a gate-rejected repeat starts nothing but keeps the gate's clocks moving", () => {
    const first = frameScanned(createScanEngine(), "A", T0);
    const second = frameScanned(first.next, "A", T0 + 33);
    expect(second.startResolving).toBeNull();
    expect(second.indicator).toBeNull();
    expect(second.next.gate?.lastSeenAt).toBe(T0 + 33);
    expect(second.next.buffer).toBe(first.next.buffer);
  });

  it("a detection mid-resolve is buffered, then drained on settle (never lost)", () => {
    const a = frameScanned(createScanEngine(), "A", T0);
    const b = frameScanned(a.next, "B", T0 + 10); // different item: accepted, buffered
    expect(b.startResolving).toBeNull();

    const settled = scanSettled(b.next);
    expect(settled.startResolving).toBe("B");
    expect(settled.indicator).toBeNull(); // still resolving — no edge
    const idle = scanSettled(settled.next);
    expect(idle.startResolving).toBeNull();
    expect(idle.indicator).toBe("off");
  });

  it("manual entry skips the gate (no cooldown) but still queues mid-resolve", () => {
    const a = frameScanned(createScanEngine(), "A", T0);
    const manual = manualScanned(a.next, "A"); // same code, inside the cooldown
    expect(manual.startResolving).toBeNull();
    expect(manual.next.buffer.pending).toEqual(["A"]);
    expect(manual.next.gate).toBe(a.next.gate); // gate untouched
  });

  it("threads the injected candidate matcher through to the gate", () => {
    const first = frameScanned(createScanEngine(), "0123", T0, stripZeros);
    // With the matcher '123' is the same item -> rejected; without it, a new item -> accepted.
    const withMatcher = frameScanned(first.next, "123", T0 + 33, stripZeros);
    expect(withMatcher.startResolving).toBeNull();
    expect(withMatcher.next.buffer.pending).toEqual([]);
    const withoutMatcher = frameScanned(first.next, "123", T0 + 33);
    expect(withoutMatcher.next.buffer.pending).toEqual(["123"]);
  });
});
