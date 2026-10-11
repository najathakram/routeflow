/**
 * SA-706c (c) — structural guard: every writer that can settle an order's credits, and every
 * invoice creation that can run on a CALLER's transaction, is classified with the first lock it
 * holds on the Order. The deadlock class (an FK insert takes KEY SHARE on the Order, settle's
 * lockOrderCreditSettle then upgrades it to FOR UPDATE) came back three times (SA-706, 706a, 706c)
 * because each new caller was reviewed by eye. This spec fails on any call site not listed here, so
 * a new caller has to declare — and a reviewer has to read — its first lock.
 *
 * Scans apps/api/src (non-spec, non-testing .ts, comments stripped). A site is `file#method`, the
 * nearest enclosing method/function. Add a row (and the proof that the lock really comes first) to
 * classify a new caller; never loosen the scan.
 */
import fs from "node:fs";
import * as ts from "typescript";
import path from "node:path";

const SRC = path.join(__dirname, "..");

const strip = (code: string) =>
  code
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/.*$/gm, (m, lead: string) => lead + " ".repeat(m.length - lead.length));

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) {
      return e.name === "node_modules" || e.name === "testing" ? [] : walk(path.join(dir, e.name));
    }
    return /\.ts$/.test(e.name) && !/\.(spec|test)\.ts$/.test(e.name)
      ? [path.join(dir, e.name)]
      : [];
  });
}

