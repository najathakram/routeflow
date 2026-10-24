import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

/**
 * units_v1 — structural proof about every code path that WRITES order or invoice lines. It replaces
 * the earlier literal-text pins (L-205: assert behaviour/structure, never scraped source text).
 *
 * How it works (TypeScript AST, no regex over source):
 *   1. INVENTORY  — every class method under apps/api/src that performs a write on an
 *      `orderItem`/`invoiceItem` delegate, or a nested `lineItems`/`items` `create|update|delete…`.
 *      The set must EQUAL the classification table below, both ways: a NEW writer fails until it is
 *      classified (and, if it can touch a unit-aware line, guarded or converted); a removed/renamed
 *      one fails until its row is dropped.
 *   2. CALL PROOF — a method classified GUARDED must contain a real CallExpression to the named
 *      guard function; SAFE_COPY must call `buildInvoiceItemData` (which copies the line's own
 *      snapshot); CONVERTED must call `resolveLineUnits`. AST calls, so a comment, a string or a
 *      renamed method cannot satisfy it.
 *   3. NULL-TENANT — the guard module and the unit CRUD service must never read `orderItem` /
 *      `invoiceItem` top-level: `forTenant()` scopes those by the ITEM's nullable tenantId, so a
 *      NULL-tenant line would be invisible. They read through the parent order/invoice relation.
 *
 * Converting a writer (steps 4b-2/4c) = change its row here to CONVERTED in the same PR.
 */
type Kind =
  | "GUARDED" // rewrites/merges existing lines — refuses a unit-aware line (needs the named call)
  | "SAFE_COPY" // copies a line's own snapshot via buildInvoiceItemData
  | "CONVERTED" // resolves the factor through resolveLineUnits
  | "PACK_ONLY_CREATE" // creates PACK lines only today (no DTO carries a unit); convert in 4b-2/4c
  | "DELETE_ONLY" // removes lines; cannot mis-price one
  | "FIELD_ONLY" // writes status / deliveredQty / invoicedQty / categoryTax — never factor or price
  | "SYNC_BACK" // invoice -> order back-sync, reachable for a unit-aware line only via a GUARDED path
  | "NOT_ORDER_INVOICE_LINE"; // a different model's `items` (estimate, PO, template, bill, return…)

interface Row {
  kind: Kind;
  why: string;
  needs?: string;
  /**
   * HYBRID rows only (units_v1 A1): additional named calls that must ALSO precede the first line
   * write. `updateOrderItems` is the one row that is neither purely GUARDED nor purely CONVERTED —
   * STAFF is converted (resolves + builds via `resolveLineUnits`), CUSTOMER/DRIVER stay refused by
   * the narrowed `assertOrderEditAllowed`. A plain CONVERTED row has no ordering requirement; a
   * HYBRID one is checked on BOTH its `needs` call and every `alsoNeeds` call.
   */
  alsoNeeds?: string[];
  /**
   * B297 (SA-098a) — an opt-in, per-row list of acceptable proofs that a method which creates a
   * line carrying `trackedCategoryId` also produces the rate trio (`categoryTaxType`/Rate/
   * PriceIncludesTax), rather than leaving it null. Any ONE entry satisfies it: a call to a
   * trio-deriving/copying helper (`categoryTaxSnapshotOf`, `copyCategoryTaxSnapshot`,
   * `buildInvoiceItemData`, `buildManualInvoiceLines`, `categoryTaxForLine`),
   * or — for a method that copies the trio inline rather than through a named helper — a direct
   * reference to the `categoryTaxType` field name (existence only, EXACTLY the same permissiveness
   * SAFE_COPY's own `needs` check already uses; not an ordering proof). Retires the file-count-pin
   * `category-tax-trio-callsites.spec.ts` guard's per-row job for the rows listed here — that guard
   * stays alive for its OTHER job (a global "no NEW categoryTaxAmount-writing site anywhere in
   * apps/api/src goes unnoticed" count pin), which this opt-in list does not replicate. Only rows
   * this session actually read and verified carry the field; an unmarked creator is not a claim
   * that it's fine — it is simply out of THIS round's audited scope.
   */
  trioVia?: string[];
  /**
   * SA-100 hardening — the explicit, reasoned escape hatch: a row whose line-write literally sets
   * `trackedCategoryId` (so the MANDATORY check below would otherwise demand `trioVia`) but never
   * legitimately needs the trio, e.g. a literal `trackedCategoryId: null` constant on a line that
   * can never be regulated. Required in place of `trioVia`, never both.
   */
  trioViaExempt?: string;
}

