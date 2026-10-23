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
import path from "node:path";
import { ROW_LOCK_ORDER } from "./db-locks";

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
  // SA-860: the settle call moved out of markSent into the ONE shared helper. It takes no lock itself: BOTH callers (markSent's
  // tx and the issuing dry run, readSendSnapshot) take lockInvoiceRow (Order then Invoice, SA-404) and then lockCreditsForSend first.
  "invoices/invoice-send-snapshot.ts#runSendCredits":
    "caller holds lockInvoiceRow (Order then Invoice, SA-404) then lockCreditsForSend: markSent and the issuing dry run (SA-860)",
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

  it("issueCredit() and approve() take the Order right after the Return, before restock / mint / insert", () => {
    const src = strip(fs.readFileSync(path.join(SRC, "returns/inline-returns.service.ts"), "utf8"));
    for (const method of ["issueCredit", "approve"]) {
      const start = src.indexOf(`async ${method}(`);
      expect(start).toBeGreaterThan(-1);
      const body = src.slice(start, start + 6000);
      const returnLock = body.indexOf('FROM "Return"');
      const orderLock = body.indexOf("lockOrderRow(tx, tenantId, fresh.orderId)");
      const firstWrite = Math.min(
        ...["restockReturnItems(", "issueCreditInTx("]
          .map((n) => body.indexOf(n))
          .filter((i) => i > -1),
      );
      expect(returnLock).toBeGreaterThan(-1);
      expect(orderLock).toBeGreaterThan(returnLock);
      expect(orderLock).toBeLessThan(firstWrite);
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

/**
 * SA-893 (row 631 PR-1) — THE ONE ROW-LOCK ORDER: Return -> Order -> Invoice -> CreditNote (`ROW_LOCK_ORDER`, read from
 * db-locks.ts, never copied). Every method that touches two of these tables is classified with the order in which it
 * FIRST locks each one, and that order must follow the constant. A lock is an explicit `FOR UPDATE` / `FOR NO KEY
 * UPDATE`, a lock helper (expanded to the tables it locks), `lockRowsNoWait(tx, "<Table>")`, or the IMPLICIT row lock
 * of `tx.<table>.update / updateMany / delete / deleteMany / upsert` on existing rows (an insert locks no other row and
 * is exempt). The customer merge took its Orders by `updateMany` before its Returns: a `lockOrderRow`-only scan misses
 * exactly that. A new or changed site fails until it is classified; a CALLER's locks are not seen, so a method that
 * runs on a caller's held locks is an EXCEPTION with its reason.
 */
describe("SA-893: every transaction takes Return -> Order -> Invoice -> CreditNote in that order", () => {
  type Table = (typeof ROW_LOCK_ORDER)[number];
  /** A function whose locks a CALLER inherits: a lock helper (`lock*`, `with*Lock*`) or a `release*InTx` row-lock step. */
  const HELPER_NAME = /^(?:lock[A-Z]\w*|with\w*Lock\w*|release\w*InTx)$/;
  const MODEL: Record<string, Table> = {
    return: "Return",
    order: "Order",
    invoice: "Invoice",
    creditNote: "CreditNote",
  };
  const EVENT =
    /FROM "(Return|Order|Invoice|CreditNote)"[^`]*FOR (?:NO KEY )?UPDATE|\blockRowsNoWait\(\s*\w+,\s*"(Return|Order|Invoice|CreditNote)"|\btx\.(return|order|invoice|creditNote)\.(?:update|updateMany|delete|deleteMany|upsert)\(|\b(\w+)\(/g;
  type Step = { table: Table } | { call: string };

  /** Every function body's lock steps in text order: a direct row lock, or a call of a helper. */
  function scanBodies(): Array<{ site: string; name: string; steps: Step[] }> {
    const bodies: Array<{ site: string; name: string; steps: Step[] }> = [];
    for (const file of walk(SRC)) {
      const src = strip(fs.readFileSync(file, "utf8"));
      const rel = path.relative(SRC, file).split(path.sep).join("/");
      const heads: Array<{ at: number; name: string }> = [];
      HEAD.lastIndex = 0;
      let h: RegExpExecArray | null;
      while ((h = HEAD.exec(src))) heads.push({ at: h.index, name: h[1] ?? h[2] });
      const byName = new Map<string, Step[]>();
      EVENT.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = EVENT.exec(src))) {
        let step: Step | undefined;
        if (m[1] ?? m[2]) step = { table: (m[1] ?? m[2]) as Table };
        else if (m[3]) step = { table: MODEL[m[3]] };
        else if (m[4] && HELPER_NAME.test(m[4])) {
          // a helper's own definition is not a call
          if (/(function |async )$/.test(src.slice(Math.max(0, m.index - 9), m.index))) continue;
          step = { call: m[4] };
        }
        if (!step) continue;
        let name = "?";
        for (const hh of heads) if (hh.at < m.index) name = hh.name;
        if (!byName.has(name)) byName.set(name, []);
        byName.get(name)!.push(step);
      }
      for (const [name, steps] of byName) bodies.push({ site: `${rel}#${name}`, name, steps });
    }
    return bodies;
  }

  /** Each function's first-lock order, its helpers expanded to a fixed point (a helper's tables come from its own body). */
  function lockSequences(): { sites: Record<string, string>; helperClash: string[] } {
    const bodies = scanBodies();
    const helperSteps = new Map<string, Step[]>();
    const helperClash: string[] = [];
    for (const b of bodies) {
      if (!HELPER_NAME.test(b.name)) continue;
      const prev = helperSteps.get(b.name);
      if (prev && JSON.stringify(prev) !== JSON.stringify(b.steps)) helperClash.push(b.name);
      if (!prev) helperSteps.set(b.name, b.steps);
    }
    const resolved = new Map<string, Table[]>();
    const expand = (steps: Step[], seen: Set<string>): Table[] =>
      steps.flatMap((s) => {
        if ("table" in s) return [s.table];
        if (seen.has(s.call) || !helperSteps.has(s.call)) return [];
        if (!resolved.has(s.call))
          resolved.set(s.call, expand(helperSteps.get(s.call)!, new Set([...seen, s.call])));
        return resolved.get(s.call)!;
      });
    const sites: Record<string, string> = {};
    for (const b of bodies) {
      const firsts = [...new Set(expand(b.steps, new Set([b.name])))];
      if (firsts.length >= 2) sites[b.site] = firsts.join(" > ");
    }
    return { sites, helperClash: [...new Set(helperClash)].sort() };
  }
  const follows = (seq: string) => {
    const ranks = seq.split(" > ").map((t) => ROW_LOCK_ORDER.indexOf(t as Table));
    return ranks.every((r, i) => i === 0 || r > ranks[i - 1]);
  };

  /** Every method that touches two of the tables, with its first-lock order. */
  const ROW_LOCK_SITES: Record<string, string> = {
    "bookkeeping/bookkeeping.service.ts#writeLedgerPayment": "Order > Invoice",
    "common/db-locks.ts#lockRowsNoWait": "Order > Invoice",
    "credit-notes/credit-note-locks.ts#lockCreditsForSend": "CreditNote > Invoice",
    "credit-notes/credit-note-locks.ts#lockCustomerCreditsForSweep": "Order > Invoice > CreditNote",
    "credit-notes/credit-note-locks.ts#lockInvoiceForCredit": "Order > Invoice",
    "credit-notes/credit-note-locks.ts#lockOrderCreditSettle": "Order > Invoice > CreditNote",
    "credit-notes/credit-notes.service.ts#applyCreditInTx": "Invoice > CreditNote",
    "credit-notes/credit-notes.service.ts#applyToInvoice": "Order > Invoice > CreditNote",
    "credit-notes/credit-notes.service.ts#autoApplyOldestCreditsInTx":
      "Order > Invoice > CreditNote",
    "credit-notes/credit-notes.service.ts#create": "Return > Order > Invoice", // SA-893: the linked Return locked before the Invoice
    "credit-notes/credit-notes.service.ts#restoreCreditFromPaymentInTx": "CreditNote > Invoice",
    "credit-notes/credit-notes.service.ts#settleOrderCreditsInTx": "Order > Invoice > CreditNote",
    "credit-notes/credit-notes.service.ts#voidWithReversalInTx": "Order > Invoice > CreditNote",
    "credit-notes/line-credit-headroom.ts#lockOrderPoolRows": "Order > Invoice",
    "customers/customer-delete-stock.ts#releaseLiveOrderStockInTx": "Return > Order",
    "customers/customers.service.ts#deleteAllCustomers": "Return > Order > Invoice",
    "customers/customers.service.ts#deleteCustomer": "Return > Order",
    "customers/customers.service.ts#mergeCustomers": "Return > Order > Invoice > CreditNote", // SA-893: both customers' Returns locked FIRST
    "customers/customers.service.ts#runImportedCustomersCleanup": "Return > Order > Invoice",
    "invoices/invoice-send-guard.ts#lockInvoiceRow": "Order > Invoice",
    "invoices/invoice-send-guard.ts#lockInvoicesForPayment": "Order > Invoice",
    "invoices/invoice-send-snapshot.ts#readSendSnapshot": "Order > Invoice > CreditNote",
    "invoices/invoices.service.ts#deleteInvoice": "Order > Invoice",
    "invoices/invoices.service.ts#markSent": "Order > Invoice > CreditNote",
    "invoices/invoices.service.ts#rebuildIssuedDepositMirrorOnDelivery": "Order > Invoice",
    "invoices/invoices.service.ts#unvoidInvoice": "Order > Invoice",
    "invoices/invoices.service.ts#voidInvoice": "Order > Invoice",
    "invoices/invoices.service.ts#voidInvoiceInTx": "Invoice > CreditNote",
    "invoices/invoices.service.ts#writeOff": "Order > Invoice",
    "invoices/invoices.service.ts#writeStandalonePayment": "Order > Invoice",
    "invoices/locked-invoice-edit.ts#loadLockedInvoiceForEdit": "Order > Invoice",
    "invoices/order-billing-lock.ts#inOrderBillingTx": "Order > Invoice",
    "invoices/order-billing-lock.ts#withOrderBillingLock": "Order > Invoice",
    "orders/counter-sale/counter-sale-void.service.ts#voidInTx": "Order > Invoice",
    "orders/edit-overpay-judge.ts#assertEditCannotOverpay": "Order > Invoice",
    "orders/order-cancel-impact.ts#lockOrderAndInvoicesInTx": "Order > Invoice",
    "orders/order-cancel-impact.ts#lockOrderForCancel": "Order > Invoice",
    "orders/order-cancel-tx.ts#cancelOrderInTx": "Order > Invoice",
    "orders/orders.service.ts#approveChangeRequestAtStop": "Order > Invoice",
    "orders/orders.service.ts#deleteOrder": "Order > Invoice",
    "orders/orders.service.ts#forceConsolidateCustomer": "Order > Invoice",
    "regulated/ledger-locks.ts#lockLedgerDocumentRows": "Order > Invoice",
    "regulated/parked-reversal-resolution.service.ts#resolve": "Return > Order",
    "returns/inline-returns.service.ts#approve": "Return > Order",
    "returns/inline-returns.service.ts#cancel": "Return > Order > Invoice",
    "returns/inline-returns.service.ts#issueCredit": "Return > Order",
    "returns/inline-returns.service.ts#refund": "Return > Order > Invoice",
    "returns/inline-returns.service.ts#storeCreditInstead": "Return > Order > Invoice",
    "returns/returns.service.ts#cancel": "Return > Order > Invoice",
    "returns/returns.service.ts#claimRefund": "Return > Order > Invoice",
    "returns/returns.service.ts#receive": "Return > Order",
    "system-config/settings.controller.ts#clearFinancialData": "Invoice > CreditNote",
  };

  /** Sites whose observed order is NOT the house order, each running on locks its CALLER already holds. */
  const CALLER_HELD: Record<string, string> = {
    "credit-notes/credit-note-locks.ts#lockCreditsForSend":
      "SA-860: both callers (markSent, readSendSnapshot) take lockInvoiceRow (Order -> Invoice) BEFORE it; its Invoice lock re-takes a held row",
    "credit-notes/credit-notes.service.ts#restoreCreditFromPaymentInTx":
      "runs inside a payment or credit reversal whose caller is documented to hold the Invoice (SA-706a); UNVERIFIED for 4 of its 6 callers (cancelStandaloneInTx, pullBackOrderCreditPair, releaseCreditsInTx, unapplyFromInvoice): a row 631 follow-up, an Invoice/CreditNote audit outside SA-893's Return tier",
  };

  it("the order is the one constant: Return -> Order -> Invoice -> CreditNote", () => {
    expect([...ROW_LOCK_ORDER]).toEqual(["Return", "Order", "Invoice", "CreditNote"]);
  });

  it("every transaction that touches two of the tables is classified, and no classification is stale", () => {
    const { sites, helperClash } = lockSequences();
    expect(helperClash).toEqual([]); // one helper name, one lock sequence
    expect(sites).toEqual(ROW_LOCK_SITES);
  });

  it("every classified order follows ROW_LOCK_ORDER, or is a listed caller-held exception", () => {
    const off = Object.entries(lockSequences().sites)
      .filter(([site, seq]) => !follows(seq) && !(site in CALLER_HELD))
      .map(([site, seq]) => `${site}: ${seq}`);
    expect(off).toEqual([]);
    for (const site of Object.keys(CALLER_HELD)) expect(site in ROW_LOCK_SITES).toBe(true);
  });
});
