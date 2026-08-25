const KEY = "rf-trip-draft-v1";
const TTL_MS = 30 * 60 * 1000;

export interface TripDraft {
  orderIds: string[];
  savedAt: number;
}

export function saveTripDraft(orderIds: string[]): void {
  try {
    sessionStorage.setItem(
      KEY,
      JSON.stringify({ orderIds, savedAt: Date.now() } satisfies TripDraft),
    );
  } catch {
    /* storage unavailable — builder will show its empty state */
  }
}

export function loadTripDraft(): TripDraft | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const draft = JSON.parse(raw) as TripDraft;
    if (
      !Array.isArray(draft.orderIds) ||
      draft.orderIds.length === 0 ||
      Date.now() - draft.savedAt > TTL_MS
    ) {
      sessionStorage.removeItem(KEY);
      return null;
    }
    return draft;
  } catch {
    return null;
  }
}

export function clearTripDraft(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* noop */
  }
}
