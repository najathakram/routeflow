/**
 * Row 372 MF3 (web). After the stale notice's Reload the page holds FRESH server lines, but the editor's own
 * `editItems` were seeded from the lines it LOADED. Diffing the two would re-send every field another writer
 * changed with the editor's stale value and silently revert it. So an edit is judged against the lines captured
 * at edit-open (what the user actually saw), and Reload REBASES, per FIELD (a three-way merge of the edit row,
 * the edit-open line and the fresh line): a field the user did not change takes the fresh value; a field they
 * changed keeps their value. A line's qty only means something WITH its denomination (product, unit, pack
 * size, box split): when either side changed one, fields are never mixed across the two (a count of boxes
 * would be sold as cases) - the user's own row wins whole if they changed the denomination themselves, else the
 * fresh row wins whole and the line is COUNTED so the page can say "re-enter your change". Lines another writer removed are dropped (an id left in `pendingDeletes` or
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

/** The keys that give `qty` / `unitPrice` their meaning: never merged field by field across two writers. */
const DENOMINATION_KEYS = [
  "productId",
  "substituteProductId",
  "unitLabel",
  "unitsPerBox",
  "boxSplit",
  "isUnlisted",
] as const;

const field = (o: object, k: string) => (o as Record<string, unknown>)[k];

/**
 * Three-way merge of ONE edit row: take `fresh` wherever the row still equals `base`, else keep the edit.
 * `conflict` is true when the user's change was DROPPED because another writer changed the line's denomination.
 */
function mergeRow<E extends Edit>(edit: E, base: E, fresh: E): { row: E; conflict: boolean } {
  const changed = Object.keys(edit).filter((k) => !same(field(edit, k), field(base, k)));
  if (changed.length === 0) return { row: fresh, conflict: false }; // untouched: the server's line
  if (changed.some((k) => (DENOMINATION_KEYS as readonly string[]).includes(k))) {
    return { row: edit, conflict: false }; // the user re-denominated it themselves: their row, whole
  }
  if (DENOMINATION_KEYS.some((k) => !same(field(base, k), field(fresh, k)))) {
    return { row: fresh, conflict: true }; // another writer re-denominated it: never mix a count with a new unit
  }
  const out: Record<string, unknown> = { ...fresh };
  for (const k of changed) out[k] = field(edit, k); // the user's own change wins, field by field
  return { row: out as unknown as E, conflict: false };
}

export function rebaseEditItems<E extends Edit, L extends Line>(
  items: E[],
  base: L[],
  fresh: L[],
  deps: RebaseDeps<E, L>,
): { items: E[]; dropped: number; conflicts: number } {
  const live = new Map(fresh.filter(isLive).map((l) => [l.id, l]));
  const baseById = new Map(base.map((l) => [l.id, l]));
  const out: E[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  let conflicts = 0;
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
    if (!baseLine) {
      out.push(deps.seed(freshLine));
      continue;
    }
    const merged = mergeRow(e, deps.seed(baseLine), deps.seed(freshLine));
    if (merged.conflict) conflicts += 1;
    out.push(merged.row);
  }
  // a line another writer ADDED (or revived from CANCELLED) since edit-open: visible, untouched
  for (const [id, line] of live) {
    const b = baseById.get(id);
    if (!seen.has(id) && (!b || !isLive(b))) out.push(deps.seed(line));
  }
  return { items: out, dropped, conflicts };
}

/** A queued DELETE for a line that no longer exists would 409 on every save: drop it. */
export function rebasePendingDeletes<L extends Line>(ids: string[], fresh: L[]): string[] {
  const live = new Set(fresh.filter(isLive).map((l) => l.id));
  return ids.filter((id) => live.has(id));
}
