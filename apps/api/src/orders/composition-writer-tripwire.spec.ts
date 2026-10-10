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
 *     line columns and the component rows) or, on a DRAFT edit, through `applyComposedLineEdits(`;
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
  "orders/backorder-marker-writes.ts::writeValues": {
    kind: "exempt",
    reason:
      "SA-714 R1: writes only OrderItem.backorderedPieces (an informational tag) — no qty, price or composition column",
  },
  "invoices/invoices.service.ts::create": {
    kind: "exempt",
    reason: "manual invoice lines carry no order provenance and are never composed",
  },
  "invoices/invoices.service.ts::createSplitInvoices": { kind: "invoice" },
  "invoices/invoices.service.ts::reconcileOrderDraftInvoice": { kind: "invoice" },
  "invoices/invoices.service.ts::rebuildSiblingDrafts": { kind: "invoice" },
  "invoices/invoices.service.ts::createPartialFromOrder": { kind: "invoice" },
  "invoices/invoices.service.ts::duplicate": {
    kind: "exempt",
    reason:
      "an order-linked invoice cannot be duplicated (RF-011); composed lines exist only on those",
  },
  "invoices/invoices.service.ts::update": { kind: "invoice" },
  "orders/line-composition.ts::syncLineCompositions": {
    kind: "exempt",
    reason:
      "the writer itself: stamps compositionMode/recipeId/recipeVersion after it writes the rows",
  },
  // SA-762r F1: the cancel's line-status flip, moved verbatim out of changeStatus into the shared unwind.
  "orders/order-cancel-tx.ts::cancelOrderInTx": { kind: "exempt", reason: "status only" },
  "orders/delivered-stamp.ts::clearUnevidencedDelivered": {
    kind: "exempt",
    reason: "deliveredQty reset to 0 only; no qty, price or composition column",
  },
  "orders/delivered-stamp.ts::stampDeliveredInFull": {
    kind: "exempt",
    reason: "SA-763r: writes only OrderItem.deliveredQty, on lines with no delivery evidence",
  },
  "orders/orders.service.ts::reopenOrder": { kind: "exempt", reason: "status only" },
  "orders/orders.service.ts::recomputeLineCategoryTaxes": {
    kind: "exempt",
    reason: "tax amount only",
  },
  "orders/order-line-removal.ts::writeLineRemoval": {
    kind: "exempt",
    reason: "struck-off lines (qty 0); called only from updateOrderItems, which syncs at its end",
  },
  "orders/order-line-removal.ts::writeLineUpdate": {
    kind: "exempt",
    reason: "called only from updateOrderItems, which syncs at its end",
  },
  "orders/order-edit-composition.ts::restoreCarriedComposition": {
    kind: "exempt",
    reason:
      "re-stamps a surviving line's stored composition after a replace-all; updateOrderItems syncs at its end",
  },
  "orders/unit-line-edit.ts::createUnitLine": {
    kind: "exempt",
    reason: "a unit-aware line is never composed (COMPOSED_UNIT_LINE)",
  },
  "invoices/finalize-order-recompute.ts::checkOrderCoverage": {
    kind: "exempt",
    reason: "invoicedQty only",
  },
  "invoices/finalize-order-recompute.ts::finalizeOrderRecompute": {
    kind: "exempt",
    reason: "zeroes a cancelled orphan line (0 pieces); no live composition is re-planned",
  },
  "invoices/partial-invoice-cas.ts::bumpInvoicedQtyCas": {
    kind: "exempt",
    reason: "invoicedQty only",
  },
  "invoices/invoices.service.ts::adjustInvoicedQtyForInvoice": {
    kind: "exempt",
    reason: "invoicedQty only",
  },
  "invoices/invoices.service.ts::resyncOrderInvoicesForEdit": {
    kind: "exempt",
    reason: "invoicedQty reset only",
  },
  "invoices/invoices.service.ts::applyPriceAdjustment": {
    kind: "exempt",
    reason:
      "post-issue price adjustment; component prices are frozen per document row (SA-589, I5)",
  },
  "invoices/invoices.service.ts::setCheckStatus": {
    kind: "exempt",
    reason: "NSF fee line, no product",
  },
  "estimates/estimates.service.ts::create": {
    kind: "exempt",
    reason: "EstimateItem, not an order/invoice line",
  },
  "estimates/estimates.service.ts::convertToInvoice": {
    kind: "exempt",
    reason: "estimate lines have no recipe composition (M4a)",
  },
  "import/import.service.ts::importInvoices": {
    kind: "exempt",
    reason: "imported history, never composed",
  },
  "inventory/inventory.service.ts::createDraftPurchaseOrderInTx": {
    kind: "exempt",
    reason: "purchase order items",
  },
  "returns/inline-returns.service.ts::captureInTx": { kind: "exempt", reason: "credit note items" },
  "routes/routes.service.ts::completeWithPayment": { kind: "exempt", reason: "deliveredQty only" },
  "routes/routes.service.ts::reopenStop": { kind: "exempt", reason: "deliveredQty/status only" },
  "common/testing/copier-contract/copier-ast.ts::?": {
    kind: "exempt",
    reason: "a comment in the copier AST helper",
  },
};

