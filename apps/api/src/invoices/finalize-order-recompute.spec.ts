import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";
import type { Prisma } from "@prisma/client";
import { checkOrderCoverage, finalizeOrderRecompute } from "./finalize-order-recompute";
import type { DeliveredBasis } from "./delivered-basis-by-line";

/** These test doubles only ever implement the couple of `db.orderItem`/`db.order` methods
 *  each test exercises — cast past the full `Prisma.TransactionClient` shape rather than
 *  building one out in full. */
const asTx = (db: unknown) => db as unknown as Prisma.TransactionClient;

// SA-093a (round 6): no DeliveryMutation rows at all -- the order behaves as undelivered,
// whatever its status (delivered-basis-by-line.ts's own rule).
const NO_DELIVERY: DeliveredBasis = { hasMutations: false, byLineId: new Map() };

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
      db: asTx(dbNeverCalled),
      orderId: "o1",
      order: { subtotal: 8, tax: 0, total: 8, shippingFee: 0, lineItems: [li] },
      byTarget: new Map([["line:li1", { qty: aggQty }]]),
      invoices: [],
      deliveredBasis: NO_DELIVERY,
    });

    expect(result.fullyCovered).toBe(true);
  });

  it("a line genuinely short (more than the tolerance) is NOT fully covered", async () => {
    const li = { id: "li1", qty: 10, invoicedQty: 0, status: "PENDING" };
    const result = await checkOrderCoverage({
      db: asTx({ orderItem: { update: async () => ({}) }, order: { update: async () => ({}) } }),
      orderId: "o1",
      order: {
        subtotal: 100,
        tax: 0,
        total: 100,
        shippingFee: 0,
        lineItems: [li],
      },
      byTarget: new Map([["line:li1", { qty: 6 }]]), // genuinely under-billed, not float noise
      invoices: [],
      deliveredBasis: NO_DELIVERY,
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
      db: asTx(dbNeverCalled),
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
      deliveredBasis: NO_DELIVERY,
    });

    expect(result.fullyCovered).toBe(true);
  });

  // #1185 round 5, item 1: an UNMATCHED line only counts as covered when it was billed to its
  // FULL billable qty -- a partial-then-removed line must fall through to the partial branch
  // (which releases it), never get treated as a covered/orphan-cancel candidate.
  it("an unmatched line billed for only PART of its qty is NOT covered (falls through to partial)", async () => {
    const li = { id: "li1", qty: 10, invoicedQty: 4, status: "PENDING" }; // billed 4 of 10, now unmatched
    const result = await checkOrderCoverage({
      db: asTx({ orderItem: { update: async () => ({}) }, order: { update: async () => ({}) } }),
      orderId: "o1",
      order: {
        subtotal: 100,
        tax: 0,
        total: 100,
        shippingFee: 0,
        lineItems: [li],
      },
      byTarget: new Map(), // no invoice item resolves to this line at all -- unmatched
      invoices: [],
      deliveredBasis: NO_DELIVERY,
    });

    expect(result.fullyCovered).toBe(false);
  });

  it("an unmatched line billed to its FULL qty IS covered (the genuine orphan case)", async () => {
    const li = { id: "li1", qty: 10, invoicedQty: 10, status: "PENDING" }; // billed in full, now removed
    const result = await checkOrderCoverage({
      db: asTx({ orderItem: { update: async () => ({}) }, order: { update: async () => ({}) } }),
      orderId: "o1",
      order: {
        subtotal: 100,
        tax: 0,
        total: 100,
        shippingFee: 0,
        lineItems: [li],
      },
      byTarget: new Map(),
      invoices: [],
      deliveredBasis: NO_DELIVERY,
    });

    expect(result.fullyCovered).toBe(true);
  });

  // #1185 round 5, item 2: an ambiguous line with NO precise match of its own is skipped by the
  // partial-branch sync loop entirely -- its invoicedQty is left exactly as stored, never
  // guessed at. (`ambiguousLineIds` can only ever apply here when `byTarget` has no `line:`
  // entry for it: resolveProductMatches never adds an ambiguous product to `existingByProduct`,
  // so a real `byTarget` entry for one of these lines can only exist via a genuine orderItemId
  // match -- see the next test.)
  it("an ambiguous line with NO precise match of its own is never touched by the partial-branch sync", async () => {
    const ambiguousLine = { id: "li1", qty: 4, invoicedQty: 0, status: "PENDING" };
    const blockingLine = { id: "li3", qty: 5, invoicedQty: 0, status: "PENDING" }; // keeps order partial
    const writes: any[] = [];
    const result = await checkOrderCoverage({
      db: asTx({ orderItem: { update: async (args: any) => writes.push(args) } }),
      orderId: "o1",
      order: {
        subtotal: 90,
        tax: 0,
        total: 90,
        shippingFee: 0,
        lineItems: [ambiguousLine, blockingLine],
      },
      byTarget: new Map(), // genuinely unresolved -- no line: entry for li1
      invoices: [],
      deliveredBasis: NO_DELIVERY,
      ambiguousLineIds: new Set(["li1"]),
    });

    expect(result.fullyCovered).toBe(false);
    expect(writes.some((w) => w.where.id === "li1")).toBe(false); // never written
  });

  // SA-093a ruling (2+3), round 6: a line named in ambiguousLineIds (its product is shared) but
  // that ALSO has its own precise byTarget match (only reachable via a real orderItemId) must be
  // trusted and synced -- ambiguity among its product-sharing siblings never overrides a
  // genuine, precise match for THIS line.
  it("a line that IS ambiguous by product but has its OWN precise byTarget match is still synced, not skipped", async () => {
    const li1 = { id: "li1", qty: 4, invoicedQty: 0, status: "PENDING" }; // precisely matched
    const li2 = { id: "li2", qty: 6, invoicedQty: 0, status: "PENDING" }; // shares li1's product, unresolved
    const blockingLine = { id: "li3", qty: 5, invoicedQty: 0, status: "PENDING" }; // keeps order partial
    const writes: any[] = [];
    const result = await checkOrderCoverage({
      db: asTx({ orderItem: { update: async (args: any) => writes.push(args) } }),
      orderId: "o1",
      order: {
        subtotal: 150,
        tax: 0,
        total: 150,
        shippingFee: 0,
        lineItems: [li1, li2, blockingLine],
      },
      byTarget: new Map([["line:li1", { qty: 4 }]]), // li1's own precise orderItemId match
      invoices: [],
      deliveredBasis: NO_DELIVERY,
      ambiguousLineIds: new Set(["li1", "li2"]), // both share the product
    });

    expect(result.fullyCovered).toBe(false);
    const li1Write = writes.find((w) => w.where.id === "li1");
    expect(li1Write?.data).toMatchObject({ invoicedQty: 4 }); // trusted, synced
    expect(writes.some((w) => w.where.id === "li2")).toBe(false); // still genuinely unresolved
  });

  // SA-093a (round 6): a line's billable qty is min(qty, its own DeliveryMutation-row qty) --
  // EVIDENCE-keyed, never order.status. A REFUSED row contributes 0 and never blocks coverage.
  // See delivered-basis-by-line.ts's own doc for the full rule.
  describe("SA-093a (round 6): mutation-row-keyed coverage basis", () => {
    it("a line delivered short of its ordered qty (mutation row present) IS covered at the delivered qty", async () => {
      const li = { id: "li1", qty: 10, invoicedQty: 0, status: "PENDING" };
      const result = await checkOrderCoverage({
        db: asTx({ orderItem: { update: async () => ({}) }, order: { update: async () => ({}) } }),
        orderId: "o1",
        order: { subtotal: 100, tax: 0, total: 100, shippingFee: 0, lineItems: [li] },
        byTarget: new Map([["line:li1", { qty: 6 }]]), // billed exactly what was delivered
        invoices: [],
        deliveredBasis: { hasMutations: true, byLineId: new Map([["li1", 6]]) },
      });

      expect(result.fullyCovered).toBe(true);
    });

    it("the SAME line with NO mutation rows at all is NOT covered (round 4's rule, unconstrained qty)", async () => {
      const li = { id: "li1", qty: 10, invoicedQty: 0, status: "PENDING" };
      const result = await checkOrderCoverage({
        db: asTx({ orderItem: { update: async () => ({}) }, order: { update: async () => ({}) } }),
        orderId: "o1",
        order: { subtotal: 100, tax: 0, total: 100, shippingFee: 0, lineItems: [li] },
        byTarget: new Map([["line:li1", { qty: 6 }]]),
        invoices: [],
        deliveredBasis: NO_DELIVERY,
      });

      expect(result.fullyCovered).toBe(false);
    });

    it("a REFUSED line (its own mutation row delivers 0) never blocks coverage", async () => {
      const refused = { id: "li1", qty: 5, invoicedQty: 0, status: "PENDING" };
      const billed = { id: "li2", qty: 4, invoicedQty: 0, status: "PENDING" };
      const result = await checkOrderCoverage({
        db: asTx({ orderItem: { update: async () => ({}) }, order: { update: async () => ({}) } }),
        orderId: "o1",
        order: { subtotal: 40, tax: 0, total: 40, shippingFee: 0, lineItems: [refused, billed] },
        byTarget: new Map([["line:li2", { qty: 4 }]]),
        invoices: [],
        deliveredBasis: {
          hasMutations: true,
          byLineId: new Map([
            ["li1", 0],
            ["li2", 4],
          ]),
        },
      });

      expect(result.fullyCovered).toBe(true);
    });

    // SA-093a: a mutation row ELSEWHERE on the order says nothing about a line delivery never
    // touched -- that line keeps its full ordered qty as the billable target (round 4's rule),
    // even though the order overall "has mutations".
    it("a line with NO mutation row of its own keeps its full ordered qty, even when a SIBLING line has one", async () => {
      const touched = { id: "li1", qty: 6, invoicedQty: 0, status: "PENDING" };
      const untouched = { id: "li2", qty: 10, invoicedQty: 0, status: "PENDING" };
      const result = await checkOrderCoverage({
        db: asTx({ orderItem: { update: async () => ({}) }, order: { update: async () => ({}) } }),
        orderId: "o1",
        order: {
          subtotal: 160,
          tax: 0,
          total: 160,
          shippingFee: 0,
          lineItems: [touched, untouched],
        },
        byTarget: new Map([
          ["line:li1", { qty: 6 }],
          ["line:li2", { qty: 6 }], // billed only 6 of li2's 10 -- unconstrained qty still gates
        ]),
        invoices: [],
        deliveredBasis: { hasMutations: true, byLineId: new Map([["li1", 6]]) },
      });

      expect(result.fullyCovered).toBe(false);
    });
  });

  describe("SA-093a (round 6): finalizeOrderRecompute cancels a line refused by its OWN mutation row", () => {
    it("a refused line (its own mutation row delivers 0, never billed) IS cancelled once the order is fully covered", async () => {
      const writes: any[] = [];
      const refused = { id: "li1", status: "PENDING", invoicedQty: 0 };
      await finalizeOrderRecompute({
        db: asTx({
          orderItem: { update: async (args: any) => writes.push(args) },
          order: { update: async () => ({}) },
        }),
        orderId: "o1",
        order: { subtotal: 40, tax: 0 },
        deliveredBasis: { hasMutations: true, byLineId: new Map([["li1", 0]]) },
        unbilled: new Map([["li1", refused]]),
        subtotal: 40,
        categoryTaxSum: 0,
        invoices: [],
      });

      const write = writes.find((w) => w.where.id === "li1");
      expect(write?.data).toMatchObject({ status: "CANCELLED", qty: 0, subtotal: 0 });
    });

    it("the SAME never-billed line with NO mutation row of its own is left untouched (round 4's rule)", async () => {
      const writes: any[] = [];
      const neverBilled = { id: "li1", status: "PENDING", invoicedQty: 0 };
      await finalizeOrderRecompute({
        db: asTx({
          orderItem: { update: async (args: any) => writes.push(args) },
          order: { update: async () => ({}) },
        }),
        orderId: "o1",
        order: { subtotal: 40, tax: 0 },
        deliveredBasis: NO_DELIVERY,
        unbilled: new Map([["li1", neverBilled]]),
        subtotal: 40,
        categoryTaxSum: 0,
        invoices: [],
      });

      expect(writes.some((w) => w.where.id === "li1")).toBe(false);
    });
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

  // Round 5 item 6: generalized past a single hardcoded "update" -- also walks `.create` and
  // `.updateMany`, so a NEW orderItem write op this file might grow can't silently skip the pin.
  const ORDER_ITEM_WRITE_OPS = new Set(["update", "create", "updateMany"]);

  /**
   * Every `orderItem.<update|create|updateMany>({ ..., data: { k1, k2, ... } })` call's data
   * keys, inside `fn`. A `...spread` in the data object is represented as a `"...<expr>"`
   * sentinel string rather than silently dropped -- round 5 item 6: the old `.map(p => p.name)`
   * mapping returned `undefined` for a `SpreadAssignment` (it has no `name`), and the trailing
   * `.filter(Boolean)` threw that `undefined` away, so a spread could inject arbitrary extra
   * fields (e.g. `...deriveFromLiveProduct(li)`) completely invisible to this pin.
   */
  function orderItemUpdateDataKeys(fn: ts.FunctionDeclaration): string[][] {
    const calls: string[][] = [];
    const visit = (n: ts.Node) => {
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        ORDER_ITEM_WRITE_OPS.has(n.expression.name.text) &&
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
              dataProp.initializer.properties.map((p) =>
                ts.isSpreadAssignment(p)
                  ? `...${p.expression.getText(sf)}`
                  : (p.name?.getText(sf) ?? "<unnamed>"),
              ),
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

  // Round 5 item 6: a `...spread` inside `data:` would surface as a `"...<expr>"` sentinel (see
  // orderItemUpdateDataKeys' own doc) -- assert neither writer ever has one, today or later.
  it("neither writer's orderItem write ever spreads an object into data -- every field is named, so this pin can see it", () => {
    for (const fnName of ["checkOrderCoverage", "finalizeOrderRecompute"]) {
      for (const keys of orderItemUpdateDataKeys(topLevelFn(fnName))) {
        for (const key of keys) expect(key.startsWith("...")).toBe(false);
      }
    }
  });

  // Round 5 item 6: `orderItem.create`/`orderItem.updateMany` carry the same footgun as `.update`
  // -- neither writer uses them today, but the scanner must not go blind if one is added later.
  it("neither writer ever calls orderItem.create or orderItem.updateMany today", () => {
    for (const fnName of ["checkOrderCoverage", "finalizeOrderRecompute"]) {
      const fnText = topLevelFn(fnName).getText(sf);
      expect(fnText).not.toMatch(/orderItem\.create\(/);
      expect(fnText).not.toMatch(/orderItem\.updateMany\(/);
    }
  });
});