const G = "assertOrderEditAllowed";
const INVENTORY: Record<string, Row> = {
  // ── orders ──────────────────────────────────────────────────────────────────
  "orders/orders.service.ts::OrdersService.updateOrderItems": {
    kind: "CONVERTED",
    alsoNeeds: [G],
    why: "HYBRID (units_v1 A1): staff resolves+builds every unit-aware site via resolveLineUnits (resolved once, up front, into a map — unit-line-edit.ts); CUSTOMER/DRIVER stay refused by the narrowed assertOrderEditAllowed",
    trioVia: ["categoryTaxSnapshotOf"],
  },
  "orders/orders.service.ts::OrdersService.approveChangeRequestAtStop": {
    kind: "GUARDED",
    needs: "assertChangeTargetAllowed",
    why: "CHANGE_QTY/ADD_ITEM match by productId at the live pack",
    trioVia: ["categoryTaxSnapshotOf"],
  },
  "orders/orders.service.ts::OrdersService.forceConsolidateCustomer": {
    kind: "GUARDED",
    needs: "assertNoUnitAwareLines",
    why: "merge folds by productId",
    // SA-124 (Opus review of B776): `trioVia: ["buildMergeLineWrites"]` (this method's earlier
    // pin) passed even if the inline `categoryTaxType`/`categoryTaxRate`/`categoryPriceIncludesTax`
    // keys were deleted from THIS method's own create() literal — `references()` only checks
    // that the method mentions the name `buildMergeLineWrites` somewhere, not that the write
    // literal it applies actually carries the trio. Named on the STAMP itself instead
    // (`categoryTaxType`, a literal key AND a read of `write.data.categoryTaxType` in the
    // create() call below), same as `InvoicesService.duplicate`'s inline-copy row.
    trioVia: ["categoryTaxType"],
  },
  "orders/orders.service.ts::OrdersService.mergeAllPendingForCustomer": {
    kind: "GUARDED",
    needs: "isUnitAwareLine",
    why: "merge folds by productId; bails out when any candidate is unit-aware",
    // SA-124: see forceConsolidateCustomer's note — named on the stamp, not the caller.
    trioVia: ["categoryTaxType"],
  },
  "orders/orders.service.ts::OrdersService.create": {
    kind: "CONVERTED",
    why: "resolveLineUnits decides pack vs unit; buildUnitLine builds the unit line (4b-2b)",
    trioVia: ["categoryTaxSnapshotOf"],
  },
  // B297 PR3: moved out of OrdersService verbatim in shape; it now also stamps a NULL rate trio, once.
  "orders/recompute-line-category-taxes.ts::recomputeLineCategoryTaxes": {
    kind: "FIELD_ONLY",
    why: "categoryTaxAmount, plus the rate trio on a NULL-trio line (stamped once); prices at the line snapshot first",
  },
  // B297 row 355: re-allocates a split product's BUY_N_GET_M free units across its lines after an edit.
  "orders/settle-split-free-units.ts::settleSplitFreeUnits": {
    kind: "FIELD_ONLY",
    why: "promoFreeUnits and the subtotal it implies (computeLineSubtotal); never a factor, quantity or unit price",
  },
  // SA-762r F1: the cancel's line status flip, moved verbatim out of changeStatus into the shared unwind.
  "orders/order-cancel-tx.ts::cancelOrderInTx": {
    kind: "FIELD_ONLY",
    why: "line status flips (CANCELLED); never factor or price",
  },
  // SA-762r: the counter-sale void zeroes deliveredQty on unevidenced lines before it cancels.
  "orders/delivered-stamp.ts::clearUnevidencedDelivered": {
    kind: "FIELD_ONLY",
    why: "deliveredQty reset to 0 on lines with no delivery evidence",
  },
  // SA-763r: a DELIVERED write / edit books what left, on lines with no delivery evidence.
  "orders/delivered-stamp.ts::stampDeliveredInFull": {
    kind: "FIELD_ONLY",
    why: "deliveredQty raised on lines with no delivery evidence; never factor or price",
  },
  // Row 587 (SA-833): PD -> DELIVERED completes office-evidenced lines to their qty.
  "orders/office-evidence-completion.ts::completeOfficeEvidencedLines": {
    kind: "FIELD_ONLY",
    why: "deliveredQty raised to qty on office-evidenced lines at a DELIVERED write; never factor or price",
  },
  "orders/orders.service.ts::OrdersService.reopenOrder": {
    kind: "FIELD_ONLY",
    why: "line status flips",
  },
  "orders/orders.service.ts::OrdersService.deleteOrder": {
    kind: "DELETE_ONLY",
    why: "removes the order's lines",
  },
  "order-templates/order-templates.service.ts::OrderTemplatesService.createOrderFromTemplate": {
    kind: "PACK_ONLY_CREATE",
    why: "OrderTemplateItem has no unit column; creates pack lines",
    trioVia: ["categoryTaxSnapshotOf"],
  },
  "routes/routes.service.ts::RoutesService.completeWithPayment": {
    kind: "FIELD_ONLY",
    why: "deliveredQty verbatim",
  },
  "routes/routes.service.ts::RoutesService.reopenStop": {
    kind: "FIELD_ONLY",
    why: "resets status/deliveredQty",
  },
  // ── invoices ────────────────────────────────────────────────────────────────
  "invoices/invoices.service.ts::InvoicesService.update": {
    kind: "GUARDED",
    needs: "assertInvoiceRewriteAllowed",
    why: "delete-and-recreate re-split at the live pack; VU-4a (D3): an order-less DRAFT edit also resolves a unit line via resolveLineUnits in update() itself, and still calls the back-sync only behind this guard",
    trioVia: ["buildEditedLines"],
  },
  "invoices/invoices.service.ts::InvoicesService.duplicate": {
    kind: "GUARDED",
    needs: "assertNoUnitAwareLines",
    why: "the copy drops unitLabel/unitsPerBox",
    // Copies the trio inline (verbatim, `categoryTaxType: (i as any).categoryTaxType ?? null`) —
    // no named helper call to point at.
    trioVia: ["categoryTaxType"],
  },
  "invoices/invoices.service.ts::InvoicesService.applyPriceAdjustment": {
    kind: "GUARDED",
    needs: "assertNoUnitAwareLines",
    why: "bulk scope keys a price by productId",
    // Re-derives categoryTaxAmount for an EXISTING line's new price — never touches the trio
    // fields (a price-only adjustment must preserve them, not a creator).
  },
  "invoices/invoices.service.ts::InvoicesService.create": {
    kind: "CONVERTED",
    why: "resolveLineUnits per item; buildManualInvoiceLines builds the unit line (4c-1)",
    trioVia: ["buildManualInvoiceLines"],
  },
  "invoices/invoices.service.ts::InvoicesService.createSplitInvoices": {
    kind: "SAFE_COPY",
    needs: "buildInvoiceItemData",
    why: "copies the order line via the shared builder",
    trioVia: ["buildInvoiceItemData"],
  },
  "invoices/invoices.service.ts::InvoicesService.reconcileOrderDraftInvoiceLocked": {
    kind: "SAFE_COPY",
    needs: "buildInvoiceItemData",
    why: "copies via the shared builder",
    trioVia: ["buildInvoiceItemData"],
  },
  "invoices/invoices.service.ts::InvoicesService.rebuildSiblingDrafts": {
    kind: "SAFE_COPY",
    needs: "buildInvoiceItemData",
    why: "copies via the shared builder",
    trioVia: ["buildInvoiceItemData"],
  },
  "invoices/invoices.service.ts::InvoicesService.createPartialFromOrder": {
    kind: "SAFE_COPY",
    needs: "buildInvoiceItemData",
    why: "copies via the shared builder",
    trioVia: ["buildInvoiceItemData"],
  },
  "invoices/invoices.service.ts::InvoicesService.recomputeOrderFromInvoices": {
    kind: "SYNC_BACK",
    why: "reachable for a unit-aware line only through invoices.update (guarded) or a single-invoice re-price (multiplier from the line itself)",
    // Row 373 (closes B767 / B835): its CREATE carries the category, subcategory and rate trio from the invoice
    // line (the source line's own snapshot), via copyCategoryTaxSnapshot.
    trioVia: ["copyCategoryTaxSnapshot"],
  },
  "invoices/invoices.service.ts::InvoicesService.resyncOrderInvoicesForEdit": {
    kind: "FIELD_ONLY",
    why: "invoicedQty bookkeeping",
  },
  "invoices/invoices.service.ts::InvoicesService.adjustInvoicedQtyForInvoice": {
    kind: "FIELD_ONLY",
    why: "invoicedQty only",
  },
  "invoices/invoices.service.ts::InvoicesService.setCheckStatus": {
    kind: "FIELD_ONLY",
    why: "adds a product-less NSF fee line",
  },
  "invoices/invoices.service.ts::InvoicesService.deleteInvoice": {
    kind: "DELETE_ONLY",
    why: "removes the invoice's lines",
  },
  "estimates/estimates.service.ts::EstimatesService.convertToInvoice": {
    kind: "CONVERTED",
    why: "unit-aware estimate lines are refused pre-flight (assertNoUnitAwareLines) before reserveNext; convertToInvoice stays CONVERTED — it still calls resolveLineUnits per line inside the tx, and buildManualInvoiceLines builds the invoice lines (B659)",
  },
  "import/import.service.ts::ImportService.importInvoices": {
    kind: "PACK_ONLY_CREATE",
    why: "flat qty x unitPrice import",
  },
  // ── deletes elsewhere ───────────────────────────────────────────────────────
  "customers/customers.service.ts::CustomersService.deleteCustomer": {
    kind: "DELETE_ONLY",
    why: "customer purge",
  },
  "customers/customers.service.ts::CustomersService.deleteAllCustomers": {
    kind: "DELETE_ONLY",
    why: "customer purge",
  },
  "customers/customers.service.ts::CustomersService.runImportedCustomersCleanup": {
    kind: "DELETE_ONLY",
    why: "customer purge",
  },
  "system-config/settings.controller.ts::SettingsController.clearFinancialData": {
    kind: "DELETE_ONLY",
    why: "financial reset",
  },
  // ── other models that also call their relation `items` ──────────────────────
  "bookkeeping/bookkeeping.service.ts::BookkeepingService.createExpense": {
    kind: "NOT_ORDER_INVOICE_LINE",
    why: "expense lineItems",
  },
  "estimates/estimates.service.ts::EstimatesService.create": {
    kind: "NOT_ORDER_INVOICE_LINE",
    why: "EstimateItem",
  },
  "inventory/inventory.service.ts::InventoryService.createPurchaseOrder": {
    kind: "NOT_ORDER_INVOICE_LINE",
    why: "PurchaseOrderItem",
  },
  "inventory/inventory.service.ts::InventoryService.updatePurchaseOrder": {
    kind: "NOT_ORDER_INVOICE_LINE",
    why: "PurchaseOrderItem",
  },
  "inventory/inventory.service.ts::InventoryService.createDraftPurchaseOrderInTx": {
    kind: "NOT_ORDER_INVOICE_LINE",
    why: "PurchaseOrderItem",
  },
  "order-templates/order-templates.service.ts::OrderTemplatesService.create": {
    kind: "NOT_ORDER_INVOICE_LINE",
    why: "OrderTemplateItem",
  },
  "order-templates/order-templates.service.ts::OrderTemplatesService.update": {
    kind: "NOT_ORDER_INVOICE_LINE",
    why: "OrderTemplateItem",
  },
  "recurring-invoices/recurring-invoices.service.ts::RecurringInvoicesService.create": {
    kind: "NOT_ORDER_INVOICE_LINE",
    why: "RecurringInvoiceItem",
  },
  "recurring-invoices/recurring-invoices.service.ts::RecurringInvoicesService.update": {
    kind: "NOT_ORDER_INVOICE_LINE",
    why: "RecurringInvoiceItem",
  },
  "returns/inline-returns.service.ts::InlineReturnsService.captureInTx": {
    kind: "NOT_ORDER_INVOICE_LINE",
    why: "ReturnItem",
  },
  "returns/returns.service.ts::ReturnsService.create": {
    kind: "NOT_ORDER_INVOICE_LINE",
    why: "ReturnItem",
  },
  "vendor-bills/vendor-bills.service.ts::VendorBillsService.create": {
    kind: "NOT_ORDER_INVOICE_LINE",
    why: "VendorBillItem",
  },
  "vendor-bills/vendor-bills.service.ts::VendorBillsService.update": {
    kind: "NOT_ORDER_INVOICE_LINE",
    why: "VendorBillItem",
  },
  "vendor-bills/vendor-bills.service.ts::VendorBillsService.receive": {
    kind: "NOT_ORDER_INVOICE_LINE",
    why: "VendorBillItem",
  },
  "vendor-bills/vendor-bills.service.ts::VendorBillsService.revertToDraft": {
    kind: "NOT_ORDER_INVOICE_LINE",
    why: "VendorBillItem",
  },
  "vendor-bills/vendor-bills.service.ts::VendorBillsService.delete": {
    kind: "NOT_ORDER_INVOICE_LINE",
    why: "VendorBillItem: AP bill line delete only: no qty/unit/price write, no sellable product added",
  },
  "vendor-bills/vendor-bills.service.ts::VendorBillsService.bulkDelete": {
    kind: "NOT_ORDER_INVOICE_LINE",
    why: "VendorBillItem: AP bill line delete only: no qty/unit/price write, no sellable product added",
  },
};

