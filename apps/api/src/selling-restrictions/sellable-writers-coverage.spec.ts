import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

/**
 * Lane R — coverage meta-spec: every code path that WRITES order / invoice lines is classified as
 * to whether it can add sellable goods of a product, and the ones that can must (eventually) call
 * the selling-restrictions choke point BEFORE their first line write. Same AST technique as
 * `orders/unit-line-writers.ast.spec.ts` (no regex over source; a comment or a string never counts).
 *
 *   GUARDED — calls `assertLinesSellable` / `checkLinesSellable` on a live branch (not in a try whose
 *             catch swallows the refusal), before its first line write (the AST proof below, positively controlled on inline source).
 *   PENDING — can add sellable goods and is NOT yet guarded: the enforcement points still to wire.
 *             A ratchet: `PENDING_BASELINE` may only go DOWN — flipping a row to GUARDED in the PR
 *             that wires it forces the constant down, so the list can never quietly grow or stall.
 *   EXEMPT  — cannot add sellable quantity of a product (deletes, status / delivered-qty bookkeeping,
 *             price-only rewrites, copies of goods an already-checked order carries, other models).
 *
 * Scope: `.ts` class methods under `apps/api/src` (not scripts, seeds, `.tsx`). The surface "paths that
 * make goods sellable" is a superset of "line writers" (the DRAFT promotion in `changeStatus` is
 * caught only through its cancel branch). Shared with the units spec, change both or neither: the
 * nested-write rule matches the `items` / `lineItems` name, so other models appear as EXEMPT rows.
 *
 * The inventory must EQUAL this table both ways: a NEW line writer fails until it is classified, and
 * a method that calls the choke point must be classified GUARDED (else its row is stale).
 */
type Row =
  { kind: "GUARDED" } | { kind: "PENDING"; step: string } | { kind: "EXEMPT"; why: string };
const G: Row = { kind: "GUARDED" };
const P = (step: string): Row => ({ kind: "PENDING", step });
const X = (why: string): Row => ({ kind: "EXEMPT", why });

const ord = (m: string) => `orders/orders.service.ts::OrdersService.${m}`;
const inv = (m: string) => `invoices/invoices.service.ts::InvoicesService.${m}`;
const rt = (m: string) => `routes/routes.service.ts::RoutesService.${m}`;
const vb = (m: string) => `vendor-bills/vendor-bills.service.ts::VendorBillsService.${m}`;
const invn = (m: string) => `inventory/inventory.service.ts::InventoryService.${m}`;
const cust = (m: string) => `customers/customers.service.ts::CustomersService.${m}`;
const tpl = (m: string) => `order-templates/order-templates.service.ts::OrderTemplatesService.${m}`;
const rec = (m: string) =>
  `recurring-invoices/recurring-invoices.service.ts::RecurringInvoicesService.${m}`;

