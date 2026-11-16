import * as fs from "fs";
import * as path from "path";
import { routeSaleRowsForLockedPeriods } from "./filing-lock";
import { RegulatedLedgerService } from "./regulated-ledger.service";
import { RegulatedFilingService } from "./regulated-filing.service";
import { FILING_LOCK_READY } from "./filing-lock-ready";

/**
 * W-965 / SA-1137 (A5): the ONE pure routing step. A sale row whose date was inherited, booked after its month's
 * filing is LOCKED, goes to the current month with `originalSoldAt` = its own date. The decision reads
 * `isLockedFiling` (LOCKED only, A4), never a status literal, and is per (category, bucket).
 */
const NOW = new Date("2026-11-14T10:00:00Z");
const OCT = new Date("2026-10-20T00:00:00Z");
const row = (cat: string, soldAt = OCT, bucket = "2026-10") => ({
  trackedCategoryId: cat,
  periodBucket: bucket,
  soldAt,
  qty: 4,
  netSales: 40,
});
const cover = (cat: string, status: string, bucket = "2026-10") => ({
  filing: { status, periodKey: bucket, id: `f-${cat}` },
  trackedCategoryId: cat,
  periodBucket: bucket,
});

describe("routeSaleRowsForLockedPeriods (pure, W-965)", () => {
  it("routes a row in a LOCKED (category, bucket) to the current month, keeping its real date", () => {
    const out = routeSaleRowsForLockedPeriods([row("K")], [cover("K", "LOCKED")], NOW);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toMatchObject({
      periodBucket: "2026-11",
      soldAt: NOW,
      originalSoldAt: OCT,
      netSales: 40,
    });
    expect(out.routed).toEqual([
      { trackedCategoryId: "K", originalPeriod: "2026-10", bookedPeriod: "2026-11", rows: 1 },
    ]);
  });

  it("is per category: a mixed invoice moves only the locked category's rows (case 4)", () => {
    const out = routeSaleRowsForLockedPeriods(
      [row("K"), row("M")],
      [cover("K", "LOCKED"), cover("M", "GENERATED")],
      NOW,
    );
    const k = out.rows.find((r) => r.trackedCategoryId === "K")!;
    const m = out.rows.find((r) => r.trackedCategoryId === "M")!;
    expect(k.periodBucket).toBe("2026-11");
    expect(k.originalSoldAt).toEqual(OCT);
    expect(m.periodBucket).toBe("2026-10");
    expect(m.soldAt).toEqual(OCT);
    expect("originalSoldAt" in m).toBe(false);
    expect(out.routed.map((r) => r.trackedCategoryId)).toEqual(["K"]);
  });

  it("does nothing when no filing covers the rows (case 9: an undated order books now, untouched)", () => {
    const rows = [row("K", NOW, "2026-11")];
    const out = routeSaleRowsForLockedPeriods(rows, [], NOW);
    expect(out.rows).toEqual(rows);
    expect(out.routed).toEqual([]);
  });

  it("does not route a GENERATED month (cases 5 and 13: only LOCKED, via isLockedFiling)", () => {
    const out = routeSaleRowsForLockedPeriods([row("K")], [cover("K", "GENERATED")], NOW);
    expect(out.rows[0].periodBucket).toBe("2026-10");
    expect(out.routed).toEqual([]);
    // another category's LOCKED filing does not move K
    const other = routeSaleRowsForLockedPeriods(
      [row("K")],
      [cover("M", "LOCKED"), cover("K", "GENERATED")],
      NOW,
    );
    expect(other.rows[0].periodBucket).toBe("2026-10");
  });

  it("does not route a FAILED filing, and a LOCKED filing for a different bucket does not match", () => {
    expect(routeSaleRowsForLockedPeriods([row("K")], [cover("K", "FAILED")], NOW).routed).toEqual(
      [],
    );
    expect(
      routeSaleRowsForLockedPeriods([row("K")], [cover("K", "LOCKED", "2026-09")], NOW).routed,
    ).toEqual([]);
  });

  it("is pure: the input rows are not mutated", () => {
    const rows = [row("K")];
    const before = JSON.stringify(rows);
    routeSaleRowsForLockedPeriods(rows, [cover("K", "LOCKED")], NOW);
    expect(JSON.stringify(rows)).toBe(before);
    expect("originalSoldAt" in rows[0]).toBe(false);
  });
});

