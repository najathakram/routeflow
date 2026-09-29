import { InvoiceStatus, OrderStatus } from "@prisma/client";

// F11 (B129 / B211): the `resolutionReason` stamped on a ChangeRequest that a
// run-terminal release declined. Exported so a UI/report can recognise a
// system decline without string-matching a literal in two places.
export const RELEASED_CHANGE_REQUEST_REASON = "Run cancelled — order released to dispatch";

// G7: single shared `lineItems` select for the ENTIRE run read path —
// RUN_STOP_INCLUDE below, findOneRun's main query, and findOneRun's
// unlinked-orders fallback all reference this SAME object (never re-literal
// it) so the three can never drift out of sync again. Carries the
// box-aware money fields (subtotal/boxes/pieces/unitsPerBox) the old
// six-field literal lacked — consumed by mobile's `run-money.ts` and,
// once they land, F10/F11/F12/F22 (route money summaries, driver payout
// reconciliation, per-stop invoicing).
export const RUN_LINE_ITEMS_SELECT = {
  id: true,
  productId: true,
  product: { select: { id: true, name: true, unit: true } },
  qty: true,
  // SA-345a: the legacy delivered column — the ONLY evidence for a line delivered before
  // DeliveryMutation rows existed; the run projection reads it when a line has no row.
  deliveredQty: true,
  unitPrice: true,
  status: true,
  subtotal: true,
  boxes: true,
  pieces: true,
  unitsPerBox: true,
  // B305 round 2 (RULING 1/3): the per-line regulated-category tax snapshot
  // (sales.prisma OrderItem.categoryTaxAmount) — mobile's run-money.ts
  // #deliveredCategoryTax scales this by delivered/ordered qty to reproduce
  // invoices.service.ts#buildInvoiceItemData's own per-unit proration for a
  // short-picked stop's estimate. NOTE: `OrderItem` has no `taxRate` column
  // (only `categoryTaxAmount`) — see routes.run-stop-select.spec.ts.
  categoryTaxAmount: true,
  // B648: units_v1 — the unit this line is sold by ("Case"…), null on a
  // plain piece/pack line. Without it, this driver read surface can't tell a
  // Case line from a pack line — lib/short-pick.ts#isUnitAwareLine gates the
  // stepper (and every money function) on it.
  unitLabel: true,
} as const;

// Shared per-stop include used by both list (`findAllRuns`) and detail
// (`findOneRun`) so the two endpoints stay in lockstep. Driver list views need
// `customer`, `customerAddress`, and `orders` to render addresses/totals and to
// build Google Maps waypoints — selecting a slim shape here previously caused
// scheduled-run cards to render "no location" for every stop.
export const RUN_STOP_INCLUDE = {
  customer: {
    select: {
      id: true,
      businessName: true,
      contactName: true,
      phone: true,
      deliveryWindowStart: true,
      deliveryWindowEnd: true,
      // B305 round 3: the driver's short-pick estimate must zero tax for an
      // exempt customer exactly as reconcileOrderDraftInvoice does.
      isTaxExempt: true,
    },
  },
  customerAddress: true,
  orders: {
    select: {
      id: true,
      orderNumber: true,
      status: true,
      urgent: true,
      notes: true,
      // B305: the driver's at-door amount due needs the tax-inclusive total —
      // these are Order Decimal columns (sales.prisma:559-561), arrive as
      // strings on the wire, no conversion here.
      subtotal: true,
      tax: true,
      total: true,
      discountAmount: true,
      shippingFee: true,
      // B305 round 2 (RULING 1): ALL open drafts, not just the oldest one — a
      // regulated SEPARATE_INVOICE order's `reconcileSplitOrderDrafts` can leave
      // it with SEVERAL open DRAFT + deliveryBatchId:null invoices (base + `-R#`
      // siblings), and every one of them is money the invoice actually bills.
      // `take: 1` silently dropped every sibling but the oldest and
      // under-charged the driver. `orderBy: createdAt asc` mirrors
      // `findOpenOrderDraft`/`reconcileSplitOrderDrafts` (invoices.service.ts)
      // so the payload lists them in the same order the server reasons about
      // them — never re-sort client-side.
      invoices: {
        where: { status: InvoiceStatus.DRAFT, deliveryBatchId: null },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          subtotal: true,
          taxAmount: true,
          discount: true,
          shippingFee: true,
          total: true,
        },
      },
      // B810/SA-130a: `payableInvoices` (SA-125's SEPARATE, non-DRAFT-only list,
      // mirroring recordDeliveryPaymentInTx's own PAYABLE query) is deliberately
      // NOT selected here — `Order` has no such relation, only `invoices` above.
      // It is fetched as its own batched `invoice.findMany` and attached
      // afterward (see run-invoice-balance.ts and this file's 4 call sites in
      // routes.service.ts) — nesting it under this `select` throws `Unknown
      // field 'payableInvoices'` against the real Prisma client.
      lineItems: { select: RUN_LINE_ITEMS_SELECT },
    },
  },
  routeStop: {
    include: {
      customer: {
        select: {
          id: true,
          businessName: true,
          contactName: true,
          phone: true,
          deliveryWindowStart: true,
          deliveryWindowEnd: true,
          // B305 round 5: findOneRun falls back to THIS customer
          // (`s.customer ?? s.routeStop?.customer`) for a legacy/seeded run
          // with no direct stop-customer link — without isTaxExempt here too,
          // that fallback path silently over-collects tax from an exempt
          // customer exactly as round 3 fixed for the direct link.
          isTaxExempt: true,
        },
      },
      customerAddress: true,
    },
  },
} as const;

/**
 * Orders the dispatch sweep must never attach and a stop completion must never flip to DELIVERED:
 * a DRAFT is not yet a commitment (TripsService.TRIP_ELIGIBLE_STATUSES already excludes it), and
 * DELIVERED/CANCELLED are terminal.
 */
export const NON_ROUTABLE_ORDER_STATUSES: OrderStatus[] = [
  OrderStatus.DRAFT,
  OrderStatus.DELIVERED,
  OrderStatus.CANCELLED,
];
