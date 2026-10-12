import { ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { LOCK_FAMILIES, tryAdvisoryXactLockShared } from "../common/db-locks";
import {
  absoluteCountChanged,
  COUNT_COMMIT_BATCH,
  COUNT_LOCK_ATTEMPTS,
  COUNT_LOCK_RETRY_MS,
  computeCommitProgress,
  lineWritesAdjustment,
  STOCK_COUNT_LOCK_FAMILY,
  stockCountCommitting,
  stockCountReference,
  stockCountSkipNote,
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

  it("a skip note is ONE line that names the product and says what to do", () => {
    const named = stockCountSkipNote({
      productId: "p1",
      name: "Acme\nWidget",
      reason: "PRODUCT_IS_FAMILY",
    });
    expect(named).toBe(
      "Skipped Acme Widget (p1): is now a product family, not counted. Recount it in a new session.",
    );
    expect(named).not.toContain("\n");
    expect(stockCountSkipNote({ productId: "p2", reason: "PRODUCT_DELETED" })).toBe(
      "Skipped p2: no longer exists, not counted. Recount it in a new session.",
    );
  });

  describe("commit progress", () => {
    const line = (productId: string, mode: string, counted: number, expected: number) => ({
      productId,
      mode,
      countedQty: counted,
      expectedQty: expected,
    });

    it("a line writes an adjustment iff its delta is non-zero (REPLACE counted - expected, ADD counted)", () => {
      expect(lineWritesAdjustment(line("a", "REPLACE", 90, 100))).toBe(true);
      expect(lineWritesAdjustment(line("a", "REPLACE", 100, 100))).toBe(false);
      expect(lineWritesAdjustment(line("a", "ADD", 4, 100))).toBe(true);
      expect(lineWritesAdjustment(line("a", "ADD", 0, 100))).toBe(false);
    });

    it("committedLines = lines with an ADJUSTMENT movement; totalLines = lines that write one", () => {
      const lines = [
        line("a", "REPLACE", 90, 100),
        line("b", "REPLACE", 90, 100),
        line("c", "REPLACE", 100, 100), // zero delta: in neither number
        line("d", "ADD", 2, 0),
      ];
      const moves = [
        { productId: "a", type: "ADJUSTMENT" },
        { productId: "b", type: "COST_BASIS" }, // a cost row alone is not a saved line
        { productId: "zzz", type: "ADJUSTMENT" }, // not a line of this session
      ];
      expect(computeCommitProgress(lines, moves)).toEqual({ committedLines: 1, totalLines: 3 });
    });
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

  it("fails CLOSED on any answer that is not an explicit true (odd client shape = not acquired)", async () => {
    for (const odd of [
      [],
      undefined,
      null,
      [{}],
      [{ ok: undefined }],
      [{ ok: null }],
      [{ ok: "t" }],
    ]) {
      // eslint-disable-next-line no-await-in-loop
      await expect(tryAdvisoryXactLockShared(txReturning(odd), "stock-count", "s1")).resolves.toBe(
        false,
      );
    }
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

describe("absoluteCountChanged (SA-767 r-note 4 A, MF1)", () => {
  const same = { boxes: null, pieces: null };

  it("compares by Decimal equality, never by float or by representation", () => {
    expect(
      absoluteCountChanged(
        { countedQty: new Prisma.Decimal("100.000"), ...same },
        { countedQty: new Prisma.Decimal(100), ...same },
      ),
    ).toBe(false);
    // 0.1 + 0.2 style float drift must not fake a change, and a real 0.001 step must register
    expect(
      absoluteCountChanged(
        { countedQty: new Prisma.Decimal("0.3"), ...same },
        { countedQty: new Prisma.Decimal("0.1").add("0.2"), ...same },
      ),
    ).toBe(false);
    expect(
      absoluteCountChanged(
        { countedQty: new Prisma.Decimal("100.000"), ...same },
        { countedQty: new Prisma.Decimal("100.001"), ...same },
      ),
    ).toBe(true);
  });

  it("a different quantity is a change", () => {
    expect(
      absoluteCountChanged(
        { countedQty: new Prisma.Decimal(100), ...same },
        { countedQty: new Prisma.Decimal(90), ...same },
      ),
    ).toBe(true);
  });

  it("a boxes / pieces split change counts as a change even at the same quantity", () => {
    const q = new Prisma.Decimal(90);
    expect(
      absoluteCountChanged(
        { countedQty: q, boxes: null, pieces: null },
        { countedQty: q, boxes: 0, pieces: 90 },
      ),
    ).toBe(true);
    expect(
      absoluteCountChanged(
        { countedQty: q, boxes: 3, pieces: 0 },
        { countedQty: q, boxes: 2, pieces: 6 },
      ),
    ).toBe(true);
    expect(
      absoluteCountChanged(
        { countedQty: q, boxes: 3, pieces: 0 },
        { countedQty: q, boxes: 3, pieces: 0 },
      ),
    ).toBe(false);
  });
});