const TABLE: Record<string, Row> = {
  // ── orders: the nine enforcement points (each call-site PR flips its row) ──────────────────
  [ord("create")]: G,
  [ord("updateOrderItems")]: G,
  [ord("approveChangeRequestAtStop")]: G,
  [ord("changeStatus")]: G,
  [ord("reopenOrder")]: G,
  [ord("mergeAllPendingForCustomer")]: X(
    "owner ruling 2026-09-25 (#2093) / SA-255: MERGE AND WARN — folds orders each checked when placed, never blocked; warns via merge-restriction-warning.ts (pinned in orders.merge-warn.spec.ts)",
  ),
  [ord("forceConsolidateCustomer")]: X(
    "owner ruling 2026-09-25 (#2093) / SA-255: MERGE AND WARN — folds orders each checked when placed, never blocked; warns via merge-restriction-warning.ts (pinned in orders.merge-warn.spec.ts)",
  ),
  [tpl("createOrderFromTemplate")]: G,
  [ord("recomputeLineCategoryTaxes")]: X("categoryTaxAmount only"),
  [ord("deleteOrder")]: X("removes lines"),
  // Owner ruling 2026-09-25 (#2093): at-door delivery of an order placed before a ban delivers up to the
  // ordered quantity; any increase, added line or substitution is blocked. That ceiling is
  // `assertDeliveriesFitStop` (pinned in routes/delivery-lines.util.spec.ts), so the path cannot sell more.
  [rt("completeWithPayment")]: X(
    "owner ruling 2026-09-25 (#2093): deliver up to the ordered qty, 0 for a cancelled line/order; the ceiling is assertDeliveriesFitStop (pinned)",
  ),
  // reopenStop resets delivery state on lines the order already carried; a cancelled line stays cancelled
  // (pinned in routes.reopen-cancelled-lines.spec.ts), so it adds no sellable quantity of any product.
  [rt("reopenStop")]: X(
    "owner ruling 2026-09-25 (#2093) companion: nothing not ordered is sold; reopen undoes a delivery, never a cancel (routes.reopen-cancelled-lines.spec.ts)",
  ),
  // ── invoices / estimates / import (step 2b remainder) ──────────────────────────────────────
  [inv("create")]: G,
  [inv("update")]: G,
  [inv("duplicate")]: G,
  [inv("createSplitInvoices")]: X(
    "owner ruling 2026-09-25 (#2093): SPLIT IS EXEMPT — quantity-neutral (siblings sum to the " +
      "parent order, already checked when placed); flagged + audited via restricted-lines-flag.ts " +
      "(pinned in invoices.service.spec.ts's F-05 #2093 describe), never blocked",
  ),
  "estimates/estimates.service.ts::EstimatesService.convertToInvoice": G,
  "import/import.service.ts::ImportService.importInvoices": X(
    "owner ruling 2026-09-25 (#2093): historical IMPORT IS EXEMPT — every row imports unchanged " +
      "(history is never rewritten); flagged + audited via restricted-lines-flag.ts (pinned in " +
      "import-invoices-restrictions.spec.ts), never blocked",
  ),
  [inv("applyPriceAdjustment")]: X("price only"),
  [inv("reconcileOrderDraftInvoice")]: X("mirrors the order's own goods (checked at the order)"),
  [inv("rebuildSiblingDrafts")]: X("mirrors the order's own goods"),
  [inv("createPartialFromOrder")]: X("copies lines of an existing, already-checked order"),
  [inv("recomputeOrderFromInvoices")]: X(
    "back-sync; a new order line comes from an invoice line already checked at the invoice",
  ),
  [inv("resyncOrderInvoicesForEdit")]: X("invoicedQty bookkeeping"),
  [inv("adjustInvoicedQtyForInvoice")]: X("invoicedQty bookkeeping"),
  [inv("setCheckStatus")]: X("a product-less NSF fee line"),
  [inv("deleteInvoice")]: X("removes lines"),
  // ── deletes elsewhere ──────────────────────────────────────────────────────────────────────
  [cust("deleteCustomer")]: X("customer purge"),
  [cust("deleteAllCustomers")]: X("customer purge"),
  [cust("runImportedCustomersCleanup")]: X("customer purge"), // #2629: the kept body
  "products/products.service.ts::ProductsService.bulkDelete": X("product purge"),
  "system-config/settings.controller.ts::SettingsController.clearFinancialData":
    X("financial reset"),
  // ── other models that also call their relation `items` ─────────────────────────────────────
  "bookkeeping/bookkeeping.service.ts::BookkeepingService.createExpense": X("expense lines"),
  "estimates/estimates.service.ts::EstimatesService.create": X("EstimateItem — not a sale"),
  [invn("createPurchaseOrder")]: X("PurchaseOrderItem"),
  [invn("updatePurchaseOrder")]: X("PurchaseOrderItem"),
  [invn("createDraftPurchaseOrderInTx")]: X("PurchaseOrderItem"),
  [tpl("create")]: X("OrderTemplateItem — a template, not an order"),
  [tpl("update")]: X("OrderTemplateItem"),
  [rec("create")]: X("RecurringInvoiceItem"),
  [rec("update")]: X("RecurringInvoiceItem"),
  "returns/inline-returns.service.ts::InlineReturnsService.captureInTx": X("ReturnItem"),
  "returns/returns.service.ts::ReturnsService.create": X("ReturnItem"),
  [vb("create")]: X("VendorBillItem"),
  [vb("update")]: X("VendorBillItem"),
  [vb("receive")]: X("VendorBillItem"),
  [vb("revertToDraft")]: X("VendorBillItem"),
  [vb("delete")]: X("AP bill line delete only: no qty/unit/price write, no sellable product added"),
  [vb("bulkDelete")]: X(
    "AP bill line delete only: no qty/unit/price write, no sellable product added",
  ),
};

