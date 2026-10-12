/**
 * Row 372 MF3 (web). After the stale notice's Reload the page holds FRESH server lines, but the editor's own
 * `editItems` were seeded from the lines it LOADED. Diffing the two would re-send every untouched line another
 * writer changed with its stale qty/price and silently revert them. So an edit is judged against the lines
 * captured at edit-open (what the user actually saw), and Reload REBASES: lines the user did not touch are
 * re-seeded from fresh data; lines they touched keep their edit; lines another writer removed are dropped (an
 * id left in `pendingDeletes` or `editItems` for a vanished line would 409 CONCURRENT_UPDATE on every save);
 * lines another writer added appear. Pure and generic over the page's own `buildItemUpdates` /
 * `buildEditItemFromLine` (passed in: this module must not import the page).
 */
type Line = { id: string; status?: string | null };
type Edit = { id: string; isNew?: boolean };

export interface RebaseDeps<E extends Edit, L extends Line> {
  /** True when `edited` differs from `orig` in anything a save would send (the page's own diff). */
  touched: (edited: E, orig: L) => boolean;
  /** The page's seed of an edit row from a stored line. */
  seed: (line: L) => E;
}

const isLive = (l: Line) => l.status !== "CANCELLED";

export function rebaseEditItems<E extends Edit, L extends Line>(
  items: E[],
  base: L[],
  fresh: L[],
  deps: RebaseDeps<E, L>,
): { items: E[]; dropped: number } {
  const live = new Map(fresh.filter(isLive).map((l) => [l.id, l]));
  const baseById = new Map(base.map((l) => [l.id, l]));
  const out: E[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const e of items) {
    if (e.isNew) {
      out.push(e); // a line the user added: not on the server yet
      continue;
    }
    seen.add(e.id);
    const freshLine = live.get(e.id);
    if (!freshLine) {
      dropped += 1; // removed or cancelled by someone else
      continue;
    }
    const orig = baseById.get(e.id);
    out.push(orig && deps.touched(e, orig) ? e : deps.seed(freshLine));
  }
  // a line another writer ADDED since edit-open: visible, untouched
  for (const [id, line] of live) if (!seen.has(id) && !baseById.has(id)) out.push(deps.seed(line));
  return { items: out, dropped };
}

/** A queued DELETE for a line that no longer exists would 409 on every save: drop it. */
export function rebasePendingDeletes<L extends Line>(ids: string[], fresh: L[]): string[] {
  const live = new Set(fresh.filter(isLive).map((l) => l.id));
  return ids.filter((id) => live.has(id));
}
