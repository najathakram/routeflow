import * as fs from "fs";
import * as path from "path";
import {
  LOCK_RETRY_DELAYS_MS,
  isLockUnavailable,
  keepsStopCompletionKey,
  releaseStopCompletionKey,
  retryOnLockUnavailable,
  stopCompletionKey,
} from "../lib/stop-completion-key";

/**
 * Row 108 (SA-706h, #3213 client condition): a 503 LOCK_UNAVAILABLE on a stop completion is refused BEFORE any write,
 * and the driver app must retry it with the SAME idempotency key. The screen minted a new key on every tap, so a retry
 * after a lost or refused response could not be recognised by the server's key (RF-019). Now one key per stop is kept
 * until the completion lands, is queued, or is refused for good.
 */
const err = (status?: number, code?: string) => ({
  response: status === undefined ? undefined : { status, data: code ? { code } : {} },
});

describe("stopCompletionKey", () => {
  afterEach(() => {
    releaseStopCompletionKey("s1");
    releaseStopCompletionKey("s2");
  });
  it("is stable for a stop until released, and distinct per stop", () => {
    const a = stopCompletionKey("s1");
    expect(stopCompletionKey("s1")).toBe(a);
    expect(stopCompletionKey("s2")).not.toBe(a);
    expect(a).toMatch(/^stop-s1-/);
  });
  it("a released key is replaced by a new one on the next attempt", () => {
    const a = stopCompletionKey("s1");
    releaseStopCompletionKey("s1");
    expect(stopCompletionKey("s1")).not.toBe(a);
  });
});

describe("keepsStopCompletionKey", () => {
  it.each([
    ["no response (network)", err(undefined)],
    ["a 500", err(500)],
    ["a 503 LOCK_UNAVAILABLE", err(503, "LOCK_UNAVAILABLE")],
    ["a 409 MERGE_IN_PROGRESS", err(409, "MERGE_IN_PROGRESS")],
  ])("keeps the key on %s (the outcome is unknown or nothing was written)", (_l, e) => {
    expect(keepsStopCompletionKey(e)).toBe(true);
  });
  it.each([400, 403, 404, 409, 422])(
    "releases it on a refused %i (a fresh attempt follows)",
    (s) => {
      expect(keepsStopCompletionKey(err(s, "SOMETHING"))).toBe(false);
    },
  );
});

describe("isLockUnavailable", () => {
  it("is the 503 LOCK_UNAVAILABLE only", () => {
    expect(isLockUnavailable(err(503, "LOCK_UNAVAILABLE"))).toBe(true);
    expect(isLockUnavailable(err(503))).toBe(false);
    expect(isLockUnavailable(err(409, "LOCK_UNAVAILABLE"))).toBe(false);
  });
  it("retries twice, briefly", () => {
    expect(LOCK_RETRY_DELAYS_MS).toEqual([1000, 2000]);
  });
});

describe("the driver payment screen's closeStop", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "../app/(driver)/route/stop/[stopId]/payment.tsx"),
    "utf8",
  );
  it("takes the stop's kept key instead of minting one per tap", () => {
    expect(src).toContain("stopCompletionKey(stopId)");
    expect(src).not.toMatch(/stop-\$\{stopId\}-\$\{Date\.now\(\)\}/);
  });
  it("sends the completion through retryOnLockUnavailable (the loop tested above)", () => {
    expect(src).toMatch(/retryOnLockUnavailable\(/);
  });
  it("releases the key when the completion lands, is queued, already completed, or refused for good", () => {
    expect((src.match(/releaseStopCompletionKey\(stopId\)/g) ?? []).length).toBeGreaterThanOrEqual(
      3,
    );
    expect(src).toMatch(/if \(!keepsStopCompletionKey\(e\)\) releaseStopCompletionKey\(stopId\)/);
  });
});

// #3723 review: a behaviour test of the retry loop itself, not only regexes on the screen.
describe("retryOnLockUnavailable", () => {
  const lockErr = (retryAfter?: string) => ({
    response: {
      status: 503,
      data: { code: "LOCK_UNAVAILABLE" },
      headers: retryAfter === undefined ? {} : { "retry-after": retryAfter },
    },
  });
  const run = () => {
    const sleeps: number[] = [];
    return { sleeps, sleep: async (ms: number) => void sleeps.push(ms) };
  };

  it("retries LOCK_UNAVAILABLE twice, then throws the last error", async () => {
    const { sleeps, sleep } = run();
    const fn = jest.fn().mockRejectedValue(lockErr());
    await expect(retryOnLockUnavailable(fn, { sleep })).rejects.toEqual(lockErr());
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([...LOCK_RETRY_DELAYS_MS]);
  });

  it("honours the server's Retry-After (seconds) over the schedule", async () => {
    const { sleeps, sleep } = run();
    const fn = jest.fn().mockRejectedValueOnce(lockErr("2")).mockResolvedValueOnce("done");
    await expect(retryOnLockUnavailable(fn, { sleep })).resolves.toBe("done");
    expect(sleeps).toEqual([2000]);
  });

  it("never retries a 500, or a 503 without the LOCK_UNAVAILABLE code", async () => {
    for (const e of [
      { response: { status: 500, data: {} } },
      { response: { status: 503, data: { code: "OTHER" } } },
    ]) {
      const { sleeps, sleep } = run();
      const fn = jest.fn().mockRejectedValue(e);
      await expect(retryOnLockUnavailable(fn, { sleep })).rejects.toBe(e);
      expect(fn).toHaveBeenCalledTimes(1);
      expect(sleeps).toEqual([]);
    }
  });

  it("every attempt is the same request (the caller's key is captured once, the loop re-sends it)", async () => {
    const keys: string[] = [];
    const key = stopCompletionKey("s9");
    const fn = jest.fn(async () => {
      keys.push(key);
      throw lockErr();
    });
    await expect(retryOnLockUnavailable(fn, { sleep: async () => undefined })).rejects.toBeTruthy();
    expect(new Set(keys).size).toBe(1);
    expect(keys).toHaveLength(3);
    releaseStopCompletionKey("s9");
  });
});
