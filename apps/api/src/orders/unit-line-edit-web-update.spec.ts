import { prepareUnitEditContext } from "./unit-line-edit";
import type { UpdateOrderItemsDto } from "./dto/update-order-items.dto";

/**
 * A3-2 precondition check (bug-hunt finding on #938, test-only — no production code touched
 * here): the web order-edit page now sends `{id, productId, qty, unitLabel}` for a unit-aware
 * line's edit (`buildItemUpdates` in `apps/web/app/(dashboard)/orders/[id]/_components/order-line-edit.tsx`). This
 * proves, against the REAL `prepareUnitEditContext`, that including `productId` is load-bearing:
 * an id-only `{id, qty, unitLabel}` item against a line `prepareUnitEditContext` doesn't already
 * know is unit-aware never gets its product/ladder preloaded, silently discarding the label
 * (`resolveLineUnits` is only ever called when the product WAS preloaded — see
 * `orders.service.ts` `updateOrderItems`). That gap is a separate, already-filed SERVER defect;
 * it is documented here, not fixed — the fix in this PR is the web client always including
 * `productId`, proven by the first case below.
 */
describe("prepareUnitEditContext — productId precondition for a web unit-line UPDATE (A3-2)", () => {
  const PRODUCT = { id: "prod-1", unit: "Box", unitsPerBox: 24, pricePerUnit: "10.00" };
  const LADDER_ROW = {
    id: "u1",
    productId: "prod-1",
    label: "Case",
    factorToBase: 24,
    price: "220.00",
    sortOrder: 0,
  };

  function makeSelf(hasFlag: boolean) {
    const findMany = jest.fn().mockResolvedValue([PRODUCT]);
    const ladderFindMany = jest.fn().mockResolvedValue([LADDER_ROW]);
    return {
      prisma: {
        getTenantId: () => "tenant-1",
        forTenant: () => ({
          product: { findMany },
          productUnit: { findMany: ladderFindMany },
        }),
      },
      entitlements: { hasFlag: jest.fn().mockResolvedValue(hasFlag) },
    } as any;
  }

  it("preloads the product/ladder when the UPDATE item carries productId (the web fix)", async () => {
    // A currently plain-PACK line (unitLabel null in the DB) being assigned a unit for the
    // first time via the edit-row picker.
    const order = { lineItems: [{ id: "li-1", productId: "prod-1", unitLabel: null }] };
    const dto: UpdateOrderItemsDto = {
      items: [{ id: "li-1", productId: "prod-1", qty: 4, unitLabel: "Case" }],
    } as any;

    const ctx = await prepareUnitEditContext(makeSelf(true), order as any, dto, {
      role: "OPERATOR",
    });

    expect(ctx.products.has("prod-1")).toBe(true);
    expect(ctx.ladders.get("prod-1")).toEqual([LADDER_ROW]);
  });

  it("also preloads for an ALREADY unit-aware line, with or without productId on the item (A3-2's own scenario)", async () => {
    // The primary A3-2 scenario: editing an existing Case line's qty. The STORED line's own
    // unitLabel already makes prepareUnitEditContext preload it, regardless of the item.
    const order = { lineItems: [{ id: "li-1", productId: "prod-1", unitLabel: "Case" }] };
    const dto: UpdateOrderItemsDto = {
      items: [{ id: "li-1", qty: 4, unitLabel: "Case" }], // no productId — still safe here
    } as any;

    const ctx = await prepareUnitEditContext(makeSelf(true), order as any, dto, {
      role: "OPERATOR",
    });

    expect(ctx.products.has("prod-1")).toBe(true);
  });

  it("documents (does not fix) the filed gap: an id-only item with NO productId against a plain-pack line is never preloaded", async () => {
    const order = { lineItems: [{ id: "li-1", productId: "prod-1", unitLabel: null }] };
    const dto: UpdateOrderItemsDto = {
      items: [{ id: "li-1", qty: 4, unitLabel: "Case" }], // the shape the web client must NEVER send
    } as any;

    const ctx = await prepareUnitEditContext(makeSelf(true), order as any, dto, {
      role: "OPERATOR",
    });

    expect(ctx.products.has("prod-1")).toBe(false);
  });
});