/** The RATCHET: how many rows are still PENDING. Lower it in the PR that flips a row to GUARDED. */
const PENDING_BASELINE = 0; // was 2: createSplitInvoices + importInvoices both EXEMPT with written reasons (F-05 #2093 split/import PR)
/** GUARDED + PENDING: reclassifying a PENDING row to EXEMPT (an escape, not progress) must change THIS. */
const ENFORCEMENT_POINTS = 10; // -2 (#2093 split/import EXEMPT, this PR); prior -2 (completeWithPayment/reopenStop) + -2 (merge/consolidate, SA-255)
const CHOKE_POINT = ["assertLinesSellable", "checkLinesSellable"];

// ─── scanner (same rules as orders/unit-line-writers.ast.spec.ts; exercised on inline source) ──
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

function classMethods(sf: ts.SourceFile): Map<string, ts.MethodDeclaration> {
  const out = new Map<string, ts.MethodDeclaration>();
  const visit = (n: ts.Node) => {
    if (ts.isClassDeclaration(n) && n.name)
      for (const m of n.members)
        if (ts.isMethodDeclaration(m) && m.name) out.set(`${n.name.text}.${m.name.getText(sf)}`, m);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function objectLiterals(e: ts.Expression): ts.ObjectLiteralExpression[] {
  if (ts.isObjectLiteralExpression(e)) return [e];
  if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e))
    return objectLiterals(e.expression);
  if (ts.isConditionalExpression(e))
    return [...objectLiterals(e.whenTrue), ...objectLiterals(e.whenFalse)];
  return [];
}

/** Source position of every line write under `node` (direct table write, or a nested relation write). */
function lineWritePositions(node: ts.Node, sf: ts.SourceFile): number[] {
  const at: number[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const table = n.expression.expression;
      if (
        WRITE_OPS.has(n.expression.name.text) &&
        ts.isPropertyAccessExpression(table) &&
        LINE_TABLES.has(table.name.text)
      )
        at.push(n.getStart());
    }
    if (ts.isPropertyAssignment(n) && NESTED_RELATIONS.has(n.name.getText(sf)))
      for (const lit of objectLiterals(n.initializer))
        if (lit.properties.some((p) => p.name && NESTED_OPS.has(p.name.getText(sf))))
          at.push(n.getStart());
    ts.forEachChild(n, visit);
  };
  visit(node);
  return at;
}

const isWithin = (n: ts.Node, c: ts.Node) => n.pos >= c.pos && n.end <= c.end;
function onDeadOrRecoveryBranch(n: ts.Node, stop: ts.Node): boolean {
  for (let c: ts.Node | undefined = n.parent; c && c !== stop; c = c.parent) {
    if (ts.isCatchClause(c)) return true;
    if (
      ts.isIfStatement(c) &&
      c.expression.kind === ts.SyntaxKind.FalseKeyword &&
      isWithin(n, c.thenStatement)
    )
      return true;
  }
  return false;
}

