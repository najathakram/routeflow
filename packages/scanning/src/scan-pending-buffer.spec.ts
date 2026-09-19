import {
  completeResolve,
  createPendingBuffer,
  PENDING_BUFFER_DEPTH,
  pushScan,
} from "./scan-pending-buffer";

describe("pending buffer", () => {
  it("starts resolving immediately when idle", () => {
    const r = pushScan(createPendingBuffer(), "A");
    expect(r.startResolving).toBe("A");
    expect(r.next).toEqual({ isResolving: true, current: "A", pending: [] });
  });

  it("queues instead of dropping while a resolve is in flight, and drains FIFO", () => {
    let s = pushScan(createPendingBuffer(), "A").next;
    s = pushScan(s, "B").next;
    s = pushScan(s, "C").next;
    expect(s.pending).toEqual(["B", "C"]);

    const afterA = completeResolve(s);
    expect(afterA.startResolving).toBe("B");
    const afterB = completeResolve(afterA.next);
    expect(afterB.startResolving).toBe("C");
    const done = completeResolve(afterB.next);
    expect(done.startResolving).toBeNull();
    expect(done.next).toEqual(createPendingBuffer());
  });

  it("keeps a repeat of the in-flight code — the gate, not the buffer, owns dedupe", () => {
    let s = pushScan(createPendingBuffer(), "A").next;
    s = pushScan(s, "A").next;
    expect(s.pending).toEqual(["A"]);
  });

  it(`is bounded at depth ${PENDING_BUFFER_DEPTH}: a third queued scan is the only intentional drop`, () => {
    let s = pushScan(createPendingBuffer(), "A").next;
    s = pushScan(s, "B").next;
    s = pushScan(s, "C").next;
    const over = pushScan(s, "D");
    expect(over.startResolving).toBeNull();
    expect(over.next).toBe(s);
  });
});