// A class member / top-level function head: `  async name(...) {`, `  name(` (multi-line params),
// `export async function name(`.
const HEAD =
  /^(?:(?:export )?(?:async )?function (\w+)\b[^\n]*|  (?:private |public |protected |static )*(?:async )?(\w+)\((?:[^\n]*\{[ \t]*|[ \t]*))$/gm;

/** `file#method` of every call of `name(` (definitions excluded). */
function callSites(name: string): string[] {
  const out: string[] = [];
  for (const file of walk(SRC)) {
    const src = strip(fs.readFileSync(file, "utf8"));
    const call = new RegExp(`\\b${name}\\(`, "g");
    let m: RegExpExecArray | null;
    while ((m = call.exec(src))) {
      if (/(async |function )$/.test(src.slice(Math.max(0, m.index - 8), m.index))) continue;
      let enclosing = "?";
      HEAD.lastIndex = 0;
      let h: RegExpExecArray | null;
      while ((h = HEAD.exec(src)) && h.index < m.index) enclosing = h[1] ?? h[2];
      out.push(`${path.relative(SRC, file).replace(/\\/g, "/")}#${enclosing}`);
    }
  }
  return [...new Set(out)].sort();
}

/**
 * Every call of `name(` (definitions excluded) with the text of its enclosing method up to the
 * call (`prefix`), so a guard can assert what that method locked BEFORE it.
 */
function callPrefixes(
  name: string,
): Array<{ site: string; prefix: string; args: string; line: number }> {
  const out: Array<{ site: string; prefix: string; args: string; line: number }> = [];
  for (const file of walk(SRC)) {
    const src = strip(fs.readFileSync(file, "utf8"));
    const call = new RegExp(`\\b${name}\\(`, "g");
    let m: RegExpExecArray | null;
    while ((m = call.exec(src))) {
      if (/(async |function )$/.test(src.slice(Math.max(0, m.index - 12), m.index))) continue;
      let start = 0;
      let enclosing = "?";
      HEAD.lastIndex = 0;
      let h: RegExpExecArray | null;
      while ((h = HEAD.exec(src)) && h.index < m.index) {
        start = h.index;
        enclosing = h[1] ?? h[2];
      }
      out.push({
        site: `${path.relative(SRC, file).replace(/\\/g, "/")}#${enclosing}`,
        prefix: src.slice(start, m.index),
        args: src.slice(m.index, src.indexOf(";", m.index)), // the whole call, multi-line or not
        line: src.slice(0, m.index).split("\n").length,
      });
    }
  }
  return out;
}

/** Every settleOrderCreditsInTx caller → the first lock it holds on the Order before it runs. */
const SETTLE_CALLERS: Record<string, string> = {
  "invoices/invoices.service.ts#createSplitInvoices":
    "own tx: lockOrderRow (SA-706); caller's tx: lockStopOrdersAndFit (completeWithPayment, SA-706c)",
  "invoices/invoices.service.ts#createPartialFromOrder": "lockOrderRow, first statement (SA-706)",
  "invoices/invoices.service.ts#markSent":
    "lockInvoiceRow (Order then Invoice, SA-404) before lockCreditsForSend",
  "orders/orders.service.ts#syncAndSettleOrderCredits":
    "lockOrderRow, first statement (SA-706a); create() and reconcileOrderAfterEdit both go through it",
  "orders/orders.service.ts#changeStatus":
    "settle is the tx's first statement: its own lockOrderCreditSettle takes the Order first",
  "returns/inline-returns.service.ts#issueCreditInTx":
    "caller holds the Order: captureInTx's first statement; issueCredit()/approve() lockOrderRow after the Return (SA-706c)",
};

/**
 * Every createInvoiceFromOrder / createSplitInvoices call. `own-tx` = the callee opens its tx and
 * takes lockOrderRow first; `caller-tx` = it runs on the caller's tx, so the caller must already
 * hold the Order FOR UPDATE.
 */
const INVOICE_CREATE_CALLERS: Record<string, string> = {
  "invoices/invoices.controller.ts#createFromOrder": "own-tx: office from-order route",
  "invoices/invoices.service.ts#createInvoiceFromOrder": "own-tx or the caller's: see below",
  "invoices/invoices.service.ts#createInvoiceFromOrderWithTenant": "own-tx: fire-and-forget path",
  "orders/orders.service.ts#createSale":
    "own-tx: no tx argument (createInvoiceFromOrder(id, undefined, ...))",
  "invoices/delivered-reconcile.ts#reconcileDeliveredOrdersInTx":
    "caller-tx: completeWithPayment's lockStopOrdersAndFit holds every stop order FOR UPDATE first",
};

describe("order-lock callers: every settle / invoice-create caller declares its first lock (SA-706c)", () => {
  it("every settleOrderCreditsInTx call site is classified, and no classification is stale", () => {
    expect(callSites("settleOrderCreditsInTx")).toEqual(Object.keys(SETTLE_CALLERS).sort());
  });

  it("every createInvoiceFromOrder / createSplitInvoices call site is classified, and none is stale", () => {
    const found = [...callSites("createInvoiceFromOrder"), ...callSites("createSplitInvoices")];
    expect([...new Set(found)].sort()).toEqual(Object.keys(INVOICE_CREATE_CALLERS).sort());
  });

  it("the caller-tx invoice creation really is preceded by the stop-order lock (completeWithPayment)", () => {
    const routes = strip(fs.readFileSync(path.join(SRC, "routes/routes.service.ts"), "utf8"));
    const lock = routes.indexOf("lockStopOrdersAndFit(");
    const claim = routes.indexOf("claimStopCompletion(tx, stopId", lock);
    const reconcile = routes.indexOf("reconcileDeliveredStopOrders(", lock);
    expect(lock).toBeGreaterThan(-1);
    expect(claim).toBeGreaterThan(lock); // before the first write
    expect(reconcile).toBeGreaterThan(claim);
    const helper = strip(
      fs.readFileSync(path.join(SRC, "routes/complete-payment-reconcile.ts"), "utf8"),
    );
    expect(helper.indexOf("lockOrderRows(")).toBeLessThan(
      helper.indexOf("assertDeliveriesFitStop("),
    );
  });

  it("issueCredit() and approve() take the Order right after the Return, before restock / mint / insert (read from the AST, so a reformat cannot move it)", () => {
    const file = path.join(SRC, "returns/inline-returns.service.ts");
    const sf = ts.createSourceFile(
      file,
      fs.readFileSync(file, "utf8"),
      ts.ScriptTarget.ES2022,
      true,
    );
    const method = (name: string): ts.MethodDeclaration => {
      let found: ts.MethodDeclaration | null = null;
      const walk = (n: ts.Node): void => {
        if (ts.isMethodDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name) found = n;
        ts.forEachChild(n, walk);
      };
      walk(sf);
      if (!found) throw new Error(`no method ${name}`);
      return found;
    };
    for (const name of ["issueCredit", "approve"]) {
      const returnLocks: number[] = [];
      const orderLocks: number[] = [];
      const writes: number[] = [];
      const walk = (n: ts.Node): void => {
        const pos = n.getStart(sf);
        // the Return row lock: a raw statement on "Return" ... FOR UPDATE
        if (ts.isTaggedTemplateExpression(n) && /FROM "Return"/.test(n.template.getText(sf)))
          returnLocks.push(pos);
        if (ts.isCallExpression(n)) {
          const callee = ts.isPropertyAccessExpression(n.expression)
            ? n.expression.name.text
            : ts.isIdentifier(n.expression)
              ? n.expression.text
              : "";
          // the Order lock: lockOrderRow(tx, tenant, fresh.orderId) or lockRefundOrders(tx, tenant, [fresh.orderId, ...sources])
          if (
            (callee === "lockOrderRow" || callee === "lockRefundOrders") &&
            n.arguments.some((a) => /fresh\.orderId/.test(a.getText(sf)))
          )
            orderLocks.push(pos);
          if (callee === "restockReturnItems" || callee === "issueCreditInTx") writes.push(pos);
        }
        ts.forEachChild(n, walk);
      };
      walk(method(name));
      expect(returnLocks.length).toBeGreaterThan(0);
      expect(orderLocks.length).toBeGreaterThan(0);
      expect(writes.length).toBeGreaterThan(0);
      expect(Math.min(...orderLocks)).toBeGreaterThan(Math.min(...returnLocks));
      expect(Math.min(...orderLocks)).toBeLessThan(Math.min(...writes));
    }
  });
  it("SA-706d: every transaction that claims a stop locks the stop's Orders FIRST (Order -> RouteRunStop, one order on every path)", () => {
    const offenders: string[] = [];
    let claims = 0;
    for (const file of walk(SRC)) {
      const src = strip(fs.readFileSync(file, "utf8"));
      const call = /\bclaimStopCompletion\(/g;
      let m: RegExpExecArray | null;
      while ((m = call.exec(src))) {
        if (/(async |function )$/.test(src.slice(Math.max(0, m.index - 12), m.index))) continue;
        claims += 1;
        // the enclosing method/function starts at the last head before the call
        let start = 0;
        HEAD.lastIndex = 0;
        let h: RegExpExecArray | null;
        while ((h = HEAD.exec(src)) && h.index < m.index) start = h.index;
        if (!src.slice(start, m.index).includes("lockStopOrdersAndFit("))
          offenders.push(
            `${path.relative(SRC, file).replace(/\\/g, "/")}:${src.slice(0, m.index).split("\n").length}`,
          );
      }
    }
    expect(claims).toBeGreaterThanOrEqual(2); // completeStop + completeWithPayment (the scan found them)
    expect(offenders).toEqual([]);
  });

  it("SA-706f: a run's terminal move locks the run's Orders BEFORE its stop rows (Orders -> RouteRunStop -> RouteRun)", () => {
    const sites = callPrefixes("lockRunStopsForTerminalStatus");
    expect(sites.map((s) => s.site)).toEqual(["routes/routes.service.ts#updateRunStatus"]);
    for (const s of sites) expect(s.prefix).toContain("lockRunOrdersForTerminalStatus(");
  });

  it("SA-706f: every other transaction that takes a RouteRunStop lock and writes Orders locks those Orders first", () => {
    // `lockRowsNoWait(tx, "RouteRunStop", ...)`: today only the at-stop change merge, which holds the
    // Order FOR UPDATE (raw or lockOrderRow(s)) before its NOWAIT stop lock.
    const sites = callPrefixes("lockRowsNoWait").filter((s) => s.args.includes('"RouteRunStop"'));
    expect(sites.map((s) => s.site)).toEqual([
      "orders/orders.service.ts#approveChangeRequestAtStop",
    ]);
    for (const s of sites)
      expect(s.prefix).toMatch(/FROM "Order" WHERE id = [^`]*FOR UPDATE|lockOrderRows?\(/);
  });

  it("SA-706f: completeStop and completeWithPayment re-run a conflict victim (coded 503 on exhaustion), each attempt starting clean", () => {
    const src = strip(fs.readFileSync(path.join(SRC, "routes/routes.service.ts"), "utf8"));
    for (const [label, reset] of [
      ["routes.completeStop", "autoCompleted = false;"],
      ["routes.completeWithPayment", "[autoCompleted, paymentIds, excess, advancePaymentId] ="],
    ] as const) {
      const at = src.indexOf(`retryRouteTx("${label}"`);
      expect(at).toBeGreaterThan(-1);
      // the attempt resets what the previous attempt may have set, before its first lock
      const body = src.slice(at, at + 600);
      expect(body).toContain(reset);
      expect(body.indexOf(reset)).toBeLessThan(body.indexOf("lockStopOrdersAndFit("));
    }
  });

  it("SA-706f: run-stop-reorder locks RouteRunStop rows and writes no Order rows (so it cannot invert the order)", () => {
    const file = strip(fs.readFileSync(path.join(SRC, "routes/run-stop-reorder.ts"), "utf8"));
    expect(file).toContain('FROM "RouteRunStop"'); // the pin is still about a stop locker
    expect(file).not.toMatch(
      /\.order\.(update|updateMany|create|createMany|delete|deleteMany|upsert)\b/,
    );
    expect(file).not.toMatch(/(UPDATE|DELETE FROM|INSERT INTO)\s+"Order"/i);
  });
});

/**
 * SA-760 R-1 — the billing-state writers. One lock order (Order -> the order's invoices id-sorted ->
 * re-read -> write), the advisory (`withOrderRecomputeLock`, family order-merge) always BEFORE rows.
 */
describe("order-lock callers: every order<->invoice billing-state writer takes the one lock order (SA-760 R-1)", () => {
  const read = (rel: string) => strip(fs.readFileSync(path.join(SRC, rel), "utf8"));
  /** The text of `name(`'s class member / function body (to the next member head at the same indent). */
  const bodyOf = (src: string, name: string): string => {
    const head = new RegExp(`^  (?:private |public )?(?:async )?${name}\\(`, "m").exec(src);
    expect(head).not.toBeNull();
    const start = head!.index;
    const end = src.indexOf("\n  }\n", start);
    return src.slice(start, end);
  };
  const IS = "invoices/invoices.service.ts";

  it("the helper takes the Order row, then the order's invoices id-sorted in one FOR UPDATE statement", () => {
    const src = read("invoices/order-billing-lock.ts");
    const body = src.slice(src.indexOf("export async function withOrderBillingLock"));
    expect(body.indexOf("lockOrderRow(")).toBeGreaterThan(-1);
    expect(body.indexOf("lockOrderRow(")).toBeLessThan(body.indexOf('FROM "Invoice"'));
    expect(body).toMatch(/FROM "Invoice"[^`]*ORDER BY id FOR UPDATE/);
    // never the unlocked client: the own-tx path is a tenantTransaction
    expect(src).not.toContain("forTenant()");
    expect(src).toContain("tenantTransaction(");
  });

  it("each public writer goes through the helper (no unlocked forTenant() fallback)", () => {
    const src = read(IS);
    expect(bodyOf(src, "reconcileOrderDraftInvoice")).toContain("inOrderBillingTxAfter(");
    expect(bodyOf(src, "reconcileOrderDeliveredInvoices")).toContain("inOrderBillingTx(");
    expect(bodyOf(src, "resyncOrderInvoicesForEdit")).toContain("inOrderBillingTx(");
    const mirror = bodyOf(src, "rebuildIssuedDepositMirrorOnDelivery");
    expect(mirror).toContain("withOrderBillingLock(");
    expect(mirror.indexOf("withOrderBillingLock(")).toBeLessThan(mirror.indexOf("db.invoice."));
    // the bodies run on the tx they are handed
    for (const locked of [
      "reconcileOrderDraftInvoiceLocked",
      "reconcileOrderDeliveredInvoicesLocked",
    ])
      expect(bodyOf(src, locked)).not.toContain("forTenant()");
    expect(bodyOf(src, "reconcileOrderDraftInvoiceLocked")).toContain("const db = opts.tx;");
  });

  it("rebuildSiblingDrafts (the shared core) is reached only from locked writers", () => {
    expect(callSites("rebuildSiblingDrafts")).toEqual(
      [
        `${IS}#reconcileOrderDeliveredInvoicesLocked`,
        `${IS}#splitDeps`,
        `${IS}#projectEditedInvoiceTotals`, // planOnly: the overpay judge's read-only projection
        // the deps-injected extraction (split-draft-reconcile.ts): its interface member and its one call
        "invoices/split-draft-reconcile.ts#rebuildSiblingDrafts",
        "invoices/split-draft-reconcile.ts#reconcileSplitOrderDrafts",
        `${IS}#rebuildIssuedDepositMirrorOnDelivery`,
        `${IS}#resyncOrderInvoicesForEdit`,
      ].sort(),
    );
    expect(callPrefixes("reconcileSplitOrderDrafts").map((c) => c.site)).toEqual([
      `${IS}#reconcileOrderDraftInvoiceLocked`,
    ]);
    expect(callSites("reconcileOrderDraftInvoiceLocked")).toEqual([
      `${IS}#reconcileOrderDraftInvoice`,
    ]);
    expect(callSites("reconcileOrderDeliveredInvoicesLocked")).toEqual([
      `${IS}#reconcileOrderDeliveredInvoices`,
    ]);
  });

  it("the void / unvoid / delete paths lock Order -> Invoice before they write invoicedQty", () => {
    const src = read(IS);
    expect(callSites("adjustInvoicedQtyForInvoice")).toEqual(
      [`${IS}#voidInvoiceInTx`, `${IS}#unvoidInvoice`, `${IS}#deleteInvoice`].sort(),
    );
    const unvoid = bodyOf(src, "unvoidInvoice");
    expect(unvoid.indexOf("lockInvoiceRow(")).toBeGreaterThan(-1);
    expect(unvoid.indexOf("lockInvoiceRow(")).toBeLessThan(
      unvoid.indexOf("adjustInvoicedQtyForInvoice("),
    );
    const del = bodyOf(src, "deleteInvoice");
    expect(del.indexOf('FROM "Order"')).toBeLessThan(del.indexOf('FROM "Invoice"'));
    expect(del.indexOf('FROM "Invoice"')).toBeLessThan(del.indexOf("adjustInvoicedQtyForInvoice("));
    // voidInvoiceInTx runs on its caller's tx: voidInvoice locks (Order ->) Invoice first; order-cancel-tx holds the Order
    expect(callSites("voidInvoiceInTx")).toEqual(
      [`${IS}#voidInvoice`, "orders/order-cancel-tx.ts#cancelOrderInTx"].sort(),
    );
    const voidFn = bodyOf(src, "voidInvoice");
    expect(voidFn.indexOf("lockInvoiceRow(")).toBeLessThan(voidFn.indexOf("voidInvoiceInTx("));
  });

  it("advisory before rows: no billing writer takes the order-merge advisory after the Order row, and recompute callers run after their own commit", () => {
    const src = read(IS);
    // the writers never call the advisory-wrapped recompute (it would take the advisory AFTER the Order row)
    for (const w of [
      "reconcileOrderDraftInvoiceLocked",
      "reconcileOrderDeliveredInvoicesLocked",
      "rebuildIssuedDepositMirrorOnDelivery",
      "rebuildSiblingDrafts",
      "resyncOrderInvoicesForEdit",
      "unvoidInvoice",
    ]) {
      expect(bodyOf(src, w)).not.toContain("recomputeOrderFromInvoices(");
      expect(bodyOf(src, w)).not.toContain("withOrderRecomputeLock(");
    }
    // recomputeOrderFromInvoices is called with NO tx (so it opens the advisory first, then its tx)
    const calls = callPrefixes("recomputeOrderFromInvoices").filter(
      (c) => c.site !== `${IS}#recomputeOrderFromInvoices`,
    );
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls)
      expect(c.args).toMatch(/recomputeOrderFromInvoices\([^,()]*(\([^)]*\))?[^,()]*\)$/);
    // and the advisory wraps the transaction, not the other way round
    const fo = read("invoices/finalize-order-recompute.ts");
    const fn = fo.slice(fo.indexOf("export async function withOrderRecomputeLock"));
    expect(fn.indexOf("withAdvisoryLock(")).toBeLessThan(fn.indexOf("tenantTransaction("));
  });
});
