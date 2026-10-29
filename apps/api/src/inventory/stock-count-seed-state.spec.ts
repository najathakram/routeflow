import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, sep } from "path";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { stockCountSeedState as sharedSeedState } from "@routeflow/types";
import { stockCountSeedState } from "../common/stock-count-seed-state";
import { refuseIfSeeding, refuseWhileSeeding } from "./stock-count-commit";
import { buildCountUnitWorld, CountUnitWorld, D, pid } from "./testing/count-unit-harness";

/**
 * SA-999 (row 562 S1): the seed-state of a stock count and the three things built on it.
 *
 *  1. The predicate: four ordinary rows and the rows the table's CHECKs forbid (which THROW).
 *  2. Parity: the api copy answers like the shared one in `packages/types` (the api may only `import type`
 *     from it, see `no-runtime-workspace-imports.spec.ts`), for every combination of the two columns.
 *  3. The commit refuses a count that is still being seeded: 409 STOCK_COUNT_SEEDING, after the existing
 *     pre-checks, as the FIRST read under the exclusive count lock, with nothing written.
 *  4. The writers: `startStockCountSession` plans the number of lines in the create that makes the count OPEN,
 *     and a count of 0 lines is complete in that same create.
 *  5. A census pin: `seedCompletedAt` has ONE writer, `seedCompletionStamp`, used by exactly two callers.
 *
 * The real-Postgres proofs (a barrier between two batches, a killed seed, discard) are
 * `stock-count-seed-state.db.spec.ts`.
 */
const mockWithAdvisoryLock = jest.fn();
jest.mock("../common/db-locks", () => ({
  ...jest.requireActual("../common/db-locks"),
  withAdvisoryLock: (...args: unknown[]) => mockWithAdvisoryLock(...args),
}));

const T0 = new Date("2026-10-26T00:00:00Z");

