import fs from "node:fs";
import path from "node:path";

/**
 * #2094 PR-A / SA-221: source pins on where OrdersService.create() calls the inline-return glue, and
 * on what must NOT sit inside the order transaction. Behavior is proven in the DB specs; these pins
 * fail the moment someone reorders the calls (the lock-order and retry-loop rules are order rules).
 * Comments are stripped so prose that names a call is fine.
 */
const strip = (code: string) =>
  code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const service = strip(fs.readFileSync(path.join(__dirname, "orders.service.ts"), "utf8"));

const methodBody = (name: string) => {
  const start = service.indexOf(`async ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const rest = service.slice(start + 1);
  const next = rest.search(/\n  (private |public |static )?(async )?[A-Za-z_]+\(/);
  return service.slice(start, next === -1 ? undefined : start + 1 + next);
};

describe("OrdersService.create(): inline-return call order (#2094)", () => {
  const body = methodBody("create");
  const at = (needle: string) => {
    const i = body.indexOf(needle);
    expect(i).toBeGreaterThan(-1);
    return i;
  };
  // The loop's `break;` (its trailing comment is stripped): the order tx has committed by here.
  const commit = () => {
    const i = body.indexOf("break;", at("for (let attempt"));
    expect(i).toBeGreaterThan(-1);
    return i;
  };

  it("the guard (prepareInlineReturn) is the first thing done, before any read of the customer", () => {
    expect(at("prepareInlineReturn(")).toBeLessThan(at("customer.findUnique("));
  });

  it("the credit-note number is reserved ONCE, before the P2002 retry loop, never inside it", () => {
    const reserve = at("reserveReturnNo(");
    const loop = at("for (let attempt");
    expect(reserve).toBeLessThan(loop);
    expect(body.split("reserveReturnNo(").length - 1).toBe(1);
  });

  it("the customer advisory lock is the FIRST statement of the order tx: before the order number, the stock rows and the order write", () => {
    const lock = at("lockInlineReturnCustomer(");
    expect(lock).toBeGreaterThan(at("for (let attempt"));
    expect(lock).toBeLessThan(at("nextOrderNumberFor("));
    expect(lock).toBeLessThan(at("decrementStockForSale("));
    expect(lock).toBeLessThan(at("tx.order.create("));
  });

  it("the return is applied AFTER the order and its lines exist, inside the same tx callback", () => {
    expect(at("applyReturn(")).toBeGreaterThan(at("tx.order.create("));
    expect(at("applyReturn(")).toBeLessThan(commit());
  });

  it("the credit event is emitted only after the loop (after the commit)", () => {
    expect(at("emitInlineReturnCredit(")).toBeGreaterThan(commit());
  });

  it("an Idempotency-Key replay must find THIS returnKey on the order: both the pre-check and the P2002 winner path assert it before returning", () => {
    const calls = body.split("replayAfterCheck(").length - 1;
    expect(calls).toBe(2);
    const first = at("replayAfterCheck(");
    expect(first).toBeLessThan(at("for (let attempt")); // the pre-check
    expect(body.indexOf("replayAfterCheck(", first + 1)).toBeGreaterThan(at("for (let attempt")); // the winner path
  });

  it("a deadlock or serialization failure on a create carrying a return retries, inside the same loop (the reserved number is reused)", () => {
    const retry = at("txConflictState(");
    expect(retry).toBeGreaterThan(at("for (let attempt"));
    expect(retry).toBeGreaterThan(at("catch (e"));
    expect(body.slice(retry, retry + 200)).toContain("continue");
  });

  it("an order that carries a return is never a candidate for the auto-merge sweep", () => {
    expect(body).toMatch(/skipAutoMerge:[^,]*!!inlineRet/);
  });

  it("the existing appliedCreditNotes sync keeps its OWN Serializable tx, outside the order tx (SA-221 change 1)", () => {
    // SA-706 MUST 2: create() hands the credit tx to the shared helper (Order lock first, retried).
    expect(at("syncAndSettleOrderCredits(")).toBeGreaterThan(commit());
    const helper = methodBody("syncAndSettleOrderCredits");
    expect(helper).toContain('isolationLevel: "Serializable"');
    expect(helper.indexOf("lockOrderRow(")).toBeLessThan(
      helper.indexOf("syncOrderCreditSelections("),
    );
  });

  it("nothing between the customer lock and the commit takes another advisory lock or a tx-less recompute", () => {
    const window = body.slice(at("lockInlineReturnCustomer("), commit());
    for (const forbidden of [
      "withAdvisoryLock",
      "withOrderRecomputeLock",
      "recomputeOrderFromInvoices",
    ]) {
      expect(window).not.toContain(forbidden);
    }
  });
});

describe("the staff merge branch carries the inlineReturn to updateOrderItems (#2094)", () => {
  const controller = strip(fs.readFileSync(path.join(__dirname, "orders.controller.ts"), "utf8"));

  it("threads dto.inlineReturn into the merge's foldDto, so it lands on the winner in the same tx", () => {
    const fold = controller.indexOf("const foldDto = {");
    expect(fold).toBeGreaterThan(-1);
    expect(controller.slice(fold, fold + 900)).toContain("inlineReturn: dto.inlineReturn");
  });

  it("a merge replay checks the return on EVERY key hit, verified or not (Opus R); #2424: the whole return, items included", () => {
    const call = controller.indexOf("findOrderIdByIdempotencyKey(");
    expect(call).toBeGreaterThan(-1);
    const args = controller.slice(call, call + 300);
    expect(args).toMatch(/dto\.inlineReturn,/); // the lines (key + items + reason), not the bare key
    expect(args).not.toContain("dto.inlineReturn?.returnKey");
  });

  it("never refuses a merge for carrying one any more", () => {
    expect(controller).not.toContain("if (dto.inlineReturn)");
  });
});

describe("OrdersService.updateOrderItems(): inline-return call order (#2094)", () => {
  const body = methodBody("updateOrderItems");
  const at = (needle: string, from = 0) => {
    const i = body.indexOf(needle, from);
    expect(i).toBeGreaterThan(-1);
    return i;
  };

  it("the guard runs before any further read: before the unit-aware edit fence", () => {
    expect(at("prepareInlineReturn(")).toBeLessThan(at("assertOrderEditAllowed("));
  });

  it("the customer advisory lock is the tx's FIRST statement: before the Order FOR UPDATE and every write", () => {
    const lock = at("lockInlineReturnCustomer(");
    expect(lock).toBeLessThan(at('FROM "Order" WHERE id = ${orderId} FOR UPDATE'));
    expect(lock).toBeLessThan(at("tx.orderItem.findMany("));
  });

  it("the return is applied AFTER the order's new total is written and BEFORE the tx returns", () => {
    const apply = at("applyReturn(");
    expect(apply).toBeGreaterThan(at("tx.order.update("));
    expect(apply).toBeLessThan(at("return { subtotal, tax, total, shouldRevert, shippingFee }"));
  });

  it("the return is validated BEFORE the un-tx'd linked-invoice revert commits (B215 class); the CN number is reserved after the license guard and before the tx", () => {
    const pre = at("preflightInlineReturn(");
    const revert = at("revertLinkedInvoicesForOrderEdit(orderId)");
    expect(pre).toBeLessThan(revert);
    const reserve = at("reserveEditReturnNumber(");
    expect(reserve).toBeGreaterThan(at("authGuard.assertAuthorizedOrThrow("));
    expect(reserve).toBeGreaterThan(revert);
    expect(reserve).toBeLessThan(at("lockInlineReturnCustomer("));
    expect(body.split("reserveEditReturnNumber(").length - 1).toBe(1);
  });

  it("the edit tx retries a write conflict via the house helper, only when the request carries a return, with the SAME reserved number (SA-340)", () => {
    const retry = at("runEditTx(");
    expect(at("reserveEditReturnNumber(")).toBeLessThan(retry); // reserved ONCE, ahead of the retried tx
    expect(retry).toBeLessThan(at("lockInlineReturnCustomer(")); // the whole tx is inside the retried callback
    expect(body.slice(retry, retry + 60)).toContain("inlineRet"); // the p gate travels with the call
  });

  it("the credit gate is re-read after the credit is applied, in the same tx", () => {
    const apply = at("applyReturn(");
    expect(body.slice(apply, apply + 800)).toContain("await creditGate()");
  });

  it("the credit event is emitted after the commit and before the post-commit reconcile", () => {
    const emit = at("emitInlineReturnCredit(");
    expect(emit).toBeGreaterThan(at("applyReturn("));
    expect(emit).toBeLessThan(at("this.reconcileOrderAfterEdit("));
  });

  it("nothing between the customer lock and the commit takes another advisory lock or a tx-less recompute", () => {
    const window = body.slice(at("lockInlineReturnCustomer("), at("emitInlineReturnCredit("));
    for (const forbidden of [
      "withAdvisoryLock",
      "withOrderRecomputeLock",
      "recomputeOrderFromInvoices",
    ]) {
      expect(window).not.toContain(forbidden);
    }
  });
});
