import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

/**
 * B1234 structural pin (same class as composition-writer-tripwire.spec.ts, SA-579 case 14): every non-spec
 * function under apps/api/src that UPDATES or DELETES an existing OrderItem is listed below by
 * `file::function` and is one of:
 *   - "guarded": the function calls `assertDeliveredLinesUntouched(` (delivered-line-lock.ts), the ONE guard
 *     that refuses (409 LINE_ALREADY_DELIVERED) a change to a delivered line of a PARTIALLY_DELIVERED order;
 *   - "status-gated": the writer cannot reach a PARTIALLY_DELIVERED order, and `gate` is a pattern that must
 *     still appear in `gateFile` (default: the writer's own file), so the claim is checkable;
 *   - "via-guarded": a helper whose ONLY callers (outside its own file) are the listed guarded / status-gated
 *     functions; a new caller fails here;
 *   - "not-a-lock-column": it writes only columns the lock does not cover (deliveredQty, invoicedQty, derived
 *     tax / free-unit snapshots, a composition stamp, an informational marker);
 *   - "excluded": deliberately outside the lock (SA-814a); `reason` states why;
 *   - "deferred": not guarded yet, tracked by a named follow-up row (SA-814a); `reason` names the row.
 * No writer stays "open": every entry is one of the kinds above.
 * A NEW writer that is not listed, a stale entry, a "guarded" function that lost its call, a "status-gated"
 * file that lost its gate, a "via-guarded" helper with a new caller, and an entry without a reason all fail here.
 */
const SRC_ROOT = join(__dirname, "..");

type Entry =
  | { kind: "guarded" }
  | { kind: "status-gated"; gate: RegExp; gateFile?: string; reason: string }
  | { kind: "via-guarded"; callee: string; callers: string[]; reason: string }
  | { kind: "not-a-lock-column"; reason: string }
  | { kind: "excluded"; reason: string }
  | { kind: "deferred"; reason: string };

const MERGE_GATE = {
  gate: /status: OrderStatus\.PENDING/,
  gateFile: "orders/merge-lock-recheck.ts",
};