describe("writeSaleEntries lockedPeriod mode (W-965, unit)", () => {
  const line = {
    invoiceItemId: "ii-1",
    orderItemId: "oi-1",
    trackedCategoryId: "K",
    qty: 4,
    netSales: 40,
    categoryTax: 2,
  };
  function makeDb(covering: Array<{ id: string; status: string }>) {
    const created: any[] = [];
    const audits: any[] = [];
    const db = {
      $queryRaw: jest.fn().mockResolvedValue(
        covering.map((c) => ({
          id: c.id,
          trackedCategoryId: "K",
          periodKey: "2026-10",
          periodStart: new Date("2026-10-01T00:00:00Z"),
          periodEnd: new Date("2026-11-01T00:00:00Z"),
          status: c.status,
        })),
      ),
      regulatedSalesLedger: { createMany: jest.fn(async ({ data }: any) => created.push(...data)) },
      auditLog: { create: jest.fn(async (a: any) => audits.push(a.data)) },
    };
    return { db, created, audits };
  }
  const write = (mode: "REFUSE" | "BOOK_CURRENT", db: any) =>
    new RegulatedLedgerService({} as any).writeSaleEntries({
      tenantId: "t1",
      orderId: "o1",
      invoiceId: "inv-1",
      soldAt: OCT,
      lines: [line],
      db,
      lockedPeriod: mode,
    });

  it("BOOK_CURRENT against a LOCKED month: one routed row and one regulated.sale_booked_late audit row", async () => {
    const { db, created, audits } = makeDb([{ id: "f1", status: "LOCKED" }]);
    expect(await write("BOOK_CURRENT", db)).toBe(1);
    expect(created).toHaveLength(1);
    expect(created[0].periodBucket).not.toBe("2026-10");
    expect(created[0].originalSoldAt).toEqual(OCT);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      tenantId: "t1",
      action: "regulated.sale_booked_late",
      entityType: "Invoice",
      entityId: "inv-1",
      meta: { invoiceId: "inv-1", categoryId: "K", originalPeriod: "2026-10", rows: 1 },
    });
  });

  it("REFUSE against a LOCKED month still throws LEDGER_PERIOD_LOCKED and writes nothing", async () => {
    const { db, created, audits } = makeDb([{ id: "f1", status: "LOCKED" }]);
    await expect(write("REFUSE", db)).rejects.toMatchObject({
      response: { code: "LEDGER_PERIOD_LOCKED" },
    });
    expect(created).toEqual([]);
    expect(audits).toEqual([]);
  });

  it("BOOK_CURRENT against a GENERATED month books the original month, no audit row", async () => {
    const { db, created, audits } = makeDb([{ id: "f1", status: "GENERATED" }]);
    await write("BOOK_CURRENT", db);
    expect(created[0].periodBucket).toBe("2026-10");
    expect(created[0].originalSoldAt).toBeUndefined();
    expect(audits).toEqual([]);
  });
});

describe("W-965 is unreachable while FILING_LOCK_READY is false (pin)", () => {
  const SRC = path.join(__dirname, "..");
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (/\.ts$/.test(e.name) && !/\.(spec|test)\.ts$/.test(e.name)) out.push(p);
    }
    return out;
  };

  it("the switch is false, lockFiling refuses before any read, and nothing but claimFilingLock writes status LOCKED", async () => {
    expect(FILING_LOCK_READY).toBe(false);
    const prisma = new Proxy(
      {},
      {
        get: (_t, key) => {
          throw new Error(`prisma.${String(key)} was read`);
        },
      },
    );
    const svc = new (RegulatedFilingService as any)(prisma, {}, {}, {}, {});
    await expect(svc.lockFiling("f-1", { userId: "u1", reason: "Filed" })).rejects.toMatchObject({
      response: { code: "FILING_LOCK_NOT_READY" },
    });
    const writers = walk(SRC).filter((f) =>
      /data:\s*\{[^}]*status:\s*"LOCKED"/.test(fs.readFileSync(f, "utf8")),
    );
    expect(writers.map((f) => path.relative(SRC, f).split(path.sep).join("/"))).toEqual([
      "regulated/filed-periods.ts",
    ]);
  });

  it("every non-spec writeSaleEntries caller names its lockedPeriod, and only the order bill books current", () => {
    const callers: Array<{ file: string; mode: string }> = [];
    for (const f of walk(SRC)) {
      const src = fs.readFileSync(f, "utf8");
      const re = /\.writeSaleEntries\(\{([\s\S]*?)\n\s*\}\)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        const mode = /lockedPeriod:\s*"(REFUSE|BOOK_CURRENT)"/.exec(m[1]);
        callers.push({
          file: path.relative(SRC, f).split(path.sep).join("/"),
          mode: mode ? mode[1] : "MISSING",
        });
      }
    }
    expect(callers.sort((a, b) => a.file.localeCompare(b.file))).toEqual([
      { file: "estimates/estimates.service.ts", mode: "REFUSE" },
      { file: "invoices/invoices.service.ts", mode: "BOOK_CURRENT" },
      { file: "invoices/invoices.service.ts", mode: "REFUSE" },
      { file: "regulated/regulated-ledger.service.ts", mode: "REFUSE" },
    ]);
  });

  it("a writeSaleEntries call without lockedPeriod does not compile (case 12; enforced by check-types)", () => {
    const svc = new RegulatedLedgerService({} as any);
    const args = { tenantId: null, orderId: null, invoiceId: "i", soldAt: NOW, lines: [], db: {} };
    // @ts-expect-error lockedPeriod is a required parameter: no default, the compiler finds every caller
    const bad = () => svc.writeSaleEntries(args);
    expect(typeof bad).toBe("function");
  });
});
