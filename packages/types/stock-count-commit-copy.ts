import { API_ERROR_CODES } from "./api/error-codes";

/**
 * SA-767 L-2.4 D (r-note 4 D, G7): the copy of a durable stock count's commit, by STATE. ONE
 * implementation for web and mobile (`apps/web/components/inventory/StockCountTab.tsx`,
 * `apps/mobile/app/(operator)/products/stock-count/[id].tsx`); the numbers come from structured body
 * fields (`committedLines` / `totalLines`), never parsed out of a message.
 *
 * The server answers an unfinished commit in two places: a 503 `LOCK_UNAVAILABLE` raised during the
 * commit carries `{ committedLines, totalLines }`, and the session detail carries
 * `commit: { committedLines, totalLines } | null` while a commit is unfinished.
 */

/** A 503 during a commit that already saved part of the count. */
export const STOCK_COUNT_PARTLY_SAVED_COPY = "Partly saved — commit again to finish";
/** A 503 during a commit that saved nothing. */
export const STOCK_COUNT_NOTHING_SAVED_COPY = "Nothing was saved — try again";
/** A second commit / an edit while a commit is running (409 STOCK_COUNT_COMMITTING). */
export const STOCK_COUNT_COMMITTING_COPY = "This count is being saved. Try again in a moment.";
/** The button that skips permanently uncountable lines and commits the rest (partly saved counts only). */
export const STOCK_COUNT_FINISH_WITH_SKIPS_LABEL = "Finish with skips";
/** Under the list of skipped products. */
export const STOCK_COUNT_RECOUNT_COPY = "Recount these in a new session";
/** Why the commit cannot finish without skipping (permanent: a family, a deleted product). */
export const STOCK_COUNT_PERMANENT_COPY =
  "Some counted products can't be saved. Finish with skips to save the rest.";

/**
 * SA-767 r-note 5 SA-3 (one OPEN count per product): a commit refused because some of its products are
 * also on another open count (a legacy overlap). The operator removes them from one of the counts.
 */
export const STOCK_COUNT_OVERLAP_COMMIT_COPY =
  "Some products are also in another open count. Remove them from one count, then commit again.";

/** "Already being counted in <count>" - an add refused by 409 PRODUCT_IN_OPEN_COUNT. */
export function productInOpenCountCopy(sessionName?: string | null): string {
  const name = typeof sessionName === "string" ? sessionName.trim() : "";
  return `Already being counted in ${name || "another count"}`;
}

export interface StockCountCommitProgress {
  committedLines: number;
  totalLines: number;
}

/** "Saving count… N of M" - while a commit runs, or while the session detail says one is unfinished. */
export function stockCountSavingCopy(p: StockCountCommitProgress): string {
  return `Saving count… ${p.committedLines} of ${p.totalLines}`;
}

export interface StockCountSkippedProductView {
  productId: string;
  name?: string;
  reason: string;
}

/**
 * A line add refused by another open count (409 PRODUCT_IN_OPEN_COUNT, read defensively from an
 * axios-shaped error): the sentence to show and the id of the count that has the product, for the
 * "open that count" link. Null for any other failure.
 */
export function stockCountProductInOpenCount(
  err: unknown,
): { copy: string; sessionId: string | null } | null {
  const res = (err as { response?: { status?: unknown; data?: unknown } } | null)?.response;
  const data = (res?.data ?? {}) as Record<string, unknown>;
  if (res?.status !== 409 || data.code !== API_ERROR_CODES.PRODUCT_IN_OPEN_COUNT) return null;
  return {
    copy: productInOpenCountCopy(typeof data.sessionName === "string" ? data.sessionName : null),
    sessionId: typeof data.sessionId === "string" ? data.sessionId : null,
  };
}

/** What a failed commit means for the screen. */
export interface StockCountCommitFailure {
  /** The sentence to show (a toast / notice). Never the server's message. */
  copy: string;
  /** The commit hit a product that can never be counted: only "Finish with skips" can finish it. */
  permanent: boolean;
}

const numberOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/**
 * Classify a failed `POST /inventory/stock-counts/:id/commit` (an axios-shaped error, read
 * defensively). Returns null for a failure the screen has no count-specific copy for - the caller then
 * keeps its generic message.
 *  - 503 LOCK_UNAVAILABLE: "Partly saved" when `committedLines > 0`, else "Nothing was saved".
 *  - 409 STOCK_COUNT_COMMITTING: the "being saved" sentence.
 *  - 409 PRODUCT_IN_OPEN_COUNT: the legacy-overlap sentence (products also on another open count).
 *  - 400 FAMILY_NOT_SELLABLE / 404 with `missingProductIds`: a permanent refusal.
 */
export function stockCountCommitFailure(err: unknown): StockCountCommitFailure | null {
  const res = (err as { response?: { status?: unknown; data?: unknown } } | null)?.response;
  const status = res?.status;
  const data = (res?.data ?? {}) as Record<string, unknown>;
  if (status === 503 && data.code === API_ERROR_CODES.LOCK_UNAVAILABLE) {
    const done = numberOrNull(data.committedLines) ?? 0;
    return {
      copy: done > 0 ? STOCK_COUNT_PARTLY_SAVED_COPY : STOCK_COUNT_NOTHING_SAVED_COPY,
      permanent: false,
    };
  }
  if (status === 409 && data.code === API_ERROR_CODES.STOCK_COUNT_COMMITTING) {
    return { copy: STOCK_COUNT_COMMITTING_COPY, permanent: false };
  }
  if (status === 409 && data.code === API_ERROR_CODES.PRODUCT_IN_OPEN_COUNT) {
    return { copy: STOCK_COUNT_OVERLAP_COMMIT_COPY, permanent: false };
  }
  if (
    (status === 400 && data.code === API_ERROR_CODES.FAMILY_NOT_SELLABLE) ||
    (status === 404 && Array.isArray(data.missingProductIds))
  ) {
    return { copy: STOCK_COUNT_PERMANENT_COPY, permanent: true };
  }
  return null;
}
