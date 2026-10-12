/**
 * Row 372 MF3 (web). After the stale notice's Reload the page holds FRESH server lines, but the editor's own
 * `editItems` were seeded from the lines it LOADED. Diffing the two would re-send every field another writer
 * changed with the editor's stale value and silently revert it. So an edit is judged against the lines captured
 * at edit-open (what the user actually saw), and Reload REBASES, per FIELD (a three-way merge of the edit row,
 * the edit-open line and the fresh line): a field the user did not change takes the fresh value; a field they
 * changed keeps their value. Lines another writer removed are dropped (an id left in `pendingDeletes` or
 * `editItems` for a vanished line would 409 CONCURRENT_UPDATE on every save); lines another writer added (or
 * revived) appear. Pure and generic over the page's own `buildEditItemFromLine` (passed in: this module must
 * not import the page).
 */
type Line = { id: string; status?: string | null };
type Edit = { id: string; isNew?: boolean };

export interface RebaseDeps<E extends Edit, L extends Line> {
  /** The page's seed of an edit row from a stored line. */
  seed: (line: L) => E;
}

const isLive = (l: Line) => l.status !== "CANCELLED";
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Three-way merge of ONE edit row: take `fresh` wherever the row still equals `base`, else keep the edit. */
function mergeRow<E extends Edit>(edit: E, base: E, fresh: E): E {
  const out: Record<string, unknown> = { ...fresh };
  for (const k of Object.keys(edit)) {
    const e = (edit as Record<string, unknown>)[k];
    if (!same(e, (base as Record<string, unknown>)[k])) out[k] = e; // the user's own change wins
  }
  return out as unknown as E;
}

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
    const baseLine = baseById.get(e.id);
    out.push(
      baseLine ? mergeRow(e, deps.seed(baseLine), deps.seed(freshLine)) : deps.seed(freshLine),
    );
  }
  // a line another writer ADDED (or revived from CANCELLED) since edit-open: visible, untouched
  for (const [id, line] of live) {
    const b = baseById.get(id);
    if (!seen.has(id) && (!b || !isLive(b))) out.push(deps.seed(line));
  }
  return { items: out, dropped };
}

/** A queued DELETE for a line that no longer exists would 409 on every save: drop it. */
export function rebasePendingDeletes<L extends Line>(ids: string[], fresh: L[]): string[] {
  const live = new Set(fresh.filter(isLive).map((l) => l.id));
  return ids.filter((id) => live.has(id));
}
