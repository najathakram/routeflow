import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

/**
 * #2717 M3 (SA-579 case 14, S4; precedent: catalog-dual-write-tripwire.spec.ts). Every place under
 * apps/api/src (non-spec) that creates or updates an OrderItem or InvoiceItem, directly
 * (`.orderItem.create/update/...`) or nested (`lineItems: { create`, `items: { create`), is listed
 * below by `file::function` and is one of:
 *   - "order": the function calls `syncOrderLineCompositions(`, so a FIXED line's frozen components
 *     are re-planned or rescaled in the SAME tx as the line write (I12);
 *   - "invoice": the function builds its lines through `buildInvoiceItemData(` (which carries the
 *     line columns and the component rows) or through `invoiceComponentsCreate(`;
 *   - "exempt": a written reason the write cannot change a composed line.
 * A NEW writer that is not listed, a stale entry, a listed function that lost its call, and a
 * nested `components: { create` without a `tenantId` (nested creates are not tenant-injected, S4)
 * all fail here.
 */
const SRC_ROOT = join(__dirname, "..");

type Entry = { kind: "order" | "invoice" | "exempt"; reason?: string };
const REGISTRY: Record<string, Entry> = {
  "orders/orders.service.ts::create": { kind: "order" },
  "orders/orders.service.ts::updateOrderItems": { kind: "order" },
  "orders/orders.service.ts::mergeAllPendingForCustomer": { kind: "order" },
  "orders/orders.service.ts::forceConsolidateCustomer": { kind: "order" },
  "orders/orders.service.ts::approveChangeRequestAtStop": { kind: "order" },
  "order-templates/order-templates.service.ts::createOrderFromTemplate": { kind: "order" },
  "invoices/invoices.service.ts::recomputeOrderFromInvoices": { kind: "order" },
  "invoices/invoices.service.ts::create": { kind: "invoice" },
  "invoices/invoices.service.ts::createSplitInvoices": { kind: "invoice" },
  "invoices/invoices.service.ts::reconcileOrderDraftInvoice": { kind: "invoice" },
  "invoices/invoices.service.ts::rebuildSiblingDrafts": { kind: "invoice" },
  "invoices/invoices.service.ts::createPartialFromOrder": { kind: "invoice" },
  "invoices/invoices.service.ts::duplicate": { kind: "invoice" },
  "invoices/invoices.service.ts::update": { kind: "invoice" },
  "orders/line-composition.ts::syncLineCompositions": {
    kind: "exempt",
    reason: "the writer itself: stamps compositionMode/recipeId/recipeVersion after it writes the rows",
  },
  "orders/orders.service.ts::changeStatus": { kind: "exempt", reason: "status only" },
  "orders/orders.service.ts::reopenOrder": { kind: "exempt", reason: "status only" },
  "orders/orders.service.ts::recomputeLineCategoryTaxes": { kind: "exempt", reason: "tax amount only" },
  "orders/order-line-removal.ts::writeLineRemoval": {
    kind: "exempt",
    reason: "struck-off lines (qty 0); called only from updateOrderItems, which syncs at its end",
  },
  "orders/order-line-removal.ts::writeLineUpdate": {
    kind: "exempt",
    reason: "called only from updateOrderItems, which syncs at its end",
  },
  "orders/unit-line-edit.ts::createUnitLine": {
    kind: "exempt",
    reason: "a unit-aware line is never composed (COMPOSED_UNIT_LINE)",
  },
  "invoices/finalize-order-recompute.ts::checkOrderCoverage": { kind: "exempt", reason: "invoicedQty only" },
  "invoices/finalize-order-recompute.ts::finalizeOrderRecompute": {
    kind: "exempt",
    reason: "zeroes a cancelled orphan line (0 pieces); no live composition is re-planned",
  },
  "invoices/partial-invoice-cas.ts::bumpInvoicedQtyCas": { kind: "exempt", reason: "invoicedQty only" },
  "invoices/invoices.service.ts::adjustInvoicedQtyForInvoice": { kind: "exempt", reason: "invoicedQty only" },
  "invoices/invoices.service.ts::resyncOrderInvoicesForEdit": { kind: "exempt", reason: "invoicedQty reset only" },
  "invoices/invoices.service.ts::applyPriceAdjustment": {
    kind: "exempt",
    reason: "post-issue price adjustment; component prices are frozen per document row (SA-589, I5)",
  },
  "invoices/invoices.service.ts::setCheckStatus": { kind: "exempt", reason: "NSF fee line, no product" },
  "estimates/estimates.service.ts::create": { kind: "exempt", reason: "EstimateItem, not an order/invoice line" },
  "estimates/estimates.service.ts::convertToInvoice": {
    kind: "exempt",
    reason: "estimate lines have no recipe composition (M4a)",
  },
  "import/import.service.ts::importInvoices": { kind: "exempt", reason: "imported history, never composed" },
  "inventory/inventory.service.ts::createDraftPurchaseOrderInTx": { kind: "exempt", reason: "purchase order items" },
  "returns/inline-returns.service.ts::captureInTx": { kind: "exempt", reason: "credit note items" },
  "routes/routes.service.ts::completeWithPayment": { kind: "exempt", reason: "deliveredQty only" },
  "routes/routes.service.ts::reopenStop": { kind: "exempt", reason: "deliveredQty/status only" },
  "common/testing/copier-contract/copier-ast.ts::?": { kind: "exempt", reason: "a comment in the copier AST helper" },
};

