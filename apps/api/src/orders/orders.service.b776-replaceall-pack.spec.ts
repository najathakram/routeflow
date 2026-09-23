// SA-124e HIGH 2 — the staff/buyer replace-all rebuild (updateOrderItems) used to re-split
// EVERY boxed item against the LIVE product pack, undoing SA-124a/SA-124c's pack-keyed fold: a
// 12-pack bucket's 1 box became 6 pieces at a live pack of 6, and its price was dropped and
// re-derived from the live catalog. Pinned end-to-end through updateOrderItems, red-first
// against the pre-fix `normalizeBoxesPieces({ ..., unitsPerBox: product.unitsPerBox })`.
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

describe("OrdersService.updateOrderItems replaceAll — SA-124e HIGH 2 pack resolution", () => {
  let h: Awaited<ReturnType<typeof buildOrdersService>>;

  beforeEach(async () => {
    h = await buildOrdersService();
    h.prisma.product.findMany.mockResolvedValue([
      {
        id: "prod-repack",
        name: "Widget",
        unitsPerBox: 6,
        pricePerUnit: 6,
        trackedCategoryId: null,
      },
    ]);
  });

  it("HIGH 2 pin: lines at 12 and 6, live pack 6, a 6-pack scan grows the 6 line; the 12 line is recreated as 1 box / 12 / $36, never 6 pieces, never re-priced", async () => {
    h.prisma.order.findUnique.mockResolvedValue({
      ...MOCK_ORDER,
      lineItems: [
        line({
          id: "li-12",
          productId: "prod-repack",
          qty: 12,
          boxes: 1,
          pieces: 0,
          unitsPerBox: 12,
          unitPrice: 36,
          subtotal: 36,
        }),
        line({
          id: "li-6",
          productId: "prod-repack",
          qty: 6,
          boxes: 1,
          pieces: 0,
          unitsPerBox: 6,
          unitPrice: 18,
          subtotal: 18,
        }),
      ],
    });

    await h.service.updateOrderItems(
      "ord-1",
      {
        replaceAll: true,
        items: [
          // the fold's own output for each bucket, carrying its OWN resolved pack (SA-124e(1)):
          {
            productId: "prod-repack",
            qty: 12,
            boxes: 1,
            pieces: 0,
            unitsPerBox: 12,
            unitPrice: 36,
          },
          { productId: "prod-repack", qty: 12, boxes: 2, pieces: 0, unitsPerBox: 6, unitPrice: 18 },
        ],
      } as never,
      operatorPayload as never,
    );

    const creates = h.prisma.orderItem.create.mock.calls.filter(
      (c: any) => c[0]?.data?.productId === "prod-repack",
    );
    expect(creates).toHaveLength(2);
    const twelvePackLine = creates.find((c: any) => c[0].data.unitPrice === 36);
    expect(twelvePackLine![0].data).toMatchObject({ boxes: 1, pieces: 0, qty: 12, unitPrice: 36 });
    const sixPackLine = creates.find((c: any) => c[0].data.unitPrice === 18);
    expect(sixPackLine![0].data).toMatchObject({ boxes: 2, pieces: 0, qty: 12 });
  });

  it("a pieces-only payload for a product with two stored packs refuses (409), never re-splits at the live pack", async () => {
    h.prisma.order.findUnique.mockResolvedValue({
      ...MOCK_ORDER,
      lineItems: [
        line({
          id: "li-12",
          productId: "prod-repack",
          qty: 12,
          boxes: 1,
          pieces: 0,
          unitsPerBox: 12,
        }),
        line({ id: "li-6", productId: "prod-repack", qty: 6, boxes: 1, pieces: 0, unitsPerBox: 6 }),
      ],
    });

    const err = await h.service
      .updateOrderItems(
        "ord-1",
        {
          replaceAll: true,
          items: [{ productId: "prod-repack", qty: 5, boxes: null, pieces: 5 }],
        } as never,
        operatorPayload as never,
      )
      .catch((e: any) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.response ?? err).toMatchObject(
      expect.objectContaining({ code: "MERGE_PACK_MISMATCH", existingPacks: [6, 12] }),
    );
  });

  it("one stored snapshot plus a bare-qty payload — the snapshot wins, the line is recreated boxed at that pack", async () => {
    h.prisma.order.findUnique.mockResolvedValue({
      ...MOCK_ORDER,
      lineItems: [
        line({
          id: "li-12",
          productId: "prod-repack",
          qty: 12,
          boxes: 1,
          pieces: 0,
          unitsPerBox: 12,
        }),
      ],
    });

    await h.service.updateOrderItems(
      "ord-1",
      { replaceAll: true, items: [{ productId: "prod-repack", qty: 12 }] } as never,
      operatorPayload as never,
    );

    const created = h.prisma.orderItem.create.mock.calls.find(
      (c: any) => c[0]?.data?.productId === "prod-repack",
    );
    expect(created![0].data).toMatchObject({ boxes: 1, pieces: 0, qty: 12, unitsPerBox: 12 });
  });

  it("no stored line and no split falls to the live pack, with a warn", async () => {
    h.prisma.order.findUnique.mockResolvedValue({ ...MOCK_ORDER, lineItems: [] });
    const warnSpy = jest
      .spyOn((h.service as any).logger, "warn")
      .mockImplementation(() => undefined);

    await h.service.updateOrderItems(
      "ord-1",
      {
        // pieces-only: packFromOwnSplit refuses it (no boxes), so nothing resolves except
        // the live pack — no prior line for this product either, so it's not a conflict.
        replaceAll: true,
        items: [{ productId: "prod-repack", qty: 5, boxes: null, pieces: 5 }],
      } as never,
      operatorPayload as never,
    );

    const created = h.prisma.orderItem.create.mock.calls.find(
      (c: any) => c[0]?.data?.productId === "prod-repack",
    );
    expect(created![0].data).toMatchObject({ unitsPerBox: 6 });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("had no pack of their own — resolved via the live product pack"),
    );
  });
});
