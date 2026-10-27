import {
  LINE_GUARD_SITES,
  lineGuardCtx,
  warnLineAmbiguity,
  type LineGuardSite,
  type RawPackLine,
} from "../common/line-ambiguity-warn";
import type { QtySplitLine } from "./qty-split-consistency";

/**
 * SA-982 PR-2b (row 139, warn only): the orders class sites dry-run `buildLine` on the RAW line a client sent, through
 * `OrdersService.warnSplit` (row 531's path ids ARE the `LINE_GUARD_SITES` ids, SA-982a). The write is never touched.
 *
 * What each site hands `buildLine` is that site's own documented reading of the client's line (SA-982a):
 *   - create / counter / cr.add: `{ unitsPerBox, boxes, pieces, qty }` exactly as sent, so a boxed product sent a bare
 *     qty (the B644 shape) is caught even though the split `if` below never runs for it;
 *   - substitute: the replacement's LIVE pack, not the replaced line's. A boxed substitute takes the client's split, else
 *     `item.qty ?? existingQty` with no split (B644, counted). A loose substitute drops the split by design
 *     (orders.service.ts, the substitute branch), so only the qty is judged and SPLIT_NO_PACK is not counted there.
 */
export function orderLineRaw(
  site: LineGuardSite,
  l: QtySplitLine,
  unitsPerBox: number | null | undefined,
  fallbackQty?: number | null,
): RawPackLine {
  if (site !== "orders.update.substitute") {
    return { unitsPerBox, boxes: l.boxes, pieces: l.pieces, qty: l.qty };
  }
  const hasSplit = l.boxes != null || l.pieces != null;
  if (!(Number(unitsPerBox) > 1)) return { qty: l.qty ?? fallbackQty };
  return {
    unitsPerBox,
    boxes: l.boxes,
    pieces: l.pieces,
    qty: hasSplit ? l.qty : (l.qty ?? fallbackQty),
  };
}

/** Dry-run the site named by `path` (a row 531 path id); any other path (e.g. `orders.update`, an edit) is not a class site. */
export function warnOrderLine(
  path: string,
  l: QtySplitLine,
  unitsPerBox: number | null | undefined,
  prisma: { getTenantId?(): string | null | undefined } | null | undefined,
  fallbackQty?: number | null,
): void {
  const site = (LINE_GUARD_SITES as readonly string[]).includes(path)
    ? (path as LineGuardSite)
    : null;
  if (!site) return;
  const ctx = lineGuardCtx({ getTenantId: () => prisma?.getTenantId?.() });
  warnLineAmbiguity(site, orderLineRaw(site, l, unitsPerBox, fallbackQty), ctx);
}
