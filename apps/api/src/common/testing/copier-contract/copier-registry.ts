// The copier registry: for every place that COPIES a sales line into a new row, what happens to each
// column of the target model. Read copier-contract.spec.ts first (method, limits, how to fix a red).
// Source of the classifications: R-ui's copier audit (unitlabel-sweep §3b/§3c, cells re-checked
// against the code by the AST pass) — C-ids are that audit's ids. Columns are space-separated.
import type { Anchor } from "./copier-ast";

/** `B###` = a filed defect; `unfiled` = known absent, no id yet; `unverified` = not traced. */
export type GapRef = `B${number}` | "unfiled" | "unverified";
export type Model =
  | "InvoiceItem"
  | "OrderItem"
  | "EstimateItem"
  | "ReturnItem"
  | "CreditNoteItem"
  | "RecurringInvoiceItem";

export interface Copier {
  id: string;
  file: string; //     repo-relative to apps/api/src (server) or to the repo root (client, registry-only)
  fn: string;
  target: Model;
  anchor?: Anchor;
  /** "registry-only": listed (and its function/file must exist) but its columns are NOT checked. */
  coverage?: "registry-only";
  why?: string; //     required for registry-only
  carried?: string; //  copied from the source line (or the source line's own snapshot)
  reset?: string; //    deliberately set to a default (a wrong VALUE here is not detectable by key presence)
  rederived?: string; // recomputed from the live product / tier / promo / tax rules
  /** carried from the SOURCE line through create()'s internal `options.sourceLines` (invisible to the anchored literal): checked structurally, each key must appear in the copier's `sourceLines` literal */
  viaOptions?: string;
  na?: string; //       cannot apply (source has no such field, or the target fills it later by design)
  gaps?: Record<string, GapRef>; // should be carried but is not: the debt this contract pins
}

/** Columns that are identity, parent FK or bookkeeping, never a copy decision. */
export const INFRA: Record<Model, string> = {
  InvoiceItem: "id invoiceId createdAt updatedAt tenantId",
  OrderItem: "id orderId createdAt updatedAt tenantId",
  EstimateItem: "id estimateId createdAt updatedAt tenantId",
  RecurringInvoiceItem: "id recurringInvoiceId tenantId",
  ReturnItem: "id returnId tenantId",
  CreditNoteItem: "id tenantId creditNoteId createdAt",
};

const ORDER_FRESH = "deliveredQty invoicedQty overrideReason overriddenBy status";
const MERGE = {
  file: "orders/orders.service.ts",
  target: "OrderItem" as const,
  anchor: { via: "delegate", model: "orderItem" } as Anchor,
  carried:
    "productId name qty unitPrice subtotal priceType originalPrice promoFreeUnits boxes pieces unitsPerBox notes overrideReason overriddenBy status trackedCategoryId " +
    // B297: the loser line's trio, via `...copyCategoryTaxSnapshot(meta)` (SPREAD_HELPER_KEYS).
    "categoryTaxType categoryTaxRate categoryPriceIncludesTax",
  rederived: "categoryTaxAmount", // recomputeLineCategoryTaxes after the fold
  na: "deliveredQty invoicedQty",
  gaps: {
    // B776/SA-124a (#938): buildMergeLineWrites now carries the contributing line's OWN
    // snapshot pack through every write (the whole point of the fix — never re-split at the
    // live product's CURRENT pack) — unitsPerBox moved to carried above, gap closed.
    unitLabel: "unfiled",
    trackedSubcategoryId: "unverified",
    position: "unverified",
  } as Record<string, GapRef>,
};

