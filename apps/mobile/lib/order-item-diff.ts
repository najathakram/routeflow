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
 * - new catalog line → `{ productId, qty, [boxes,pieces], [unitPrice,overrideReason] }`;
 * - new unlisted line → `{ name, qty, unitPrice }`;
 * - existing UPDATE → `{ id, action:"UPDATE", qty, [boxes,pieces], [unitPrice,overrideReason] }`
 *   (qty always sent; price only when it changed vs the original);
 * - substitute → `{ id, substituteProductId, qty }`;
 * - trash → `{ id, action:"DELETE" }` (server hard-deletes only if uninvoiced/undelivered);
 * - not-available → `{ id, action:"CANCEL" }`.
 * Only DTO-whitelisted keys are emitted — never spread a UI draft.
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
  /** Send boxes/pieces only for a genuinely box-split line (stored denomination). */
  boxSplit: boolean;
  unitPrice: number;
  /** The customer's tier/base price — a new line sends unitPrice only if it diverges. */
  basePrice: number;
  overrideReason?: string;
  /** Set when this row substitutes a different product onto its original line. */
  substituteProductId?: string;
  /** Per-line note (buyer-visible), carried onto the invoice line. */
  notes?: string;
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
  const explicit = new Set([...pendingDeletes, ...pendingCancels]);
  const droppedDeletes = originals
    .map((o) => o.id)
    .filter((id) => !surviving.has(id) && !explicit.has(id));

  for (const id of [...pendingDeletes, ...droppedDeletes]) out.push({ id, action: "DELETE" });
  for (const id of pendingCancels) out.push({ id, action: "CANCEL" });

  for (const line of catalog) {
    if (line.qty <= 0) continue; // zero-out goes through delete/cancel; DTO qty is Min(1)
    const boxFields = line.boxSplit ? { boxes: line.boxes ?? 0, pieces: line.pieces ?? 0 } : {};
    const noteVal = (line.notes ?? "").trim();

    if (!line.lineId) {
      // New catalog line — send the price only when it diverges from the tier base.
      const overridden = Math.abs(line.unitPrice - line.basePrice) > EPS;
      out.push({
        productId: line.productId,
        qty: line.qty,
        ...boxFields,
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
      out.push({ id: line.lineId, substituteProductId: line.substituteProductId, qty: line.qty });
      continue;
    }

    const qtyChanged = Math.abs(line.qty - orig.qty) > EPS;
    const priceChanged = Math.abs(line.unitPrice - orig.unitPrice) > EPS;
    // A note-only edit is still a change (send the new value; empty clears it).
    const notesChanged = noteVal !== (orig.notes ?? "").trim();
    if (qtyChanged || priceChanged || notesChanged) {
      out.push({
        id: line.lineId,
        action: "UPDATE",
        qty: line.qty, // server's UPDATE branch requires qty present
        ...boxFields,
        ...(priceChanged
          ? {
              unitPrice: line.unitPrice,
              ...(line.overrideReason ? { overrideReason: line.overrideReason } : {}),
            }
          : {}),
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