const SITE =
  /\.(orderItem|invoiceItem)\.(create|createMany|update|updateMany|upsert|createManyAndReturn)\(|\b(lineItems|items)\s*:\s*\{\s*(create|createMany)\b/;
const FN_START =
  /^(?: {2}(?:async |private |public |protected |static )*[A-Za-z_][A-Za-z0-9_]*\(|(?:export )?(?:async )?function [A-Za-z0-9_]+|export const [A-Za-z0-9_]+ = (?:async )?\()/;

function fnName(line: string): string {
  const m = line.startsWith("  ")
    ? line.match(/([A-Za-z_][A-Za-z0-9_]*)\(/)
    : line.match(/function ([A-Za-z0-9_]+)|const ([A-Za-z0-9_]+)/);
  return (m && (m[1] ?? m[2])) || "?";
}

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== "node_modules") out.push(...listTsFiles(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".spec.ts") && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

/** `file::function` -> that function's source text, for every function holding a writer site. */
function collectSites(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of listTsFiles(SRC_ROOT)) {
    const rel = relative(SRC_ROOT, file).split("\\").join("/");
    const lines = readFileSync(file, "utf8").split("\n");
    const starts: Array<{ at: number; name: string }> = [];
    lines.forEach((l, i) => {
      if (FN_START.test(l)) starts.push({ at: i, name: fnName(l) });
    });
    lines.forEach((l, i) => {
      if (!SITE.test(l) || /^\s*(\/\/|\*)/.test(l)) return;
      const owner = [...starts].reverse().find((s) => s.at <= i);
      const key = `${rel}::${owner?.name ?? "?"}`;
      if (found.has(key)) return;
      const next = starts.find((s) => owner && s.at > owner.at);
      found.set(key, lines.slice(owner?.at ?? 0, next ? next.at : lines.length).join("\n"));
    });
  }
  return found;
}

describe("composition writer tripwire (#2717 M3, case 14)", () => {
  const sites = collectSites();

  it("is not vacuous: it finds the known order and invoice writers", () => {
    expect(sites.has("orders/orders.service.ts::updateOrderItems")).toBe(true);
    expect(sites.has("invoices/invoices.service.ts::create")).toBe(true);
  });

  it("every order/invoice line writer is listed (an unlisted new site fails here)", () => {
    expect([...sites.keys()].filter((k) => !REGISTRY[k])).toEqual([]);
  });

  it("no listed entry is stale", () => {
    expect(Object.keys(REGISTRY).filter((k) => !sites.has(k))).toEqual([]);
  });

  it("every exempt entry carries a reason", () => {
    const bare = Object.entries(REGISTRY).filter(([, e]) => e.kind === "exempt" && !e.reason);
    expect(bare).toEqual([]);
  });

  it.each(Object.entries(REGISTRY).filter(([, e]) => e.kind === "order"))(
    "%s calls syncOrderLineCompositions in the same function",
    (key) => {
      expect(sites.get(key)).toContain("syncOrderLineCompositions(");
    },
  );

  it.each(Object.entries(REGISTRY).filter(([, e]) => e.kind === "invoice"))(
    "%s builds its lines through the component-carrying builder",
    (key) => {
      expect(sites.get(key)).toMatch(/buildInvoiceItemData\(|invoiceComponentsCreate\(/);
    },
  );

  it("every nested `components: { create` passes tenantId (nested creates are not tenant-injected)", () => {
    const offenders: string[] = [];
    for (const file of listTsFiles(SRC_ROOT)) {
      const text = readFileSync(file, "utf8");
      const re = /\bcomponents\s*:\s*\{\s*create\b/g;
      for (let m = re.exec(text); m; m = re.exec(text)) {
        const window = text.slice(Math.max(0, m.index - 400), m.index + 400);
        if (!window.includes("tenantId")) offenders.push(relative(SRC_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