/** Methods that are not writers but decide merge targets / roll lines forward: they must guard too. */
const GUARD_SITES: Array<{ key: string; needs: string }> = [
  {
    key: "orders/orders.service.ts::OrdersService.findActiveOrder",
    needs: "ORDER_HAS_NO_UNIT_AWARE_LINE",
  },
  {
    key: "orders/change-requests.service.ts::ChangeRequestsService.approveNextDelivery",
    needs: "assertNoUnitAwareLines",
  },
];

// ─── scanner (exported shape kept tiny; exercised on inline source below) ─────────────────────
const WRITE_OPS = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "delete",
  "deleteMany",
  "upsert",
]);
const READ_OPS = new Set([
  "findMany",
  "findFirst",
  "findUnique",
  "findFirstOrThrow",
  "findUniqueOrThrow",
  "count",
  "aggregate",
  "groupBy",
]);
const LINE_TABLES = new Set(["orderItem", "invoiceItem"]);
const NESTED_RELATIONS = new Set(["lineItems", "items"]);
const NESTED_OPS = new Set([
  "create",
  "createMany",
  "deleteMany",
  "delete",
  "update",
  "updateMany",
  "upsert",
  "set",
]);

const parse = (name: string, text: string) =>
  ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);

type WriterNode = ts.MethodDeclaration | ts.FunctionDeclaration;

function classMethods(sf: ts.SourceFile): Map<string, ts.MethodDeclaration> {
  const out = new Map<string, ts.MethodDeclaration>();
  const visit = (n: ts.Node) => {
    if (ts.isClassDeclaration(n) && n.name) {
      for (const m of n.members) {
        if (ts.isMethodDeclaration(m) && m.name) out.set(`${n.name.text}.${m.name.getText(sf)}`, m);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/**
 * SA-762r: exported top-level FUNCTIONS. An extraction such as order-cancel-tx.ts moves a class method's line write into
 * one, and a class-method-only scan silently lost it (the row for the method went stale, the write went unclassified).
 * Files listed in FREE_WRITER_FILES are scanned for their exported functions too, keyed `file::functionName`; the
 * inventory then proves each such row exists. A free-function line writer in `orders/` that is neither listed nor in
 * KNOWN_UNSCANNED_FREE_WRITERS fails the baseline test below, so a NEW extraction cannot lose its writes again.
 */
const FREE_WRITER_FILES = [
  "orders/order-cancel-tx.ts",
  "orders/delivered-stamp.ts",
  "orders/office-evidence-completion.ts",
  "orders/recompute-line-category-taxes.ts",
  "orders/settle-split-free-units.ts",
];
/** Pre-existing free-function line writers under orders/ that predate this scan (shrink-only; classify one to remove it). */
const KNOWN_UNSCANNED_FREE_WRITERS = [
  "orders/line-composition.ts::syncLineCompositions",
  "orders/merge-lock-recheck.ts::deleteLoserGuarded",
  "orders/order-edit-composition.ts::restoreCarriedComposition",
  "orders/order-line-removal.ts::writeLineRemoval",
  "orders/order-line-removal.ts::writeLineUpdate",
  "orders/testing/merge-recheck.ts::pass",
  "orders/unit-line-edit.ts::createUnitLine",
];

/**
 * The `data` keys of every direct `orderItem`/`invoiceItem` write inside `node` (a spread or a non-literal `data` reads
 * as "...", which no allow-list contains). Lets a FIELD_ONLY row of a free function PROVE it never writes a price.
 */
function lineWriteDataKeys(node: ts.Node): string[] {
  const keys = new Set<string>();
  const visit = (n: ts.Node) => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      WRITE_OPS.has(n.expression.name.text) &&
      ts.isPropertyAccessExpression(n.expression.expression) &&
      LINE_TABLES.has(n.expression.expression.name.text)
    ) {
      const arg = n.arguments[0];
      const data =
        arg && ts.isObjectLiteralExpression(arg)
          ? arg.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText() === "data")
          : undefined;
      const lit = data && ts.isPropertyAssignment(data) ? data.initializer : undefined;
      if (lit && ts.isObjectLiteralExpression(lit))
        for (const p of lit.properties)
          keys.add(
            ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)
              ? p.name.getText()
              : "...",
          );
      else keys.add("...");
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return [...keys].sort();
}

/** The only line columns each FREE_WRITER_FILES FIELD_ONLY row may write (exact set: adding a price or a qty fails). */
const FREE_WRITER_DATA_KEYS: Record<string, string[]> = {
  "orders/order-cancel-tx.ts::cancelOrderInTx": ["status"],
  "orders/delivered-stamp.ts::clearUnevidencedDelivered": ["deliveredQty"],
  "orders/delivered-stamp.ts::stampDeliveredInFull": ["deliveredQty"],
  "orders/office-evidence-completion.ts::completeOfficeEvidencedLines": ["deliveredQty"],
  "orders/settle-split-free-units.ts::settleSplitFreeUnits": ["promoFreeUnits", "subtotal"],
  "orders/recompute-line-category-taxes.ts::recomputeLineCategoryTaxes": [
    "categoryPriceIncludesTax",
    "categoryTaxAmount",
    "categoryTaxRate",
    "categoryTaxType",
  ],
};

function exportedFunctions(sf: ts.SourceFile): Map<string, ts.FunctionDeclaration> {
  const out = new Map<string, ts.FunctionDeclaration>();
  for (const st of sf.statements) {
    if (
      ts.isFunctionDeclaration(st) &&
      st.name &&
      st.body &&
      st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    )
      out.set(st.name.text, st);
  }
  return out;
}

/** Everything the inventory scans in one file: class methods, plus the exported functions of FREE_WRITER_FILES. */
function writerUnits(sf: ts.SourceFile, file: string): Map<string, WriterNode> {
  return new Map<string, WriterNode>([
    ...classMethods(sf),
    ...(FREE_WRITER_FILES.includes(file) ? exportedFunctions(sf) : []),
  ]);
}

/** Object literals an initializer can evaluate to: `{..}`, `c ? {..} : undefined`, `({..})`, `{..} as T`. */
function objectLiterals(e: ts.Expression): ts.ObjectLiteralExpression[] {
  if (ts.isObjectLiteralExpression(e)) return [e];
  if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e))
    return objectLiterals(e.expression);
  if (ts.isConditionalExpression(e))
    return [...objectLiterals(e.whenTrue), ...objectLiterals(e.whenFalse)];
  return [];
}

