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
});
