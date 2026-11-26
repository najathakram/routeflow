/**
 * SA-1544 (as) / A9 9.3 items 1, 2, 5, 7: the edit transaction's CONTRACT, pinned as source structure (the same family as
 * `no-bare-cron.spec.ts`). A reorder of these statements, an invoice call without the edit's `tx`, or a literal timeout
 * beside the tx call is a lock-order or budget regression that no behavioral spec can see on a small fixture.
 *
 *  1. Lock order: the customer returns lock (`dl.lockFirst`) is the callback's FIRST statement, then the Order row
 *     (`lockEditedOrder`), the routing recheck (`dl.assertLocked`), the stock settle, the judge (Order + Invoice), the
 *     restate writes, then `applyReturn`, then the revision. No advisory lock after the Order row, no in-process lock.
 *  2. Every invoice call made inside the edit transaction passes the edit's `tx` (without one `inOrderBillingTx` opens its
 *     own transaction and waits on the Order row the edit holds).
 *  5. The budget is `dl.txOptions()` (EDIT_TX_BUDGET_MS), never a literal beside the tx call.
 *  7. The restate runs before `applyReturn`.
 */
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const read = (f: string) => readFileSync(join(__dirname, f), "utf8");
const service = read("orders.service.ts");
const glue = read("delivered-line-correction.ts");
const judge = read("edit-overpay-judge.ts");

/** The text of the edit transaction's callback: from `runEditTx(` to the options argument that closes it. */
const txBody = (() => {
  const start = service.indexOf("inlineReturn.runEditTx(");
  const end = service.indexOf("dl.txOptions()", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return service.slice(start, end);
})();

/** Every `<receiver>.<method>(` call's argument text (balanced parentheses). */
function callsOf(src: string, receiver: RegExp): Array<{ method: string; args: string }> {
  const out: Array<{ method: string; args: string }> = [];
  const re = new RegExp(receiver.source + "\\.(\\w+)\\(", "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let depth = 1;
    let i = re.lastIndex;
    while (i < src.length && depth > 0) {
      if (src[i] === "(") depth += 1;
      else if (src[i] === ")") depth -= 1;
      i += 1;
    }
    out.push({ method: m[1], args: src.slice(re.lastIndex, i - 1) });
  }
  return out;
}

describe("SA-1544 (as): the edit transaction's lock order and budget", () => {
  it("the returns lock is the callback's first statement: nothing is awaited before dl.lockFirst", () => {
    const open = txBody.indexOf("async (tx: any) => {");
    const first = txBody.indexOf("dl.lockFirst(tx");
    expect(open).toBeGreaterThan(0);
    expect(first).toBeGreaterThan(open);
    // comments are not statements; the `await` that opens the lock statement itself is its own
    const before = txBody
      .slice(open, first)
      .replace(/\/\/.*$/gm, "")
      .replace(/await\s*$/, "");
    expect(before).not.toMatch(/\bawait\b/);
  });

  it("lock order: returns lock, Order row, routing recheck, carrier revert, line writes and corrections, judge, restate, return, revision", () => {
    const order = [
      "dl.lockFirst(tx",
      "lockEditedOrder(tx",
      "dl.assertLocked(tx",
      "carrierGuard.carrierRevertUnderLock(",
      "dl.applyCorrections(tx",
      "judgeEditTail(",
      "dl.restateInvoices(tx",
      "applyReturn(tx",
      "appendOrderRevisionInTx(",
    ];
    const at = order.map((needle) => txBody.indexOf(needle));
    order.forEach((needle, i) => expect([needle, at[i] >= 0]).toEqual([needle, true]));
    expect(at).toEqual([...at].sort((a, b) => a - b)); // strictly the written order
  });

  it("no advisory or in-process lock is taken after the Order row (the only advisory is the first statement)", () => {
    const afterOrderLock = txBody.slice(txBody.indexOf("lockEditedOrder(tx"));
    expect(afterOrderLock).not.toMatch(
      /withAdvisoryLock|pg_advisory|lockInlineReturnCustomer|lockReturnCustomersOf/,
    );
    expect(txBody).not.toMatch(/new (Mutex|Semaphore)|async-mutex/);
  });

  it("the restate sits before applyReturn (A9 9.3 item 7) and no post-commit restate is left in the edit's own code", () => {
    expect(txBody.indexOf("dl.restateInvoices(tx")).toBeLessThan(txBody.indexOf("applyReturn(tx"));
    const resyncs = callsOf(glue, /invoicesService!?/).filter(
      (c) => c.method === "resyncOrderInvoicesForEdit",
    );
    expect(resyncs).toHaveLength(1); // the one in-tx call
  });

  it("every invoice call inside the edit tx passes the edit's tx (service callback, correction glue, judge)", () => {
    const inTx = [
      ...callsOf(txBody, /this\.invoicesService/),
      ...callsOf(glue, /invoicesService!?/),
      ...callsOf(judge, /deps\.invoices/),
    ];
    const methods = inTx.map((c) => c.method).sort();
    expect(methods).toEqual(
      [
        "projectEditedInvoiceTotals",
        "resyncOrderInvoicesForEdit",
        "revertLinkedInvoicesForOrderEdit",
      ].sort(),
    );
    for (const call of inTx)
      expect([call.method, /\btx\b/.test(call.args)]).toEqual([call.method, true]);
  });

  it("the resync in the glue also carries an after-commit queue and the actor (gatewayFor refuses an emit without one)", () => {
    const [call] = callsOf(glue, /invoicesService!?/).filter(
      (c) => c.method === "resyncOrderInvoicesForEdit",
    );
    expect(call.args.replace(/\s+/g, " ")).toMatch(/tx,\s*after,\s*i\.user\?\.sub/);
  });

  it("the budget is dl.txOptions(), not a literal: no `timeout: 15_000` beside the edit tx call", () => {
    const tail = service.slice(
      service.indexOf("dl.txOptions()") - 400,
      service.indexOf("dl.txOptions()") + 60,
    );
    expect(tail).not.toMatch(/timeout:\s*\d/);
    expect(service.match(/dl\.txOptions\(\)/g)?.length).toBe(1);
  });
});

describe("SA-1546 (bf): no spec writes outside the tree", () => {
  it("no orders spec appends to or writes a file at an absolute machine path (CI has no such folder)", () => {
    const offenders = readdirSync(__dirname)
      .filter((f) => f.endsWith(".spec.ts") && f !== "delivered-line-correction.structure.spec.ts")
      .filter((f) =>
        ["sa1506-pr1-logs", "observe" + ".txt", ":/ClaudeCode"].some((n) => read(f).includes(n)),
      );
    expect(offenders).toEqual([]);
  });
});