export const COPIERS: Copier[] = [
  {
    id: "C1",
    file: "invoices/invoices.service.ts",
    fn: "buildInvoiceItemData",
    target: "InvoiceItem",
    anchor: { via: "return" },
    carried:
      "productId qty unitPrice subtotal boxes pieces unitsPerBox unitLabel promoFreeUnits originalPrice priceType notes categoryTaxAmount orderItemId trackedCategoryId trackedSubcategoryId " +
      "categoryTaxType categoryTaxRate categoryPriceIncludesTax", // B297: the order line's own trio, verbatim
    rederived: "description msrp taxRate",
    reset: "discount",
  },
  {
    id: "C2",
    file: "invoices/invoices.service.ts",
    fn: "duplicate",
    target: "InvoiceItem",
    anchor: { via: "prop", name: "items" },
    carried:
      "description productId qty unitPrice discount taxRate boxes pieces promoFreeUnits msrp subtotal trackedCategoryId trackedSubcategoryId categoryTaxAmount unitsPerBox originalPrice priceType notes " +
      "categoryTaxType categoryTaxRate categoryPriceIncludesTax", // B297: the source line's trio, verbatim
    na: "unitLabel orderItemId", // unit lines are refused (409); order-linked invoices are refused (RF-011)
  },
  {
    id: "C4",
    file: "estimates/estimates.service.ts",
    fn: "create",
    target: "EstimateItem",
    anchor: { via: "prop", name: "items" },
    carried:
      "description productId qty unitPrice subtotal priceType originalPrice boxes pieces unitsPerBox",
    gaps: { unitLabel: "unfiled" },
  },
  // C5 (estimate -> invoice). Since B659 (#1279) convertToInvoice writes `items: { create: itemsData }`
  // from the SHARED builder, so the entry anchors on the builder and classifies it FROM THE ESTIMATE
  // PATH (estimateConvertLineItems feeds it). InvoicesService.create also uses this builder for request
  // lines; that caller is NOT_A_COPIER ("primary create from request lines").
  {
    id: "C5",
    file: "invoices/manual-invoice-lines.ts",
    fn: "buildManualInvoiceLines",
    target: "InvoiceItem",
    // `nested`: the builder's own `return { itemsData, subtotal }` must not count as a written line.
    anchor: { via: "return", nested: true },
    carried: "description productId qty unitPrice subtotal boxes pieces unitsPerBox",
    // B659: the category tax is priced at CONVERT time from the live category (never a quote-date
    // rate), and the B297 trio is stamped beside it (`...categorySnapshot`, an opaque spread).
    rederived:
      "taxRate msrp trackedCategoryId trackedSubcategoryId categoryTaxAmount categoryTaxType categoryTaxRate categoryPriceIncludesTax",
    reset: "discount",
    // The estimate line has no such column / no order link; unit-aware lines are refused (409 UNIT_AWARE_LINE).
    na: "promoFreeUnits notes orderItemId unitLabel",
    gaps: { priceType: "unfiled", originalPrice: "unfiled" },
  },
  {
    id: "C6",
    file: "recurring-invoices/recurring-invoices.service.ts",
    fn: "generateInvoiceFromTemplate",
    target: "InvoiceItem",
    anchor: { via: "prop", name: "items" },
    carried: "description productId qty unitPrice discount taxRate",
    // InvoicesService.create prices the category tax and stamps the B297 trio from the LIVE category.
    rederived:
      "subtotal msrp categoryTaxAmount categoryTaxType categoryTaxRate categoryPriceIncludesTax",
    na: "originalPrice priceType promoFreeUnits notes orderItemId", // RecurringInvoiceItem has none of these columns
    gaps: {
      boxes: "B646",
      pieces: "B646",
      unitsPerBox: "B646",
      unitLabel: "unfiled",
      trackedCategoryId: "unverified",
      trackedSubcategoryId: "unverified",
    },
  },
  {
    id: "C7",
    file: "order-templates/order-templates.service.ts",
    fn: "createOrderFromTemplate",
    target: "OrderItem",
    anchor: { via: "prop", name: "lineItems" },
    carried: "productId qty notes",
    // B658: categoryTaxAmount is now priced from the live category (it was a hard 0), and B297 stamps
    // the trio beside it (`...categorySnapshot`, an opaque spread: presence is not checked).
    rederived:
      "unitPrice subtotal priceType originalPrice promoFreeUnits trackedCategoryId categoryTaxAmount categoryTaxType categoryTaxRate categoryPriceIncludesTax",
    na: ORDER_FRESH,
    gaps: {
      boxes: "B647",
      pieces: "B647",
      unitsPerBox: "B647",
      trackedSubcategoryId: "B658",
      unitLabel: "unfiled",
      name: "unfiled",
      position: "unfiled",
    },
  },
  {
    id: "C8",
    file: "orders/change-requests.service.ts",
    fn: "approveNextDelivery",
    target: "OrderItem",
    anchor: { via: "prop", name: "items" },
    carried: "productId qty boxes pieces",
    // The new line is written by OrdersService.create, which stamps the B297 trio from the live category.
    // D-20 / #1808 (SA-330): unitsPerBox, unitPrice, priceType and originalPrice are the SOURCE line's, passed as
    // create()'s INTERNAL `options.sourceLines` (orders/source-line.ts), never the live pack or today's price;
    // the contract checks each key is in approveNextDelivery's `sourceLines` literal. The subtotal is re-derived
    // by computeLineSubtotal at that carried pack and price; promoFreeUnits is 0 for a rollover line.
    viaOptions: "unitsPerBox unitPrice priceType originalPrice overrideReason overriddenBy",
    rederived:
      "name subtotal promoFreeUnits trackedCategoryId trackedSubcategoryId categoryTaxAmount position categoryTaxType categoryTaxRate categoryPriceIncludesTax",
    na: "deliveredQty invoicedQty status", // overrideReason/overriddenBy ride viaOptions (D-20)
    gaps: {
      unitLabel: "unfiled",
      notes: "unverified",
    },
  },
  { id: "C9a", fn: "mergeAllPendingForCustomer", ...MERGE },
  { id: "C9b", fn: "forceConsolidateCustomer", ...MERGE },
  {
    id: "C10",
    file: "credit-notes/credit-notes.service.ts",
    fn: "create",
    target: "CreditNoteItem",
    coverage: "registry-only",
    why: "the rows are `{ ...i, creditNoteId, tenantId }` spread from validateAndBuildCnItems output: no local literal to read",
  },
  {
    id: "C11",
    file: "returns/returns.service.ts",
    fn: "create",
    target: "ReturnItem",
    anchor: { via: "prop", name: "items" },
    carried: "productId qty reason restock condition notes",
    na: "unitPrice subtotal taxAmount categoryTax priceSource originalPrice overrideReason overriddenBy", // priced later by priceReturn
    gaps: {
      boxes: "B665",
      pieces: "B665",
      unitsPerBox: "B665",
      sourceOrderId: "unfiled",
      sourceInvoiceItemId: "unfiled",
      sourceOrderItemId: "unfiled",
    },
  },
  {
    id: "C12",
    file: "returns/inline-returns.service.ts",
    fn: "captureInTx",
    target: "ReturnItem",
    anchor: { via: "prop", name: "items" },
    carried:
      "productId reason restock condition sourceOrderId sourceInvoiceItemId sourceOrderItemId unitPrice subtotal taxAmount categoryTax priceSource originalPrice overrideReason overriddenBy",
    rederived: "qty", // TRUE pieces, unlike C11 (B660)
    gaps: { boxes: "B660", pieces: "B660", unitsPerBox: "B660", notes: "unverified" },
  },
  {
    id: "C14",
    file: "import/import.service.ts",
    fn: "importInvoices",
    target: "InvoiceItem",
    anchor: { via: "push", name: "itemsData" },
    carried: "description productId qty unitPrice subtotal discount",
    reset: "taxRate", // forced 0
    na: "originalPrice msrp priceType boxes pieces unitsPerBox promoFreeUnits notes orderItemId trackedCategoryId trackedSubcategoryId categoryTaxAmount unitLabel categoryTaxType categoryTaxRate categoryPriceIncludesTax",
  }, // CSV: per-piece by construction
  // C17 (not in R-ui's first table: the discovery pass found it; R-ui then verified it, invoices.service.ts
  // 2273-2420, callers 3540/3601/6342 = invoice edit and status flows). It UPDATES an existing order line, and
  // CREATES a new OrderItem when an invoice line has a productId and matches no order line. Only the CREATE
  // branch is checked here (delegate orderItem.create). CREATE loses name, priceType (falls to the column
  // default STANDARD even for a promo line), originalPrice, notes, unitLabel, position, and both tracked ids
  // although the aggregate sample carries them; readers fall back to the LIVE product (invoices.service.ts
  // 990/1018/1099), the same "live re-derive" class as C1's description, not a new leak.
  // UNVERIFIED: UPDATE forces status PENDING and invoicedQty = qty on EVERY recompute; whether that flips a
  // DELIVERED or CANCELLED line is untraced (status and invoicedQty sit under `reset` until it is).
  {
    id: "C17",
    file: "invoices/invoices.service.ts",
    fn: "recomputeOrderFromInvoices",
    target: "OrderItem",
    anchor: { via: "delegate", model: "orderItem" },
    carried:
      "productId qty unitPrice subtotal boxes pieces unitsPerBox categoryTaxAmount promoFreeUnits",
    reset: "priceType status invoicedQty",
    rederived: "name trackedSubcategoryId",
    na: "deliveredQty overrideReason overriddenBy",
    gaps: {
      trackedCategoryId: "B767", // CREATE carries categoryTaxAmount without its category attribution
      originalPrice: "unfiled",
      notes: "unfiled",
      unitLabel: "unfiled",
      position: "unfiled",
      // B297: CREATE carries the invoice lines' categoryTaxAmount but not the trio it was priced at.
      categoryTaxType: "B835",
      categoryTaxRate: "B835",
      categoryPriceIncludesTax: "B835",
    },
  },
  // Client copiers: NOT column-checked (the spec is API-side; a request body is not a Prisma model).
  // C3 (web Duplicate rebuild) was retired by B644 (#1159): the button now calls the server endpoint. The client set is C15, C16.
  {
    id: "C15",
    file: "apps/mobile/lib/order-tracking-logic.ts",
    fn: "buildReorderItems",
    target: "OrderItem",
    coverage: "registry-only",
    why: "mobile reorder request body",
  },
  {
    id: "C16a",
    file: "apps/web/app/(dashboard)/invoices/[id]/edit/page.tsx",
    fn: "",
    target: "InvoiceItem",
    coverage: "registry-only",
    why: "web invoice edit PATCH replace-all",
  },
  {
    id: "C16b",
    file: "apps/mobile/lib/invoice-totals.ts",
    fn: "invoiceLineDto",
    target: "InvoiceItem",
    coverage: "registry-only",
    why: "mobile invoice edit PATCH line DTO (B656)",
  },
];

