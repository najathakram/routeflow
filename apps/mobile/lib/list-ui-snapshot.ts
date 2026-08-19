/**
 * Pure state machine behind restoring a list screen's search, filters and
 * scroll position across a remount — a drill-in/back, a tab switch (the
 * deployed app is the Expo web export, where inactive tabs go `display:none`
 * rather than unmount), or `popToTop` on the tab bar.
 *
 * Deliberately in-memory only (paired with `store/listUiStore.ts`): a cold
 * reload restoring nothing is BY DESIGN, not a gap — nobody expects search
 * state to survive killing the app, and persisting it would mean writing to
 * disk on every keystroke/scroll frame for no real benefit.
 */

export interface ListUiSnapshot<TFilters = Record<string, unknown>> {
  search: string;
  filters: TFilters;
  scrollOffset: number;
  /** How many pages were loaded when this was saved — the page-chase's target. */
  pageCount: number;
  /** `Date.now()` at save time. */
  savedAt: number;
}

/** A snapshot older than this is treated as if it never existed. */
export const LIST_UI_SNAPSHOT_TTL_MS = 15 * 60 * 1000;

/** The page-chase never fetches past this many pages while restoring. */
export const MAX_RESTORE_PAGES = 10;

/**
 * ...or this many rows, whichever comes first. A search-narrowed catalog can
 * report a `pageCount` of several pages at a small page size — the row cap is
 * what actually bounds the chase's network + render cost for that case.
 */
export const MAX_RESTORE_ROWS = 150;

/** True when `snapshot` exists and is within the TTL as of `now`. */
export function isSnapshotFresh<TFilters>(
  snapshot: ListUiSnapshot<TFilters> | null | undefined,
  now: number = Date.now(),
): snapshot is ListUiSnapshot<TFilters> {
  if (!snapshot) return false;
  return now - snapshot.savedAt < LIST_UI_SNAPSHOT_TTL_MS;
}

/**
 * True when the snapshot's search term or any filter was active. Those result
 * sets are already short (server-filtered), so the bounded page-chase is
 * pointless work — the first page is enough to contain wherever the operator
 * had scrolled to.
 */
export function snapshotHasSearchOrFilter<TFilters extends object>(
  snapshot: Pick<ListUiSnapshot<TFilters>, "search" | "filters">,
): boolean {
  if (snapshot.search.trim().length > 0) return true;
  return Object.values(snapshot.filters).some((v) => v !== undefined && v !== null && v !== "");
}

export interface PageChaseState {
  pagesLoaded: number;
  rowsLoaded: number;
}

/**
 * Should the restore's page-chase fetch one more page? Bounded by BOTH the
 * page count and the row count — whichever is hit first stops the chase —
 * and never fetches past the page the snapshot actually saw.
 */
export function shouldContinuePageChase(state: PageChaseState, targetPageCount: number): boolean {
  if (state.pagesLoaded >= targetPageCount) return false;
  if (state.pagesLoaded >= MAX_RESTORE_PAGES) return false;
  if (state.rowsLoaded >= MAX_RESTORE_ROWS) return false;
  return true;
}

// ─── One-shot scroll restore ───────────────────────────────────────────────

export interface ScrollRestoreState {
  pendingOffset: number | null;
}

export const NO_PENDING_SCROLL_RESTORE: ScrollRestoreState = { pendingOffset: null };

/** Queue an offset to restore to. A non-positive offset queues nothing. */
export function queueScrollRestore(offset: number): ScrollRestoreState {
  return offset > 0 ? { pendingOffset: offset } : NO_PENDING_SCROLL_RESTORE;
}

/**
 * One-shot: returns the offset to apply (or `null` when nothing is queued)
 * and the next state with it cleared. Calling this again on the returned
 * state always yields `null` — a fired restore never re-fires on its own.
 * Re-arm it with {@link queueScrollRestore} (the products screen does this on
 * every `useFocusEffect`, which covers the `display:none` tab case where the
 * scroll position resets but nothing else about the list changed).
 */
export function stepScrollRestore(state: ScrollRestoreState): {
  offset: number | null;
  state: ScrollRestoreState;
} {
  if (state.pendingOffset == null) return { offset: null, state };
  return { offset: state.pendingOffset, state: NO_PENDING_SCROLL_RESTORE };
}
