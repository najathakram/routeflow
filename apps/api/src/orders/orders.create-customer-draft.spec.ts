import {
  buildOrdersService,
  customerPayload,
  operatorPayload,
} from "./testing/orders-service-harness";

/**
 * F1(ii): a CUSTOMER cannot create a DRAFT order. A draft is the staff working copy that skips the
 * selling-restrictions check until promotion; a buyer-authored draft would be judged at the promoter's
 * channel only. The refusal lives in `create()` itself, so no caller (controller, buyer module, a future
 * internal caller) can bypass it. The internal not-on-truck draft (change-request approval) is the one
 * explicit, option-gated exception.
 */
describe("OrdersService.create: a customer cannot create a DRAFT (F1 ii)", () => {
  let h: Awaited<ReturnType<typeof buildOrdersService>>;
  const buyer = { ...customerPayload, tenantId: "t-1" } as never;
  const buyerPseudo = { ...customerPayload, type: "BUYER", tenantId: "t-1" } as never;
  const operator = { ...operatorPayload, tenantId: "t-1" } as never;
  const input = (status: "DRAFT" | "PENDING", over: Record<string, unknown> = {}) =>
    ({ status, customerId: "cust-1", items: [{ productId: "prod-1", qty: 1 }], ...over }) as never;

  beforeEach(async () => {
    h = await buildOrdersService();
    h.prisma.customer.findFirst.mockResolvedValue({ id: "cust-1", pricingTier: 1 });
    h.prisma.customer.findUnique.mockResolvedValue({
      id: "cust-1",
      pricingTier: 1,
      user: { status: "ACTIVE" },
      deletedAt: null,
    });
    h.prisma.product.findMany.mockResolvedValue([
      {
        id: "prod-1",
        name: "Widget",
        pricePerUnit: 10,
        unitsPerBox: null,
        category: null,
        trackedCategoryId: null,
        trackedSubcategoryId: null,
        isActive: true,
        kind: "STANDARD",
        portalVisible: true,
        parent: null,
      },
    ]);
    h.prisma.order.create.mockResolvedValue({
      id: "ord-new",
      customerId: "cust-1",
      orderNumber: "x",
      total: 10,
      urgent: false,
      createdAt: new Date(),
      customer: { id: "cust-1", businessName: "Acme" },
      lineItems: [],
    });
    (h.prisma.tenantTransaction as jest.Mock).mockImplementation((fn: any) =>
      fn({
        ...h.prisma,
        $queryRaw: jest.fn().mockResolvedValue([{ max: null }]),
        $executeRaw: jest.fn().mockResolvedValue(0),
      }),
    );
  });

  it("a CUSTOMER DRAFT create is a coded 400 and writes nothing", async () => {
    for (const user of [buyer, buyerPseudo]) {
      await expect(h.service.create(input("DRAFT"), user)).rejects.toMatchObject({
        status: 400,
        response: { code: "ORDER_DRAFT_STAFF_ONLY" },
      });
    }
    expect(h.prisma.order.create).not.toHaveBeenCalled();
    expect(h.prisma.tenantTransaction).not.toHaveBeenCalled();
  });

  it("the refusal is not reachable around by an option other than the internal flag", async () => {
    await expect(
      h.service.create(input("DRAFT"), buyer, { skipAutoMerge: true, allowArchived: true }),
    ).rejects.toMatchObject({ response: { code: "ORDER_DRAFT_STAFF_ONLY" } });
  });

  it("control: a staff DRAFT create still works", async () => {
    await expect(h.service.create(input("DRAFT"), operator)).resolves.toBeDefined();
    expect(h.prisma.order.create).toHaveBeenCalledTimes(1);
  });

  it("control: a CUSTOMER PENDING create still works", async () => {
    await expect(h.service.create(input("PENDING"), buyer)).resolves.toBeDefined();
    expect(h.prisma.order.create).toHaveBeenCalledTimes(1);
  });

  it("the internal not-on-truck draft (change-request approval) is the one flagged exception", async () => {
    await expect(
      h.service.create(input("DRAFT"), buyerPseudo, { internalCustomerDraft: true }),
    ).resolves.toBeDefined();
  });
});
