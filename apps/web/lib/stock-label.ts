// #2066 review round: `unitsLabel` moved to `@routeflow/pricing` (mobile's PO
// detail screen had grown its own local copy — the same "drifting mirror" class
// B707/#1171 already fixed once for invoice/order lines). Re-exported under this
// file's original name/path so every existing `@/lib/stock-label` import keeps
// working unchanged — same pattern as `apps/web/lib/invoice-line-unit.ts`'s
// `invoiceLineQtyText` re-export (#1275 precedent).
export { unitsLabel } from "@routeflow/pricing";
