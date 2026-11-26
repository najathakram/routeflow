import { ConflictException } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { correctedDeliveredFor } from "./corrected-delivered";
import { isAdminForCorrection } from "./delivered-line-edit-mode";
import { restateLineEvidence } from "./delivered-line-correction";
import { reduceDeliveredLineEntries } from "./delivered-line-lock";
import { lockedCopy } from "./delivered-line-copy";

describe("correctedDeliveredFor (SA-1514 R1, A2's rule)", () => {
  it("a cut lowers delivered to the new quantity", () => {
    expect(correctedDeliveredFor({ deliveredQty: 10 }, { finalQty: 8, struck: false })).toBe(8);
  });
  it("a raise leaves delivered where it was", () => {
    expect(correctedDeliveredFor({ deliveredQty: 10 }, { finalQty: 12, struck: false })).toBe(10);
  });
  it("a short line is not raised to the quantity", () => {
    expect(correctedDeliveredFor({ deliveredQty: 4 }, { finalQty: 8, struck: false })).toBe(4);
  });
  it("a take-off delivers 0", () => {
    expect(correctedDeliveredFor({ deliveredQty: 10 }, { finalQty: 10, struck: true })).toBe(0);
  });
});

describe("isAdminForCorrection (the SA-1513 seam)", () => {
  it("is a tenant admin in a tenant, nobody else", () => {
    expect(isAdminForCorrection(UserRole.TENANT_ADMIN, true)).toBe(true);
    expect(isAdminForCorrection(UserRole.TENANT_ADMIN, false)).toBe(false);
    expect(isAdminForCorrection(UserRole.OPERATOR, true)).toBe(false);
    expect(isAdminForCorrection(UserRole.SUPER_ADMIN, true)).toBe(false);
    expect(isAdminForCorrection(undefined, true)).toBe(false);
  });
});

describe("restateLineEvidence ROUTE basis (A3 M-d belt)", () => {
  it("answers a typed 409 with the ROUTE sentence, never an Error", async () => {
    const err = await restateLineEvidence(
      {},
      { orderId: "o1", tenantId: "t1" },
      { id: "l1" },
      8,
      "ROUTE",
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      code: "LINE_ALREADY_DELIVERED",
      message: lockedCopy("ROUTE"),
    });
  });
});

describe("reduceDeliveredLineEntries: unchanged price and unit on a CORRECT entry (A3 LOW 9)", () => {
  const held = [
    { id: "L1", productId: "p1", qty: 10, deliveredQty: 10, unitPrice: 2.5, unitLabel: null },
  ];
  const modes = new Map([["L1", { mode: "CORRECT", basis: "NONE" } as const]]);
  const run = (entry: Record<string, unknown>) =>
    reduceDeliveredLineEntries(
      { status: "CONFIRMED" },
      held,
      [{ id: "L1", ...entry }],
      modes as any,
    );

  it("drops a restated unitPrice and keeps the real qty change", () => {
    expect(run({ qty: 8, unitPrice: 2.5 })).toEqual([{ id: "L1", qty: 8 }]);
  });
  it("keeps a real price change", () => {
    expect(run({ qty: 8, unitPrice: 3 })).toEqual([{ id: "L1", qty: 8, unitPrice: 3 }]);
  });
  it("drops a restated unitLabel", () => {
    const m = new Map([["L2", { mode: "CORRECT", basis: "NONE" } as const]]);
    const h2 = [
      { id: "L2", productId: "p1", qty: 10, deliveredQty: 10, unitPrice: 1, unitLabel: "case" },
    ];
    const out = reduceDeliveredLineEntries(
      { status: "CONFIRMED" },
      h2,
      [{ id: "L2", qty: 8, unitLabel: "case" }],
      m as any,
    );
    expect(out).toEqual([{ id: "L2", qty: 8 }]);
  });
  it("a take-off DELETE becomes a CANCEL without the restated price", () => {
    expect(run({ action: "DELETE", unitPrice: 2.5 })).toEqual([{ id: "L1", action: "CANCEL" }]);
  });
});

describe("correctedDeliveredFor: SA-1520 (held figure is billing's; fully delivered stays delivered)", () => {
  const run = (held: { deliveredQty: number; qty: number }, e: object) =>
    correctedDeliveredFor(held, { finalQty: 13, struck: false, ...e });
  it("R4-G: a line billed in full (figure 12 of 12) raised to 13 is delivered 13", () => {
    expect(run({ deliveredQty: 12, qty: 12 }, {})).toBe(13);
  });
  it("a fully delivered line cut stays fully delivered at the new quantity", () => {
    expect(run({ deliveredQty: 12, qty: 12 }, { finalQty: 8 })).toBe(8);
  });
  it("a short line (6 of 12) raised keeps its figure", () => {
    expect(run({ deliveredQty: 6, qty: 12 }, {})).toBe(6);
  });
  it("R4-F: deliveredTo wins, and a short one stays below the quantity", () => {
    expect(run({ deliveredQty: 12, qty: 12 }, { finalQty: 12, deliveredTo: 8 })).toBe(8);
  });
  it("deliveredTo above the final quantity is a 400", () => {
    expect(() => run({ deliveredQty: 12, qty: 12 }, { finalQty: 12, deliveredTo: 13 })).toThrow(
      "Delivered can't be more than the quantity.",
    );
  });
});
