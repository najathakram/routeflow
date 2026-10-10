// SA-124g/h R1 — the replace-all rebuild in updateOrderItems is reverted to master
// byte-for-byte (see replace-all-pack-resolution.ts's header for why: R-PRICE, the full
// SA-077 resolution order, is R2's scope). The ONE thing R1 adds on top is
// assertReplaceAllPackMatchesLive: refuse (rolled back, nothing written) a payload item whose
// own resolved pack disagrees with the live product pack, instead of silently re-splitting it.
jest.mock("../common/db-locks", () => ({
  ...jest.requireActual("../common/db-locks"),
  withAdvisoryLock: jest.fn(async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  })),
}));

import { buildOrdersService, operatorPayload } from "./testing/orders-service-harness";

const MOCK_ORDER = {
  id: "ord-1",
  tenantId: "t1",
  customerId: "cust-1",
  status: "PENDING",
  lineItems: [] as unknown[],
  routeRun: null,
};

const line = (over: Record<string, unknown>) => ({
  id: "li-x",
  orderId: "ord-1",
  productId: "prod-repack",
  name: null,
  qty: 12,
  boxes: 1,
  pieces: 0,
  unitsPerBox: 12,
  unitLabel: null,
  unitPrice: 36,
  subtotal: 36,
  status: "PENDING",
  deliveredQty: 0,
  invoicedQty: 0,
  priceType: "STANDARD",
  originalPrice: null,
  overrideReason: null,
  overriddenBy: null,
  promoFreeUnits: null,
  trackedCategoryId: null,
  position: 0,
  ...over,
});

