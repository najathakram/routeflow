import * as fs from "fs";
import * as path from "path";
import {
  LOCK_RETRY_DELAYS_MS,
  isLockUnavailable,
  keepsStopCompletionKey,
  releaseStopCompletionKey,
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
  it("retries a 503 LOCK_UNAVAILABLE with the same key, on the LOCK_RETRY_DELAYS_MS schedule", () => {
    expect(src).toMatch(/isLockUnavailable\(e\)/);
    expect(src).toContain("LOCK_RETRY_DELAYS_MS");
  });
  it("releases the key when the completion lands, is queued, already completed, or refused for good", () => {
    expect((src.match(/releaseStopCompletionKey\(stopId\)/g) ?? []).length).toBeGreaterThanOrEqual(
      3,
    );
    expect(src).toMatch(/if \(!keepsStopCompletionKey\(e\)\) releaseStopCompletionKey\(stopId\)/);
  });
});