describe("stockCountSeedState (SA-999)", () => {
  it("planned NULL and completedAt NULL: 'legacy' (a person's own count, or a count from before the columns)", () => {
    expect(stockCountSeedState({ seedPlannedLines: null, seedCompletedAt: null })).toBe("legacy");
  });

  it("planned set and completedAt NULL: 'seeding' (running, or the process died)", () => {
    expect(stockCountSeedState({ seedPlannedLines: 450, seedCompletedAt: null })).toBe("seeding");
    expect(stockCountSeedState({ seedPlannedLines: 1, seedCompletedAt: null })).toBe("seeding");
  });

  it("completedAt set (with planned): 'complete', a Date or the ISO string off the wire", () => {
    expect(stockCountSeedState({ seedPlannedLines: 450, seedCompletedAt: T0 })).toBe("complete");
    expect(stockCountSeedState({ seedPlannedLines: 450, seedCompletedAt: T0.toISOString() })).toBe(
      "complete",
    );
  });

  it("a seed of 0 lines (planned 0, stamped in the create) is 'complete', not 'seeding'", () => {
    expect(stockCountSeedState({ seedPlannedLines: 0, seedCompletedAt: T0 })).toBe("complete");
    expect(stockCountSeedState({ seedPlannedLines: 0, seedCompletedAt: null })).toBe("seeding");
  });

  it("completedAt without planned THROWS (the table's CHECK forbids the row)", () => {
    expect(() => stockCountSeedState({ seedPlannedLines: null, seedCompletedAt: T0 })).toThrow(
      /seedCompletedAt is set without seedPlannedLines/,
    );
  });

  it.each([-1, -450, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "a planned count of %p THROWS (negative or not a whole number)",
    (n) => {
      expect(() => stockCountSeedState({ seedPlannedLines: n, seedCompletedAt: null })).toThrow(
        /seedPlannedLines must be a non-negative integer/,
      );
      expect(() => stockCountSeedState({ seedPlannedLines: n, seedCompletedAt: T0 })).toThrow();
    },
  );
});

describe("stockCountSeedState: the api copy and the shared one answer alike (SA-999)", () => {
  const planned = [null, 0, 1, 200, 450, -1, 2.5];
  const completed = [null, T0, T0.toISOString()];
  const outcome = (fn: typeof stockCountSeedState, p: number | null, c: Date | string | null) => {
    try {
      return fn({ seedPlannedLines: p, seedCompletedAt: c });
    } catch (e) {
      return `throws: ${(e as Error).message}`;
    }
  };

  it.each(planned.flatMap((p) => completed.map((c) => [p, c] as const)))(
    "planned %p, completedAt %p",
    (p, c) => {
      expect(outcome(stockCountSeedState, p, c)).toEqual(outcome(sharedSeedState, p, c));
    },
  );
});

describe("refuseIfSeeding / refuseWhileSeeding (SA-999)", () => {
  const seedingRow = { status: "OPEN", seedPlannedLines: 450, seedCompletedAt: null };
  const codeOf = (fn: () => unknown) => {
    try {
      fn();
    } catch (e: any) {
      return { status: e?.getStatus?.(), code: e?.getResponse?.()?.code, message: e?.message };
    }
    return null;
  };

  it("a seeding OPEN or REVIEW count is the coded 409 with the plain sentence", () => {
    for (const status of ["OPEN", "REVIEW"]) {
      expect(codeOf(() => refuseIfSeeding({ ...seedingRow, status }))).toEqual({
        status: 409,
        code: "STOCK_COUNT_SEEDING",
        message: "This count is still being prepared. Try again in a moment.",
      });
    }
  });

  it("legacy, complete and unselected columns pass", () => {
    expect(codeOf(() => refuseIfSeeding({ status: "OPEN" }))).toBeNull();
    expect(
      codeOf(() =>
        refuseIfSeeding({ status: "OPEN", seedPlannedLines: null, seedCompletedAt: null }),
      ),
    ).toBeNull();
    expect(codeOf(() => refuseIfSeeding({ ...seedingRow, seedCompletedAt: T0 }))).toBeNull();
  });

  it("a DISCARDED or COMMITTED count keeps its own answer (the 400, the idempotent replay)", () => {
    for (const status of ["DISCARDED", "COMMITTED"]) {
      expect(codeOf(() => refuseIfSeeding({ ...seedingRow, status }))).toBeNull();
    }
  });

  it("refuseWhileSeeding reads status and the two columns of THIS session, then applies the same rule", async () => {
    const findUnique = jest.fn().mockResolvedValue(seedingRow);
    await expect(
      refuseWhileSeeding({ stockCountSession: { findUnique } }, "s1"),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: "s1" },
      select: { status: true, seedPlannedLines: true, seedCompletedAt: true },
    });

    findUnique.mockResolvedValue({ ...seedingRow, seedCompletedAt: T0 });
    await expect(
      refuseWhileSeeding({ stockCountSession: { findUnique } }, "s1"),
    ).resolves.toBeUndefined();
    findUnique.mockResolvedValue(null); // a gone session is the caller's 404, not this check's
    await expect(
      refuseWhileSeeding({ stockCountSession: { findUnique } }, "s1"),
    ).resolves.toBeUndefined();
  });
});

