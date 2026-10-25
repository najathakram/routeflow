import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { decideStaffWrite } from "../selling-restrictions/restriction-warning";
import { lockedUnvoidHeld, unvoidParams } from "./invoice-unvoid-gate";

/**
 * Row 460 (SA-958 §3.1): unvoid is a new sale of the whole invoice, judged before any write on the STAFF channel with
 * every line live; the lines are re-read under the invoice lock.
 */
const stamp = {
  restrictionOverrideReason: "approved by owner",
  restrictionOverrideBy: "u1",
  restrictionOverrideAt: new Date("2026-10-01T00:00:00Z"),
  restrictionOverrideRuleIds: ["r1:CA"],
};
const rows = [
  { id: "li1", productId: "p1", ...{ restrictionOverrideRuleIds: [] } },
  { id: "li2", productId: "p2", ...stamp },
  { id: "li3", productId: "p1", restrictionOverrideRuleIds: [] },
  { id: "li4", productId: null, restrictionOverrideRuleIds: [] },
];
const prismaWith = (items: unknown[], order: unknown = null) => ({
  getTenantId: () => "t1",
  forTenant: () => ({
    invoiceItem: { findMany: jest.fn().mockResolvedValue(items) },
    order: { findFirst: jest.fn().mockResolvedValue(order) },
  }),
});
const OP = { sub: "u1", role: "OPERATOR" } as never;

describe("unvoidParams", () => {
  it("judges each distinct catalog product once, keyed by its first line, no quantity delta", async () => {
    const { params, judged } = await unvoidParams(
      prismaWith(rows),
      { id: "inv1", customerId: "c1" },
      OP,
      undefined,
    );
    expect(params.lines).toEqual([
      { productId: "p1", lineKey: "l:li1" },
      { productId: "p2", lineKey: "l:li2" },
    ]);
    expect(params.lines.some((l) => "qtyDelta" in l)).toBe(false);
    expect([...judged].sort()).toEqual(["p1", "p2"]);
    expect(params).toMatchObject({ tenantId: "t1", customerId: "c1", document: "INVOICE" });
  });

  it("holds every line as LIVE with its pre-void stamp (sticky coverage, row 510)", async () => {
    const { params } = await unvoidParams(
      prismaWith(rows),
      { id: "inv1", customerId: "c1" },
      OP,
      undefined,
    );
    expect(params.held).toHaveLength(4);
    expect(params.held?.every((h) => h.status === null)).toBe(true);
    expect(params.held?.find((h) => h.id === "li2")?.restrictionOverrideReason).toBe(
      "approved by owner",
    );
  });

  it("passes the staff actor and the acknowledgement through", async () => {
    const ack = {
      warningHash: "rw1:x",
      restrictionOverrides: [{ lineKey: "l:li1", reason: "ok" }],
    };
    const { params } = await unvoidParams(
      prismaWith(rows),
      { id: "inv1", customerId: "c1" },
      OP,
      ack as never,
    );
    expect(params.principal).toBe(OP);
    expect(params.ack).toBe(ack);
  });

  it("an order-linked invoice is judged at its order's kind (a counter order: COUNTER)", async () => {
    const { params } = await unvoidParams(
      prismaWith(rows, { counterSale: true, fulfillPath: "PICKUP" }),
      { id: "inv1", customerId: "c1", orderId: "o1" },
      OP,
      undefined,
    );
    expect(params.fulfilmentKind).toBe("COUNTER");
  });

  it("an order-less invoice is DELIVERY", async () => {
    const { params } = await unvoidParams(
      prismaWith(rows),
      { id: "inv1", customerId: "c1" },
      OP,
      undefined,
    );
    expect(params.fulfilmentKind).toBe("DELIVERY");
  });

  it("a tenant-less session is refused (fail closed)", async () => {
    const p = { ...prismaWith(rows), getTenantId: () => null };
    await expect(
      unvoidParams(p, { id: "inv1", customerId: "c1" }, OP, undefined),
    ).rejects.toBeDefined();
  });
});

describe("lockedUnvoidHeld (under the invoice lock)", () => {
  const tx = (items: unknown[]) => ({
    invoiceItem: { findMany: jest.fn().mockResolvedValue(items) },
  });

  it("returns the lines live when the product set is the one judged", async () => {
    const held = await lockedUnvoidHeld(tx(rows), "inv1", new Set(["p1", "p2"]));
    expect(held.every((h) => h.status === null)).toBe(true);
  });

  it("a product added since the judgement is a 409 INVOICE_CHANGED_CONCURRENTLY, nothing re-judged blind", async () => {
    const err = await lockedUnvoidHeld(tx(rows), "inv1", new Set(["p1"])).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ code: API_ERROR_CODES.INVOICE_CHANGED_CONCURRENTLY });
  });

  it("a product removed since the judgement is the same 409", async () => {
    const err = await lockedUnvoidHeld(tx(rows), "inv1", new Set(["p1", "p2", "p3"])).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(ConflictException);
  });
});

describe("the decision over an unvoid (end to end through the pure protocol)", () => {
  const breach = {
    productId: "p1",
    productName: "Gummies",
    outcome: "BLOCK",
    ruleIds: ["r1"],
    rules: [{ id: "r1", kind: "STATE_HIT", states: ["CA"], legal: true, reason: "State ban" }],
    unknownProduct: false,
    state: "CA",
  };
  const judgement = {
    outcome: "BLOCK",
    reasons: [],
    breaches: [breach],
    basis: "CUSTOMER",
  } as never;
  const decide = async (items: unknown[]) => {
    const { params } = await unvoidParams(
      prismaWith(items),
      { id: "inv1", customerId: "c1" },
      OP,
      undefined,
    );
    return decideStaffWrite({
      judgement,
      lines: params.lines,
      held: params.held,
      principal: OP,
      customerId: "c1",
      blocked: ((r: unknown) => new Error("blocked")) as never,
    } as never);
  };

  it("a VOID invoice with a line now banned for the customer's state warns (nothing written)", async () => {
    const err = await decide([
      { id: "li1", productId: "p1", restrictionOverrideRuleIds: [] },
    ]).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse().code).toBe("RESTRICTION_WARNING");
  });

  it("the same line carrying a covering pre-void override is covered (sticky)", async () => {
    const d = await decide([{ id: "li1", productId: "p1", ...stamp }]);
    expect(d.stamps).toEqual([]);
  });
});
