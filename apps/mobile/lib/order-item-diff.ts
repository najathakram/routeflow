/**
 * Build the incremental order-item edit payload (mirrors web's `handleSaveItems`).
 *
 * The mobile edit screen used to re-send EVERY line as an id-less array, which
 * the server treats as a full replace (delete + recreate) — wiping line ids,
 * invoicedQty, deliveredQty, and override history on untouched lines. This emits
 * a minimal diff instead: only changed/added/removed lines, each carrying its DB
 * `id` + `action`, sent with `replaceAll:false` so untouched lines are preserved.
 *
 * Rules match the web golden reference:
 * - untouched line → nothing;
 * - new catalog line → `{ productId, qty, [boxes,pieces], [unitPrice,overrideReason] }`, or
 *   `{ productId, qty:<unit count>, unitLabel, [unitPrice,overrideReason] }` when the operator
 *   picked a unit on it (units_v1 — `UnitPickerRow`/`CartRow`; no boxes/pieces on that shape);
 * - new unlisted line → `{ name, qty, unitPrice }`;
 * - existing UPDATE → `{ id, action:"UPDATE", qty, [boxes,pieces], [unitPrice,overrideReason] }`
 *   (qty always sent; price only when it changed vs the original) — UNLESS the line
 *   carries a units_v1 `unitLabel` (Case, Pallet…, set/changed this session via
 *   `UnitPickerRow`/`DraftItemCard`, or simply carried forward unchanged from a
 *   previously-saved unit line), in which case it's
 *   `{ id, action:"UPDATE", qty:<unit count>, unitLabel, productId, [unitPrice,overrideReason] }`
 *   instead: the server's unit-aware branch reads `qty` as a COUNT OF THE UNIT and refuses
 *   boxes/pieces outright, needs `unitLabel` resent or it refuses the whole edit (B707), and
 *   needs `productId` alongside it so the server preloads the product/ladder for a line it
 *   doesn't already know is unit-aware (filed separately, not fixed here — see the PR body);
 * - substitute → `{ id, substituteProductId, qty, [boxes,pieces], [unitPrice,overrideReason] }`
 *   (same box-split + override rules as a fresh add — the SUBSTITUTE's own LIST
 *   price, carried in `basePrice`, is what "diverges" is measured against: it is
 *   the price the server applies when the payload carries none, so a tier price
 *   or an operator override must both go on the wire);
 * - trash → `{ id, action:"DELETE" }` (server hard-deletes only if uninvoiced/undelivered);
 * - not-available → `{ id, action:"CANCEL" }`.
 * Only DTO-whitelisted keys are emitted — never spread a UI draft.
 *
 * The `boxes`/`pieces` fields are emitted whenever the line carries that DATA
 * (`boxes != null || pieces != null`), not off a separately-maintained
 * `boxSplit` boolean — a producer that forgets to flip a flag can no longer
 * silently strip a real box split from the payload (see B1: a fresh case-add
 * that skipped `boxSplit: true` billed box-price × piece-count).
 */
import type { UpdateOrderItemInput } from "./api/orders";

const EPS = 0.0001;

export interface DiffCatalogLine {
  /** Original DB line id; undefined = freshly added this session. */
  lineId?: string;
  productId: string;
  /** Effective piece count for the line (already box-resolved). */
  qty: number;
  boxes?: number | null;
  pieces?: number | null;
  /**
   * Stored denomination hint from the UI (client state only — never sent to
   * the server as its own field). The `boxFields` gate below no longer trusts
   * this flag; it reads `boxes`/`pieces` DATA presence instead, so this field
   * is now informational only. Kept on the interface for callers that already
   * track it.
   */
  boxSplit: boolean;
  unitPrice: number;
  /**
   * The base this line's price is measured against — the customer's tier price
   * on a fresh add, the SUBSTITUTE's list price on a substitution. `unitPrice`
   * goes on the wire only when it diverges from this.
   */
  basePrice: number;
  overrideReason?: string;
  /** Set when this row substitutes a different product onto its original line. */
  substituteProductId?: string;
  /** Per-line note (buyer-visible), carried onto the invoice line. */
  notes?: string;
  /**
   * units_v1: the unit this line is sold by ("Case"…), carried unchanged
   * from the stored line. When set, an UPDATE's wire shape diverges from a
   * pack line's — see the UPDATE branch below (B707).
   */
  unitLabel?: string | null;
}

export interface DiffUnlistedLine {
  /** Original DB line id for an existing unlisted line; undefined = new. */
  lineId?: string;
  name: string;
  qty: number;
  unitPrice: number;
  notes?: string;
}

export interface OriginalLine {
  id: string;
  productId: string | null;
  qty: number;
  unitPrice: number;
  name?: string | null;
  notes?: string | null;
  overrideReason?: string | null;
}

