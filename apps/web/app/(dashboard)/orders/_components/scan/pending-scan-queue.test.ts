import {
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  PENDING_MAX,
  PENDING_MAX_ATTEMPTS,
  backoffMs,
  dueScans,
  enqueue,
  recordFailure,
  removePending,
  retryAllNow,
  type PendingScan,
} from "./pending-scan-queue";

const T0 = 1_000_000;
const item = (id: string, o: Partial<PendingScan> = {}): PendingScan => ({
  id,
  code: `code-${id}`,
  scannedAt: T0,
  attempts: 1,
  nextAttemptAt: T0 + BACKOFF_BASE_MS,
  ...o,
});

describe("backoffMs", () => {
  it("doubles from 5s and caps at 60s", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(backoffMs)).toEqual([
      5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000, 60_000,
    ]);
    expect(backoffMs(6)).toBe(BACKOFF_CAP_MS);
  });

  it("treats a nonsense attempt count as the first", () => {
    expect(backoffMs(0)).toBe(5_000);
    expect(backoffMs(-3)).toBe(5_000);
    expect(backoffMs(1.9)).toBe(5_000);
  });
});

describe("enqueue", () => {
  it("adds a scan whose original failed lookup is attempt 1, due after the first backoff", () => {
    const { queue, accepted } = enqueue([], "111", T0, "q1");
    expect(accepted).toBe(true);
    expect(queue).toEqual([
      { id: "q1", code: "111", scannedAt: T0, attempts: 1, nextAttemptAt: T0 + 5_000 },
    ]);
  });

  it("does NOT deduplicate: two scans of one code are two deliberate scans", () => {
    const a = enqueue([], "111", T0, "q1");
    const b = enqueue(a.queue, "111", T0 + 10, "q2");
    expect(b.queue.map((p) => p.code)).toEqual(["111", "111"]);
  });

  it(`refuses the ${PENDING_MAX + 1}th scan and leaves the queue untouched`, () => {
    let q: PendingScan[] = [];
    for (let i = 0; i < PENDING_MAX; i++) q = enqueue(q, `c${i}`, T0, `q${i}`).queue;
    expect(q).toHaveLength(PENDING_MAX);
    const over = enqueue(q, "one-too-many", T0, "qx");
    expect(over.accepted).toBe(false);
    expect(over.queue).toEqual(q);
  });

  it("never mutates its input", () => {
    const q = Object.freeze([item("a")]) as readonly PendingScan[];
    expect(() => enqueue(q, "x", T0, "b")).not.toThrow();
  });
});

describe("dueScans", () => {
  it("returns only scans whose time has come, oldest first", () => {
    const q = [item("a", { nextAttemptAt: T0 + 100 }), item("b", { nextAttemptAt: T0 + 50 })];
    expect(dueScans(q, T0 + 60).map((p) => p.id)).toEqual(["b"]);
    expect(dueScans(q, T0 + 100).map((p) => p.id)).toEqual(["a", "b"]);
    expect(dueScans(q, T0)).toEqual([]);
  });
});

describe("recordFailure", () => {
  it("bumps attempts and schedules the next try with backoff", () => {
    const { queue, dropped } = recordFailure([item("a", { attempts: 1 })], "a", T0 + 7_000);
    expect(dropped).toBeNull();
    expect(queue[0]).toMatchObject({ attempts: 2, nextAttemptAt: T0 + 7_000 + 10_000 });
  });

  it(`drops the scan at ${PENDING_MAX_ATTEMPTS} attempts and returns it`, () => {
    const { queue, dropped } = recordFailure(
      [item("a", { attempts: PENDING_MAX_ATTEMPTS - 1 })],
      "a",
      T0,
    );
    expect(queue).toEqual([]);
    expect(dropped).toMatchObject({ id: "a", attempts: PENDING_MAX_ATTEMPTS });
  });

  it("keeps a scan at attempt 9 (one more try left)", () => {
    const { queue, dropped } = recordFailure([item("a", { attempts: 8 })], "a", T0);
    expect(dropped).toBeNull();
    expect(queue).toHaveLength(1);
  });

  it("an unknown id is a no-op (it was discarded while its lookup was in flight)", () => {
    const q = [item("a")];
    const { queue, dropped } = recordFailure(q, "gone", T0);
    expect(queue).toEqual(q);
    expect(dropped).toBeNull();
  });

  it("only touches the scan that failed", () => {
    const { queue } = recordFailure([item("a"), item("b")], "a", T0);
    expect(queue.find((p) => p.id === "b")).toEqual(item("b"));
  });
});

describe("removePending / retryAllNow", () => {
  it("removePending removes exactly one scan", () => {
    expect(removePending([item("a"), item("b")], "a").map((p) => p.id)).toEqual(["b"]);
  });

  it("retryAllNow makes every scan due now without ever pushing one LATER", () => {
    const q = [item("a", { nextAttemptAt: T0 + 60_000 }), item("b", { nextAttemptAt: T0 - 5 })];
    const out = retryAllNow(q, T0);
    expect(out.map((p) => p.nextAttemptAt)).toEqual([T0, T0 - 5]);
    expect(dueScans(out, T0)).toHaveLength(2);
  });
});
