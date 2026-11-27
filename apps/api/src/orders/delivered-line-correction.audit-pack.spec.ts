/**
 * SA-1506 PR-1a / R-358: the correction's audit row sizes a pack-less line through the SAME live-pack map the stock settle
 * reads (`loadLiveUnitsPerBoxByProduct`), so `stockDeltaPieces` can never drift from what the counter moved.
 *
 * The product's pack is 12 through the map and a different number through a direct `product.findUnique`: a take-off of a
 * delivered line of 2 books 24 pieces back. The wrong value (a direct read) gives 14.
 */
import { deliveredLineEdit } from "./delivered-line-correction";
import type { DeliveredModes } from "./delivered-line-facts";

const LIVE_PACK = 12;
const DIRECT_READ_PACK = 7; // what `product.findUnique` would answer: never the number the map gives

function build() {
  const held = {
    id: "line-1",
    productId: "prod-1",
    status: "PENDING",
    qty: 2,
    deliveredQty: 2,
    boxes: null,
    pieces: null,
    unitsPerBox: null, // box-unaware, no snapshot: only the product's live pack can size it
    unitLabel: null,
    unitPrice: "1.00",
  };
  const after = { ...held, status: "CANCELLED" }; // the take-off
  const tx = {
    orderItem: {
      findMany: jest.fn().mockResolvedValue([after]),
      update: jest.fn().mockResolvedValue({}),
      count: jest.fn().mockResolvedValue(1), // the order keeps another live line
    },
    product: {
      findMany: jest.fn().mockResolvedValue([{ id: "prod-1", unitsPerBox: LIVE_PACK }]),
      findUnique: jest.fn().mockResolvedValue({ unitsPerBox: DIRECT_READ_PACK }),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    deliveryMutation: { create: jest.fn().mockResolvedValue({}) },
  };
  const dl = deliveredLineEdit({
    deps: {} as any,
    order: {
      id: "order-1",
      tenantId: "tenant-1",
      status: "PARTIALLY_DELIVERED",
      lineItems: [],
    } as any,
    dto: { items: [{ id: "line-1", qty: 0 }] } as any,
    user: { role: "TENANT_ADMIN", sub: "user-1" },
    isDiffPayload: true,
    prisma: { forTenant: () => ({}), getTenantId: () => "tenant-1" },
  });
  const modes: DeliveredModes = new Map([["line-1", { mode: "CORRECT", basis: "NONE" }]]);
  return { dl, tx, modes, held };
}

describe("SA-1506 PR-1a: the correction audit row reads the pack through the live-pack map", () => {
  it("stockDeltaPieces of a pack-less delivered line taken off is sized by the map's pack, not a direct product read", async () => {
    const { dl, tx, modes, held } = build();
    await dl.applyCorrections(tx, modes, [held] as any);

    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    const meta = tx.auditLog.create.mock.calls[0][0].data.meta;
    expect(meta.taken_off).toBe(true);
    expect(meta.stockDeltaPieces).toBe(2 * LIVE_PACK); // wrong value: 14 (2 x the direct read's 7)
    expect(tx.product.findMany).toHaveBeenCalledTimes(1); // the one batched, tenant-scoped map read
    expect(tx.product.findUnique).not.toHaveBeenCalled();
  });
});
