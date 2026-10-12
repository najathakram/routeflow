/**
 * Row 372 MF3 (web). After the stale notice's Reload the page holds FRESH server lines, but the editor's own
 * `editItems` were seeded from the lines it LOADED. Diffing the two would re-send every field another writer
 * changed with the editor's stale value and silently revert it. So an edit is judged against the lines captured
 * at edit-open (what the user actually saw), and Reload REBASES, per FIELD (a three-way merge of the edit row,
 * the edit-open line and the fresh line): a field the user did not change takes the fresh value; a field they
 * changed keeps their value. A line's qty only means something WITH its denomination (product, unit, pack
 * size, box split): when BOTH sides changed a line and either touched its denomination, nothing is mixed - the
 * fresh row wins whole and the line is COUNTED so the page can say "re-check it". Lines another writer removed are dropped (an id left in `pendingDeletes` or
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
/** UI-only flags the unit picker writes on its own (`false` vs absent): never evidence of an edit. */
const UI_ONLY_KEYS = new Set(["priceEdited", "startOnDefaultUnit", "reasonBaselinePrice"]);
/** Display facts read from the live PRODUCT, not the order line: a catalog change is nobody editing the line. */
const PRODUCT_ONLY_KEYS = new Set(["unitCost", "category", "unit", "originalUnitsPerBox"]);
const IGNORED_KEYS = new Set([...UI_ONLY_KEYS, ...PRODUCT_ONLY_KEYS]);

const field = (o: object, k: string) => (o as Record<string, unknown>)[k];
const isDenomination = (k: string) => (DENOMINATION_KEYS as readonly string[]).includes(k);
const keysOf = (...rows: object[]) => [...new Set(rows.flatMap((r) => Object.keys(r)))];
/** What a save would compare: a note is trimmed and null == "" (exactly `buildItemUpdates`' own rule). */
const norm = (k: string, v: unknown) => (k === "notes" ? String(v ?? "").trim() : v);
const differs = (a: object, b: object, k: string) =>
  !same(norm(k, field(a, k)), norm(k, field(b, k)));

/**
 * Three-way merge of ONE edit row (edit, the edit-open `base`, the `fresh` server row). Never a SILENT revert:
 *   1. the user changed nothing on it -> the fresh row;
 *   2. nobody else changed it -> the user's row whole (nothing of anyone else's to lose);
 *   3. both changed it, and either side touched the denomination (product, unit, pack size, box split) -> the
 *      fresh row whole, COUNTED (`conflict`) so the page tells the user to re-check it: a qty is never carried
 *      across a unit/pack/product change, and no stale field of the user's row is ever re-sent over theirs;
 *   4. both changed it, denomination untouched by both -> per field: fresh, plus the user's own changes; a field
 *      BOTH changed to different values takes the fresh value and is COUNTED (the user re-enters it).
 */
function mergeRow<E extends Edit>(edit: E, base: E, fresh: E): { row: E; conflict: boolean } {
  const userChanged = keysOf(edit, base).filter(
    (k) => !IGNORED_KEYS.has(k) && differs(edit, base, k),
  );
  if (userChanged.length === 0) return { row: fresh, conflict: false };
  const freshChanged = keysOf(fresh, base).filter(
    (k) => !IGNORED_KEYS.has(k) && differs(fresh, base, k),
  );
  if (freshChanged.length === 0) return { row: edit, conflict: false };
  if (userChanged.some(isDenomination) || freshChanged.some(isDenomination)) {
    // a "Not available" strike sends no qty, so it is the one user change that is safe to keep
    return { row: { ...fresh, cancelled: field(edit, "cancelled") } as E, conflict: true };
  }
  const out: Record<string, unknown> = { ...fresh };
  let conflict = false;
  for (const k of userChanged) {
    if (freshChanged.includes(k) && differs(edit, fresh, k))
      conflict = true; // both changed it: theirs stands
    else out[k] = field(edit, k); // the user's own change wins, field by field
  }
  for (const k of UI_ONLY_KEYS) if (k in edit) out[k] = field(edit, k); // the picker's own memory stays
  return { row: out as unknown as E, conflict };
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

type Credit = { creditNoteId: string; amount?: number };
export interface ReloadSnapshot<L> {
  lines?: L[];
  fee?: number;
  credits?: Credit[];
}

/**
 * Row 372 MF3: everything Reload re-bases, in one place (the page only wires its setters). Lines per `rebaseEditItems`;
 * queued deletes of vanished lines dropped; the shipping fee and the applied credit notes follow the SAME rule as a
 * line field: untouched -> the server's value; changed by the user alone -> theirs; changed by BOTH to different
 * values -> the server's, and counted. Credits matter most: `appliedCreditNotes` is the FULL desired set, so a stale
 * selection would silently pull back a credit another operator just applied. Returns how many things the user must
 * re-check (the page's toast).
 */
export function rebaseOnReload<E extends Edit, L extends Line>(
  s: {
    editItems: E[];
    editShippingFee: number;
    editCredits: Credit[];
    creditsTouched: boolean;
    deps: RebaseDeps<E, L>;
    setEditItems: (f: (prev: E[]) => E[]) => void;
    setPendingDeletes: (f: (ids: string[]) => string[]) => void;
    setEditShippingFee: (f: (fee: number) => number) => void;
    setEditCredits: (c: Credit[]) => void;
    setCreditsTouched: (t: boolean) => void;
  },
  fresh: ReloadSnapshot<L>,
  base: ReloadSnapshot<L>,
): number {
  const [bl, fl] = [base.lines ?? [], fresh.lines ?? []];
  const lines = rebaseEditItems(s.editItems, bl, fl, s.deps);
  s.setEditItems((prev) => rebaseEditItems(prev, bl, fl, s.deps).items);
  s.setPendingDeletes((ids) => rebasePendingDeletes(ids, fl));

  const [bf, ff] = [base.fee ?? 0, fresh.fee ?? 0];
  const moved = (a: number, b: number) => Math.abs(a - b) > 0.0001;
  const feeClash = moved(s.editShippingFee, bf) && moved(ff, bf) && moved(s.editShippingFee, ff);
  s.setEditShippingFee((f) => (!moved(f, bf) || (moved(ff, bf) && moved(f, ff)) ? ff : f));

  let credits = 0;
  if (base.credits && fresh.credits && !same(base.credits, fresh.credits)) {
    // another operator changed the applied credits: the server's set stands (the user's selection was stale)
    s.setEditCredits(fresh.credits);
    s.setCreditsTouched(false);
    if (s.creditsTouched && !same(s.editCredits, fresh.credits)) credits = 1;
  }
  return lines.dropped + lines.conflicts + (feeClash ? 1 : 0) + credits;
}
