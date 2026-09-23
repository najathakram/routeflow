import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";
import { checkOrderCoverage } from "./finalize-order-recompute";

describe("checkOrderCoverage", () => {
  // #1185 tier-1 review, finding 2: `qty` is Decimal(10,3), and Node's float math means summing
  // fractional pieces of a line's billed qty can land a hair short of the line's own qty even
  // when every piece of it was genuinely billed (e.g. 0.7 + 0.1 === 0.7999999999999999, not 0.8).
  // A strict `>=` would then never count that line as fully invoiced — the order stays gated
  // forever even though nothing is actually missing. Reused from
  // orders/merge-idempotency.ts's shouldSkipInPlaceResync: ±0.001 tolerance, and a zero-qty line
  // can never block coverage (it can never be billed).
  it("a float-imprecise but effectively-exact billed sum still counts as fully covered", async () => {
    const li = { id: "li1", qty: "0.8", invoicedQty: "0.8", status: "PENDING" };
    // 0.7 + 0.1 in floating point is 0.7999999999999999, one part in 1e16 short of 0.8 --
    // exactly the class of drift the ±0.001 tolerance exists to absorb.
    const aggQty = 0.7 + 0.1;
    expect(aggQty).toBeLessThan(0.8); // sanity: proves the float drift is real, not assumed

    const dbNeverCalled = {
      orderItem: {
        update: () => {
          throw new Error("must not write — fullyCovered:true returns before any write");
        },
      },
      order: {
        update: () => {
          throw new Error("must not write — fullyCovered:true returns before any write");
        },
      },
    };
    const result = await checkOrderCoverage({
      db: dbNeverCalled,
      orderId: "o1",
      order: { subtotal: 8, tax: 0, total: 8, shippingFee: 0, lineItems: [li] },
      byTarget: new Map([["line:li1", { qty: aggQty }]]),
      invoices: [],
    });

    expect(result.fullyCovered).toBe(true);
  });

  it("a line genuinely short (more than the tolerance) is NOT fully covered", async () => {
    const li = { id: "li1", qty: 10, invoicedQty: 0, status: "PENDING" };
    const result = await checkOrderCoverage({
      db: { orderItem: { update: async () => ({}) }, order: { update: async () => ({}) } },
      orderId: "o1",
      order: { subtotal: 100, tax: 0, total: 100, shippingFee: 0, lineItems: [li] },
      byTarget: new Map([["line:li1", { qty: 6 }]]), // genuinely under-billed, not float noise
      invoices: [],
    });

    expect(result.fullyCovered).toBe(false);
  });

  it("a zero-qty active line never blocks coverage (it can never be billed)", async () => {
    const zeroQtyLine = { id: "li0", qty: 0, invoicedQty: 0, status: "PENDING" };
    const billedLine = { id: "li1", qty: 4, invoicedQty: 4, status: "PENDING" };
    const dbNeverCalled = {
      orderItem: {
        update: () => {
          throw new Error("must not write — fullyCovered:true returns before any write");
        },
      },
      order: {
        update: () => {
          throw new Error("must not write — fullyCovered:true returns before any write");
        },
      },
    };
    const result = await checkOrderCoverage({
      db: dbNeverCalled,
      orderId: "o1",
      order: {
        subtotal: 40,
        tax: 0,
        total: 40,
        shippingFee: 0,
        lineItems: [zeroQtyLine, billedLine],
      },
      byTarget: new Map([["line:li1", { qty: 4 }]]),
      invoices: [],
    });

    expect(result.fullyCovered).toBe(true);
  });
});

// #1185 tier-1 review, finding 3: `unit-line-writers.ast.spec.ts`'s scanner inventories CLASS
// METHODS only (its own `classMethods`, ~L305) -- `checkOrderCoverage`/`finalizeOrderRecompute`
// are top-level free functions (extracted out of `InvoicesService.recomputeOrderFromInvoices`
// for the size ratchet), so they are structurally invisible to it. Widening that scanner to also
// discover free functions surfaced a SEPARATE, pre-existing, DELIBERATELY-deferred gap
// (`orders/unit-line-edit.ts`'s own B635 comment: "Filed, not fixed here (do not widen the
// scanner in this PR)") -- fixing that is out of scope for B667 and belongs to whoever picks up
// that filed item. Pinning explicitly instead, per the reviewer's own offered alternative: a
// narrow, self-contained AST check of ONLY this file's two writers, asserting the exact
// `orderItem.update` data keys each one writes are a fixed, known-safe set that can never
// silently gain `unitsPerBox`/`unitPrice`/`boxes`/`pieces` set to a non-zero DERIVED value (the
// exact class of "silently re-price a Case line at the pack's size" defect this whole guard
// family exists to prevent) without this test catching the diff.
describe("finalize-order-recompute.ts's own writers stay within their pinned, known-safe fields", () => {
  const src = fs.readFileSync(path.join(__dirname, "finalize-order-recompute.ts"), "utf8");
  const sf = ts.createSourceFile("finalize-order-recompute.ts", src, ts.ScriptTarget.Latest, true);

  /** Every `orderItem.update({ ..., data: { k1, k2, ... } })` call's data keys, inside `fn`. */
  function orderItemUpdateDataKeys(fn: ts.FunctionDeclaration): string[][] {
    const calls: string[][] = [];
    const visit = (n: ts.Node) => {
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === "update" &&
        ts.isPropertyAccessExpression(n.expression.expression) &&
        n.expression.expression.name.text === "orderItem"
      ) {
        const arg = n.arguments[0];
        if (arg && ts.isObjectLiteralExpression(arg)) {
          const dataProp = arg.properties.find(
            (p): p is ts.PropertyAssignment =>
              ts.isPropertyAssignment(p) && p.name.getText(sf) === "data",
          );
          if (dataProp && ts.isObjectLiteralExpression(dataProp.initializer)) {
            calls.push(
              dataProp.initializer.properties
                .map((p) => p.name?.getText(sf))
                .filter((k): k is string => !!k),
            );
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(fn);
    return calls;
  }

  function topLevelFn(name: string): ts.FunctionDeclaration {
    const found = sf.statements.find(
      (n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === name,
    );
    if (!found) throw new Error(`function not found in finalize-order-recompute.ts: ${name}`);
    return found;
  }

  it("checkOrderCoverage's only orderItem.update writes invoicedQty, and nothing else", () => {
    const calls = orderItemUpdateDataKeys(topLevelFn("checkOrderCoverage"));
    expect(calls).toEqual([["invoicedQty"]]);
  });

  it("finalizeOrderRecompute's only orderItem.update writes the fixed orphan-cancel field set, and nothing else", () => {
    const calls = orderItemUpdateDataKeys(topLevelFn("finalizeOrderRecompute"));
    expect(calls).toEqual([["status", "qty", "subtotal", "boxes", "pieces", "invoicedQty"]]);
  });

  it("neither writer's data keys ever include unitsPerBox or unitPrice -- the exact fields a live-product re-derivation would touch", () => {
    for (const fnName of ["checkOrderCoverage", "finalizeOrderRecompute"]) {
      for (const keys of orderItemUpdateDataKeys(topLevelFn(fnName))) {
        expect(keys).not.toContain("unitsPerBox");
        expect(keys).not.toContain("unitPrice");
      }
    }
  });
});