const SITE =
  /\.(orderItem|invoiceItem)\.(create|createMany|update|updateMany|upsert|createManyAndReturn)\(|\b(lineItems|items)\s*:\s*\{\s*(create|createMany)\b/;
const FN_START =
  /^(?: {2}(?:async |private |public |protected |static )*[A-Za-z_][A-Za-z0-9_]*\(|(?:export )?(?:async )?function [A-Za-z0-9_]+|export const [A-Za-z0-9_]+ = (?:async )?\()/;

/** The same starts without the 2-space method form: in a file with no class, an indented call is a statement, not a method. */
const FREE_FN_START =
  /^(?:(?:export )?(?:async )?function [A-Za-z0-9_]+|export const [A-Za-z0-9_]+ = (?:async )?\()/;
const DECLARES_CLASS = /^(?:export )?(?:abstract )?class /m;

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

/** Add every writer site of one file's text to `found` as `file::function` -> function source. */
function scanSites(rel: string, text: string, found: Map<string, string>): Map<string, string> {
  const lines = text.split("\n");
  const starts: Array<{ at: number; name: string }> = [];
  const startRe = DECLARES_CLASS.test(text) ? FN_START : FREE_FN_START;
  lines.forEach((l, i) => {
    if (startRe.test(l)) starts.push({ at: i, name: fnName(l) });
  });
  lines.forEach((l, i) => {
    if (!SITE.test(l) || /^\s*(\/\/|\*)/.test(l)) return;
    const owner = [...starts].reverse().find((s) => s.at <= i);
    const key = `${rel}::${owner?.name ?? "?"}`;
    if (found.has(key)) return;
    const next = starts.find((s) => owner && s.at > owner.at);
    found.set(key, lines.slice(owner?.at ?? 0, next ? next.at : lines.length).join("\n"));
  });
  return found;
}

/** `file::function` -> that function's source text, for every function holding a writer site. */
function collectSites(files: string[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of files) {
    const rel = relative(SRC_ROOT, file).split("\\").join("/");
    scanSites(rel, readFileSync(file, "utf8"), found);
  }
  return found;
}

/** Nested `components: { create` sites of one text: how many, and how many name no tenantId. */
function nestedComponentCreates(text: string): { found: number; withoutTenant: number } {
  const re = /\bcomponents\s*:\s*\{\s*create\b/g;
  let found = 0;
  let withoutTenant = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    found += 1;
    const window = text.slice(Math.max(0, m.index - 400), m.index + 400);
    if (!window.includes("tenantId")) withoutTenant += 1;
  }
  return { found, withoutTenant };
}

describe("composition writer tripwire (#2717 M3, case 14)", () => {
  const files = listTsFiles(SRC_ROOT);
  const sites = collectSites(files);

  it("is not vacuous: it scans the source tree and finds the known order and invoice writers", () => {
    // Floors, not exact counts: the scan must keep finding the tree and a healthy set of sites.
    expect(files.length).toBeGreaterThan(300);
    expect(sites.size).toBeGreaterThanOrEqual(30);
    expect(sites.has("orders/orders.service.ts::updateOrderItems")).toBe(true);
    expect(sites.has("invoices/invoices.service.ts::create")).toBe(true);
  });

  it("negative control: the scanner reports an unlisted writer in a fixture, so the listing check would fail on it", () => {
    const fixture = [
      "export class FixtureService {",
      "  async sneakyWriter(tx: unknown) {",
      "    await tx.orderItem.create({ data: { orderId: 'o', qty: 1 } });",
      "  }",
      "}",
    ].join("\n");
    const fixtureSites = scanSites("fixture/fixture.service.ts", fixture, new Map());
    const unlisted = [...fixtureSites.keys()].filter((k) => !REGISTRY[k]);
    expect(unlisted).toEqual(["fixture/fixture.service.ts::sneakyWriter"]);
    expect(fixtureSites.get(unlisted[0])).not.toMatch(
      /syncOrderLineCompositions\(|this\.syncCompositions\(/,
    );
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
      expect(sites.get(key)).toMatch(/syncOrderLineCompositions\(|this\.syncCompositions\(/);
    },
  );

  it.each(Object.entries(REGISTRY).filter(([, e]) => e.kind === "invoice"))(
    "%s builds its lines through the component-carrying builder",
    (key) => {
      expect(sites.get(key)).toMatch(/buildInvoiceItemData\(|applyComposedLineEdits\(/);
    },
  );

  it("every nested `components: { create` passes tenantId (nested creates are not tenant-injected)", () => {
    let found = 0;
    const offenders: string[] = [];
    for (const file of files) {
      const r = nestedComponentCreates(readFileSync(file, "utf8"));
      found += r.found;
      if (r.withoutTenant > 0) offenders.push(relative(SRC_ROOT, file));
    }
    expect(found).toBeGreaterThanOrEqual(1); // not vacuous: the invoice carry builder is one
    expect(offenders).toEqual([]);
  });

  it("negative control: a nested components create with no tenantId in a fixture is reported", () => {
    expect(nestedComponentCreates("const d = { components: { create: [{ qty: 1 }] } };")).toEqual({
      found: 1,
      withoutTenant: 1,
    });
    expect(
      nestedComponentCreates("const d = { components: { create: [{ qty: 1, tenantId: t }] } };"),
    ).toEqual({ found: 1, withoutTenant: 0 });
  });
});
