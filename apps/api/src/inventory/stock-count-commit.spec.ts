import { ConflictException } from "@nestjs/common";
import { LOCK_FAMILIES, tryAdvisoryXactLockShared } from "../common/db-locks";
import {
  COUNT_COMMIT_BATCH,
  COUNT_LOCK_ATTEMPTS,
  COUNT_LOCK_RETRY_MS,
  STOCK_COUNT_LOCK_FAMILY,
  stockCountCommitting,
  stockCountReference,
} from "./stock-count-commit";

/** SA-767 L-2.2: the shared vocabulary of the batched stock-count commit. */
describe("stock-count-commit vocabulary", () => {
  it("the batch size is the ruled 50", () => {
    expect(COUNT_COMMIT_BATCH).toBe(50);
  });

  it("every movement of a count carries STOCK_COUNT-<sessionId>", () => {
    expect(stockCountReference("sess-1")).toBe("STOCK_COUNT-sess-1");
  });

  it("stockCountCommitting is a coded 409 STOCK_COUNT_COMMITTING", () => {
    const e = stockCountCommitting();
    expect(e).toBeInstanceOf(ConflictException);
    expect(e.getStatus()).toBe(409);
    expect(e.getResponse()).toMatchObject({
      code: "STOCK_COUNT_COMMITTING",
      message: "This count is being saved. Try again in a moment.",
    });
  });
});

describe("stock-count-commit: SA-767 L-2.4 vocabulary", () => {
  it("the committer's lock family is the one db-locks lists, and the try-retry is short", () => {
    expect(STOCK_COUNT_LOCK_FAMILY).toBe("stock-count");
    expect(LOCK_FAMILIES).toContain(STOCK_COUNT_LOCK_FAMILY);
    expect(COUNT_LOCK_ATTEMPTS * COUNT_LOCK_RETRY_MS).toBeLessThanOrEqual(1000);
  });
});

describe("tryAdvisoryXactLockShared (SA-767 L-2.4 B)", () => {
  const txReturning = (rows: unknown) => ({ $queryRaw: jest.fn().mockResolvedValue(rows) });

  it("true when the shared lock was granted, false only on an explicit not-granted", async () => {
    await expect(
      tryAdvisoryXactLockShared(txReturning([{ ok: true }]), "stock-count", "s1"),
    ).resolves.toBe(true);
    await expect(
      tryAdvisoryXactLockShared(txReturning([{ ok: false }]), "stock-count", "s1"),
    ).resolves.toBe(false);
  });

  it("binds family and key as hashtext() arguments, like the committer's lock", async () => {
    const tx = txReturning([{ ok: true }]);
    await tryAdvisoryXactLockShared(tx, "stock-count", "s1");
    const [strings, ...values] = tx.$queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    expect(strings.join("?").replace(/\s+/g, " ")).toContain(
      "pg_try_advisory_xact_lock_shared(hashtext(?), hashtext(?))",
    );
    expect(values).toEqual(["stock-count", "s1"]);
  });

  it("refuses an empty key and an unknown family before any statement", async () => {
    const tx = txReturning([{ ok: true }]);
    await expect(tryAdvisoryXactLockShared(tx, "stock-count", "")).rejects.toThrow(TypeError);
    await expect(tryAdvisoryXactLockShared(tx, "nope" as never, "s1")).rejects.toThrow(TypeError);
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });
});
