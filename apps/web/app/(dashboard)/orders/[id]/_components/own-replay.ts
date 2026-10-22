/**
 * Row 698: is a 409 ORDER_REVISION_STALE on Save really YOUR OWN earlier save?
 *
 * A save whose reply was lost (timeout / dropped connection) was still applied, so the user's retry carries the
 * revision it loaded and gets a stale 409 about a change the user made. The client cannot tell that from another
 * user's change by the revision alone, so it re-reads the order and only calls it "mine" when EVERY edit it just
 * sent is already what the server holds. Anything it cannot check exactly (new lines, substitutions, boxed or
 * unit-label lines, credits, an inline return) answers false and the real conflict notice stays: a false "yours"
 * would drop someone else's change on the floor, a false conflict is only a Reload.
 */
export type SentLine = object;
export interface ServerLine {
  id: string;
  qty?: number | string | null;
  unitPrice?: number | string | null;
  notes?: string | null;
  status?: string | null;
}
export interface ServerOrder {
  lineItems?: ServerLine[];
  shippingFee?: number | string | null;
}

const EPS = 0.0001;
const same = (a: unknown, b: number) => Math.abs(Number(a) - b) <= EPS;
// Keys a plain qty/price/note UPDATE or a CANCEL/DELETE carries; any other key (productId, boxes, unitLabel,
// substituteProductId, name ...) means a shape this check does not model.
const PLAIN = new Set(["id", "action", "qty", "unitPrice", "overrideReason", "notes"]);

export function serverHoldsWhatWasSent(
  sentLines: SentLine[],
  server: ServerOrder | undefined,
  opts: { fee?: number; unverifiable?: boolean } = {},
): boolean {
  const sent = sentLines as Array<{
    id?: string;
    action?: string;
    qty?: number;
    unitPrice?: number;
    notes?: string;
  }>;
  if (!server?.lineItems || opts.unverifiable || sent.length === 0) return false;
  if (opts.fee != null && !same(server.shippingFee ?? 0, opts.fee)) return false;
  for (const u of sent) {
    if (!u.id || Object.keys(u).some((k) => !PLAIN.has(k))) return false;
    const live = server.lineItems.find((l) => l.id === u.id);
    if (u.action === "DELETE") {
      if (live) return false;
    } else if (u.action === "CANCEL") {
      if (live && live.status !== "CANCELLED") return false;
    } else if (u.action === "UPDATE") {
      if (!live || u.qty == null || !same(live.qty, u.qty)) return false;
      if (u.unitPrice != null && !same(live.unitPrice, u.unitPrice)) return false;
      if (u.notes != null && (live.notes ?? "").trim() !== u.notes.trim()) return false;
    } else {
      return false;
    }
  }
  return true;
}
