/**
 * SA-999 (row 562 S1): the seed-state of a durable stock count, ONE predicate for web and mobile (the API keeps
 * a pinned copy: `apps/api/src/common/stock-count-seed-state.ts`, because it may only `import type` from here).
 *
 * A count the batched seeder (`apps/api/src/inventory/stock-count-seed.ts`) fills line by line carries two
 * nullable columns on `StockCountSession`:
 *   - `seedPlannedLines`: how many lines the seed will write, set in the same create that makes the session OPEN;
 *   - `seedCompletedAt`: stamped by the final batch (inside its own transaction), or in the create of a 0-line seed.
 *
 * The three states:
 *   - "legacy":   planned is NULL. Nothing seeded this count in batches (a person's own count, or a session from
 *                 before the columns). It commits as it always did.
 *   - "complete": completedAt is set (so planned is set). Every planned line was written.
 *   - "seeding":  planned is set and completedAt is NULL. The seed is running, or it died: the commit answers
 *                 409 STOCK_COUNT_SEEDING until a completion is stamped, and the count can be discarded.
 * Anything else (completedAt without planned, a negative or non-integer planned count) THROWS: the table's CHECKs
 * make those rows impossible, so seeing one is a bug to surface, never a state to guess.
 */

export type StockCountSeedState = "legacy" | "complete" | "seeding";

/** The two columns, as the api reads them (Date) or the wire carries them (ISO string). */
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

/**
 * `GET /inventory/stock-counts/:id/progress` (a few hundred bytes the page polls while a seed or a commit
 * runs). `seedState` is `stockCountSeedState` of the session; `seeded` is the number of lines the count has now
 * and `planned` its `seedPlannedLines` (null for a legacy count). The web shows "Preparing count… {seeded} of
 * {planned}" while `seedState` is "seeding".
 */
export interface StockCountProgressResponse {
  status: "OPEN" | "REVIEW" | "COMMITTED" | "DISCARDED";
  lineCount: number;
  commit: { committedLines: number; totalLines: number } | null;
  seedState: StockCountSeedState;
  seeded: number;
  planned: number | null;
}
