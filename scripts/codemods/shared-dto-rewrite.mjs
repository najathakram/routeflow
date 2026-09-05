#!/usr/bin/env node
/**
 * Wave E / imp-10b: rewrites apps/web|mobile `lib/api/*.ts` local declarations
 * of names that now live in `@routeflow/types` (packages/types/api/*.ts) into
 * `import type { ... } from "@routeflow/types";` — driven by the explicit
 * manifest below (from the DTO-duplication sweep's 95-name identical +
 * near-identical move list, `.claude/pipeline/wave-E-structure/2026-09-03-imp-10b-shared-dtos/sweep.md`).
 *
 * Idempotent: a file with no matching local declaration left is a no-op.
 *
 * Modes:
 *   --check   report any manifest entry whose LOCAL declaration is still
 *             present in its file (exit 1 if any remain)
 *   --write   remove each manifest entry's local declaration from its file
 *             and ensure the file imports it from "@routeflow/types" instead
 *
 * Scope note: renamed / re-exported-under-an-alias cases (VendorBillStatus,
 * PurchaseOrderStatus↔POStatus, BuyerPromotion, EstimateStatus, the
 * VariantAssignResultRow→VariantAssignResultItem rename, the OrderTemplate/
 * SalesBy*Row intra-app dedup-and-rename) are handled by hand (see the imp-10b
 * build report) — this script covers the same-name deletions, which are the
 * large majority of the 95.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

const MODE = process.argv.includes("--write") ? "write" : "check";

/** [relative file path, exported type name, "interface" | "type"] */
const MANIFEST = [
  // orders
  ["apps/web/lib/api/orders.ts", "ActiveOrderSummary", "interface"],
  ["apps/web/lib/api/orders.ts", "CancelImpact", "interface"],
  ["apps/web/lib/api/orders.ts", "CustomerPriceHistory", "interface"],
  ["apps/mobile/lib/api/orders.ts", "ActiveOrderSummary", "interface"],
  ["apps/mobile/lib/api/orders.ts", "CancelImpact", "interface"],
  ["apps/mobile/lib/api/orders.ts", "CustomerPriceHistory", "interface"],

  // customers / authorizations
  ["apps/web/lib/api/authorizations.ts", "CustomerAuthorization", "interface"],
  ["apps/web/lib/api/authorizations.ts", "ExpiringAuthorization", "interface"],
  ["apps/mobile/lib/api/authorizations.ts", "CustomerAuthorization", "interface"],
  ["apps/mobile/lib/api/authorizations.ts", "ExpiringAuthorization", "interface"],
  ["apps/mobile/lib/api/buyer.ts", "ExpiringAuthorization", "interface"],
  ["apps/web/lib/api/customers.ts", "CustomerComment", "interface"],
  ["apps/web/lib/api/customers.ts", "CustomerDocument", "interface"],
  ["apps/mobile/lib/api/customers.ts", "CustomerComment", "interface"],
  ["apps/mobile/lib/api/customers.ts", "CustomerDocument", "interface"],
  ["apps/web/lib/api/buyer.ts", "SubmitBuyerAuthorizationInput", "interface"],
  ["apps/mobile/lib/api/buyer.ts", "SubmitBuyerAuthorizationInput", "interface"],

  // products / inventory / stock-count
  ["apps/web/lib/api/inventory.ts", "InventoryValuation", "interface"],
  ["apps/web/lib/api/inventory.ts", "RecomputeCostsResult", "interface"],
  ["apps/mobile/lib/api/inventory.ts", "InventoryValuation", "interface"],
  ["apps/mobile/lib/api/inventory.ts", "RecomputeCostsResult", "interface"],
  ["apps/web/lib/api/stock-count.ts", "CommitStockCountPayload", "interface"],
  ["apps/web/lib/api/stock-count.ts", "CommitStockCountResponse", "interface"],
  ["apps/web/lib/api/stock-count.ts", "CommitStockCountSessionResponse", "interface"],
  ["apps/mobile/lib/api/stock-count.ts", "CommitStockCountPayload", "interface"],
  ["apps/mobile/lib/api/stock-count.ts", "CommitStockCountResponse", "interface"],
  ["apps/mobile/lib/api/stock-count.ts", "CommitStockCountSessionResponse", "interface"],
  ["apps/web/lib/api/variant-assign.ts", "VariantAssignResult", "interface"],
  ["apps/web/lib/api/variant-assign.ts", "VariantAssignResultItem", "interface"],
  ["apps/mobile/lib/api/variant-assign.ts", "VariantAssignResult", "interface"],
  ["apps/web/lib/api/product-sales.ts", "ProductSaleLine", "interface"],
  ["apps/web/lib/api/product-sales.ts", "ProductSalesHistory", "interface"],
  ["apps/mobile/lib/api/product-sales.ts", "ProductSaleLine", "interface"],
  ["apps/mobile/lib/api/product-sales.ts", "ProductSalesHistory", "interface"],
  ["apps/mobile/lib/api/product-sales.ts", "ProductSalesSummary", "interface"],

  // invoices / payments / finance
  ["apps/web/lib/api/invoices.ts", "CreatePartialInvoiceItem", "interface"],
  ["apps/web/lib/api/invoices.ts", "CreatePartialInvoiceDto", "interface"],
  ["apps/web/lib/api/invoices.ts", "CreateInvoiceItem", "interface"],
  ["apps/web/lib/api/invoices.ts", "SendInvoiceEmailResult", "interface"],
  ["apps/web/lib/api/invoices.ts", "SetCheckStatusDto", "interface"],
  ["apps/web/lib/api/invoices.ts", "StandalonePaymentDto", "interface"],
  ["apps/web/lib/api/invoices.ts", "PaymentListParams", "interface"],
  ["apps/web/lib/api/invoices.ts", "PaymentListResponse", "interface"],
  ["apps/web/lib/api/invoices.ts", "RecurringInvoiceItem", "interface"],
  ["apps/web/lib/api/invoices.ts", "RecurringInvoice", "interface"],
  ["apps/web/lib/api/invoices.ts", "CreateRecurringInvoiceDto", "interface"],
  ["apps/mobile/lib/api/invoices.ts", "CreatePartialInvoiceItem", "interface"],
  ["apps/mobile/lib/api/invoices.ts", "CreatePartialInvoiceDto", "interface"],
  ["apps/mobile/lib/api/invoices.ts", "CreateInvoiceItem", "interface"],
  ["apps/mobile/lib/api/invoices.ts", "SendInvoiceEmailResult", "interface"],
  ["apps/mobile/lib/api/payments.ts", "SetCheckStatusDto", "interface"],
  ["apps/mobile/lib/api/payments.ts", "StandalonePaymentDto", "interface"],
  ["apps/mobile/lib/api/payments.ts", "PaymentListParams", "interface"],
  ["apps/mobile/lib/api/payments.ts", "PaymentListResponse", "interface"],
  ["apps/mobile/lib/api/recurring-invoices.ts", "RecurringInvoiceItem", "interface"],
  ["apps/mobile/lib/api/recurring-invoices.ts", "RecurringInvoice", "interface"],
  ["apps/mobile/lib/api/recurring-invoices.ts", "CreateRecurringInvoiceDto", "interface"],
  ["apps/mobile/lib/api/recurring-invoices.ts", "CreateRecurringInvoiceItem", "interface"],
  ["apps/web/lib/api/finance.ts", "ExpenseCategory", "interface"],
  ["apps/mobile/lib/api/expenses.ts", "ExpenseCategory", "interface"],

  // vendor bills / scan / supplier
  ["apps/web/lib/api/vendor-bills.ts", "UnlinkedItemsError", "interface"],
  ["apps/web/lib/api/vendor-bills.ts", "DuplicateVendorBillInfo", "interface"],
  ["apps/web/lib/api/vendor-bills.ts", "DuplicateVendorBillError", "interface"],
  ["apps/web/lib/api/vendor-bills.ts", "PriorScanSummary", "interface"],
  ["apps/web/lib/api/vendor-bills.ts", "CheckVendorBillDuplicateDto", "interface"],
  ["apps/mobile/lib/api/vendor-bills.ts", "UnlinkedItemsError", "interface"],
  ["apps/mobile/lib/api/vendor-bills.ts", "DuplicateVendorBillInfo", "interface"],
  ["apps/mobile/lib/api/vendor-bills.ts", "DuplicateVendorBillError", "interface"],
  ["apps/mobile/lib/api/vendor-bills.ts", "PriorScanSummary", "interface"],
  ["apps/mobile/lib/api/vendor-bills.ts", "CheckVendorBillDuplicateDto", "interface"],
  ["apps/mobile/lib/api/vendor-bills.ts", "ScanCandidate", "interface"],
  ["apps/web/lib/api/invoice-scan.ts", "ScanCandidate", "interface"],
  ["apps/web/lib/api/supplier-payments.ts", "SupplierStatementRowType", "type"],
  ["apps/web/lib/api/supplier-payments.ts", "SupplierStatementRow", "interface"],
  ["apps/web/lib/api/supplier-payments.ts", "SupplierStatement", "interface"],
  ["apps/web/lib/api/supplier-payments.ts", "RecordSupplierPaymentDto", "interface"],
  ["apps/web/lib/api/supplier-payments.ts", "RecordSupplierPaymentResult", "interface"],
  ["apps/web/lib/api/supplier-payments.ts", "SupplierAllocationLine", "interface"],
  ["apps/mobile/lib/api/supplier-payments.ts", "SupplierStatementRowType", "type"],
  ["apps/mobile/lib/api/supplier-payments.ts", "SupplierStatementRow", "interface"],
  ["apps/mobile/lib/api/supplier-payments.ts", "SupplierStatement", "interface"],
  ["apps/mobile/lib/api/supplier-payments.ts", "RecordSupplierPaymentDto", "interface"],
  ["apps/mobile/lib/api/supplier-payments.ts", "RecordSupplierPaymentResult", "interface"],
  ["apps/web/lib/api/supplier-statements.ts", "StatementAiErrorCode", "type"],
  ["apps/web/lib/api/supplier-statements.ts", "StatementAiError", "interface"],
  ["apps/mobile/lib/api/supplier-statements.ts", "StatementAiErrorCode", "type"],
  ["apps/mobile/lib/api/supplier-statements.ts", "StatementAiError", "interface"],

  // returns
  ["apps/web/lib/api/returns.ts", "CreateReturnItemDto", "interface"],
  ["apps/mobile/lib/api/returns.ts", "CreateReturnItemDto", "interface"],

  // regulated / tracked categories / tobacco
  ["apps/web/lib/api/tracked-categories.ts", "RegulatedLedgerRow", "interface"],
  ["apps/web/lib/api/tracked-categories.ts", "RegulatedLedgerResponse", "interface"],
  ["apps/web/lib/api/tracked-categories.ts", "RegulatedReportWarningCode", "type"],
  ["apps/web/lib/api/tracked-categories.ts", "RegulatedReportWarning", "interface"],
  ["apps/web/lib/api/tracked-categories.ts", "RegulatedReportColumn", "interface"],
  ["apps/web/lib/api/tracked-categories.ts", "RegulatedReportPreview", "interface"],
  ["apps/web/lib/api/tracked-categories.ts", "TemplateUomOption", "interface"],
  ["apps/web/lib/api/tracked-categories.ts", "TemplateItemType", "interface"],
  ["apps/web/lib/api/tracked-categories.ts", "TemplateColumn", "interface"],
  ["apps/web/lib/api/tracked-categories.ts", "ReportTemplateDef", "interface"],
  ["apps/web/lib/api/tobacco.ts", "TobaccoOverview", "interface"],
  ["apps/mobile/lib/api/tobacco.ts", "TobaccoOverview", "interface"],

  // routes / drivers / trips
  ["apps/web/lib/api/routes.ts", "RouteSettings", "interface"],
  ["apps/web/lib/api/routes.ts", "StopETA", "interface"],
  ["apps/web/lib/api/routes.ts", "RouteAnalysisResult", "interface"],
  ["apps/web/lib/api/routes.ts", "TripIneligibleReason", "type"],
  ["apps/web/lib/api/routes.ts", "TripEligibilityRow", "interface"],
  ["apps/web/lib/api/routes.ts", "TripOrigin", "type"],
  ["apps/mobile/lib/api/routes.ts", "RouteAnalysisResult", "interface"],
  ["apps/mobile/lib/api/admin.ts", "TripIneligibleReason", "type"],
  ["apps/mobile/lib/api/admin.ts", "TripEligibilityRow", "interface"],
  ["apps/mobile/lib/api/admin.ts", "TripOrigin", "type"],

  // buyer portal
  ["apps/web/lib/api/buyer.ts", "LockedCategory", "interface"],
  ["apps/web/lib/api/buyer.ts", "ReplenishmentEstimate", "interface"],
  ["apps/web/lib/api/buyer.ts", "ShelfEstimate", "interface"],
  ["apps/web/lib/api/buyer.ts", "ShelfActiveOrder", "interface"],
  ["apps/web/lib/api/buyer.ts", "ShelfResponse", "interface"],
  ["apps/web/lib/api/buyer.ts", "BuyerCreateChangeRequestInput", "interface"],
  ["apps/web/lib/api/buyer.ts", "BuyerStockAlerts", "interface"],
  ["apps/web/lib/api/buyer.ts", "BuyerAnalytics", "interface"],
  ["apps/web/lib/api/buyer.ts", "BuyerStatementTransaction", "interface"],
  ["apps/web/lib/api/buyer.ts", "BuyerStatement", "interface"],
  ["apps/web/lib/api/buyer.ts", "BuyerPayment", "interface"],
  ["apps/web/lib/api/buyer.ts", "BuyerRemittance", "interface"],
  ["apps/web/lib/api/buyer.ts", "BuyerAuthorizationRow", "interface"],
  ["apps/mobile/lib/api/buyer.ts", "LockedCategory", "interface"],
  ["apps/mobile/lib/api/buyer.ts", "ReplenishmentEstimate", "interface"],
  ["apps/mobile/lib/api/buyer.ts", "ShelfEstimate", "interface"],
  ["apps/mobile/lib/api/buyer.ts", "ShelfActiveOrder", "interface"],
  ["apps/mobile/lib/api/buyer.ts", "ShelfResponse", "interface"],
  ["apps/mobile/lib/api/buyer.ts", "BuyerCreateChangeRequestInput", "interface"],
  ["apps/mobile/lib/api/buyer.ts", "BuyerStockAlerts", "interface"],
  ["apps/mobile/lib/api/buyer.ts", "BuyerAnalytics", "interface"],
  ["apps/mobile/lib/api/buyer.ts", "BuyerStatementTransaction", "interface"],
  ["apps/mobile/lib/api/buyer.ts", "BuyerStatement", "interface"],
  ["apps/mobile/lib/api/buyer.ts", "BuyerPayment", "interface"],
  ["apps/mobile/lib/api/buyer.ts", "BuyerRemittance", "interface"],
  ["apps/mobile/lib/api/buyer.ts", "BuyerAuthorizationRow", "interface"],
  ["apps/web/lib/api/order-templates.ts", "OrderTemplateItem", "interface"],
  ["apps/mobile/lib/api/order-templates.ts", "OrderTemplateItem", "interface"],

  // misc
  ["apps/web/lib/api/margin.ts", "MarginConfig", "interface"],
  ["apps/mobile/lib/api/margin.ts", "MarginConfig", "interface"],
  ["apps/web/lib/api/cost-history.ts", "CostHistoryEntry", "interface"],
  ["apps/mobile/lib/api/cost-history.ts", "CostHistoryEntry", "interface"],
  ["apps/web/lib/api/drafts.ts", "SaleDraft", "interface"],
  ["apps/web/lib/api/drafts.ts", "SaveDraftInput", "type"],
  ["apps/mobile/lib/api/drafts.ts", "SaleDraft", "interface"],
  ["apps/mobile/lib/api/drafts.ts", "SaveDraftInput", "type"],
  ["apps/web/lib/api/estimates.ts", "EstimateItem", "interface"],
  ["apps/web/lib/api/estimates.ts", "Estimate", "interface"],
  ["apps/mobile/lib/api/estimates.ts", "EstimateItem", "interface"],
  ["apps/mobile/lib/api/estimates.ts", "Estimate", "interface"],
];