/** True when EVERY path through `stmts` ends in a throw: a `return`, a bare `if (x) throw e;` or falling off the end does not. */
function alwaysThrows(stmts: readonly ts.Statement[]): boolean {
  const branch = (n: ts.Statement) => alwaysThrows(ts.isBlock(n) ? n.statements : [n]);
  /** A `return` anywhere under `n` (not inside a nested function) is a path that swallows. */
  const returns = (n: ts.Node): boolean =>
    ts.isReturnStatement(n) || (!ts.isFunctionLike(n) && ts.forEachChild(n, returns) === true);
  for (const st of stmts) {
    if (ts.isThrowStatement(st)) return true;
    if (returns(st)) return false;
    if (ts.isBlock(st) && alwaysThrows(st.statements)) return true;
    if (
      ts.isIfStatement(st) &&
      st.elseStatement &&
      branch(st.thenStatement) &&
      branch(st.elseStatement)
    )
      return true;
  }
  return false;
}

/**
 * A call inside `try { … } catch { … }` whose catch does not ALWAYS rethrow is a refusal that can be SWALLOWED:
 * the write goes ahead anyway, so it is not a guard. (Deliberately NOT part of `onDeadOrRecoveryBranch`:
 * the stale-row scan must still see such a call, so its method has to be classified GUARDED, and
 * then this proof rejects it.)
 */
function swallowedByTry(n: ts.Node, stop: ts.Node): boolean {
  for (let c: ts.Node | undefined = n.parent; c && c !== stop; c = c.parent) {
    if (!ts.isTryStatement(c) || !c.catchClause || !isWithin(n, c.tryBlock)) continue;
    if (!alwaysThrows(c.catchClause.block.statements)) return true;
  }
  return false;
}