export function buildOrderItemDiff(args: {
  catalog: DiffCatalogLine[];
  unlisted: DiffUnlistedLine[];
  originals: OriginalLine[];
  pendingDeletes: string[];
  pendingCancels: string[];
}): UpdateOrderItemInput[] {
  const { catalog, unlisted, originals, pendingDeletes, pendingCancels } = args;
  const byId = new Map(originals.map((o) => [o.id, o]));
  const out: UpdateOrderItemInput[] = [];

  // Any original line NOT present among the surviving catalog/unlisted lines is
  // a removal — including lines the operator zeroed via the qty stepper (which
  // drop out of the draft without hitting the trash button). Without this,
  // replaceAll:false leaves those lines fully intact on the order (silent
  // overcharge). Explicit pending flags win; the server downgrades DELETE→CANCEL
  // for invoiced/delivered lines, protecting money history.
  const surviving = new Set<string>();
  for (const l of catalog) if (l.lineId) surviving.add(l.lineId);
  for (const u of unlisted) if (u.lineId) surviving.add(u.lineId);
  // B805 (Opus N1): an id can be BOTH in pendingDeletes/pendingCancels AND
  // surviving — the draft record is keyed by lineId, so removing a line and
  // then re-adding the SAME product (a rescan in one batch, or reopening the
  // price modal on a line mid-remove) can re-populate `draft[lineId]` after
  // the trash button already queued that lineId here. The later, surviving
  // state wins: a pending delete/cancel whose id is still a live catalog/
  // unlisted entry is dropped, never emitted alongside that entry's own
  // UPDATE/CREATE — sending both actions for the same id in one diff is a
  // contradiction the server should never have to resolve.
  // F3: one removal per id. The same id queued twice (a restored snapshot, a double tap), or queued as
  // BOTH a delete and a cancel, would put it in the array twice and the API refuses DUPLICATE_LINE_ID.
  // A cancel wins over a delete: it is the non-destructive one and the server downgrades a delete anyway.
  const pendingCancelsLive = [...new Set(pendingCancels)].filter((id) => !surviving.has(id));
  const cancelling = new Set(pendingCancelsLive);
  const pendingDeletesLive = [...new Set(pendingDeletes)].filter(
    (id) => !surviving.has(id) && !cancelling.has(id),
  );
  const explicit = new Set([...pendingDeletesLive, ...pendingCancelsLive]);
  const droppedDeletes = originals
    .map((o) => o.id)
    .filter((id) => !surviving.has(id) && !explicit.has(id));

  for (const id of [...pendingDeletesLive, ...droppedDeletes]) out.push({ id, action: "DELETE" });
  for (const id of pendingCancelsLive) out.push({ id, action: "CANCEL" });

  for (const line of catalog) {
    if (line.qty <= 0) continue; // zero-out goes through delete/cancel; DTO qty is Min(1)
    // Data presence, not the separately-maintained `boxSplit` flag — a producer
    // that forgets to flip the flag can no longer silently drop a real split (B1).
    const boxFields =
      line.boxes != null || line.pieces != null
        ? { boxes: line.boxes ?? 0, pieces: line.pieces ?? 0 }
        : {};
    const noteVal = (line.notes ?? "").trim();

    if (!line.lineId) {
      // New catalog line — send the price only when it diverges from the tier base.
      // units_v1: a fresh unit-sold line has no boxes/pieces (boxFields is already {} since the
      // picker never sets them) — qty is the unit COUNT, and unitLabel names it. This branch
      // already sends productId unconditionally (a new line always names its product), so the
      // server's product/ladder preload always covers it — unlike the id-only UPDATE branch
      // below, which must add productId explicitly for the same reason.
      const overridden = Math.abs(line.unitPrice - line.basePrice) > EPS;
      const unitLabel = line.unitLabel?.trim() || undefined;
      out.push({
        productId: line.productId,
        qty: line.qty,
        ...boxFields,
        ...(unitLabel ? { unitLabel } : {}),
        ...(overridden
          ? {
              unitPrice: line.unitPrice,
              ...(line.overrideReason ? { overrideReason: line.overrideReason } : {}),
            }
          : {}),
        ...(noteVal ? { notes: noteVal } : {}),
      });
      continue;
    }

    const orig = byId.get(line.lineId);
    if (!orig) continue;

    if (line.substituteProductId && line.substituteProductId !== orig.productId) {
      // Substitution: honor a box split + operator override the same way as a
      // fresh add (the server explicitly supports both on this branch).
      // Inheriting bare qty silently overcharged by unitsPerBox (B2), and any
      // price other than the substitute's list price was discarded (B3).
      // `basePrice` here is the SUBSTITUTE's own LIST price (see
      // lib/substitute-line.ts), which is exactly what the server bills when no
      // `unitPrice` arrives — so a tier price diverges from it and is sent too.
      const overridden = Math.abs(line.unitPrice - line.basePrice) > EPS;
      out.push({
        id: line.lineId,
        substituteProductId: line.substituteProductId,
        qty: line.qty,
        ...boxFields,
        ...(overridden
          ? {
              unitPrice: line.unitPrice,
              ...(line.overrideReason ? { overrideReason: line.overrideReason } : {}),
            }
          : {}),
      });
      continue;
    }

    const qtyChanged = Math.abs(line.qty - orig.qty) > EPS;
    const priceChanged = Math.abs(line.unitPrice - orig.unitPrice) > EPS;
    // A reason-only correction (unitPrice unchanged) is still a change — without
    // this, buildOrderItemDiff dropped it silently: the UI showed the corrected
    // reason as saved, but a reload reverted it (M1).
    const reasonChanged = (line.overrideReason ?? "") !== (orig.overrideReason ?? "");
    // A note-only edit is still a change (send the new value; empty clears it).
    const notesChanged = noteVal !== (orig.notes ?? "").trim();
    if (qtyChanged || priceChanged || reasonChanged || notesChanged) {
      // units_v1 (B707): a line sold by a named unit stores qty/boxes/pieces
      // in PACK PIECES (so qtyChanged above stays on the same basis as every
      // other line), but the server's unit-aware UPDATE branch (buildUnitLine)
      // takes `qty` as a COUNT OF THE UNIT and refuses boxes/pieces outright —
      // sending the piece-expanded qty here billed a 3-case edit as 864
      // "cases". `unitLabel` may now be set/changed THIS session too (the
      // mobile unit picker) as well as ride along unchanged from a
      // previously-saved unit line — either way it must go on the wire, or
      // the server's assertUnitLabelNamed mistakes the save for a plain
      // pieces edit and refuses it (UNIT_AWARE_LINE). `productId` rides
      // along with it: prepareUnitEditContext only preloads the product/
      // ladder for THIS item when the item itself carries productId (an
      // already-unit-aware STORED line is covered without it, but a line
      // being assigned a unit for the first time this session is not — a
      // filed, unfixed server gap; sending productId unconditionally here
      // is free and closes it for every case, not just the new one).
      const unitLabel = line.unitLabel?.trim() || undefined;
      // B718: `line.boxes` here means "the unit COUNT" (a 3-Case line stores boxes:3), never a
      // real pack box count — but `?? ` alone only catches null/undefined, not a MEANINGLESS
      // boxes:0 (the shape a fresh piece-code scan leaves — lib/edit-items-draft.ts's
      // applyPickToDraft — on a line that had no unitLabel at the time). `line.qty <= 0` is
      // already refused above, so falling through to it here can never itself introduce a
      // zero; only a genuinely positive `boxes` should ever be preferred over it.
      const unitQty = unitLabel && line.boxes != null && line.boxes > 0 ? line.boxes : line.qty;
      out.push({
        id: line.lineId,
        action: "UPDATE",
        qty: unitLabel ? unitQty : line.qty, // server's UPDATE branch requires qty present
        ...(unitLabel ? { unitLabel, productId: line.productId } : boxFields),
        // unitPrice is gated on priceChanged ALONE (R9): the server's edit
        // branch derives isManualOverride from whether the sent price differs
        // from the stored one, so echoing it back on a reason-only edit would
        // read as "not manual" and risk re-deriving a SPECIAL/manually-priced
        // line's billed price.
        ...(priceChanged ? { unitPrice: line.unitPrice } : {}),
        // B465: the reason travels WITH the price — sent whenever EITHER
        // changed, not just when the reason itself did. A price change alone
        // (reason already carried forward unchanged from the stored line, per
        // the draft's own seeding) must still land the reason on the SAME
        // request, or the server's "a reason is required to change a
        // special-price line" refusal has nothing to fall back on. Empty
        // string included on a clear — omitting it is the same bug M1 fixed,
        // for the opposite direction (the server keeps whatever it last had).
        ...(priceChanged || reasonChanged ? { overrideReason: line.overrideReason ?? "" } : {}),
        ...(notesChanged ? { notes: noteVal } : {}),
      });
    }
  }

  for (const u of unlisted) {
    const name = u.name.trim();
    if (u.qty <= 0 || name === "") continue;
    const noteVal = (u.notes ?? "").trim();
    if (!u.lineId) {
      out.push({
        name,
        qty: u.qty,
        unitPrice: u.unitPrice,
        ...(noteVal ? { notes: noteVal } : {}),
      });
      continue;
    }
    const orig = byId.get(u.lineId);
    if (!orig) continue;
    const qtyChanged = Math.abs(u.qty - orig.qty) > EPS;
    const priceChanged = Math.abs(u.unitPrice - orig.unitPrice) > EPS;
    const nameChanged = name !== (orig.name ?? "").trim();
    const notesChanged = noteVal !== (orig.notes ?? "").trim();
    if (qtyChanged || priceChanged || nameChanged || notesChanged) {
      out.push({
        id: u.lineId,
        qty: u.qty,
        ...(nameChanged ? { name } : {}),
        ...(priceChanged ? { unitPrice: u.unitPrice } : {}),
        ...(notesChanged ? { notes: noteVal } : {}),
      });
    }
  }

  return out;
}