describe("the commit refuses a count that is still being seeded (SA-999)", () => {
  let w: CountUnitWorld;
  const started = new Date("2026-10-01T00:00:00Z");
  const line = (i: number) => ({
    id: `line-${i}`,
    sessionId: "sess-1",
    productId: pid(i),
    mode: "REPLACE",
    countedQty: D(90),
    expectedQty: D(100),
    unitCostOverride: null,
  });
  const sess = (over: Record<string, unknown> = {}, lines = [line(1)]) => ({
    id: "sess-1",
    status: "OPEN",
    movementReference: null,
    notes: null,
    startedAt: started,
    seedPlannedLines: null,
    seedCompletedAt: null,
    lines,
    ...over,
  });
  const commit = () => w.service.commitStockCountSession("sess-1", {}, { sub: "u" });
  const code = (e: any) => ({ status: e?.getStatus?.(), code: e?.getResponse?.()?.code });

  beforeEach(async () => {
    w = await buildCountUnitWorld(mockWithAdvisoryLock);
    w.seed([pid(1), pid(2)]);
  });

  it("a seeding count: 409 STOCK_COUNT_SEEDING, no stock moves, no movement, no CAS", async () => {
    w.prisma.stockCountSession.findUnique.mockResolvedValue(sess({ seedPlannedLines: 450 }));

    const err: any = await commit().catch((e) => e);

    expect(code(err)).toEqual({ status: 409, code: "STOCK_COUNT_SEEDING" });
    expect(w.prisma.product.update).not.toHaveBeenCalled();
    expect(w.prisma.stockMovement.create).not.toHaveBeenCalled();
    expect(w.prisma.stockCountSession.updateMany).not.toHaveBeenCalled();
  });

  it("the read under the lock is the authority: a seed that began between the two reads is refused, nothing written", async () => {
    // the early read says legacy (not seeding); the first read under the exclusive lock says seeding
    w.prisma.stockCountSession.findUnique
      .mockResolvedValueOnce(sess())
      .mockResolvedValue(sess({ seedPlannedLines: 450 }));

    const err: any = await commit().catch((e) => e);

    expect(mockWithAdvisoryLock).toHaveBeenCalledTimes(1);
    expect(code(err)).toEqual({ status: 409, code: "STOCK_COUNT_SEEDING" });
    expect(w.prisma.product.update).not.toHaveBeenCalled();
    expect(w.prisma.stockMovement.create).not.toHaveBeenCalled();
  });

  it("the seed-state read is the FIRST read under the lock: the second findUnique, before any movement or product read", async () => {
    w.prisma.stockCountSession.findUnique.mockImplementation(async () => {
      w.events.push("session-read");
      return sess({ seedPlannedLines: 450 });
    });
    mockWithAdvisoryLock.mockImplementation(async (_o: unknown, fn: () => Promise<unknown>) => {
      w.events.push("count-lock");
      return { acquired: true, value: await fn() };
    });

    await commit().catch(() => undefined);

    const afterLock = w.events.slice(w.events.indexOf("count-lock") + 1);
    expect(afterLock[0]).toBe("session-read");
    expect(afterLock).not.toContain("movement-read");
    expect(afterLock).not.toContain("product-read");
  });

  it("a seed that stamped its completion commits; so does a legacy count", async () => {
    for (const over of [{ seedPlannedLines: 1, seedCompletedAt: T0 }, {}]) {
      w = await buildCountUnitWorld(mockWithAdvisoryLock);
      w.seed([pid(1)]);
      w.prisma.stockCountSession.findUnique.mockResolvedValue(sess(over));

      const res: any = await commit();

      expect(res.applied).toBe(1);
    }
  });

  it("the existing pre-checks keep their place: DISCARDED 400, COMMITTED idempotent, no lines 400 - all before the seeding 409", async () => {
    const seeding = { seedPlannedLines: 450 };

    w.prisma.stockCountSession.findUnique.mockResolvedValue(
      sess({ ...seeding, status: "DISCARDED" }),
    );
    await expect(commit()).rejects.toBeInstanceOf(BadRequestException);

    w.prisma.stockCountSession.findUnique.mockResolvedValue(
      sess({ ...seeding, status: "COMMITTED", movementReference: "STOCK_COUNT-sess-1" }),
    );
    await expect(commit()).resolves.toMatchObject({ alreadyCommitted: true });

    w.prisma.stockCountSession.findUnique.mockResolvedValue(sess(seeding, []));
    await expect(commit()).rejects.toBeInstanceOf(BadRequestException);

    expect(mockWithAdvisoryLock).not.toHaveBeenCalled();
  });
});

