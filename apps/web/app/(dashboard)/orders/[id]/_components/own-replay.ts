/**
 * Row 698: is a 409 ORDER_REVISION_STALE on Save really YOUR OWN earlier save?
 *
 * A save whose reply was lost (timeout / dropped connection) was still applied, so the user's retry carries the
 * revision it loaded and gets a stale 409 about a change the user made. The client cannot tell that from another
 * user's change by the revision alone, so it re-reads the order and calls it "mine" only when the server holds
 * EXACTLY (the order the editor opened) + (the edits it sent), nothing more and nothing less:
 *  - every field the edit sent matches what was sent;
 *  - every field of an edited line that the edit did NOT send still equals the opened baseline (qty 4 -> 7 sent
 *    while another user also set 7 AND a new price or note must stay a conflict);
 *  - every line the edit did not touch still equals the baseline, no line was added, and an unsent shipping fee
 *    is unchanged.
 * Anything it cannot check exactly (new lines, substitutions, boxed or unit-label lines, credits, an inline
 * return, no baseline) answers false and the real conflict notice stays: a false "yours" would hide someone
 * else's change, a false conflict only costs a Reload.
 */
export type SentLine = object;
export interface ServerOrder {
  lineItems?: Array<{ id: string } & Record<string, unknown>>;
  shippingFee?: number | string | null;
}
export interface Baseline {
  lines?: Array<{ id: string } & Record<string, unknown>>;
  fee?: number;
}

// Money in cents (no tolerance), quantities to 4 dp, text trimmed; null / undefined / "" are one "nothing".
const cents = (v: unknown) => Math.round(Number(v ?? 0) * 100);
const qty4 = (v: unknown) => Math.round(Number(v ?? 0) * 10000);
const text = (v: unknown) => (v == null ? "" : String(v).trim());

type Kind = "money" | "qty" | "text";
// Every line field the server could change that the plain edit does not send (or derives from what it sends).
const MONEY: string[] = ["unitPrice", "originalPrice"];
const OTHER: Array<[string, Kind]> = [
  ["productId", "text"],
  ["name", "text"],
  ["notes", "text"],
  ["status", "text"],
  ["priceType", "text"],
  ["overrideReason", "text"],
  ["unitLabel", "text"],
  ["unitsPerBox", "qty"],
  ["boxes", "qty"],
  ["pieces", "qty"],
];
const eq = (kind: Kind, a: unknown, b: unknown) =>
  kind === "money"
    ? cents(a) === cents(b)
    : kind === "qty"
      ? qty4(a) === qty4(b)
      : text(a) === text(b);

/** Fields of `live` that differ from `base`, minus `skip` (the ones the edit sent or the server derives from them). */
function drift(
  live: Record<string, unknown>,
  base: Record<string, unknown>,
  skip: Set<string>,
): boolean {
  if (!skip.has("qty") && qty4(live.qty) !== qty4(base.qty)) return true;
  for (const f of MONEY) if (!skip.has(f) && !eq("money", live[f], base[f])) return true;
  for (const [f, k] of OTHER) if (!skip.has(f) && !eq(k, live[f], base[f])) return true;
  return false;
}

// Keys a plain qty/price/note UPDATE or a CANCEL/DELETE carries; any other key (productId, boxes, unitLabel,
// substituteProductId, name ...) means a shape this check does not model.
const PLAIN = new Set(["id", "action", "qty", "unitPrice", "overrideReason", "notes"]);
// Derived by the server from a changed qty / price: never compared on a line the edit changed.
const DERIVED = ["boxes", "pieces", "priceType", "originalPrice"];

export function serverHoldsWhatWasSent(
  sentLines: SentLine[],
  server: ServerOrder | undefined,
  base: Baseline | undefined,
  opts: { fee?: number; unverifiable?: boolean } = {},
): boolean {
  const sent = sentLines as Array<{
    id?: string;
    action?: string;
    qty?: number;
    unitPrice?: number;
    notes?: string;
  }>;
  if (!server?.lineItems || !base?.lines || opts.unverifiable || sent.length === 0) return false;

  // Shipping fee: a sent fee must match to the cent; an unsent one must be the opened one.
  if (opts.fee != null) {
    if (cents(server.shippingFee) !== cents(opts.fee)) return false;
  } else if (base.fee != null && cents(server.shippingFee) !== cents(base.fee)) {
    return false;
  }

  const sentById = new Map<string, (typeof sent)[number]>();
  for (const u of sent) {
    if (!u.id || Object.keys(u).some((k) => !PLAIN.has(k))) return false;
    sentById.set(u.id, u);
  }

  // No line the editor never saw (another user added one).
  const baseIds = new Set(base.lines.map((l) => l.id));
  if (server.lineItems.some((l) => !baseIds.has(l.id))) return false;

  for (const b of base.lines) {
    const live = server.lineItems.find((l) => l.id === b.id);
    const u = sentById.get(b.id);
    if (!u) {
      // Untouched by this edit: it must still be exactly what the editor opened.
      if (!live || drift(live, b, new Set())) return false;
      continue;
    }
    if (u.action === "DELETE") {
      if (live) return false;
    } else if (u.action === "CANCEL") {
      if (live && text(live.status) !== "CANCELLED") return false;
    } else if (u.action === "UPDATE") {
      if (!live || u.qty == null || qty4(live.qty) !== qty4(u.qty)) return false;
      if (u.unitPrice != null && !eq("money", live.unitPrice, u.unitPrice)) return false;
      if (u.notes != null && text(live.notes) !== text(u.notes)) return false;
      // Fields we did not send must be what the editor opened (another user's price / note / name edit).
      const skip = new Set<string>(["qty", ...DERIVED]);
      if (u.unitPrice != null) {
        skip.add("unitPrice");
        skip.add("overrideReason");
      }
      if (u.notes != null) skip.add("notes");
      if (drift(live, b, skip)) return false;
    } else {
      return false;
    }
  }
  // A sent id the baseline never had cannot be verified.
  for (const id of sentById.keys()) if (!baseIds.has(id)) return false;
  return true;
}
