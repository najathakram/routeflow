/**
 * The products list restore must expire a stale snapshot, skip the bounded
 * page-chase for a search/filtered (already-short) result set, cap the chase
 * by both pages and rows, and fire the scroll restore exactly once per arm.
 */
import {
  isSnapshotFresh,
  LIST_UI_SNAPSHOT_TTL_MS,
  MAX_RESTORE_PAGES,
  MAX_RESTORE_ROWS,
  NO_PENDING_SCROLL_RESTORE,
  queueScrollRestore,
  shouldContinuePageChase,
  snapshotHasSearchOrFilter,
  stepScrollRestore,
  type ListUiSnapshot,
  type ScrollRestoreState,
} from "../lib/list-ui-snapshot";

function makeSnapshot(
  overrides: Partial<ListUiSnapshot<Record<string, unknown>>> = {},
): ListUiSnapshot<Record<string, unknown>> {
  return {
    search: "",
    filters: {},
    scrollOffset: 0,
    pageCount: 1,
    savedAt: Date.now(),
    ...overrides,
  };
}

describe("isSnapshotFresh", () => {
  it("is false for a missing snapshot", () => {
    expect(isSnapshotFresh(null)).toBe(false);
    expect(isSnapshotFresh(undefined)).toBe(false);
  });

  it("is true just inside the 15-minute TTL", () => {
    const now = 1_000_000_000;
    const snapshot = makeSnapshot({ savedAt: now - (LIST_UI_SNAPSHOT_TTL_MS - 1) });
    expect(isSnapshotFresh(snapshot, now)).toBe(true);
  });

  it("is false once the TTL has fully elapsed", () => {
    const now = 1_000_000_000;
    const snapshot = makeSnapshot({ savedAt: now - LIST_UI_SNAPSHOT_TTL_MS });
    expect(isSnapshotFresh(snapshot, now)).toBe(false);
  });

  it("is false for a snapshot well past the TTL", () => {
    const now = 1_000_000_000;
    const snapshot = makeSnapshot({ savedAt: now - LIST_UI_SNAPSHOT_TTL_MS - 60_000 });
    expect(isSnapshotFresh(snapshot, now)).toBe(false);
  });
});

describe("snapshotHasSearchOrFilter", () => {
  it("is false with no search and no active filter", () => {
    expect(snapshotHasSearchOrFilter(makeSnapshot())).toBe(false);
  });

  it("is false when filters are present but all undefined (the 'All' state)", () => {
    const snapshot = makeSnapshot({ filters: { stockStatus: undefined, section: undefined } });
    expect(snapshotHasSearchOrFilter(snapshot)).toBe(false);
  });

  it("is true when a search term is set", () => {
    expect(snapshotHasSearchOrFilter(makeSnapshot({ search: "  bananas " }))).toBe(true);
  });

  it("is false when the search term is only whitespace", () => {
    expect(snapshotHasSearchOrFilter(makeSnapshot({ search: "   " }))).toBe(false);
  });

  it("is true when any filter has a value", () => {
    const snapshot = makeSnapshot({ filters: { stockStatus: "LOW" } });
    expect(snapshotHasSearchOrFilter(snapshot)).toBe(true);
  });
});

describe("shouldContinuePageChase", () => {
  it("continues while under both the target and the caps", () => {
    expect(shouldContinuePageChase({ pagesLoaded: 1, rowsLoaded: 40 }, 5)).toBe(true);
  });

  it("stops once the target page count is reached", () => {
    expect(shouldContinuePageChase({ pagesLoaded: 5, rowsLoaded: 40 }, 5)).toBe(false);
  });

  it("stops at MAX_RESTORE_PAGES even if the target is higher", () => {
    expect(shouldContinuePageChase({ pagesLoaded: MAX_RESTORE_PAGES, rowsLoaded: 1 }, 999)).toBe(
      false,
    );
  });

  it("stops at MAX_RESTORE_ROWS even with pages left under the target", () => {
    expect(shouldContinuePageChase({ pagesLoaded: 1, rowsLoaded: MAX_RESTORE_ROWS }, 10)).toBe(
      false,
    );
  });

  it("stops just short of MAX_RESTORE_ROWS but continues one row before the cap", () => {
    expect(shouldContinuePageChase({ pagesLoaded: 1, rowsLoaded: MAX_RESTORE_ROWS - 1 }, 10)).toBe(
      true,
    );
  });
});

describe("stepScrollRestore (one-shot)", () => {
  it("emits nothing when nothing is queued", () => {
    const out = stepScrollRestore(NO_PENDING_SCROLL_RESTORE);
    expect(out.offset).toBeNull();
    expect(out.state).toBe(NO_PENDING_SCROLL_RESTORE);
  });

  it("emits the queued offset and clears it", () => {
    const queued = queueScrollRestore(420);
    const out = stepScrollRestore(queued);
    expect(out.offset).toBe(420);
    expect(out.state).toEqual(NO_PENDING_SCROLL_RESTORE);
  });

  it("refuses to fire twice on the same state", () => {
    const queued = queueScrollRestore(420);
    const first = stepScrollRestore(queued);
    const second = stepScrollRestore(first.state);
    expect(second.offset).toBeNull();
  });

  it("queueing a non-positive offset queues nothing", () => {
    expect(queueScrollRestore(0)).toEqual(NO_PENDING_SCROLL_RESTORE);
    expect(queueScrollRestore(-10)).toEqual(NO_PENDING_SCROLL_RESTORE);
  });

  it("re-arms after a completed restore when queued again (the useFocusEffect case)", () => {
    const first = stepScrollRestore(queueScrollRestore(200));
    expect(first.offset).toBe(200);

    const rearmed: ScrollRestoreState = queueScrollRestore(200);
    const second = stepScrollRestore(rearmed);
    expect(second.offset).toBe(200);
  });
});