/** Scans forward from `openBraceIdx` (the `{` itself) to its matching `}`,
 *  ignoring braces inside string/template literals and comments. */
function findMatchingBrace(text, openBraceIdx) {
  let depth = 0;
  let i = openBraceIdx;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "/" && text[i + 1] === "/") {
      i = text.indexOf("\n", i);
      if (i === -1) return -1;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2);
      if (i === -1) return -1;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i++;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/** Removes a preceding `/** ... *\/` JSDoc block directly above `startIdx`
 *  (only whitespace/newlines between), returning the adjusted start index. */
function extendBackForJsDoc(text, startIdx) {
  let i = startIdx;
  while (i > 0 && /\s/.test(text[i - 1])) i--;
  if (text.slice(Math.max(0, i - 2), i) === "*/") {
    const openIdx = text.lastIndexOf("/**", i);
    if (openIdx !== -1) return openIdx;
  }
  return startIdx;
}

function removeDeclaration(text, name, kind) {
  const declRe =
    kind === "interface"
      ? new RegExp(`export interface ${name}\\b[^{]*\\{`, "m")
      : new RegExp(`export type ${name}\\b\\s*=`, "m");
  const m = declRe.exec(text);
  if (!m) return null;
  const matchStart = m.index;
  let end;
  if (kind === "interface") {
    const braceIdx = m.index + m[0].length - 1;
    const closeIdx = findMatchingBrace(text, braceIdx);
    if (closeIdx === -1) return null;
    end = closeIdx + 1;
  } else {
    // type alias: scan to the first top-level `;` (depth-aware over {}/()/<>)
    let depth = 0;
    let i = matchStart + m[0].length;
    while (i < text.length) {
      const ch = text[i];
      if ("{(<".includes(ch)) depth++;
      else if ("})>".includes(ch)) depth--;
      else if (ch === ";" && depth <= 0) {
        end = i + 1;
        break;
      }
      i++;
    }
    if (end === undefined) return null;
  }
  const start = extendBackForJsDoc(text, matchStart);
  // Consume one trailing newline (and a following blank line, if any) so removal
  // doesn't leave a double-blank gap.
  let trimEnd = end;
  if (text[trimEnd] === "\n") trimEnd++;
  if (text[trimEnd] === "\n") trimEnd++;
  return { start, end: trimEnd, full: text.slice(start, end) };
}