const REGISTRY: Record<string, Entry> = {
  "orders/orders.service.ts::updateOrderItems": { kind: "guarded" },

  // Reached only from updateOrderItems (guarded) or approveChangeRequestAtStop (status-gated below).
  "orders/order-line-removal.ts::writeLineRemoval": {
    kind: "via-guarded",
    callee: "writeLineRemoval",
    callers: ["orders/orders.service.ts::updateOrderItems"],
    reason: "per-line CANCEL / DELETE strike-off and hard delete of the edit",
  },
  "orders/order-line-removal.ts::writeLineUpdate": {
    kind: "via-guarded",
    callee: "writeLineUpdate",
    callers: [
      "orders/orders.service.ts::updateOrderItems",
      "orders/unit-line-edit.ts::updateUnitLine",
    ],
    reason: "per-line substitute / unit rewrite of the edit",
  },
  "orders/settle-split-free-units.ts::settleSplitFreeUnits": {
    kind: "via-guarded",
    callee: "settleSplitFreeUnits",
    callers: [
      "orders/orders.service.ts::updateOrderItems",
      "orders/orders.service.ts::approveChangeRequestAtStop",
    ],
    reason: "free-unit snapshot and the subtotal it implies, after the edit's own line writes",
  },

  // The at-door change request: refused outright on a PARTIALLY_DELIVERED order, then per delivered line.
  "orders/orders.service.ts::approveChangeRequestAtStop": {
    kind: "status-gated",
    gate: /\["PENDING", "CONFIRMED", "OUT_FOR_DELIVERY"\]\.includes\(live\.status\)/,
    reason:
      "CHANGE_WINDOW_ORDER_STATUS for any other status; a delivered line is also LINE_ALREADY_DELIVERED",
  },
  // Order merges: the shared predicate (merge-lock-recheck.ts) only ever selects PENDING orders.
  "orders/orders.service.ts::mergeAllPendingForCustomer": {
    kind: "status-gated",
    ...MERGE_GATE,
    reason: "merge group = PENDING, unrouted, uninvoiced orders",
  },
  "orders/orders.service.ts::forceConsolidateCustomer": {
    kind: "status-gated",
    ...MERGE_GATE,
    reason: "merge group = PENDING, unrouted, uninvoiced orders",
  },
  "orders/merge-lock-recheck.ts::deleteLoserGuarded": {
    kind: "status-gated",
    ...MERGE_GATE,
    reason: "deletes the lines of a merged-away PENDING order",
  },
  "orders/orders.service.ts::reopenOrder": {
    kind: "status-gated",
    gate: /Only CANCELLED orders can be reopened/,
    reason: "CANCELLED -> PENDING only; flips struck-off line statuses back",
  },
  "orders/order-cancel-tx.ts::cancelOrderInTx": {
    kind: "status-gated",
    gate: /Cancelling would erase revenue for goods the customer already has/,
    gateFile: "orders/orders.service.ts",
    reason: "B56: an order with delivered units cannot be cancelled (status flip of every line)",
  },

  // Columns outside the lock (quantity, price, unit, removal).
  "orders/delivered-stamp.ts::stampDeliveredInFull": {
    kind: "not-a-lock-column",
    reason: "writes deliveredQty on lines with no delivery evidence",
  },
  "orders/delivered-stamp.ts::clearUnevidencedDelivered": {
    kind: "not-a-lock-column",
    reason: "resets deliveredQty to 0 only",
  },
  "routes/routes.service.ts::completeWithPayment": {
    kind: "not-a-lock-column",
    reason: "delivery completion: deliveredQty recompute",
  },
  "routes/routes.service.ts::reopenStop": {
    kind: "not-a-lock-column",
    reason: "undoes a stop: line status back to PENDING and a deliveredQty recompute",
  },
  "orders/backorder-marker-writes.ts::writeValues": {
    kind: "not-a-lock-column",
    reason: "backorderedPieces, an informational tag",
  },
  "orders/line-composition.ts::syncLineCompositions": {
    kind: "not-a-lock-column",
    reason: "composition stamp and component rows after the line write; no qty, price or unit",
  },
  "orders/order-edit-composition.ts::restoreCarriedComposition": {
    kind: "not-a-lock-column",
    reason: "stamps the composition on a line re-created inside the same (guarded) edit",
  },
  "orders/recompute-line-category-taxes.ts::recomputeLineCategoryTaxes": {
    kind: "not-a-lock-column",
    reason: "category tax amount, plus the rate trio stamped once on a NULL-trio line",
  },
  "invoices/finalize-order-recompute.ts::checkOrderCoverage": {
    kind: "not-a-lock-column",
    reason: "invoicedQty only (invoicing what was delivered is an allowed office action)",
  },
  "invoices/partial-invoice-cas.ts::bumpInvoicedQtyCas": {
    kind: "not-a-lock-column",
    reason: "invoicedQty only",
  },
  "invoices/invoices.service.ts::adjustInvoicedQtyForInvoice": {
    kind: "not-a-lock-column",
    reason: "invoicedQty only",
  },
  "invoices/invoices.service.ts::resyncOrderInvoicesForEdit": {
    kind: "not-a-lock-column",
    reason: "invoicedQty reset only",
  },
  "invoices/invoices.service.ts::reconcileOrderDraftInvoiceLocked": {
    kind: "not-a-lock-column",
    reason: "invoicedQty reset to what the draft bills",
  },
  "invoices/invoices.service.ts::rebuildSiblingDrafts": {
    kind: "not-a-lock-column",
    reason: "invoicedQty set to what each draft bills",
  },

  // Whole-order and invoice-driven paths the ruling does not name (SA-814a): excluded or deferred, never open.
  "orders/orders.service.ts::deleteOrder": {
    kind: "deferred",
    reason: "deferred: row (P2, delivery lane) refuse delete when any line has deliveredQty > 0",
  },
  "customers/customers.service.ts::deleteCustomer": {
    kind: "excluded",
    reason: "excluded: by design (SA-814a)",
  },
  "customers/customers.service.ts::deleteAllCustomers": {
    kind: "excluded",
    reason: "excluded: by design (SA-814a)",
  },
  "customers/customers.service.ts::runImportedCustomersCleanup": {
    kind: "excluded",
    reason: "excluded: by design (SA-814a)",
  },
  "invoices/invoices.service.ts::recomputeOrderFromInvoices": {
    kind: "excluded",
    reason:
      "excluded: the invoice is the billing authority (SA-803/B663); B1050 keeps stock booked at max(qty, delivered)",
  },
  "invoices/finalize-order-recompute.ts::finalizeOrderRecompute": {
    kind: "excluded",
    reason:
      "excluded: the invoice is the billing authority (SA-803/B663); B1050 keeps stock booked at max(qty, delivered)",
  },
};

