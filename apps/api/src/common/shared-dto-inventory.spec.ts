import * as fs from "fs";
import * as path from "path";

/**
 * Wave E / imp-10b, T1: static inventory check for the DTO-duplication sweep's
 * move list. Every name below must (a) be exported from `@routeflow/types` and
 * (b) NOT be locally hand-declared (`export interface X` / `export type X =`)
 * in any `apps/web/lib/api/*.ts` or `apps/mobile/lib/api/*.ts` file any more —
 * a local re-declaration alongside the shared import is exactly the kind of
 * silent fork this move is meant to prevent.
 *
 * Scope note: the sweep's "95 identical + near-identical" figure (sweep.md §7)
 * counts several enum-SHAPED names (InvoiceStatus, ReturnStatus, ReturnReason,
 * CreditNoteStatus, ExpenseStatus, InvoiceTreatment, InvoiceScanStatus,
 * EstimateStatus, …) that this build routed to `packages/types/api/enums.ts`
 * instead (per R3 — they mirror a Prisma enum, so they belong with the other
 * ~40 enum mirrors and are pinned by `enum-parity.spec.ts`, not duplicated
 * here). This list is the DTO-shaped remainder: 83 names moved verbatim plus
 * `BuyerPromotion` (moved once its `type`/`scope` fields were re-typed from the
 * shared enums, which resolved the only reason the sweep called it divergent).
 * Renamed-apart intra-app pairs (`BuyerOrderTemplate`, `ReportSalesByCustomerRow`,
 * `ReportSalesByItemRow`) are deliberately NOT in this list — they are local by
 * design, not shared.
 */
const MOVED_NAMES = [
  "ActiveOrderSummary",
  "BuyerAnalytics",
  "BuyerAuthorizationRow",
  "BuyerCreateChangeRequestInput",
  "BuyerPayment",
  "BuyerPromotion",
  "BuyerRemittance",
  "BuyerStatement",
  "BuyerStatementTransaction",
  "BuyerStockAlerts",
  "CancelImpact",
  "CheckVendorBillDuplicateDto",
  "CommitStockCountPayload",
  "CommitStockCountResponse",
  "CommitStockCountSessionResponse",
  "CostHistoryEntry",
  "CreateInvoiceItem",
  "CreatePartialInvoiceDto",
  "CreatePartialInvoiceItem",
  "CreateRecurringInvoiceDto",
  "CreateRecurringInvoiceItem",
  "CreateReturnItemDto",
  "CustomerAuthorization",
  "CustomerComment",
  "CustomerDocument",
  "CustomerPriceHistory",
  "DuplicateVendorBillError",
  "DuplicateVendorBillInfo",
  "Estimate",
  "EstimateItem",
  "ExpenseCategory",
  "ExpiringAuthorization",
  "InventoryValuation",
  "LockedCategory",
  "MarginConfig",
  "OrderTemplateItem",
  "PaymentListParams",
  "PaymentListResponse",
  "PriorScanSummary",
  "ProductSaleLine",
  "ProductSalesHistory",
  "ProductSalesSummary",
  "RecomputeCostsResult",
  "RecordSupplierPaymentDto",
  "RecordSupplierPaymentResult",
  "RecurringInvoice",
  "RecurringInvoiceItem",
  "RegulatedLedgerResponse",
  "RegulatedLedgerRow",
  "RegulatedReportColumn",
  "RegulatedReportPreview",
  "RegulatedReportWarning",
  "RegulatedReportWarningCode",
  "ReplenishmentEstimate",
  "ReportTemplateDef",
  "RouteAnalysisResult",
  "RouteSettings",
  "SaleDraft",
  "SaveDraftInput",
  "ScanCandidate",
  "SendInvoiceEmailResult",
  "SetCheckStatusDto",
  "ShelfActiveOrder",
  "ShelfEstimate",
  "ShelfResponse",
  "StandalonePaymentDto",
  "StatementAiError",
  "StatementAiErrorCode",
  "StopETA",
  "SubmitBuyerAuthorizationInput",
  "SupplierAllocationLine",
  "SupplierStatement",
  "SupplierStatementRow",
  "SupplierStatementRowType",
  "TemplateColumn",
  "TemplateItemType",
  "TemplateUomOption",
  "TobaccoOverview",
  "TripEligibilityRow",
  "TripIneligibleReason",
  "TripOrigin",
  "UnlinkedItemsError",
  "VariantAssignResult",
  "VariantAssignResultItem",
];

const REPO_ROOT = path.resolve(__dirname, "../../../..");

function listApiLibFiles(appDir: string): string[] {
  const dir = path.join(REPO_ROOT, appDir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => path.join(dir, f));
}

const LIB_API_FILES = [
  ...listApiLibFiles("apps/web/lib/api"),
  ...listApiLibFiles("apps/mobile/lib/api"),
];

function listSharedTypesSourceFiles(): string[] {
  const dir = path.join(REPO_ROOT, "packages/types/api");
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => path.join(dir, f));
}
const SHARED_TYPES_SOURCE_FILES = listSharedTypesSourceFiles();

describe("shared DTO inventory (wave E / imp-10b, T1)", () => {
  // Type-only exports (`export interface X`, `export type X`) are erased at
  // compile time and leave no trace in a `require()`'d module's own keys, so
  // "exported from @routeflow/types" is checked at the SOURCE level: the name
  // must be declared (or bare-re-exported) somewhere under
  // `packages/types/api/*.ts`, which `index.ts` re-exports wholesale via
  // `export * from "./api/<domain>"`. `packages/types` also has no build
  // step (its own `package.json` points `main`/`types` straight at
  // `index.ts`), so "declared in source" and "importable at the type level"
  // are the same fact here.
  it.each(MOVED_NAMES)("%s is declared in packages/types/api/*.ts", (name) => {
    const declRe = new RegExp(
      `export (interface|type) ${name}\\b|export type \\{[^}]*\\b${name}\\b`,
    );
    const foundIn = SHARED_TYPES_SOURCE_FILES.filter((file) =>
      declRe.test(fs.readFileSync(file, "utf8")),
    );
    expect(foundIn.length).toBeGreaterThan(0);
  });

  describe("no local re-declaration in apps/web|mobile/lib/api", () => {
    for (const name of MOVED_NAMES) {
      it(`${name} is not hand-declared (export interface|type) in any lib/api file`, () => {
        const offenders: string[] = [];
        const declRe = new RegExp(`export (interface|type) ${name}\\b`);
        for (const file of LIB_API_FILES) {
          const text = fs.readFileSync(file, "utf8");
          if (declRe.test(text)) offenders.push(path.relative(REPO_ROOT, file));
        }
        expect(offenders).toEqual([]);
      });
    }
  });
});