/** Positions of every REAL call to any of `names` under `node`, on live branches. */
function callPositions(node: ts.Node, names: string[]): number[] {
  const at: number[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const c = n.expression;
      const name = ts.isIdentifier(c)
        ? c.text
        : ts.isPropertyAccessExpression(c)
          ? c.name.text
          : "";
      if (names.includes(name) && !onDeadOrRecoveryBranch(n, node)) at.push(n.getStart());
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return at;
}

/**
 * A choke-point call only counts as a GUARD when it is AWAITED (a floating promise neither precedes
 * nor blocks the write) and it is not buried in a closure that is never run (a function expression
 * counts only as a call argument — a callback such as `tenantTransaction(async (tx) => ...)` — or
 * when immediately invoked).
 */
function guardCallPositions(node: ts.Node): number[] {
  const at: number[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const c = n.expression;
      const name = ts.isIdentifier(c)
        ? c.text
        : ts.isPropertyAccessExpression(c)
          ? c.name.text
          : "";
      if (
        CHOKE_POINT.includes(name) &&
        !onDeadOrRecoveryBranch(n, node) &&
        !swallowedByTry(n, node) &&
        isAwaited(n, node) &&
        !inDeadClosure(n, node)
      )
        at.push(n.getStart());
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return at;
}
function isAwaited(n: ts.Node, stop: ts.Node): boolean {
  for (let c: ts.Node | undefined = n.parent; c && c !== stop; c = c.parent) {
    if (ts.isAwaitExpression(c)) return true;
    if (ts.isBlock(c) || ts.isExpressionStatement(c) || ts.isVoidExpression(c)) return false;
  }
  return false;
}
function inDeadClosure(n: ts.Node, stop: ts.Node): boolean {
  for (let c: ts.Node | undefined = n.parent; c && c !== stop; c = c.parent) {
    if (!ts.isArrowFunction(c) && !ts.isFunctionExpression(c)) continue;
    const p = c.parent;
    const asArgument = ts.isCallExpression(p) && p.arguments.includes(c as ts.Expression);
    const iife = ts.isCallExpression(p) && p.expression === c;
    if (!asArgument && !iife) return true;
  }
  return false;
}

/** What is wrong with a method classified GUARDED: no real awaited call, or a call only AFTER its first line write. */
function guardProblem(node: ts.Node, sf: ts.SourceFile): string | null {
  const calls = guardCallPositions(node);
  if (calls.length === 0) return `does not (await) call ${CHOKE_POINT.join(" / ")}`;
  const writes = lineWritePositions(node, sf);
  if (writes.length > 0 && Math.min(...calls) > Math.min(...writes))
    return "calls the choke point only AFTER its first line write";
  return null;
}

const SRC = path.join(__dirname, "..");
const walkFiles = (dir: string): string[] =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory()
        ? walkFiles(path.join(dir, e.name))
        : e.name.endsWith(".ts") && !e.name.endsWith(".spec.ts")
          ? [path.join(dir, e.name)]
          : [],
    );
const files = new Map(
  walkFiles(SRC).map((f) => [
    path.relative(SRC, f).split(path.sep).join("/"),
    parse(f, fs.readFileSync(f, "utf8")),
  ]),
);

function writers(): Set<string> {
  const found = new Set<string>();
  for (const [file, sf] of files)
    for (const [name, node] of classMethods(sf))
      if (lineWritePositions(node, sf).length > 0) found.add(`${file}::${name}`);
  return found;
}
const methodOf = (key: string) => {
  const [file, name] = key.split("::");
  const sf = files.get(file)!;
  return { node: classMethods(sf).get(name)!, sf };
};

describe("the scanner and the proof themselves (so a silent no-match cannot pass below)", () => {
  const sf = parse(
    "inline.ts",
    `class A {
      good() { await this.r.assertLinesSellable({}); this.prisma.orderItem.create({}); }
      late() { this.prisma.orderItem.create({}); await this.r.checkLinesSellable({}); }
      none() { this.prisma.invoiceItem.update({}); }
      commented() { /* this.r.assertLinesSellable({}) */ const s = "assertLinesSellable("; this.prisma.orderItem.create({}); }
      voided() { void this.r.assertLinesSellable({}); this.prisma.orderItem.create({}); }
      floating() { this.r.assertLinesSellable({}); this.prisma.orderItem.create({}); }
      neverRun() { const f = async () => { await this.r.assertLinesSellable({}); }; this.prisma.orderItem.create({}); }
      inTx() { await this.tx(async (tx) => { await this.r.assertLinesSellable({}); tx.orderItem.create({}); }); }
      dead() { if (false) { await this.r.assertLinesSellable({}); } this.prisma.orderItem.create({}); }
      recovery() { try { w(); } catch (e) { await this.r.assertLinesSellable({}); } this.prisma.orderItem.create({}); }
      swallowed() { try { await this.r.assertLinesSellable({}); } catch (e) { log(e); } this.prisma.orderItem.create({}); }
      rethrown() { try { await this.r.assertLinesSellable({}); } catch (e) { log(e); throw e; } this.prisma.orderItem.create({}); }
      earlyReturn() { try { await this.r.assertLinesSellable({}); } catch (e) { if (x) return; throw e; } this.prisma.orderItem.create({}); }
      condRethrown() { try { await this.r.assertLinesSellable({}); } catch (e) { if (x) throw e; } this.prisma.orderItem.create({}); }
      bothRethrown() { try { await this.r.assertLinesSellable({}); } catch (e) { if (x) throw e; else throw new Error("y"); } this.prisma.orderItem.create({}); }
      nested() { return this.prisma.order.update({ data: { lineItems: c ? { create: [] } : undefined } }); }
      other() { return this.prisma.order.update({ data: { notes: "x" } }); }
    }`,
  );
  const m = classMethods(sf);

  it("finds direct and nested line writes and ignores unrelated writes", () => {
    expect(lineWritePositions(m.get("A.good")!, sf)).toHaveLength(1);
    expect(lineWritePositions(m.get("A.nested")!, sf)).toHaveLength(1);
    expect(lineWritePositions(m.get("A.other")!, sf)).toHaveLength(0);
  });

  it("the guard proof accepts a real early call and rejects none / late / commented / dead / recovery / swallowed / conditionally rethrown", () => {
    expect(guardProblem(m.get("A.good")!, sf)).toBeNull();
    expect(guardProblem(m.get("A.inTx")!, sf)).toBeNull(); // awaited inside a transaction callback
    expect(guardProblem(m.get("A.rethrown")!, sf)).toBeNull(); // a catch that rethrows still refuses
    expect(guardProblem(m.get("A.bothRethrown")!, sf)).toBeNull(); // every branch throws: still a refusal
    expect(guardProblem(m.get("A.late")!, sf)).toMatch(/AFTER/);
    for (const name of [
      "A.none",
      "A.commented",
      "A.dead",
      "A.recovery",
      "A.swallowed",
      "A.condRethrown", // `if (x) throw e;` swallows every other error
      "A.earlyReturn", // a path that returns swallows too
      "A.voided",
      "A.floating",
      "A.neverRun",
    ])
      expect(guardProblem(m.get(name)!, sf)).toMatch(/does not/);
  });

  it("the real tree yields a plausible inventory (not zero)", () => {
    expect(writers().size).toBeGreaterThan(40);
  });
});

describe("every order/invoice line writer is classified for selling restrictions", () => {
  it("the inventory equals the table, both directions", () => {
    const scanned = [...writers()].sort();
    expect({ unclassified: scanned.filter((k) => !TABLE[k]) }).toEqual({ unclassified: [] });
    expect({ stale: Object.keys(TABLE).filter((k) => !scanned.includes(k)) }).toEqual({
      stale: [],
    });
  });

  it("every GUARDED row really calls the choke point before its first line write", () => {
    const failures = Object.entries(TABLE)
      .filter(([, r]) => r.kind === "GUARDED")
      .flatMap(([key]) => {
        const { node, sf } = methodOf(key);
        const p = guardProblem(node, sf);
        return p ? [`${key} ${p}`] : [];
      });
    expect(failures).toEqual([]);
  });

  it("a method that calls the choke point is classified GUARDED (else its row is stale)", () => {
    const stale: string[] = [];
    for (const [file, sf] of files) {
      if (file.startsWith("selling-restrictions/")) continue; // the definition itself
      for (const [name, node] of classMethods(sf)) {
        const key = `${file}::${name}`;
        if (callPositions(node, CHOKE_POINT).length > 0 && TABLE[key]?.kind !== "GUARDED")
          stale.push(key);
      }
    }
    expect(stale).toEqual([]);
  });

  it("THE RATCHET: PENDING rows == PENDING_BASELINE (lower it when a row flips to GUARDED); each states its step", () => {
    const pending = Object.entries(TABLE).filter(([, r]) => r.kind === "PENDING");
    expect(pending).toHaveLength(PENDING_BASELINE);
    // reclassifying PENDING -> EXEMPT would shrink `pending` exactly like wiring a guard: pin the sum
    expect(pending.length + Object.values(TABLE).filter((r) => r.kind === "GUARDED").length).toBe(
      ENFORCEMENT_POINTS,
    );
    for (const [key, r] of pending)
      expect({ key, step: (r as { step: string }).step.length > 0 }).toEqual({ key, step: true });
  });

  it("EXEMPT rows state why", () => {
    const missing = Object.entries(TABLE).filter(
      ([, r]) => r.kind === "EXEMPT" && !(r as { why: string }).why,
    );
    expect(missing).toEqual([]);
  });

  it("custom (productless) lines are EXEMPT by owner ruling 2026-09-25, and the uncategorised-lines report row reviews them", () => {
    // The ban check ignores a line with no catalog product (a tenant that wants one checked adds it to the
    // catalog). That exemption is only acceptable because this standing review list exists: if the report
    // code or its wiring goes, this fails and the exemption must be revisited with the owner.
    const src = (rel: string) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
    expect(src("regulated/report-types.ts")).toContain("UNCATEGORISED_LINE_IN_RULE_STATE");
    expect(src("regulated/uncategorised-lines.ts")).toContain("productId: null");
    expect(src("regulated/regulated-report.service.ts")).toContain("uncategorisedLineWarnings(");
  });
});
