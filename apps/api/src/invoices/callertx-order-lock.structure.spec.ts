import * as fs from "fs";
import * as path from "path";

/**
 * Row 372 MUST 1a (SA-735): `createInvoiceFromOrder(orderId, callerTx)` skips its own Order lock
 * (`if (!callerTx)`), so every caller that passes a tx must already hold the Order row lock. There is ONE call
 * site that passes one: `deps.createInvoiceFromOrder(orderId, tx)` in delivered-reconcile.ts, reached only
 * through `reconcileDeliveredOrdersInTx` (via `reconcileDeliveredStopOrders`) and `recordDeliveryPaymentInTx`;
 * both run only inside RoutesService.completeWithPayment, whose tx's FIRST statements are
 * `lockStopOrdersAndFit` -> `lockOrderRows(tx, null, <the stop's order ids>)` (FOR UPDATE, id ordered, SA-706c),
 * the same orders it then reconciles. The locks that tx takes before the Order locks: none (lock-first). House
 * order: Stop/Order rows -> Order -> Invoice (SA error rule 8). This spec fails if a caller of the callerTx path
 * (any argument name, any file) appears outside delivered-reconcile.ts, or if a RoutesService method reaches the
 * two entry points without locking the stop's orders first.
 */
const SRC = path.resolve(__dirname, "..");
const CALLER_TX_CALL =
  /(?<!async\s+)\bcreateInvoiceFromOrder\(\s*[^,()]+,\s*(?!undefined\b|null\b)[^\s,)]/;
const read = (f: string) => fs.readFileSync(path.join(SRC, f), "utf8");

describe("createInvoiceFromOrder's callerTx callers hold the Order lock first (row 372, MUST 1a)", () => {
  it("lockStopOrdersAndFit locks the stop's Orders FOR UPDATE through lockOrderRows before anything else", () => {
    const src = read("routes/complete-payment-reconcile.ts");
    const body = src.slice(src.indexOf("export async function lockStopOrdersAndFit"));
    expect(body.indexOf("lockOrderRows(")).toBeGreaterThan(0);
    expect(body.indexOf("lockOrderRows(")).toBeLessThan(body.indexOf("assertDeliveriesFitStop("));
    expect(read("credit-notes/credit-note-locks.ts")).toMatch(/FOR UPDATE/);
  });

  it("every RoutesService method that reconciles a stop or records a delivery payment locks the stop's orders first", () => {
    const src = read("routes/routes.service.ts");
    const lines = src.split("\n");
    const methodStarts = lines
      .map((l, i) => (/^  (private |public )?async \w+\(/.test(l) ? i : -1))
      .filter((i) => i >= 0);
    const offenders: string[] = [];
    lines.forEach((l, i) => {
      if (
        !/\b(reconcileDeliveredStopOrders|recordDeliveryPaymentInTx)\(/.test(l) ||
        /^\s*(\/\/|\*)/.test(l)
      )
        return;
      const start = [...methodStarts].reverse().find((s) => s <= i) ?? 0;
      const lockAt = lines.slice(start, i).findIndex((x) => /\blockStopOrdersAndFit\(/.test(x));
      if (lockAt < 0) offenders.push(`${lines[start].trim()} (call at line ${i + 1})`);
    });
    expect(offenders).toEqual([]);
  });

  it("the two callerTx callers of createInvoiceFromOrder are the only ones (a third must be classified here)", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.ts$/.test(e.name) && !/\.(spec|test)\.ts$/.test(e.name)) {
          // any call (`x.createInvoiceFromOrder(` or a bare one) whose SECOND argument is not undefined/null,
          // whatever it is named; a method DECLARATION (`async createInvoiceFromOrder(`) is not a call
          const code = fs
            .readFileSync(p, "utf8")
            .replace(/\/\*[\s\S]*?\*\//g, "") // block comments and JSDoc name the call in prose
            .replace(/(^|\s)\/\/.*$/gm, "$1");
          if (CALLER_TX_CALL.test(code)) hits.push(path.relative(SRC, p));
        }
      }
    };
    walk(SRC);
    expect(hits.sort()).toEqual(["invoices/delivered-reconcile.ts"]);
  });
});