describe("startStockCountSession plans the seed (SA-999)", () => {
  let w: CountUnitWorld;
  const ids = Array.from({ length: 450 }, (_, i) => pid(i + 1));
  const src = (productIds: string[]) => ({
    id: "old",
    status: "COMMITTED",
    lines: productIds.map((productId) => ({
      productId,
      countedQty: D(7),
      boxes: null,
      pieces: null,
      mode: "REPLACE",
    })),
  });
  const createData = () => w.prisma.stockCountSession.create.mock.calls[0][0].data;
  const stampCalls = () =>
    w.prisma.stockCountSession.updateMany.mock.calls.filter(
      (c: any[]) => c[0].data.seedCompletedAt,
    );

  beforeEach(async () => {
    w = await buildCountUnitWorld(mockWithAdvisoryLock);
    w.seed(ids, 50);
    w.prisma.stockCountSession.findMany.mockResolvedValue([]);
    w.prisma.stockCountSession.create.mockResolvedValue({ id: "new-sess" });
    w.prisma.stockCountSession.findFirst.mockResolvedValue({ id: "new-sess", status: "OPEN" });
    w.prisma.stockCountLine.findMany.mockResolvedValue([]);
    w.prisma.stockCountLine.createMany.mockImplementation(async (a: any) => ({
      count: a.data.length,
    }));
  });

  it("an amend of 450 lines: planned 450 in the create that makes the count OPEN, NOT complete there; the final batch stamps it", async () => {
    w.prisma.stockCountSession.findUnique.mockResolvedValue(src(ids));

    await w.service.startStockCountSession({ amendsSessionId: "old" }, { sub: "u-1" });

    expect(createData()).toMatchObject({ seedPlannedLines: 450 });
    expect("seedCompletedAt" in createData()).toBe(false);
    expect(stampCalls()).toHaveLength(1);
    expect(stampCalls()[0][0].where).toMatchObject({ id: "new-sess", seedPlannedLines: 450 });
  });

  it("the planned number is the number of lines the seed writes (a product twice in the source is one line)", async () => {
    w.prisma.stockCountSession.findUnique.mockResolvedValue(src([ids[0], ids[0], ids[1]]));

    await w.service.startStockCountSession({ amendsSessionId: "old" }, { sub: "u-1" });

    expect(createData().seedPlannedLines).toBe(2);
    expect(w.prisma.stockCountLine.createMany.mock.calls[0][0].data).toHaveLength(2);
  });

  it("a count with no lines to seed: planned 0 AND completed, both in the create; no batch, no later stamp", async () => {
    await w.service.startStockCountSession({ name: "aisle 3" }, { sub: "u-1" });

    expect(createData().seedPlannedLines).toBe(0);
    expect(createData().seedCompletedAt).toBeInstanceOf(Date);
    expect(w.prisma.stockCountLine.createMany).not.toHaveBeenCalled();
    expect(stampCalls()).toHaveLength(0);
  });

  it("an amend of a committed count with no lines is the same 0-line create", async () => {
    w.prisma.stockCountSession.findUnique.mockResolvedValue(src([]));

    await w.service.startStockCountSession({ amendsSessionId: "old" }, { sub: "u-1" });

    expect(createData()).toMatchObject({ seedPlannedLines: 0, amendsSessionId: "old" });
    expect(createData().seedCompletedAt).toBeInstanceOf(Date);
  });
});

/* ------------------------------------------------------------------------------------------------------------- */
/* The census: `seedCompletedAt` has ONE writer.                                                                  */
/* ------------------------------------------------------------------------------------------------------------- */

const SRC = join(__dirname, "..");
const API = join(__dirname, "..", "..");
const SEEDER = join(__dirname, "stock-count-seed.ts");
const SERVICE = join(__dirname, "inventory.service.ts");

const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** The text between the parentheses opened at `open` (balanced; strings are not special-cased: none carry parens here). */
function balanced(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1);
}

