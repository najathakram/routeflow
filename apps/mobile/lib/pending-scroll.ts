/**
 * "Scroll this row into view once it actually exists" for the sale builders.
 *
 * Cached per-row Y offsets go stale the moment the rendered list is swapped
 * (clearing the search re-renders the whole catalog), and a just-scanned row is
 * frequently absent for a render or two while its product refetches. This keeps
 * the request as an id — resolved against whatever the list renders THIS pass —
 * so the target survives the refetch window and resolves to a live index.
 */
export interface PendingScrollState {
  targetId: string | null;
}

export const NO_PENDING_SCROLL: PendingScrollState = { targetId: null };

/** Queue a scroll. A new id supersedes a still-pending one. */
export function requestScroll(state: PendingScrollState, id: string): PendingScrollState {
  return state.targetId === id ? state : { targetId: id };
}

/**
 * Resolve the pending target against the ids the list currently renders.
 * Emits the index and clears exactly once; while the target is absent it stays
 * pending and emits null. A cleared target never re-emits without a new
 * {@link requestScroll}.
 */
export function stepPendingScroll(
  state: PendingScrollState,
  visibleIds: readonly string[],
): { state: PendingScrollState; scrollIndex: number | null } {
  const target = state.targetId;
  if (target == null) return { state, scrollIndex: null };
  const index = visibleIds.indexOf(target);
  if (index < 0) return { state, scrollIndex: null };
  return { state: NO_PENDING_SCROLL, scrollIndex: index };
}
