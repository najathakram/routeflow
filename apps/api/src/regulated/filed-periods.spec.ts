import * as fs from "fs";
import * as path from "path";
import {
  anyLockedFiling,
  claimFilingLock,
  filedThroughOf,
  findFiledPeriod,
  findGeneratedTobaccoReport,
  findLockedFiling,
  lockedFilingsCovering,
  updateFilingUnlessLocked,
  type FiledCache,
} from "./filed-periods";

/**
 * SA-819 MUST 1: the three "filed" predicates live in one module and their tiers are deliberately different.
 * This spec pins each tier's statuses (the query it sends, not a mock's answer) and, structurally, that no
 * `regulatedFiling` / `tobaccoReport` status filter exists anywhere else in `src`.
 */

describe("tier 1 - lockedFilingsCovering: LOCKED only, per bucket", () => {
  it("asks for status LOCKED and nothing else", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    await lockedFilingsCovering({ regulatedFiling: { findMany } }, [
      { trackedCategoryId: "c1", periodBucket: "2026-08" },
    ]);
    expect(findMany).toHaveBeenCalledWith({
      where: { trackedCategoryId: { in: ["c1"] }, status: "LOCKED" },
    });
  });

  it("covers a bucket only inside [periodStart, periodEnd) of the same category", async () => {
    const filing = {
      id: "f1",
      trackedCategoryId: "c1",
      periodKey: "2026-08",
      periodStart: new Date("2026-08-01T00:00:00Z"),
      periodEnd: new Date("2026-09-01T00:00:00Z"),
      status: "LOCKED",
    };
    const db = { regulatedFiling: { findMany: jest.fn().mockResolvedValue([filing]) } };
    const hit = (b: string, c = "c1") =>
      lockedFilingsCovering(db, [{ trackedCategoryId: c, periodBucket: b }]);
    expect(await hit("2026-08")).toHaveLength(1);
    expect(await hit("2026-09")).toHaveLength(0);
    expect(await hit("2026-07")).toHaveLength(0);
    expect(await hit("2026-08", "c2")).toHaveLength(0);
  });

  it("the helpers on the same tier send LOCKED too", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    await anyLockedFiling({ regulatedFiling: { findMany } });
    expect(findMany).toHaveBeenCalledWith({ where: { status: "LOCKED" }, take: 1 });
    const findFirst = jest.fn().mockResolvedValue(null);
    await findLockedFiling(
      { regulatedFiling: { findFirst } },
      { trackedCategoryId: "c", periodKey: "k" },
    );
    expect(findFirst).toHaveBeenCalledWith({
      where: { trackedCategoryId: "c", periodKey: "k", status: "LOCKED" },
    });
  });

  it("the lock transition claims only a GENERATED row, and a regeneration never touches a LOCKED one", async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    await claimFilingLock(
      { regulatedFiling: { updateMany } },
      { id: "f", lockedById: "u", reason: "r" },
    );
    expect(updateMany.mock.calls[0][0].where).toEqual({ id: "f", status: "GENERATED" });
    expect(updateMany.mock.calls[0][0].data.status).toBe("LOCKED");
    const update = jest.fn().mockResolvedValue({});
    await updateFilingUnlessLocked({ regulatedFiling: { update } }, "f", { totals: 1 });
    expect(update.mock.calls[0][0].where).toEqual({ id: "f", status: { not: "LOCKED" } });
  });
});

