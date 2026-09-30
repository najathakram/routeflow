import {
  RESTRICTION_STATUSES,
  restrictionStatus,
  statusWhere,
} from "./selling-restrictions-admin.service";

/**
 * Two pins. (1) The API-side status list is set-equal to the shared one (the API never imports the
 * workspace package at runtime, so it mirrors it — L-072). (2) `statusWhere` — the SQL used to
 * filter BEFORE the read cap — selects exactly the rows `restrictionStatus` puts in that stage, over
 * every window boundary. A tiny evaluator for the operators `statusWhere` uses stands in for Prisma.
 */
const DAY = 86_400_000;
const NOW = new Date("2026-09-20T12:00:00Z");
const at = (ms: number) => new Date(NOW.getTime() + ms);

function matches(row: Record<string, any>, where: Record<string, any>): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === "AND") return (v as any[]).every((w) => matches(row, w));
    if (k === "OR") return (v as any[]).some((w) => matches(row, w));
    const cell = row[k] as Date | null;
    if (v === null) return cell === null;
    if ("gt" in v) return cell !== null && cell.getTime() > v.gt.getTime();
    if ("lte" in v) return cell !== null && cell.getTime() <= v.lte.getTime();
    throw new Error(`unsupported operator on ${k}`);
  });
}

describe("restriction status parity", () => {
  it("the API mirror is set-equal to the shared RESTRICTION_STATUS_VALUES", () => {
    const shared = (require("@routeflow/types") as { RESTRICTION_STATUS_VALUES: string[] })
      .RESTRICTION_STATUS_VALUES;
    expect([...RESTRICTION_STATUSES].sort()).toEqual([...shared].sort());
  });

  const froms = [at(-DAY), at(0), at(DAY)];
  const tos = [null, at(-DAY), at(0), at(DAY)];
  const lifts = [null, at(-DAY), at(-1), at(0), at(DAY)];
  const rows = froms.flatMap((effectiveFrom) =>
    tos.flatMap((effectiveTo) =>
      lifts.map((liftedAt) => ({ effectiveFrom, effectiveTo, liftedAt })),
    ),
  );

  it.each(RESTRICTION_STATUSES)(
    "%s: SQL twin and function agree on every boundary row",
    (status) => {
      let seen = 0;
      for (const row of rows) {
        const inSql = matches(row, statusWhere(status, NOW));
        expect(inSql).toBe(restrictionStatus(row as any, NOW) === status);
        if (inSql) seen++;
      }
      expect(seen).toBeGreaterThan(0); // every stage is actually reachable in the grid
    },
  );

  it("the four stages partition the grid (no row in two stages, none in none)", () => {
    for (const row of rows) {
      const hits = RESTRICTION_STATUSES.filter((s) => matches(row, statusWhere(s, NOW)));
      expect(hits).toHaveLength(1);
    }
  });
});
