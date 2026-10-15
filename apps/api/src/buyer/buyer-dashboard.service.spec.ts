import { noRestrictionsProvider } from "../selling-restrictions/testing/no-restrictions-provider";
import { Test } from "@nestjs/testing";
import { BuyerDashboardService } from "./buyer-dashboard.service";
import { RegulatedVisibilityService } from "./regulated-visibility.service";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { createMockPrisma } from "../testing/prisma-mock";

describe("BuyerDashboardService — W7 gate", () => {
  let service: BuyerDashboardService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let visibility: { computeGate: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();
    (prisma.orderItem as any).groupBy = jest.fn().mockResolvedValue([]);
    visibility = { computeGate: jest.fn() };
    const mod = await Test.createTestingModule({
      providers: [
        BuyerDashboardService,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: { presignedUrl: jest.fn() } },
        { provide: RegulatedVisibilityService, useValue: visibility },
        noRestrictionsProvider,
      ],
    }).compile();
    service = mod.get(BuyerDashboardService);
    prisma.customer.findUnique.mockResolvedValue({ pricingTier: 1 });
  });

  it("excludes hidden regulated categories from the product surfaces", async () => {
    visibility.computeGate.mockResolvedValue({ hiddenIds: new Set(["cat-alc"]), locked: [] });
    await service.getDashboard("c1");
    const productCalls = prisma.product.findMany.mock.calls;
    expect(productCalls.length).toBeGreaterThanOrEqual(2); // new + featured
    for (const [args] of productCalls) {
      // the category-name lookup (select:category, no product display) is exempt
      if (args?.select?.category) continue;
      // NULL-SAFE gate shape: the bare `{ notIn }` this used to pin excludes
      // NULL rows in Prisma, hiding every untracked product from the rails.
      expect(args.where.trackedCategoryId).toBeUndefined();
      // the gate now rides inside the shared builder's AND (buyerVisibleProductWhere(NO_BUYER_RESTRICTIONS, extra))
      const gateClause = (args.where.AND as any[]).find((c) =>
        c.OR?.some((o: any) => "trackedCategoryId" in o),
      );
      expect(gateClause.OR).toEqual([
        { trackedCategoryId: null },
        { trackedCategoryId: { notIn: ["cat-alc"] } },
      ]);
    }
  });

  it("applies no exclusion on the fast path (nothing hidden)", async () => {
    visibility.computeGate.mockResolvedValue({ hiddenIds: new Set(), locked: [] });
    await service.getDashboard("c1");
    for (const [args] of prisma.product.findMany.mock.calls) {
      expect(args?.where?.trackedCategoryId).toBeUndefined();
    }
  });

  // SA-770 r-note: the strip follows the staff rule - open AND a balance due; it sums BALANCE, never gross.
  describe("unpaid strip (SA-770: balance due, in the invoice's own tenant zone)", () => {
    const pay = (amount: number, status = "PAID") => ({ amount, status, method: "CASH" });
    const row = (total: number, payments: any[], dueDate: string, status = "SENT") => ({
      status,
      total,
      dueDate: new Date(dueDate),
      payments,
    });
    const stats = async (rows: any[]) => {
      visibility.computeGate.mockResolvedValue({ hiddenIds: new Set(), locked: [] });
      prisma.invoice.findMany.mockResolvedValue(rows);
      return (await service.getDashboard("c1")).stats;
    };

    it("sums BALANCE: $100 with $60 paid shows $40, not $100", async () => {
      const st = await stats([row(100, [pay(60)], "2099-01-01", "PARTIAL")]);
      expect(st.unpaidInvoiceCount).toBe(1);
      expect(st.unpaidInvoiceTotal).toBe(40);
    });

    it("an overpaid open invoice past due is not unpaid: count 0 and $0 (before: 1 and the gross)", async () => {
      const st = await stats([row(100, [pay(110)], "2020-01-01")]);
      expect(st.unpaidInvoiceCount).toBe(0);
      expect(st.unpaidInvoiceTotal).toBe(0);
    });

    it("a mix: only what is still owed counts, in cents", async () => {
      const st = await stats([
        row(100, [pay(100)], "2020-01-01"),
        row(0.1, [], "2099-01-01"),
        row(0.2, [], "2020-01-01", "OVERDUE"),
        row(80, [pay(30, "DRAFT")], "2099-01-01"),
      ]);
      expect(st.unpaidInvoiceCount).toBe(3);
      expect(st.unpaidInvoiceTotal).toBe(80.3);
    });

    it("reads only the buyer's own OPEN invoices, with the payments that net the balance", async () => {
      await stats([]);
      expect(prisma.invoice.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            customerId: "c1",
            status: { in: ["SENT", "VIEWED", "PARTIAL", "OVERDUE"] },
          }),
          // dropping `status`/`method` from the payments select would silently show gross
          select: {
            status: true,
            total: true,
            dueDate: true,
            payments: {
              where: { status: "PAID" },
              select: { amount: true, status: true, method: true },
            },
          },
        }),
      );
    });

    it("defaults to 0 when there are no open invoices", async () => {
      const st = await stats([]);
      expect(st.unpaidInvoiceCount).toBe(0);
      expect(st.unpaidInvoiceTotal).toBe(0);
    });
  });

  it("1B: recent orders carry fulfillPath + shippedAt so the badge matches the order detail", async () => {
    visibility.computeGate.mockResolvedValue({ hiddenIds: new Set(), locked: [] });
    // The recent-orders read is the only order.findMany with a `select` + take 5.
    prisma.order.findMany.mockResolvedValue([
      {
        id: "o1",
        orderNumber: "ORD-00001",
        status: "CONFIRMED",
        total: 20,
        createdAt: new Date("2026-09-10T12:00:00Z"),
        requestedDeliveryDate: null,
        fulfillPath: "SHIP",
        shippedAt: new Date("2026-10-01T10:00:00Z"),
        lineItems: [{ id: "li-1" }],
      },
    ]);

    const res = await service.getDashboard("c1");

    const recentCall = prisma.order.findMany.mock.calls.find(([a]: any[]) => a?.take === 5)?.[0];
    expect(recentCall.select).toMatchObject({ fulfillPath: true, shippedAt: true });
    expect(res.recentOrders[0]).toMatchObject({
      fulfillPath: "SHIP",
      shippedAt: new Date("2026-10-01T10:00:00Z"),
    });
  });
});