describe("tier 2 - filedThroughOf: GENERATED | LOCKED (and a non-FAILED tobacco report), cumulative through", () => {
  const product = {
    id: "p",
    isTobacco: true,
    trackedCategoryId: "c1",
    trackedCategory: { name: "Vapes" },
  };

  it("sends GENERATED+LOCKED for the category and not-FAILED for the tobacco report", async () => {
    const regulatedFiling = { findFirst: jest.fn().mockResolvedValue(null) };
    const tobaccoReport = { findFirst: jest.fn().mockResolvedValue(null) };
    await filedThroughOf(
      { regulatedFiling, tobaccoReport },
      "t1",
      product,
      new Map() as FiledCache,
    );
    expect(regulatedFiling.findFirst.mock.calls[0][0].where).toEqual({
      tenantId: "t1",
      trackedCategoryId: "c1",
      status: { in: ["GENERATED", "LOCKED"] },
    });
    expect(tobaccoReport.findFirst.mock.calls[0][0].where).toEqual({
      tenantId: "t1",
      status: { not: "FAILED" },
    });
  });

  it("is cumulative: the LATEST close wins, a tie keeps tobacco", async () => {
    const regulatedFiling = {
      findFirst: jest.fn().mockResolvedValue({
        periodStart: new Date("2026-08-01T00:00:00Z"),
        periodEnd: new Date("2026-09-01T00:00:00Z"),
        periodKey: "2026-08",
        cadence: "MONTHLY",
      }),
    };
    const tobaccoReport = {
      findFirst: jest.fn().mockResolvedValue({
        periodStart: new Date("2026-09-01T00:00:00Z"),
        periodEnd: new Date("2026-09-30T23:59:59.999Z"),
      }),
    };
    const r = await filedThroughOf({ regulatedFiling, tobaccoReport }, "t1", product, new Map());
    expect(r?.filedFor).toBe("Tobacco");
    expect(r?.label).toBe("September 2026");
  });
});

describe("tier 3 - findFiledPeriod: GENERATED | LOCKED, per bucket (a label, never a refusal)", () => {
  it("sends GENERATED+LOCKED for the bucket's month", async () => {
    const findFirst = jest.fn().mockResolvedValue({
      periodKey: "2026-08",
      status: "GENERATED",
      trackedCategoryId: "c1",
    });
    const r = await findFiledPeriod({ regulatedFiling: { findFirst } }, ["c1"], "2026-08");
    expect(findFirst.mock.calls[0][0].where).toEqual({
      trackedCategoryId: { in: ["c1"] },
      periodStart: { lte: new Date("2026-08-01T00:00:00.000Z") },
      periodEnd: { gt: new Date("2026-08-01T00:00:00.000Z") },
      status: { in: ["GENERATED", "LOCKED"] },
    });
    expect(r).toEqual({ periodKey: "2026-08", status: "GENERATED", trackedCategoryId: "c1" });
  });

  it("reads nothing for no categories", async () => {
    const findFirst = jest.fn();
    expect(await findFiledPeriod({ regulatedFiling: { findFirst } }, [], "2026-08")).toBeNull();
    expect(findFirst).not.toHaveBeenCalled();
  });
});

describe("the legacy tobacco cron probe", () => {
  it("looks for a GENERATED report of the month", async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    await findGeneratedTobaccoReport({ tobaccoReport: { findFirst } }, { year: 2026, month: 8 });
    expect(findFirst).toHaveBeenCalledWith({
      where: { periodYear: 2026, periodMonth: 8, status: "GENERATED" },
    });
  });
});

describe("structural pin: no regulatedFiling / tobaccoReport status FILTER outside filed-periods.ts", () => {
  const SRC = path.join(__dirname, "..");
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "node_modules") walk(p, out);
      } else if (/\.tsx?$/.test(e.name) && !/\.(spec|test)\.tsx?$/.test(e.name)) out.push(p);
    }
    return out;
  };

  /** A `status` constraint inside a `where` of a filing / report query, or a `status` the query selects on. */
  const FILTER =
    /\bstatus\s*:\s*(\{\s*(?:in|not|notIn|equals)\b|"(?:GENERATED|LOCKED|FAILED)"\s*[,}\n])/;

  it('finds none (a data write `status: "X" as const` is not a filter)', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (path.basename(file) === "filed-periods.ts") continue;
      const rel = path.relative(SRC, file);
      if (rel.startsWith(`testing${path.sep}`) || rel.includes(`${path.sep}testing${path.sep}`))
        continue;
      const text = fs.readFileSync(file, "utf8");
      if (!/\b(regulatedFiling|tobaccoReport)\b/.test(text)) continue;
      text.split("\n").forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        if (/\bas const\b/.test(line)) return; // a data write
        if (FILTER.test(line)) offenders.push(`${rel}:${i + 1} ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("the pattern really matches the shapes it exists to catch", () => {
    for (const bad of [
      'where: { status: "LOCKED" },',
      'status: { in: ["GENERATED", "LOCKED"] },',
      'where: { tenantId, status: { not: "FAILED" } },',
    ])
      expect(FILTER.test(bad)).toBe(true);
    expect(FILTER.test('status: "GENERATED" as const,')).toBe(false); // a data write
  });
});