/** Functions that write the target models but do not COPY a line; each needs its reason. */
export const NOT_A_COPIER: Record<string, string> = {
  "invoices/invoices.service.ts::create": "primary create from request lines",
  "invoices/invoices.service.ts::update":
    "replace-all from the edit request (the client side is C16)",
  "invoices/invoices.service.ts::runCreation": "consumes C1's output",
  "estimates/estimates.service.ts::convertToInvoice":
    "consumes C5's builder (buildManualInvoiceLines)",
  "invoices/invoices.service.ts::reconcileOrderDraftInvoice": "consumes C1's output",
  "invoices/invoices.service.ts::rebuildSiblingDrafts": "consumes C1's output",
  "invoices/invoices.service.ts::setCheckStatus": "synthesises the NSF fee line, not a copy",
  "order-templates/order-templates.service.ts::create": "template lines from the request",
  "order-templates/order-templates.service.ts::update": "template lines from the request",
  "orders/orders.service.ts::create": "primary create from request lines",
  "orders/orders.service.ts::updateOrderItems": "order edit from the request",
  "orders/unit-line-edit.ts::createUnitLine":
    "units_v1 line create inside updateOrderItems' order edit, from the request (not a copy)",
  "orders/orders.service.ts::approveChangeRequestAtStop":
    "at-door line from the change-request payload",
  "recurring-invoices/recurring-invoices.service.ts::create": "template lines from the request",
  "recurring-invoices/recurring-invoices.service.ts::update": "template lines from the request",
  // C13: a JSON snapshot (OrderRevision.snapshot.lineItems), not a line model. It DROPS unitLabel,
  // deliveredQty, promoFreeUnits, categoryTaxAmount and position; readers see boxes for a Case.
  "orders/orders.service.ts::appendOrderRevision":
    "C13: JSON snapshot; drops unitLabel deliveredQty promoFreeUnits categoryTaxAmount position",
};

/** Whole files that write items of OTHER models (the discovery pass matches relation names, not types). */
export const NOT_SALES_FILES: Record<string, string> = {
  "bookkeeping/bookkeeping.service.ts": "expense line items",
  "inventory/inventory.service.ts": "purchase-order items",
  "vendor-bills/vendor-bills.service.ts": "vendor-bill items",
};
