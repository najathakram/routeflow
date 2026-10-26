/**
 * SA-999 (row 562 S1): the API's copy of `stockCountSeedState` (packages/types/api/stock-count.ts, the one web and
 * mobile import). The API may only `import type` from `@routeflow/types` (its entry is raw TypeScript and
 * `nest build` does not bundle it: `no-runtime-workspace-imports.spec.ts`), so the predicate is mirrored here and
 * `stock-count-seed-state.spec.ts` pins the two to the same answer, throws included, over every shape of row.
 * Change both together; the spec goes red on the first difference.
 *
 *   "legacy"   planned is NULL (and completedAt is NULL): nothing seeded this count in batches.
 *   "complete" completedAt is set (planned is set).
 *   "seeding"  planned is set and completedAt is NULL: the seed runs, or died. The commit is 409 STOCK_COUNT_SEEDING.
 * Anything else THROWS (the table's CHECKs make it impossible): completedAt without planned, a negative or
 * non-integer planned count.
 */
export type StockCountSeedState = "legacy" | "complete" | "seeding";

export interface StockCountSeedColumns {
  seedPlannedLines: number | null;
  seedCompletedAt: Date | string | null;
}

export function stockCountSeedState(row: StockCountSeedColumns): StockCountSeedState {
  const { seedPlannedLines: planned, seedCompletedAt: completedAt } = row;
  if (planned !== null && (!Number.isInteger(planned) || planned < 0)) {
    throw new Error(
      `stockCountSeedState: seedPlannedLines must be a non-negative integer, got ${planned}`,
    );
  }
  if (planned === null) {
    if (completedAt !== null) {
      throw new Error("stockCountSeedState: seedCompletedAt is set without seedPlannedLines");
    }
    return "legacy";
  }
  return completedAt !== null ? "complete" : "seeding";
}