function ensureImport(text, names) {
  const importRe = /import type \{([^}]*)\} from "@routeflow\/types";/;
  const m = importRe.exec(text);
  if (m) {
    const existing = m[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const merged = Array.from(new Set([...existing, ...names])).sort();
    const newImport = `import type { ${merged.join(", ")} } from "@routeflow/types";`;
    return text.slice(0, m.index) + newImport + text.slice(m.index + m[0].length);
  }
  // Insert after the last top-of-file import statement.
  const importLineRe = /^import .+;$/gm;
  let lastEnd = 0;
  let mm;
  while ((mm = importLineRe.exec(text))) {
    lastEnd = mm.index + mm[0].length;
  }
  const sorted = [...names].sort();
  const newImportLine = `\nimport type { ${sorted.join(", ")} } from "@routeflow/types";`;
  if (lastEnd === 0) return newImportLine.trimStart() + "\n" + text;
  return text.slice(0, lastEnd) + newImportLine + text.slice(lastEnd);
}

function main() {
  /** @type {Map<string, {names: string[], kinds: Map<string,string>}>} */
  const byFile = new Map();
  for (const [file, name, kind] of MANIFEST) {
    if (!byFile.has(file)) byFile.set(file, { names: [], kinds: new Map() });
    byFile.get(file).names.push(name);
    byFile.get(file).kinds.set(name, kind);
  }

  let remaining = 0;
  let removedCount = 0;
  const notFound = [];

  for (const [file, { names, kinds }] of byFile) {
    const absPath = path.join(ROOT, file);
    if (!fs.existsSync(absPath)) {
      notFound.push(`${file}: FILE MISSING`);
      continue;
    }
    let text = fs.readFileSync(absPath, "utf8");
    const importedNames = [];

    for (const name of names) {
      const kind = kinds.get(name);
      const removal = removeDeclaration(text, name, kind);
      if (!removal) {
        // Either already removed (idempotent re-run) or genuinely absent.
        const stillLocal = new RegExp(`export (interface|type) ${name}\\b`).test(text);
        if (stillLocal) {
          remaining++;
          console.log(`  REMAIN  ${file} :: ${name} (could not isolate declaration bounds)`);
        }
        continue;
      }
      if (MODE === "check") {
        remaining++;
        console.log(`  LOCAL   ${file} :: ${name}`);
        continue;
      }
      text = text.slice(0, removal.start) + text.slice(removal.end);
      importedNames.push(name);
      removedCount++;
    }

    if (MODE === "write" && importedNames.length > 0) {
      text = ensureImport(text, importedNames);
      fs.writeFileSync(absPath, text, "utf8");
      console.log(`  WROTE   ${file} :: +${importedNames.length} (${importedNames.join(", ")})`);
    }
  }

  if (notFound.length > 0) {
    console.log("\nFiles not found:");
    for (const line of notFound) console.log(`  ${line}`);
  }

  if (MODE === "check") {
    console.log(
      `\n${remaining} local declaration(s) remain of ${MANIFEST.length} manifest entries.`,
    );
    process.exit(remaining > 0 ? 1 : 0);
  } else {
    console.log(`\nRemoved ${removedCount} local declarations across ${byFile.size} files.`);
    if (remaining > 0) {
      console.log(`${remaining} entries could not be auto-removed — inspect manually.`);
    }
  }
}

main();