const WRITE_CALL =
  /\bstockCountSession\s*\.\s*(create|createMany|createManyAndReturn|update|updateMany|upsert)\s*\(/g;

/**
 * The write shapes `text` (comments stripped) uses on `seedCompletedAt`:
 *   "literal"  - `seedCompletedAt: <value>` inside the `data` of a StockCountSession write
 *   "stamp"    - `seedCompletionStamp(` called inside such a write
 *   "raw-sql"  - raw SQL that writes the column
 * A filter (`where: { seedCompletedAt: null }`) and a read (`select`) are not writes.
 */
export function seedCompletedAtWritesIn(text: string): string[] {
  const code = stripComments(text);
  const out: string[] = [];
  for (const m of code.matchAll(WRITE_CALL)) {
    const args = balanced(code, (m.index ?? 0) + m[0].length - 1);
    const dataAt = args.search(/\bdata\s*:/);
    if (dataAt < 0) continue;
    const data = args.slice(dataAt);
    if (/\bseedCompletedAt\b/.test(data)) out.push("literal");
    if (/\bseedCompletionStamp\s*\(/.test(data)) out.push("stamp");
  }
  if (/(UPDATE|INSERT\s+INTO)\s+"?StockCountSession"?[^`]*"?seedCompletedAt"?/i.test(code)) {
    out.push("raw-sql");
  }
  return out;
}

function sources(dir: string, exts: RegExp, skip: string[]): string[] {
  return readdirSync(dir).flatMap((name) => {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) {
      return name === "node_modules" || name === "dist" || skip.includes(name)
        ? []
        : sources(abs, exts, skip);
    }
    return exts.test(name) && !/\.spec\.ts$/.test(name) ? [abs] : [];
  });
}

describe("SA-999 pin: seedCompletedAt has ONE writer, seedCompletionStamp, with two callers", () => {
  it("the detector sees every write shape and ignores filters, reads, comments and types (self-test)", () => {
    expect(
      seedCompletedAtWritesIn(
        "await db.stockCountSession.create({ data: { seedCompletedAt: new Date() } })",
      ),
    ).toEqual(["literal"]);
    expect(
      seedCompletedAtWritesIn(
        "tx.stockCountSession.updateMany({ where: { id, seedCompletedAt: null }, data: { seedCompletedAt: at } })",
      ),
    ).toEqual(["literal"]);
    expect(
      seedCompletedAtWritesIn(
        "tx.stockCountSession.updateMany({ where: { id, seedCompletedAt: null }, data: seedCompletionStamp() })",
      ),
    ).toEqual(["stamp"]);
    expect(
      seedCompletedAtWritesIn(
        "x.stockCountSession.create({ data: { a: 1, ...(n === 0 ? seedCompletionStamp() : {}) } })",
      ),
    ).toEqual(["stamp"]);
    expect(
      seedCompletedAtWritesIn(
        'await tx.$executeRaw`UPDATE "StockCountSession" SET "seedCompletedAt" = now()`',
      ),
    ).toEqual(["raw-sql"]);
    // not writes
    expect(
      seedCompletedAtWritesIn(
        "db.stockCountSession.findUnique({ where: { id }, select: { seedCompletedAt: true } })",
      ),
    ).toEqual([]);
    expect(
      seedCompletedAtWritesIn(
        "db.stockCountSession.updateMany({ where: { seedCompletedAt: null }, data: { status: 'DISCARDED' } })",
      ),
    ).toEqual([]);
    expect(
      seedCompletedAtWritesIn(
        "// stockCountSession.create({ data: { seedCompletedAt: x } })\nconst a = 1;",
      ),
    ).toEqual([]);
    expect(seedCompletedAtWritesIn("interface R { seedCompletedAt: Date | null }")).toEqual([]);
  });

  it("no api source writes seedCompletedAt directly: no literal, no raw SQL (the helper builds the value)", () => {
    const offenders = [
      ...sources(SRC, /\.ts$/, []),
      ...sources(join(API, "scripts"), /\.(ts|js|mjs|cjs)$/, []),
      ...sources(join(API, "prisma"), /\.(ts|js|mjs|cjs)$/, ["migrations"]),
    ].flatMap((f) =>
      seedCompletedAtWritesIn(readFileSync(f, "utf8"))
        .filter((w) => w === "literal" || w === "raw-sql")
        .map((w) => `${relative(API, f).split(sep).join("/")}: ${w}`),
    );
    expect(offenders).toEqual([]);
  });

  it("the stamp is called from exactly two places: the final seed batch and the create of a 0-line seed", () => {
    const callers = sources(SRC, /\.ts$/, []).flatMap((f) =>
      seedCompletedAtWritesIn(readFileSync(f, "utf8"))
        .filter((w) => w === "stamp")
        .map(() => relative(SRC, f).split(sep).join("/")),
    );
    expect(callers.sort()).toEqual([
      "inventory/inventory.service.ts",
      "inventory/stock-count-seed.ts",
    ]);
  });

  it("seedCompletionStamp is defined once, in stock-count-seed.ts, and is the only place that names the value", () => {
    const seed = stripComments(readFileSync(SEEDER, "utf8"));
    expect(seed.match(/export function seedCompletionStamp\(/g)).toHaveLength(1);
    expect(seed.match(/\{\s*seedCompletedAt\s*:\s*at\s*\}/g)).toHaveLength(1);
    const service = stripComments(readFileSync(SERVICE, "utf8"));
    expect(service).not.toMatch(/seedCompletedAt\s*:/);
    // the stamped update is guarded by the planned number, and sits in the final batch of the seeder
    expect(seed).toMatch(/if \(isFinalBatch\)/);
    expect(seed).toMatch(/seedPlannedLines:\s*lines\.length/);
  });

  it("the seed-state columns are written by the one StockCountSession creator", () => {
    const creators = sources(SRC, /\.ts$/, ["testing"]).filter((f) =>
      /\bstockCountSession\s*\.\s*(create|createMany|createManyAndReturn|upsert)\s*\(/.test(
        stripComments(readFileSync(f, "utf8")),
      ),
    );
    expect(creators.map((f) => relative(SRC, f).split(sep).join("/"))).toEqual([
      "inventory/inventory.service.ts",
    ]);
    const service = stripComments(readFileSync(SERVICE, "utf8"));
    expect(service.match(/stockCountSession\s*\.\s*create\s*\(/g)).toHaveLength(1);
    expect(service).toMatch(/seedPlannedLines:\s*planned\.length/);
  });
});
