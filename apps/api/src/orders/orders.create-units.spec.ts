/**
 * units_v1 step 4b-2b — `OrdersService.create` sells by a unit of the product's ladder for STAFF
 * behind `flag.units_v1`; a pack-only request is byte-identical. The builder itself is proven in
 * `unit-line-build.spec.ts`; this pins the WIRING: what create() reads, refuses and writes.
 * Harness copied from `orders.create-restrictions.spec.ts`.
 */

// InvoicesService / NotificationsService import ESM-only modules (@react-pdf/renderer,
// expo-server-sdk) Jest's CommonJS parser cannot load; the auto-mocker below never needs them.
jest.mock("../invoices/invoices.service", () => ({ InvoicesService: class InvoicesService {} }));
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: class NotificationsService {},
}));

import { Test } from "@nestjs/testing";
import { BadRequestException, ConflictException, ForbiddenException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { OrdersService } from "./orders.service";
import { PrismaService } from "../prisma/prisma.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { createMockPrisma } from "../testing/prisma-mock";

const operatorPayload = { sub: "user-op", username: "operator", role: "OPERATOR" as const };
const customerPayload = { sub: "user-cust", username: "customer1", role: "CUSTOMER" as const };

/** Every collaborator create() touches that this spec does not care about: any method resolves undefined. */
const autoMock = () =>
  new Proxy({} as Record<string | symbol, jest.Mock>, {
    // `then`/symbols stay undefined: a thenable mock would hang every `await`.
    get: (t, k) =>
      k === "then" || typeof k === "symbol"
        ? undefined
        : (t[k] ??= jest.fn().mockResolvedValue(undefined)),
  });

describe("OrdersService.create — sell by a unit (units_v1, 4b-2b)", () => {
  let service: OrdersService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const module = await Test.createTestingModule({ providers: [OrdersService] })
      .useMocker((token) => {
        if (token === PrismaService) return prisma;
        if (token === ConfigService) return { get: jest.fn().mockReturnValue(0.1) };
        if (token === EntitlementsService) return { hasFlag: jest.fn().mockResolvedValue(true) };
        return autoMock();
      })
      .compile();
    service = module.get(OrdersService);
  });

  // A 24-piece box at $42; a Case of 288 with an explicit $480; a Pallet with no price (derived).
  const PRODUCT = {
    id: "prod-1",
    name: "Widget",
    unit: "Box",
    pricePerUnit: 42,
    unitsPerBox: 24,
    category: null,
    trackedCategoryId: null,
    trackedSubcategoryId: null,
    isActive: true,
    // the buyer gate (#2856) judges these: a fixture that omits them is correctly hidden
    kind: "STANDARD",
    portalVisible: true,
    parent: null,
  };
  const ladder = [
    { productId: "prod-1", label: "Case", factorToBase: 288, price: "480.00", sortOrder: 0 },
    { productId: "prod-1", label: "Pallet", factorToBase: 5760, price: null, sortOrder: 1 },
  ].map((u) => ({ priceTier2: null, priceTier3: null, priceTier4: null, priceTier5: null, ...u }));
  const staff = { ...operatorPayload, tenantId: "t-1" } as never;
  const scopedUnits = { findMany: jest.fn() };
  const hasFlag = () => (service as any).entitlements.hasFlag as jest.Mock;
  const orderData = () => prisma.order.create.mock.calls[0][0].data;

  beforeEach(() => {
    prisma.customer.findFirst.mockResolvedValue({ id: "cust-1", pricingTier: 1 });
    prisma.customer.findUnique.mockResolvedValue({
      id: "cust-1",
      pricingTier: 1,
      user: { status: "ACTIVE" },
      deletedAt: null,
    });
    prisma.product.findMany.mockResolvedValue([PRODUCT]);
    scopedUnits.findMany.mockReset().mockResolvedValue(ladder);
    (prisma.forTenant as jest.Mock).mockReturnValue({
      ...(prisma.forTenant as jest.Mock)(),
      productUnit: scopedUnits,
    });
    prisma.order.create.mockResolvedValue({
      id: "ord-new",
      customerId: "cust-1",
      orderNumber: "x",
      total: 0,
      urgent: false,
      createdAt: new Date(),
      customer: { id: "cust-1", businessName: "Acme" },
      lineItems: [],
    });
    (prisma.tenantTransaction as jest.Mock).mockImplementation((fn: any) =>
      fn({
        ...prisma,
        $queryRaw: jest.fn().mockResolvedValue([{ max: null }]),
        $executeRaw: jest.fn().mockResolvedValue(0),
      }),
    );
    hasFlag().mockResolvedValue(true);
  });
  const create = (items: unknown[], user: never = staff) =>
    service.create({ customerId: "cust-1", items } as never, user);

  it("writes a Case line from the SERVER ladder: unit count, base-piece qty, factor snapshot, unit price — and never auto-merges the order", async () => {
    await create([{ productId: "prod-1", qty: 3, unitLabel: "Case" }]);
    const d = orderData();
    expect(d.lineItems.create).toHaveLength(1);
    expect(d.lineItems.create[0]).toMatchObject({
      productId: "prod-1",
      unitLabel: "Case",
      boxes: 3,
      pieces: 0,
      qty: 864,
      unitsPerBox: 288,
      unitPrice: 480,
      subtotal: 1440,
      position: 0,
      tenantId: "test-tenant",
    });
    expect(d.subtotal).toBe(1440);
    expect(d.skipAutoMerge).toBe(true);
    // read through the TENANT-SCOPED client (forTenant), never the raw one
    expect(scopedUnits.findMany).toHaveBeenCalledTimes(1);
    expect(scopedUnits.findMany.mock.calls[0][0].where).toEqual({ productId: { in: ["prod-1"] } });
    expect(prisma.productUnit.findMany).not.toHaveBeenCalled();
    expect(hasFlag()).toHaveBeenCalledWith("test-tenant", "flag.units_v1");
  });

  describe("SA-728 / P0b: a derived Piece from an OLD client bills as the pack's pieces", () => {
    const PACK3 = { ...PRODUCT, id: "prod-3", unit: "Pack", pricePerUnit: 10, unitsPerBox: 3 };
    const caseRow = {
      productId: "prod-3",
      label: "Case",
      factorToBase: 12,
      price: null,
      priceTier2: null,
      priceTier3: null,
      priceTier4: null,
      priceTier5: null,
      sortOrder: 0,
    };
    beforeEach(() => prisma.product.findMany.mockResolvedValue([PACK3]));

    it("3-pack @10, 2 pcs sent as unitLabel Piece = $6.67 on a pack line (boxes 0, pieces 2), no unitLabel stored", async () => {
      scopedUnits.findMany.mockResolvedValue([caseRow]);
      await create([{ productId: "prod-3", qty: 2, unitLabel: "Piece", unitPrice: 3.33 }]);
      const line = orderData().lineItems.create[0];
      expect("unitLabel" in line && line.unitLabel != null).toBe(false);
      expect(line).toMatchObject({
        boxes: 0,
        pieces: 2,
        qty: 2,
        unitsPerBox: 3,
        unitPrice: 10,
        subtotal: 6.67,
      });
      expect(orderData().subtotal).toBe(6.67);
    });

    it("an own-priced Piece row keeps the unit-line path: unitLabel Piece at the row's price", async () => {
      scopedUnits.findMany.mockResolvedValue([
        { ...caseRow, label: "Piece", factorToBase: 1, price: "3.00" },
      ]);
      await create([{ productId: "prod-3", qty: 2, unitLabel: "Piece" }]);
      expect(orderData().lineItems.create[0]).toMatchObject({
        unitLabel: "Piece",
        unitPrice: 3,
        qty: 2,
        subtotal: 6,
      });
    });
  });

  it("a mixed order keeps its pack line exactly as before next to a unit line", async () => {
    await create([
      { productId: "prod-1", qty: 2, boxes: 2, pieces: 0 }, // pack: 2 boxes of 24 at $42
      { productId: "prod-1", qty: 1, unitLabel: "Pallet" }, // derived 42 x 5760 / 24 = 10080
    ]);
    const [pack, pallet] = orderData().lineItems.create;
    expect(pack).toMatchObject({ boxes: 2, qty: 48, unitsPerBox: 24, unitPrice: 42, subtotal: 84 });
    expect("unitLabel" in pack).toBe(false);
    expect(pallet).toMatchObject({ unitLabel: "Pallet", unitPrice: 10080, position: 1 });
    expect(orderData().subtotal).toBe(10164);
    expect(orderData().skipAutoMerge).toBe(true);
  });

  it("a pack-only request reads nothing new: no ladder query, no entitlement lookup, merge behaviour unchanged", async () => {
    await create([{ productId: "prod-1", qty: 1 }]);
    expect(scopedUnits.findMany).not.toHaveBeenCalled();
    expect(hasFlag()).not.toHaveBeenCalled();
    expect(orderData().skipAutoMerge).toBe(false);
    expect("unitLabel" in orderData().lineItems.create[0]).toBe(false);
  });

  it("the pack's own label (or a blank one) is a plain pack line, not a unit line", async () => {
    await create([
      { productId: "prod-1", qty: 1, boxes: 1, unitLabel: "Box" },
      { productId: "prod-1", qty: 1, boxes: 1, unitLabel: "  " },
    ]);
    for (const line of orderData().lineItems.create) {
      expect("unitLabel" in line).toBe(false);
      expect(line).toMatchObject({ boxes: 1, unitsPerBox: 24, unitPrice: 42 });
    }
    expect(orderData().skipAutoMerge).toBe(false);
  });

  it.each([
    ["a buyer", { ...customerPayload, tenantId: "t-1" }, BadRequestException],
    ["a tenant without flag.units_v1", staff, ForbiddenException],
  ])("%s asking for a unit is refused BEFORE any write", async (who, user, err) => {
    if (who !== "a buyer") hasFlag().mockResolvedValue(false);
    await expect(
      create([{ productId: "prod-1", qty: 1, unitLabel: "Case" }], user as never),
    ).rejects.toBeInstanceOf(err);
    expect(prisma.tenantTransaction).not.toHaveBeenCalled();
    expect(prisma.order.create).not.toHaveBeenCalled();
  });

  it("WS8: a FAMILY container on a line is a 400 FAMILY_NOT_SELLABLE, for staff too, and nothing is written", async () => {
    prisma.product.findMany.mockResolvedValue([{ ...PRODUCT, kind: "FAMILY" }]);
    const err = await create([{ productId: "prod-1", qty: 1 }]).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({
      code: "FAMILY_NOT_SELLABLE",
      productIds: ["prod-1"],
    });
    expect(prisma.order.create).not.toHaveBeenCalled();
  });

  it("a BUYER naming a FAMILY container gets the buyer 409 SELLING_RESTRICTED (blocked-lines dialog), not the staff 400", async () => {
    prisma.product.findMany.mockResolvedValue([{ ...PRODUCT, kind: "FAMILY" }]);
    const err = await create([{ productId: "prod-1", qty: 1 }], {
      ...customerPayload,
      tenantId: "t-1",
    } as never).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({
      code: "SELLING_RESTRICTED",
      blockedLines: [
        expect.objectContaining({ productId: "prod-1", reason: "HIDDEN_FROM_PORTAL" }),
      ],
    });
    expect(prisma.order.create).not.toHaveBeenCalled();
  });

  it("#2784 / SA-601 interim: a BUYER's plain qty stays a PACK line even when a level is flagged isDefaultSelling, and no ladder is read for a buyer", async () => {
    scopedUnits.findMany.mockResolvedValue(
      ladder.map((u) => (u.label === "Case" ? { ...u, isDefaultSelling: true } : u)),
    );
    (service as any).promotionsService.activeForCatalog.mockResolvedValue([]);
    await create([{ productId: "prod-1", qty: 2 }], {
      ...customerPayload,
      tenantId: "t-1",
    } as never);
    const line = orderData().lineItems.create[0];
    expect("unitLabel" in line).toBe(false);
    // a plain pack line: no unit, and no factor snapshot (snapshots only for a box-split or unit-aware line)
    expect(line).toMatchObject({ productId: "prod-1", unitsPerBox: null, qty: 2 });
    expect(scopedUnits.findMany).not.toHaveBeenCalled();
    // The goal (owner #2780: a buyer's plain qty = the default selling unit) needs the SA's buyer unit-line design first.
  });

  it("an unknown unit, boxes beside a unit, and a unit on a custom line are 400s that write nothing", async () => {
    for (const items of [
      [{ productId: "prod-1", qty: 1, unitLabel: "Bogus" }],
      [{ productId: "prod-1", qty: 1, boxes: 1, unitLabel: "Case" }],
      [{ name: "Delivery", qty: 1, unitPrice: 5, unitLabel: "Case" }],
    ]) {
      await expect(create(items)).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(prisma.order.create).not.toHaveBeenCalled();
  });

  it("a staff-typed unit price is a one-time DISCOUNTED price against the tier-1 unit price", async () => {
    await create([{ productId: "prod-1", qty: 2, unitLabel: "Case", unitPrice: 450 }]);
    expect(orderData().lineItems.create[0]).toMatchObject({
      unitPrice: 450,
      priceType: "DISCOUNTED",
      originalPrice: 480,
      subtotal: 900,
    });
  });

  it("an Idempotency-Key retry of the SAME unit cart replays the original order; a changed unit is a 409", async () => {
    const original = {
      id: "ord-old",
      customerId: "cust-1",
      lineItems: [
        { productId: "prod-1", qty: 864, boxes: 3, unitLabel: "Case", status: "PENDING" },
      ],
    };
    jest.spyOn(service as any, "findReplayCandidateByKey").mockResolvedValue(original);
    const withKey = (items: unknown[]) =>
      service.create({ customerId: "cust-1", items, idempotencyKey: "k1" } as never, staff);
    await expect(withKey([{ productId: "prod-1", qty: 3, unitLabel: "Case" }])).resolves.toBe(
      original,
    );
    await expect(withKey([{ productId: "prod-1", qty: 3, unitLabel: "Pallet" }])).rejects.toThrow(
      /different cart/,
    );
    await expect(withKey([{ productId: "prod-1", qty: 4, unitLabel: "Case" }])).rejects.toThrow(
      /different cart/,
    );
    expect(prisma.order.create).not.toHaveBeenCalled();
  });
});