/**
 * A function that is not itself a writer but sits between a "via-guarded" helper and a guarded function:
 * its only callers must be listed here (and be guarded or status-gated).
 */
const INTERMEDIATE: Record<string, { callee: string; callers: string[] }> = {
  "orders/unit-line-edit.ts::updateUnitLine": {
    callee: "updateUnitLine",
    callers: ["orders/orders.service.ts::updateOrderItems"],
  },
};

/**
 * Not OrderItem writers (so not in REGISTRY), but a known gap in the same lock, named so it is not forgotten:
 * the un-tx'd `revertLinkedInvoicesForOrderEdit` before the binding 409 can commit a revert when the
 * pre-tx status was stale (b1234-delivered-line-lock.db.spec.ts carries the matching `it.todo`).
 */
const DEFERRED_NON_WRITERS: Record<string, string> = {
  "orders/orders.service.ts::updateOrderItems -> revertLinkedInvoicesForOrderEdit (pre-tx)":
    "deferred: row (P2) pre-tx preflight read-only; revert in-tx under the lock",
};

const SITE =
  /\.orderItem\.(update|updateMany|delete|deleteMany|upsert)\(|\blineItems\s*:\s*\{\s*(update|updateMany|delete|deleteMany|upsert)\b|(UPDATE|DELETE\s+FROM)\s+"OrderItem"/;
const FN_START =
  /^(?: {2}(?:async |private |public |protected |static )*[A-Za-z_][A-Za-z0-9_]*\(|(?:export )?(?:async )?function [A-Za-z0-9_]+|export const [A-Za-z0-9_]+ = (?:async )?\()/;
/** In a file with no class an indented call is a statement, not a method. */
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
    } else if (
      entry.endsWith(".ts") &&
      !/\.(spec|test)\.ts$/.test(entry) &&
      !entry.endsWith(".d.ts") &&
      !full.split(/[\\/]/).includes("testing")
    ) {
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

/** Every function body in the tree (not only writers), for the via-guarded caller check. */
function scanFunctions(rel: string, text: string, found: Map<string, string>): void {
  const lines = text.split("\n");
  const startRe = DECLARES_CLASS.test(text) ? FN_START : FREE_FN_START;
  const starts: Array<{ at: number; name: string }> = [];
  lines.forEach((l, i) => {
    if (startRe.test(l)) starts.push({ at: i, name: fnName(l) });
  });
  starts.forEach((st, idx) => {
    const end = starts[idx + 1]?.at ?? lines.length;
    found.set(`${rel}::${st.name}`, lines.slice(st.at, end).join("\n"));
  });
}

const files = listTsFiles(SRC_ROOT);
const relOf = (file: string) => relative(SRC_ROOT, file).split("\\").join("/");
const sites = new Map<string, string>();
const functions = new Map<string, string>();
for (const file of files) {
  const text = readFileSync(file, "utf8");
  scanSites(relOf(file), text, sites);
  scanFunctions(relOf(file), text, functions);
}
const textOf = (rel: string) => readFileSync(join(SRC_ROOT, rel), "utf8");
/** Functions outside `definingFile` that call `callee(`. */
const callersOf = (callee: string, definingFile: string): string[] =>
  [...functions.entries()]
    .filter(([key, body]) => !key.startsWith(`${definingFile}::`) && body.includes(`${callee}(`))
    .map(([key]) => key)
    .sort();

describe("delivered-line lock: every writer of an existing OrderItem is guarded or accounted for (B1234)", () => {
  it("is not vacuous: it scans the tree and finds the known edit writers", () => {
    expect(files.length).toBeGreaterThan(300);
    expect(sites.size).toBeGreaterThanOrEqual(15);
    expect(sites.has("orders/orders.service.ts::updateOrderItems")).toBe(true);
    expect(sites.has("orders/order-line-removal.ts::writeLineRemoval")).toBe(true);
  });

  it("negative control: the scanner reports an unlisted updater and deleter in a fixture", () => {
    const fixture = [
      "export class FixtureService {",
      "  async sneakyUpdate(tx: unknown) {",
      "    await tx.orderItem.update({ where: { id: 'l' }, data: { qty: 1 } });",
      "  }",
      "  async sneakyDelete(tx: unknown) {",
      "    await tx.orderItem.deleteMany({ where: { orderId: 'o' } });",
      "  }",
      "}",
    ].join("\n");
    const found = scanSites("fixture/fixture.service.ts", fixture, new Map());
    expect([...found.keys()].filter((k) => !REGISTRY[k])).toEqual([
      "fixture/fixture.service.ts::sneakyUpdate",
      "fixture/fixture.service.ts::sneakyDelete",
    ]);
    expect(found.get("fixture/fixture.service.ts::sneakyUpdate")).not.toMatch(
      /assertDeliveredLinesUntouched\(/,
    );
  });

  it("every writer is listed (an unlisted new site fails here)", () => {
    expect([...sites.keys()].filter((k) => !REGISTRY[k]).sort()).toEqual([]);
  });

  it("no listed entry is stale", () => {
    expect(Object.keys(REGISTRY).filter((k) => !sites.has(k))).toEqual([]);
  });

  it("every non-guarded entry carries a reason", () => {
    const bare = Object.entries(REGISTRY).filter(
      ([, e]) => e.kind !== "guarded" && !(e as { reason?: string }).reason,
    );
    expect(bare).toEqual([]);
  });

  it("no writer stays open: every entry is one of the accounted kinds, and excluded / deferred say why", () => {
    const kinds = [
      "guarded",
      "status-gated",
      "via-guarded",
      "not-a-lock-column",
      "excluded",
      "deferred",
    ];
    expect(Object.entries(REGISTRY).filter(([, e]) => !kinds.includes(e.kind))).toEqual([]);
    for (const [, e] of Object.entries(REGISTRY)) {
      if (e.kind === "excluded") expect(e.reason).toMatch(/^excluded: /);
      if (e.kind === "deferred") expect(e.reason).toMatch(/^deferred: row \(P2/);
    }
    for (const reason of Object.values(DEFERRED_NON_WRITERS)) {
      expect(reason).toMatch(/^deferred: row \(P2\)/);
    }
  });

  it.each(Object.entries(REGISTRY).filter(([, e]) => e.kind === "guarded"))(
    "%s calls assertDeliveredLinesUntouched",
    (key) => {
      expect(sites.get(key)).toMatch(/assertDeliveredLinesUntouched\(/);
    },
  );

  it.each(Object.entries(REGISTRY).filter(([, e]) => e.kind === "status-gated"))(
    "%s: its status gate is still in place",
    (key, entry) => {
      const { gate, gateFile } = entry as { gate: RegExp; gateFile?: string };
      expect(textOf(gateFile ?? key.split("::")[0])).toMatch(gate);
    },
  );

  it.each(Object.entries(REGISTRY).filter(([, e]) => e.kind === "via-guarded"))(
    "%s: its only callers are the listed guarded or status-gated functions",
    (key, entry) => {
      const { callee, callers } = entry as { callee: string; callers: string[] };
      expect(callersOf(callee, key.split("::")[0])).toEqual([...callers].sort());
      for (const caller of callers) {
        const kind = REGISTRY[caller]?.kind ?? (INTERMEDIATE[caller] ? "intermediate" : undefined);
        expect(["guarded", "status-gated", "intermediate"]).toContain(kind);
      }
    },
  );

  it.each(Object.entries(INTERMEDIATE))(
    "%s: its only callers are guarded or status-gated functions",
    (key, { callee, callers }) => {
      expect(callersOf(callee, key.split("::")[0])).toEqual([...callers].sort());
      for (const caller of callers) {
        expect(["guarded", "status-gated"]).toContain(REGISTRY[caller]?.kind);
      }
    },
  );

  it("the lock itself is wired: updateOrderItems calls the guard on the pre-tx read AND the locked read", () => {
    const body = sites.get("orders/orders.service.ts::updateOrderItems") ?? "";
    expect(body.match(/assertDeliveredLinesUntouched\(/g)?.length).toBeGreaterThanOrEqual(2);
    expect(body).toMatch(/assertDeliveredLinesUntouched\(order, order\.lineItems/);
    // SA-814: the locked call decides applicability from the status read under the Order lock, never `order.status`.
    expect(body).toMatch(
      /assertDeliveredLinesUntouched\(\s*\{ status: lockedStatus\?\.status \?\? order\.status \},\s*heldItems/,
    );
  });
});