function lineWrites(node: ts.Node, sf: ts.SourceFile): string[] {
  const hits: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const table = n.expression.expression;
      if (
        WRITE_OPS.has(n.expression.name.text) &&
        ts.isPropertyAccessExpression(table) &&
        LINE_TABLES.has(table.name.text)
      ) {
        hits.push(`${table.name.text}.${n.expression.name.text}`);
      }
    }
    if (ts.isPropertyAssignment(n) && NESTED_RELATIONS.has(n.name.getText(sf))) {
      for (const lit of objectLiterals(n.initializer)) {
        for (const p of lit.properties) {
          if (p.name && NESTED_OPS.has(p.name.getText(sf)))
            hits.push(`nested ${n.name.getText(sf)}.${p.name.getText(sf)}`);
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return [...new Set(hits)];
}

/**
 * SA-100 hardening — every line-write's own `data:` object literal (a direct `x.orderItem.create/
 * update({ data: {...} })` call) that ALSO sets `key` as a property, i.e. "this write can touch a
 * regulated line." Backs the MANDATORY trioVia check below: a row that writes `trackedCategoryId`
 * has no excuse to skip declaring how it produces the trio.
 *
 * LIMIT (same class as this file's other documented limits): only DIRECT table calls are checked —
 * a nested `lineItems`/`items` relation write is invisible here, same as `lineWrites` already
 * documents for its own NULL-tenant/B635 blind spots. No currently-classified row relies on a
 * nested write to set `trackedCategoryId`, so this is a real, not theoretical, narrowing.
 */
function writeDataLiteralsWithKey(node: ts.Node, sf: ts.SourceFile, key: string): ts.Node[] {
  const hits: ts.Node[] = [];
  const hasKey = (lit: ts.ObjectLiteralExpression) =>
    lit.properties.some((p) => p.name && p.name.getText(sf) === key);
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const table = n.expression.expression;
      if (
        WRITE_OPS.has(n.expression.name.text) &&
        ts.isPropertyAccessExpression(table) &&
        LINE_TABLES.has(table.name.text)
      ) {
        const arg = n.arguments[0];
        const dataProp =
          arg && ts.isObjectLiteralExpression(arg)
            ? arg.properties.find(
                (p): p is ts.PropertyAssignment =>
                  ts.isPropertyAssignment(p) && p.name.getText(sf) === "data",
              )
            : undefined;
        if (dataProp && objectLiterals(dataProp.initializer).some(hasKey)) hits.push(n);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return hits;
}

const isFalseLiteral = (e: ts.Expression) => e.kind === ts.SyntaxKind.FalseKeyword;

/** True when `n` sits on a branch that can never run for real: `if (false)`, or a `catch` handler. */
function onDeadOrRecoveryBranch(n: ts.Node, stop: ts.Node): boolean {
  for (let c: ts.Node | undefined = n.parent; c && c !== stop; c = c.parent) {
    if (ts.isCatchClause(c)) return true;
    if (ts.isIfStatement(c) && isFalseLiteral(c.expression) && isWithin(n, c.thenStatement))
      return true;
  }
  return false;
}
const isWithin = (n: ts.Node, container: ts.Node) =>
  n.pos >= container.pos && n.end <= container.end;

/**
 * Source positions of every REAL call (or, when `callOnly` is false, reference — for filters passed
 * to `.some`) to `name` under `node`, on live branches. Never a comment or a string.
 */
function referencePositions(node: ts.Node, name: string, opts: { callOnly: boolean }): number[] {
  const pos: number[] = [];
  const visit = (n: ts.Node) => {
    let hit = false;
    if (ts.isCallExpression(n)) {
      const c = n.expression;
      hit =
        (ts.isIdentifier(c) && c.text === name) ||
        (ts.isPropertyAccessExpression(c) && c.name.text === name);
    }
    if (!hit && !opts.callOnly) {
      hit =
        (ts.isIdentifier(n) && n.text === name) ||
        (ts.isPropertyAccessExpression(n) && n.name.text === name);
    }
    if (hit && !onDeadOrRecoveryBranch(n, node)) pos.push(n.getStart());
    ts.forEachChild(n, visit);
  };
  visit(node);
  return pos;
}
const references = (node: ts.Node, name: string, opts: { callOnly: boolean }) =>
  referencePositions(node, name, opts).length > 0;

/** Start of the first line-write inside `node` (a nested write is positioned at its relation key). */
function firstLineWritePos(node: ts.Node, sf: ts.SourceFile): number {
  let first = Number.POSITIVE_INFINITY;
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const table = n.expression.expression;
      if (
        WRITE_OPS.has(n.expression.name.text) &&
        ts.isPropertyAccessExpression(table) &&
        LINE_TABLES.has(table.name.text)
      ) {
        first = Math.min(first, n.getStart());
      }
    }
    if (ts.isPropertyAssignment(n) && NESTED_RELATIONS.has(n.name.getText(sf))) {
      for (const lit of objectLiterals(n.initializer)) {
        if (lit.properties.some((p) => p.name && NESTED_OPS.has(p.name.getText(sf))))
          first = Math.min(first, n.getStart());
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return first;
}

/** Top-level line-table READS (`x.orderItem.findMany(...)`) — the NULL-tenant blind spot. */
function topLevelLineReads(sf: ts.SourceFile): string[] {
  const hits: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const table = n.expression.expression;
      if (
        READ_OPS.has(n.expression.name.text) &&
        ts.isPropertyAccessExpression(table) &&
        LINE_TABLES.has(table.name.text)
      ) {
        hits.push(`${table.name.text}.${n.expression.name.text}`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return hits;
}

const SRC = path.join(__dirname, "..");
function walk(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory()
        ? walk(path.join(dir, e.name))
        : e.name.endsWith(".ts") && !e.name.endsWith(".spec.ts")
          ? [path.join(dir, e.name)]
          : [],
    );
}
const rel = (f: string) => path.relative(SRC, f).split(path.sep).join("/");
const sourceFiles = new Map(walk(SRC).map((f) => [rel(f), parse(f, fs.readFileSync(f, "utf8"))]));

function scanAll(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const [file, sf] of sourceFiles) {
    for (const [name, node] of writerUnits(sf, file)) {
      const hits = lineWrites(node, sf);
      if (hits.length) found.set(`${file}::${name}`, hits);
    }
  }
  return found;
}
const methodNode = (key: string): { node: WriterNode; sf: ts.SourceFile } => {
  const [file, name] = key.split("::");
  const sf = sourceFiles.get(file)!;
  const node = writerUnits(sf, file).get(name);
  if (!node) throw new Error(`method not found: ${key}`);
  return { node, sf };
};

describe("the scanner itself (so a silent no-match cannot pass the checks below)", () => {
  const src = `
    class A {
      writes() { this.prisma.orderItem.update({}); tx.invoiceItem.deleteMany({}); }
      nested() { return this.prisma.order.update({ data: { lineItems: { create: [] } } }); }
      other() { return this.prisma.order.update({ data: { notes: "x" } }); }
      reads() { return this.prisma.orderItem.findMany({}); }
      guarded() { unitAware.assertOrderEditAllowed(); }
      commented() { /* unitAware.assertOrderEditAllowed(); */ const s = "assertOrderEditAllowed("; }
      dead() { if (false) { unitAware.assertOrderEditAllowed(); } }
      recovery() { try { work(); } catch (e) { unitAware.assertOrderEditAllowed(); } }
      late() { this.prisma.orderItem.update({}); unitAware.assertOrderEditAllowed(); }
      cond(c) { return this.prisma.order.update({ data: { lineItems: c ? { create: [] } : undefined } }); }
      inlineTrio() { this.prisma.orderItem.create({ data: { trackedCategoryId: "cat-1", qty: 1 } }); }
      spreadTrio() { const write = { data: { trackedCategoryId: "cat-1" } }; this.prisma.orderItem.create({ data: { ...write.data } }); }
    }`;
  const sf = parse("inline.ts", src);
  const m = classMethods(sf);

  it("finds direct and nested line writes, and ignores reads and unrelated writes", () => {
    expect(lineWrites(m.get("A.writes")!, sf)).toEqual([
      "orderItem.update",
      "invoiceItem.deleteMany",
    ]);
    expect(lineWrites(m.get("A.nested")!, sf)).toEqual(["nested lineItems.create"]);
    expect(lineWrites(m.get("A.other")!, sf)).toEqual([]);
    expect(lineWrites(m.get("A.reads")!, sf)).toEqual([]);
    expect(topLevelLineReads(sf)).toEqual(["orderItem.findMany"]);
  });

  it("a conditional nested relation is still seen as a write", () => {
    expect(lineWrites(m.get("A.cond")!, sf)).toEqual(["nested lineItems.create"]);
  });

  it("a guard call in `if (false)` or a catch handler does not count, and ordering is measured", () => {
    expect(references(m.get("A.dead")!, "assertOrderEditAllowed", { callOnly: true })).toBe(false);
    expect(references(m.get("A.recovery")!, "assertOrderEditAllowed", { callOnly: true })).toBe(
      false,
    );
    const late = m.get("A.late")!;
    const guardAt = Math.min(
      ...referencePositions(late, "assertOrderEditAllowed", { callOnly: true }),
    );
    expect(guardAt).toBeGreaterThan(firstLineWritePos(late, sf)); // a late guard is detectable
  });

  it("a call proof needs a real call: comments and strings do not count", () => {
    expect(references(m.get("A.guarded")!, "assertOrderEditAllowed", { callOnly: true })).toBe(
      true,
    );
    expect(references(m.get("A.commented")!, "assertOrderEditAllowed", { callOnly: true })).toBe(
      false,
    );
  });

  it("SA-124: writeDataLiteralsWithKey detects an inline literal key but a spread hides it", () => {
    // The MANDATORY trioVia check's whole premise — deleting the actual trackedCategoryId
    // key must be visible to this detector; a `...write.data` spread carrying the SAME key
    // at runtime is invisible to it (a SpreadAssignment has no `.name`), which is exactly why
    // B776's merge-line-writes.ts create() calls were flattened to explicit inline keys.
    expect(writeDataLiteralsWithKey(m.get("A.inlineTrio")!, sf, "trackedCategoryId")).toHaveLength(
      1,
    );
    expect(writeDataLiteralsWithKey(m.get("A.spreadTrio")!, sf, "trackedCategoryId")).toHaveLength(
      0,
    );
  });

  it("the real tree yields a plausible inventory (not zero)", () => {
    expect(scanAll().size).toBeGreaterThan(40);
  });
});

describe("every order/invoice line writer is classified (units_v1)", () => {
  it("the inventory equals the classification table, both directions", () => {
    const scanned = [...scanAll().keys()].sort();
    const classified = Object.keys(INVENTORY).sort();
    expect({ unclassifiedWriters: scanned.filter((k) => !INVENTORY[k]) }).toEqual({
      unclassifiedWriters: [],
    });
    expect({ staleRows: classified.filter((k) => !scanned.includes(k)) }).toEqual({
      staleRows: [],
    });
  });

  it("free-function line writers under orders/ are the listed files' or the shrink-only known baseline (a new extraction cannot lose its writes)", () => {
    const free: string[] = [];
    for (const [file, sf] of sourceFiles) {
      if (!file.startsWith("orders/") || FREE_WRITER_FILES.includes(file)) continue;
      for (const [name, node] of exportedFunctions(sf))
        if (lineWrites(node, sf).length > 0) free.push(`${file}::${name}`);
    }
    expect(free.sort()).toEqual([...KNOWN_UNSCANNED_FREE_WRITERS].sort());
    // the listed files exist and are really scanned: each is represented in the inventory
    for (const f of FREE_WRITER_FILES)
      expect(Object.keys(INVENTORY).some((k) => k.startsWith(`${f}::`))).toBe(true);
  });

  it("the free-function FIELD_ONLY rows write only their declared columns (no price, qty or factor)", () => {
    const got: Record<string, string[]> = {};
    for (const key of Object.keys(FREE_WRITER_DATA_KEYS)) {
      const { node } = methodNode(key);
      got[key] = lineWriteDataKeys(node);
    }
    expect(got).toEqual(FREE_WRITER_DATA_KEYS);
    // every inventoried row of a FREE_WRITER_FILES file has a declared column set (a new function cannot skip it)
    const freeRows = Object.keys(INVENTORY).filter((k) =>
      FREE_WRITER_FILES.includes(k.split("::")[0]),
    );
    expect(freeRows.sort()).toEqual(Object.keys(FREE_WRITER_DATA_KEYS).sort());
  });

  it("GUARDED / SAFE_COPY / CONVERTED writers really call what their row says, BEFORE their first line write (AST, not text)", () => {
    const failures: string[] = [];
    for (const [key, row] of Object.entries(INVENTORY)) {
      const needs = row.kind === "CONVERTED" ? "resolveLineUnits" : row.needs;
      if (!["GUARDED", "SAFE_COPY", "CONVERTED"].includes(row.kind)) continue;
      const { node, sf } = methodNode(key);
      // `isUnitAwareLine` is used as a filter reference (passed to .some), not called directly.
      const positions = referencePositions(node, needs!, { callOnly: needs !== "isUnitAwareLine" });
      if (positions.length === 0) {
        failures.push(`${key} does not call ${needs}`);
        continue;
      }
      // SAFE_COPY calls the builder while writing; GUARDED and a HYBRID CONVERTED row (alsoNeeds)
      // must dominate the first write on BOTH their own call and every alsoNeeds call.
      const firstWrite = firstLineWritePos(node, sf);
      const isHybrid = (row.alsoNeeds?.length ?? 0) > 0;
      if ((row.kind === "GUARDED" || isHybrid) && Math.min(...positions) > firstWrite) {
        failures.push(`${key} calls ${needs} only AFTER its first line write`);
      }
      for (const also of row.alsoNeeds ?? []) {
        const alsoPositions = referencePositions(node, also, { callOnly: true });
        if (alsoPositions.length === 0) {
          failures.push(`${key} does not call ${also}`);
        } else if (Math.min(...alsoPositions) > firstWrite) {
          failures.push(`${key} calls ${also} only AFTER its first line write`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("B297 (SA-098a): every trioVia-marked row really references what it claims (AST, not text)", () => {
    const failures: string[] = [];
    for (const [key, row] of Object.entries(INVENTORY)) {
      if (!row.trioVia || row.trioVia.length === 0) continue;
      const { node } = methodNode(key);
      const satisfied = row.trioVia.some((name) => references(node, name, { callOnly: false }));
      if (!satisfied) {
        failures.push(`${key} references none of: ${row.trioVia.join(", ")}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("SA-100: trioVia is MANDATORY (or an explicit, reasoned trioViaExempt) for any row whose line-write literally sets trackedCategoryId", () => {
    const failures: string[] = [];
    for (const [key, row] of Object.entries(INVENTORY)) {
      const { node, sf } = methodNode(key);
      const setters = writeDataLiteralsWithKey(node, sf, "trackedCategoryId");
      if (setters.length === 0) continue;
      if (row.trioViaExempt) continue;
      if (!row.trioVia || row.trioVia.length === 0) {
        failures.push(`${key} writes trackedCategoryId but declares no trioVia or trioViaExempt`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("every caller of the invoice->order back-sync is a GUARDED method and its guard precedes the call", () => {
    const failures: string[] = [];
    let callers = 0;
    for (const [file, sf] of sourceFiles) {
      for (const [name, node] of writerUnits(sf, file)) {
        const calls = referencePositions(node, "recomputeOrderFromInvoices", { callOnly: true });
        if (calls.length === 0 || name === "InvoicesService.recomputeOrderFromInvoices") continue;
        callers++;
        const key = `${file}::${name}`;
        const row = INVENTORY[key];
        if (!row || row.kind !== "GUARDED") {
          failures.push(`${key} calls recomputeOrderFromInvoices but is not a GUARDED writer`);
          continue;
        }
        const guardAt = Math.min(...referencePositions(node, row.needs!, { callOnly: true }));
        if (guardAt > Math.min(...calls))
          failures.push(`${key} runs the back-sync before its guard`);
      }
    }
    expect(callers).toBeGreaterThan(0); // the scan really found the callers
    expect(failures).toEqual([]);
  });

  it("the merge-target and next-delivery paths (not writers) still apply the guard", () => {
    const failures: string[] = [];
    for (const { key, needs } of GUARD_SITES) {
      const { node } = methodNode(key);
      if (!references(node, needs, { callOnly: needs !== "ORDER_HAS_NO_UNIT_AWARE_LINE" }))
        failures.push(`${key} misses ${needs}`);
    }
    expect(failures).toEqual([]);
  });

  it("pack-only creators are the ONLY unguarded origins — none may gain a unit input without becoming CONVERTED", () => {
    // A PACK_ONLY_CREATE method that starts to read `unitLabel` from its input is an origin of
    // unit-aware lines and must move to CONVERTED (call resolveLineUnits) in the same PR.
    const offenders = Object.entries(INVENTORY)
      .filter(([, r]) => r.kind === "PACK_ONLY_CREATE")
      .filter(([k]) => references(methodNode(k).node, "unitLabel", { callOnly: false }))
      .map(([k]) => k);
    expect(offenders).toEqual([]);
  });
});

// Scope, deliberately: this invariant covers ONLY the guard module and the unit CRUD service. Other
// services still read the line tables top-level (invoices.service recompute sums, products.service's
// delete guard, analytics…) — a pre-existing blind spot whose real close-out is the owner-ruled
// NOT NULL migration on Order/Invoice/OrderItem/InvoiceItem.tenantId, not a per-callsite rewrite.
describe("NULL-tenant blind spot: guards read lines through the parent, never top-level", () => {
  it.each(["orders/unit-aware-guard.ts", "products/product-units.service.ts"])(
    "%s never reads orderItem/invoiceItem top-level",
    (file) => {
      expect(topLevelLineReads(sourceFiles.get(file)!)).toEqual([]);
    },
  );
});

/**
 * Row 372 (MF2) — every writer that changes an ORDER's lines moves the order's revision, or is classified
 * why it need not. `expectedRevisionNumber` only protects an editor if EVERY lines-writer bumps it: a
 * merge that folds carts into the winner (or an invoice edit that back-syncs a line) changed what the
 * editor is looking at without the number moving, so a stale save silently reverted it.
 *
 * The writer set is REBUILT by predicate from the same AST scan as the units_v1 inventory above — every
 * method/function that creates, updates or deletes an `orderItem` (or an order's nested `lineItems`) — and
 * must equal this table both ways, so a new writer fails until it is classified.
 *   BUMPS        appends a revision in its own tx (a real call to the in-tx helper is proved)
 *   COVERED      only runs inside the named BUMPS writer's tx (the named writer must call it)
 *   NEW_ORDER    writes the lines of an order that does not exist yet: no earlier revision to go stale
 *   ORDER_GONE   deletes the order (or a merge loser) with its lines: nothing left to edit
 *   STATUS_ONLY  writes status / delivery / invoicing / derived-tax columns only (the inventory's FIELD_ONLY
 *                proof that it never writes qty, price or pack applies): the sale is unchanged
 */
type RevisionKind =
  "BUMPS" | "COVERED" | "NEW_ORDER" | "ORDER_GONE" | "STATUS_ONLY" | "NOT_AN_ORDER";
interface RevisionRow {
  kind: RevisionKind;
  why: string;
  /** COVERED only: the BUMPS writer whose tx this one runs in. */
  via?: string;
  /** STATUS_ONLY only, REQUIRED when the row writes line `status`: why it cannot revive a CANCELLED line. */
  lineStatus?: string;
}
const REVISION_CALLS = [
  "appendOrderRevisionInTx",
  "appendMergeRevisionInTx",
  "appendReopenRevisionInTx",
  "bumpRevisionIfSaleMoved",
];
/**
 * The columns a STATUS_ONLY writer may touch: delivery/invoicing state and derived stamps, never the sale. A line
 * `status` write can move a line between CANCELLED and live (a sale change), so it is NOT in this set: a row that
 * writes `status` must carry a `lineStatus` reason saying why it cannot revive a line under an open editor.
 */
const STATUS_COLUMNS = new Set([
  "deliveredQty",
  "invoicedQty",
  "backorderedPieces",
  "categoryTaxAmount",
  "categoryTaxType",
  "categoryTaxRate",
  "categoryPriceIncludesTax",
  "compositionMode",
  "recipeId",
  "recipeVersion",
]);
const U = "orders/orders.service.ts::OrdersService";
const UPDATE_ITEMS = `${U}.updateOrderItems`;
const CHANGE_REQUEST = `${U}.approveChangeRequestAtStop`;
const MERGE_ALL = `${U}.mergeAllPendingForCustomer`;
const FORCE = `${U}.forceConsolidateCustomer`;
const RECOMPUTE = "invoices/invoices.service.ts::InvoicesService.recomputeOrderFromInvoices";
const covered = (via: string, why: string): RevisionRow => ({ kind: "COVERED", via, why });
const statusOnly = (why: string, lineStatus?: string): RevisionRow => ({
  kind: "STATUS_ONLY",
  why,
  lineStatus,
});
const REVISIONS: Record<string, RevisionRow> = {
  [UPDATE_ITEMS]: { kind: "BUMPS", why: "staff/buyer/driver edit: EDIT revision at the tx tail" },
  [CHANGE_REQUEST]: {
    kind: "BUMPS",
    why: "approved at-door change request: CHANGE_REQUEST revision in tx",
  },
  [MERGE_ALL]: {
    kind: "BUMPS",
    why: "folds loser carts into the winner: SYSTEM_MERGE revision in tx",
  },
  [FORCE]: { kind: "BUMPS", why: "same fold, forced: SYSTEM_MERGE revision in tx" },
  [RECOMPUTE]: {
    kind: "BUMPS",
    why: "invoice edit back-synced onto the order's lines: SYSTEM_INVOICE_SYNC revision in tx, only when a sale field was written",
  },
  "invoices/finalize-order-recompute.ts::finalizeOrderRecompute": covered(
    RECOMPUTE,
    "cancels orphan lines; reports `touched` so the caller bumps",
  ),
  "orders/order-line-removal.ts::writeLineRemoval": covered(
    UPDATE_ITEMS,
    "line struck off / removed by the edit",
  ),
  "orders/order-line-removal.ts::writeLineUpdate": covered(
    UPDATE_ITEMS,
    "line qty/price written by the edit",
  ),
  "orders/unit-line-edit.ts::createUnitLine": covered(
    UPDATE_ITEMS,
    "unit-aware line created by the edit",
  ),
  "orders/settle-split-free-units.ts::settleSplitFreeUnits": covered(
    UPDATE_ITEMS,
    "re-derives free units + subtotal inside the edit/merge/approve tx",
  ),
  [`${U}.create`]: {
    kind: "NEW_ORDER",
    why: "the order does not exist yet: no earlier revision to go stale",
  },
  "order-templates/order-templates.service.ts::OrderTemplatesService.createOrderFromTemplate": {
    kind: "NEW_ORDER",
    why: "creates a new order; any merge into an existing one goes through mergeAllPendingForCustomer (BUMPS)",
  },
  "orders/merge-lock-recheck.ts::deleteLoserGuarded": {
    kind: "ORDER_GONE",
    why: "the merge loser's lines die with the loser order; the winner is bumped by the merge",
  },
  [`${U}.deleteOrder`]: { kind: "ORDER_GONE", why: "deletes the order and its lines" },
  "customers/customers.service.ts::CustomersService.deleteCustomer": {
    kind: "ORDER_GONE",
    why: "deletes the customer's orders with their lines",
  },
  "customers/customers.service.ts::CustomersService.deleteAllCustomers": {
    kind: "ORDER_GONE",
    why: "deletes every customer's orders with their lines",
  },
  "customers/customers.service.ts::CustomersService.runImportedCustomersCleanup": {
    kind: "ORDER_GONE",
    why: "deletes imported customers' orders with their lines",
  },
  "bookkeeping/bookkeeping.service.ts::BookkeepingService.createExpense": {
    kind: "NOT_AN_ORDER",
    why: "the nested `lineItems` are an expense's, not an order's",
  },
  [`${U}.reopenOrder`]: {
    kind: "BUMPS",
    why: "puts every item-CANCELLED line live again (a new sale of the whole order): SYSTEM_REOPEN revision in tx",
  },
  "orders/order-cancel-tx.ts::cancelOrderInTx": statusOnly(
    "order cancel: line status only",
    "moves lines TO cancelled with the order; a cancelled order takes no edit, and reopenOrder (BUMPS) is the only way back",
  ),
  "orders/delivered-stamp.ts::stampDeliveredInFull": statusOnly(
    "delivery evidence (deliveredQty), not the sale",
  ),
  "orders/delivered-stamp.ts::clearUnevidencedDelivered": statusOnly(
    "delivery evidence (deliveredQty), not the sale",
  ),
  "orders/office-evidence-completion.ts::completeOfficeEvidencedLines": statusOnly(
    "delivery evidence (deliveredQty), not the sale",
  ),
  // B692: a manual PARTIALLY_DELIVERED records per-line delivery evidence (deliveredQty recompute), not the sale.
  "orders/order-pd-quantities.ts::writeOfficeDeliveries": statusOnly(
    "delivery evidence (deliveredQty), not the sale",
  ),
  "routes/routes.service.ts::RoutesService.completeWithPayment": statusOnly(
    "delivery (deliveredQty), not the sale",
  ),
  "routes/routes.service.ts::RoutesService.reopenStop": statusOnly(
    "delivery undo (deliveredQty/status), not the sale",
    "its where-clause is `status: { not: CANCELLED }`: it only moves live lines between delivery states",
  ),
  "orders/backorder-marker-writes.ts::writeValues": statusOnly(
    "backorder marker (backorderedPieces)",
  ),
  "orders/recompute-line-category-taxes.ts::recomputeLineCategoryTaxes":
    statusOnly("derived levy stamp"),
  "orders/line-composition.ts::syncLineCompositions": statusOnly(
    "derived recipe/composition stamp",
  ),
  "orders/order-edit-composition.ts::restoreCarriedComposition": statusOnly(
    "derived recipe/composition stamp",
  ),
  "invoices/finalize-order-recompute.ts::checkOrderCoverage": statusOnly("invoicedQty bookkeeping"),
  "invoices/partial-invoice-cas.ts::bumpInvoicedQtyCas": statusOnly("invoicedQty bookkeeping"),
  "invoices/invoices.service.ts::InvoicesService.adjustInvoicedQtyForInvoice":
    statusOnly("invoicedQty bookkeeping"),
  "invoices/invoices.service.ts::InvoicesService.rebuildSiblingDrafts":
    statusOnly("invoicedQty bookkeeping"),
  "invoices/invoices.service.ts::InvoicesService.reconcileOrderDraftInvoiceLocked":
    statusOnly("invoicedQty bookkeeping"),
  "invoices/invoices.service.ts::InvoicesService.resyncOrderInvoicesForEdit":
    statusOnly("invoicedQty bookkeeping"),
};

/** The `data` keys of every DIRECT `orderItem` write in `node` ("..." for a spread or non-literal `data`). */
function orderItemWriteKeys(node: ts.Node, sf: ts.SourceFile): string[] {
  const keys: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const table = n.expression.expression;
      const op = n.expression.name.text;
      if (
        WRITE_OPS.has(op) &&
        !op.startsWith("delete") &&
        ts.isPropertyAccessExpression(table) &&
        table.name.text === "orderItem"
      ) {
        const arg = n.arguments[0];
        const data =
          arg && ts.isObjectLiteralExpression(arg)
            ? arg.properties.find(
                (p) => ts.isPropertyAssignment(p) && p.name.getText(sf) === "data",
              )
            : undefined;
        const lits = data && ts.isPropertyAssignment(data) ? objectLiterals(data.initializer) : [];
        if (lits.length === 0) keys.push("...");
        for (const lit of lits)
          for (const p of lit.properties)
            keys.push(
              ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)
                ? p.name.getText(sf)
                : "...",
            );
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return [...new Set(keys)];
}

/** Every named top-level unit of a file that can hold a line write: class methods, functions, arrow consts. */
function namedUnits(file: string, sf: ts.SourceFile): Map<string, ts.Node> {
  const out = new Map<string, ts.Node>();
  for (const [name, m] of classMethods(sf)) out.set(`${file}::${name}`, m);
  const visitClass = (n: ts.Node) => {
    if (ts.isClassDeclaration(n) && n.name) {
      for (const m of n.members) {
        if (
          ts.isPropertyDeclaration(m) &&
          m.initializer &&
          (ts.isArrowFunction(m.initializer) || ts.isFunctionExpression(m.initializer))
        )
          out.set(`${file}::${n.name.text}.${m.name.getText(sf)}`, m.initializer);
      }
    }
    ts.forEachChild(n, visitClass);
  };
  visitClass(sf);
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name && st.body) out.set(`${file}::${st.name.text}`, st);
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        const init = d.initializer;
        if (
          ts.isIdentifier(d.name) &&
          init &&
          (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
        )
          out.set(`${file}::${d.name.text}`, init);
      }
    }
  }
  return out;
}

const isOrderLineWrite = (hits: string[]) =>
  hits.some((h) => h.startsWith("orderItem.") || h.startsWith("nested lineItems."));

/** The predicate: every named unit under apps/api/src that creates/updates/deletes an order's lines. */
function orderLineWriters(): string[] {
  const out: string[] = [];
  for (const [file, sf] of sourceFiles) {
    if (/(^|\/)testing\//.test(file)) continue; // spec fixtures, not product code
    for (const [key, node] of namedUnits(file, sf)) {
      if (isOrderLineWrite(lineWrites(node, sf))) out.push(key);
    }
  }
  return out;
}

describe("every order-lines writer moves the order revision or is classified (row 372 MF2)", () => {
  it("the predicate finds the known writers (a silent no-match cannot pass)", () => {
    const found = orderLineWriters();
    expect(found).toEqual(expect.arrayContaining([UPDATE_ITEMS, MERGE_ALL, FORCE, CHANGE_REQUEST]));
    expect(found).toContain("invoices/finalize-order-recompute.ts::finalizeOrderRecompute");
  });

  it("the predicate-built writer set equals the revision classification, both directions", () => {
    const scanned = orderLineWriters().sort();
    const classified = Object.keys(REVISIONS).sort();
    expect({ unclassified: scanned.filter((k) => !REVISIONS[k]) }).toEqual({ unclassified: [] });
    expect({ stale: classified.filter((k) => !scanned.includes(k)) }).toEqual({ stale: [] });
  });

  it("a BUMPS writer really calls the in-tx revision helper", () => {
    const missing = Object.entries(REVISIONS)
      .filter(([, r]) => r.kind === "BUMPS")
      .filter(([k]) => {
        const [file, name] = k.split("::");
        const node = namedUnits(file, sourceFiles.get(file)!).get(k);
        return !REVISION_CALLS.some((c) => references(node!, c, { callOnly: true }));
      })
      .map(([k]) => k);
    expect(missing).toEqual([]);
  });

  it("a COVERED writer names a BUMPS writer that actually reaches it", () => {
    const bad: string[] = [];
    for (const [k, r] of Object.entries(REVISIONS)) {
      if (r.kind !== "COVERED") continue;
      const via = r.via && REVISIONS[r.via];
      if (!via || via.kind !== "BUMPS") {
        bad.push(`${k}: via ${r.via} is not a BUMPS writer`);
        continue;
      }
      const viaFile = r.via!.split("::")[0];
      const viaNode = namedUnits(viaFile, sourceFiles.get(viaFile)!).get(r.via!)!;
      const name = k.split("::")[1].split(".").pop()!;
      if (!references(viaNode, name, { callOnly: false }))
        bad.push(`${k}: ${r.via} never references ${name}`);
    }
    expect(bad).toEqual([]);
  });

  it("a STATUS_ONLY writer writes only status/delivery/invoicing/derived columns (never qty, price or pack)", () => {
    const bad: string[] = [];
    for (const [k, r] of Object.entries(REVISIONS)) {
      if (r.kind !== "STATUS_ONLY") continue;
      const [file] = k.split("::");
      const sf = sourceFiles.get(file)!;
      const keys = orderItemWriteKeys(namedUnits(file, sf).get(k)!, sf);
      // `status` can move a line between CANCELLED and live: only with a declared reason it cannot revive one
      const off = keys.filter((c) => !STATUS_COLUMNS.has(c) && !(c === "status" && r.lineStatus));
      if (keys.length === 0 || off.length > 0)
        bad.push(`${k}: ${keys.join(",") || "no literal data"}`);
    }
    expect(bad).toEqual([]);
  });

  it("no raw SQL writes an OrderItem outside the classified Prisma writers (the predicate cannot see it)", () => {
    const raw = /(UPDATE\s+"OrderItem"|DELETE\s+FROM\s+"OrderItem"|INSERT\s+INTO\s+"OrderItem")/i;
    const hits = [...sourceFiles.entries()]
      .filter(([file]) => !/(^|\/)testing\//.test(file))
      .filter(([, sf]) => raw.test(sf.text))
      .map(([file]) => file);
    expect(hits).toEqual([]);
  });

  it("class-property arrow functions are enumerated too (a writer cannot hide in one)", () => {
    const sf = parse(
      "inline.ts",
      "class A { w = async (tx: any) => { await tx.orderItem.update({ data: { qty: 1 } }); }; }",
    );
    expect([...namedUnits("inline.ts", sf).keys()]).toContain("inline.ts::A.w");
  });
});