describe("OrdersService.updateOrderItems replaceAll — SA-124g/h R1's ONE guard", () => {
  let h: Awaited<ReturnType<typeof buildOrdersService>>;

  beforeEach(async () => {
    h = await buildOrdersService();
  });

  it("gate (c): a payload item carrying its own 12-pack against a live-repacked-to-6 product refuses — nothing written", async () => {
    h.prisma.product.findMany.mockResolvedValue([
      {
        id: "prod-repack",
        name: "Widget",
        unitsPerBox: 6,
        pricePerUnit: 6,
        trackedCategoryId: null,
      },
    ]);
    h.prisma.order.findUnique.mockResolvedValue({
      ...MOCK_ORDER,
      lineItems: [line({ id: "li-12" })],
    });

    const err = await h.service
      .updateOrderItems(
        "ord-1",
        {
          replaceAll: true,
          items: [
            {
              productId: "prod-repack",
              qty: 12,
              boxes: 1,
              pieces: 0,
              unitsPerBox: 12,
              unitPrice: 36,
            },
          ],
        } as never,
        operatorPayload as never,
      )
      .catch((e: any) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.response ?? err).toMatchObject(
      expect.objectContaining({
        code: "MERGE_PACK_MISMATCH",
        existingPacks: [12],
        incomingPack: 6,
      }),
    );
    expect(h.prisma.orderItem.create).not.toHaveBeenCalled();
  });

  it("gate (e): a normal same-pack replace-all (payload pack matches live pack) is unchanged from master — no refusal", async () => {
    h.prisma.product.findMany.mockResolvedValue([
      {
        id: "prod-repack",
        name: "Widget",
        unitsPerBox: 12,
        pricePerUnit: 3,
        trackedCategoryId: null,
      },
    ]);
    h.prisma.order.findUnique.mockResolvedValue({
      ...MOCK_ORDER,
      lineItems: [line({ id: "li-12" })],
    });

    await h.service.updateOrderItems(
      "ord-1",
      {
        replaceAll: true,
        items: [
          {
            productId: "prod-repack",
            qty: 24,
            boxes: 2,
            pieces: 0,
            unitsPerBox: 12,
            unitPrice: 36,
          },
        ],
      } as never,
      operatorPayload as never,
    );

    const created = h.prisma.orderItem.create.mock.calls.find(
      (c: any) => c[0]?.data?.productId === "prod-repack",
    );
    expect(created![0].data).toMatchObject({ boxes: 2, pieces: 0, qty: 24 });
  });

  it("a payload item with no resolvable own pack (pieces-only) never refuses — matches pre-B776 master exactly", async () => {
    h.prisma.product.findMany.mockResolvedValue([
      {
        id: "prod-repack",
        name: "Widget",
        unitsPerBox: 6,
        pricePerUnit: 6,
        trackedCategoryId: null,
      },
    ]);
    h.prisma.order.findUnique.mockResolvedValue({ ...MOCK_ORDER, lineItems: [] });

    await h.service.updateOrderItems(
      "ord-1",
      {
        replaceAll: true,
        items: [{ productId: "prod-repack", qty: 5, boxes: null, pieces: 5 }],
      } as never,
      operatorPayload as never,
    );

    const created = h.prisma.orderItem.create.mock.calls.find(
      (c: any) => c[0]?.data?.productId === "prod-repack",
    );
    expect(created).toBeDefined();
    expect(created![0].data.unitsPerBox).toBe(6); // live pack, master's original behavior
  });

  it("SA-124i (option i): sourceLineId disambiguates two same-product lines with different overrideReasons — each payload item's fallback reason resolves to ITS OWN line, never confused by productId alone", async () => {
    h.prisma.product.findMany.mockResolvedValue([
      {
        id: "prod-dup",
        name: "Widget",
        unitsPerBox: null,
        pricePerUnit: 5,
        trackedCategoryId: null,
      },
    ]);
    const lineA = line({
      id: "li-a",
      qty: 10,
      boxes: null,
      pieces: null,
      unitsPerBox: null,
      unitPrice: 40,
      priceType: "MANUAL",
      overrideReason: "reason A",
    });
    const lineB = line({
      id: "li-b",
      qty: 7,
      boxes: null,
      pieces: null,
      unitsPerBox: null,
      unitPrice: 60,
      priceType: "MANUAL",
      overrideReason: "reason B",
    });
    h.prisma.order.findUnique.mockResolvedValue({
      ...MOCK_ORDER,
      lineItems: [lineA, lineB],
    });

    // Both echoed at their OWN unchanged price, WITHOUT an explicit overrideReason on the
    // payload — the fallback must pick each line's own stored reason. Without sourceLineId,
    // existingLineByProduct treats 2 pre-edit lines of one product as ambiguous and resolves
    // NEITHER, so both would fall back to null.
    await h.service.updateOrderItems(
      "ord-1",
      {
        replaceAll: true,
        items: [
          { productId: "prod-dup", sourceLineId: "li-a", qty: 10, unitPrice: 40 },
          { productId: "prod-dup", sourceLineId: "li-b", qty: 7, unitPrice: 60 },
        ],
      } as never,
      operatorPayload as never,
    );

    const calls = h.prisma.orderItem.create.mock.calls.filter(
      (c: any) => c[0]?.data?.productId === "prod-dup",
    );
    const created40 = calls.find((c: any) => c[0].data.unitPrice === 40);
    const created60 = calls.find((c: any) => c[0].data.unitPrice === 60);
    expect(created40![0].data.overrideReason).toBe("reason A");
    expect(created60![0].data.overrideReason).toBe("reason B");
  });

  it("SA-124k: a folded STANDARD bucket with no unitPrice re-derives at product.pricePerUnit verbatim — the BOX price, never divided or multiplied by unitsPerBox", async () => {
    // pricePerUnit is the price of ONE SELLING UNIT — a box, when unitsPerBox > 1 (create(),
    // the web create modal and SA-124g all share this convention; common/msrp.ts:33 states it
    // explicitly for the same reason). getTierPrice/resolveBuyerLinePrice must read it
    // VERBATIM. A chain-spec fixture (b776-r1-chain.db.spec.ts case (f)) once seeded a
    // per-piece price here by mistake and misread the correct $3/box re-derivation as a 12x
    // bug in this code — this pin exists so that mistake can't recur silently.
    h.prisma.product.findMany.mockResolvedValue([
      {
        id: "prod-box",
        name: "Widget",
        unitsPerBox: 12,
        pricePerUnit: 36, // the BOX price, not 36/12
        trackedCategoryId: null,
      },
    ]);
    h.prisma.order.findUnique.mockResolvedValue({
      ...MOCK_ORDER,
      lineItems: [line({ id: "li-box", productId: "prod-box", boxes: 2, qty: 24, unitPrice: 36 })],
    });

    // A folded item with NO unitPrice — exactly foldMergeItems' own output for a grown
    // STANDARD/derived bucket (REG-B465-MERGE-2: a derived line's price never survives the
    // fold), forcing this code down the resolveBuyerLinePrice re-derivation branch.
    await h.service.updateOrderItems(
      "ord-1",
      {
        replaceAll: true,
        items: [{ productId: "prod-box", sourceLineId: "li-box", qty: 36, boxes: 3, pieces: 0 }],
      } as never,
      operatorPayload as never,
    );

    const created = h.prisma.orderItem.create.mock.calls.find(
      (c: any) => c[0]?.data?.productId === "prod-box",
    );
    expect(created![0].data.priceType).toBe("STANDARD");
    expect(Number(created![0].data.unitPrice)).toBe(36);
  });
});
