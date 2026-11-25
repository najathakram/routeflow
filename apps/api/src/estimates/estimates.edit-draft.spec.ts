/**
 * The owner's three estimate gaps (2026-11-19): a typed price on a quote line, editing a draft, and bringing a sent or
 * accepted quote back to draft. Harness: estimates.units-prices-v2.spec.ts.
 */
import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { EstimatesService } from "./estimates.service";
import { PrismaService } from "../prisma/prisma.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { NumberingService } from "../import/numbering.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { NO_PRICE_RIGHTS } from "../common/testing/no-rights-actor";
import { ESTIMATE_MOVES } from "@routeflow/types";

let rights = true;
jest.mock("../auth/permissions/price-edit", () => ({
  priceEditAllowedFor: jest.fn(async () => rights),
}));

const WIDGET = { id: "p1", name: "Widget", pricePerUnit: 10, unitsPerBox: null, kind: "STANDARD" };

describe("Estimates: typed prices, draft edit, back to draft", () => {
  let service: EstimatesService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    rights = true;
    prisma = createMockPrisma();
    const mod = await Test.createTestingModule({
      providers: [
        EstimatesService,
        { provide: SellingRestrictionsService, useValue: { assertLinesSellable: jest.fn() } },
        { provide: PrismaService, useValue: prisma },
        { provide: EntitlementAuthority, useValue: { can: jest.fn().mockResolvedValue(false) } },
        {
          provide: EntitlementsService,
          useValue: {
            hasFlag: jest.fn(async () => false),
            hasFlagStrict: jest.fn(async () => false),
          },
        },
        {
          provide: NumberingService,
          useValue: { reserveNext: jest.fn().mockResolvedValue("EST-1") },
        },
        { provide: RegulatedLedgerService, useValue: {} },
      ],
    }).compile();
    service = mod.get(EstimatesService);
    prisma.customer.findUnique.mockResolvedValue({ id: "cust-1", pricingTier: 1 });
    // assertRefsInTenant: every asked customer id is in the tenant.
    prisma.customer.findMany.mockImplementation(async (args: any) =>
      (args?.where?.id?.in ?? []).map((id: string) => ({ id })),
    );
    prisma.estimate.create.mockResolvedValue({ id: "est-1" });
    prisma.product.findMany.mockResolvedValue([WIDGET]);
  });

  const createLine = async (unitPrice?: number) => {
    await service.create(
      {
        customerId: "cust-1",
        items: [{ productId: "p1", qty: 2, ...(unitPrice != null ? { unitPrice } : {}) }],
      } as never,
      NO_PRICE_RIGHTS,
    );
    return prisma.estimate.create.mock.calls[0][0].data;
  };

  describe("create: a typed price", () => {
    it("above list is quoted at the typed price (MANUAL), not dropped back to list", async () => {
      const data = await createLine(12.5);
      expect(data.items.create[0]).toMatchObject({
        unitPrice: 12.5,
        priceType: "MANUAL",
        originalPrice: 10,
        subtotal: 25,
      });
      expect(data.subtotal).toBe(25);
    });

    it("under list is DISCOUNTED at the typed price", async () => {
      const data = await createLine(8);
      expect(data.items.create[0]).toMatchObject({
        unitPrice: 8,
        priceType: "DISCOUNTED",
        originalPrice: 10,
      });
    });

    it("equal to the customer's price is no override (STANDARD) and asks no rights", async () => {
      rights = false;
      const data = await createLine(10);
      expect(data.items.create[0]).toMatchObject({ unitPrice: 10, priceType: "STANDARD" });
    });

    it("off the customer's price without price rights is refused (403), above list too", async () => {
      rights = false;
      await expect(createLine(12.5)).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.estimate.create).not.toHaveBeenCalled();
    });

    it("a custom line with no price is a 400, never a NaN write", async () => {
      await expect(
        service.create(
          { customerId: "cust-1", items: [{ description: "Delivery", qty: 1 }] } as never,
          NO_PRICE_RIGHTS,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("update(): edit a draft", () => {
    const heldDraft = (over: Record<string, unknown> = {}) => ({
      id: "est-1",
      status: "DRAFT",
      customerId: "cust-1",
      discount: 0,
      createdAt: new Date("2026-11-19T00:00:00Z"),
      items: [
        {
          id: "line-1",
          productId: "p1",
          description: "Widget",
          qty: 2,
          unitPrice: 8,
          priceType: "DISCOUNTED",
          boxes: null,
          pieces: null,
        },
      ],
      ...over,
    });

    beforeEach(() => {
      prisma.estimate.findUnique.mockResolvedValue(heldDraft());
      prisma.estimate.updateMany.mockResolvedValue({ count: 1 });
    });

    it("re-prices the sent lines, claims the DRAFT and replaces the lines", async () => {
      await service.update(
        "est-1",
        { items: [{ id: "line-1", productId: "p1", qty: 3, unitPrice: 9 }], notes: "  Net 30  " },
        NO_PRICE_RIGHTS,
      );
      const claim = prisma.estimate.updateMany.mock.calls[0][0];
      expect(claim.where).toEqual({ id: "est-1", status: { in: [...ESTIMATE_MOVES.edit] } });
      expect(claim.data).toMatchObject({ subtotal: 27, total: 27, notes: "Net 30" });
      expect(prisma.estimateItem.deleteMany).toHaveBeenCalledWith({
        where: { estimateId: "est-1" },
      });
      const written = prisma.estimateItem.createMany.mock.calls[0][0].data;
      expect(written).toHaveLength(1);
      expect(written[0]).toMatchObject({
        estimateId: "est-1",
        qty: 3,
        unitPrice: 9,
        priceType: "DISCOUNTED",
        subtotal: 27,
      });
    });

    it("a held typed price re-sent unchanged needs no price rights", async () => {
      rights = false;
      await service.update(
        "est-1",
        { items: [{ id: "line-1", productId: "p1", qty: 5, unitPrice: 8 }] },
        NO_PRICE_RIGHTS,
      );
      expect(prisma.estimateItem.createMany.mock.calls[0][0].data[0]).toMatchObject({
        unitPrice: 8,
        qty: 5,
      });
    });

    it("a changed price without price rights is refused before any write", async () => {
      rights = false;
      await expect(
        service.update(
          "est-1",
          { items: [{ id: "line-1", productId: "p1", qty: 2, unitPrice: 7 }] },
          NO_PRICE_RIGHTS,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.estimate.updateMany).not.toHaveBeenCalled();
    });

    it("no items: the held lines are kept (typed price kept) and the customer can change", async () => {
      await service.update("est-1", { customerId: "cust-2" }, NO_PRICE_RIGHTS);
      expect(prisma.estimate.updateMany.mock.calls[0][0].data).toMatchObject({
        customerId: "cust-2",
        subtotal: 16,
      });
      expect(prisma.estimateItem.createMany.mock.calls[0][0].data[0]).toMatchObject({
        unitPrice: 8,
        qty: 2,
      });
    });

    // #4386 read A M1: a held price is judged against its customer. A new customer makes every held typed price a new
    // price for them, so it is authoring again and needs price rights.
    it("a customer change without price rights is refused when a held line carries a typed price", async () => {
      rights = false;
      await expect(
        service.update("est-1", { customerId: "cust-2" }, NO_PRICE_RIGHTS),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.estimate.updateMany).not.toHaveBeenCalled();
      expect(prisma.estimateItem.createMany).not.toHaveBeenCalled();
    });

    it("the same customer sent back is no change: the held typed price needs no rights", async () => {
      rights = false;
      await service.update("est-1", { customerId: "cust-1", notes: "x" }, NO_PRICE_RIGHTS);
      expect(prisma.estimateItem.createMany.mock.calls[0][0].data[0]).toMatchObject({
        unitPrice: 8,
        priceType: "DISCOUNTED",
      });
    });

    it("a new custom line without price rights is refused before any write", async () => {
      rights = false;
      await expect(
        service.update(
          "est-1",
          {
            items: [
              { id: "line-1", productId: "p1", qty: 2, unitPrice: 8 },
              { description: "Delivery", qty: 1, unitPrice: 15 },
            ],
          },
          NO_PRICE_RIGHTS,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.estimate.updateMany).not.toHaveBeenCalled();
    });

    it("a SENT estimate is refused: move it back to draft first", async () => {
      prisma.estimate.findUnique.mockResolvedValue(heldDraft({ status: "SENT" }));
      await expect(service.update("est-1", { notes: "x" }, NO_PRICE_RIGHTS)).rejects.toThrow(
        "Sent estimates cannot be edited. Move the estimate back to draft first.",
      );
      expect(prisma.estimate.updateMany).not.toHaveBeenCalled();
    });

    it("a draft sent between the read and the write loses the claim and writes no lines", async () => {
      prisma.estimate.updateMany.mockResolvedValue({ count: 0 });
      prisma.estimate.findFirst.mockResolvedValue({ status: "SENT" });
      await expect(service.update("est-1", { notes: "x" }, NO_PRICE_RIGHTS)).rejects.toThrow(
        "Sent estimates cannot be edited",
      );
      expect(prisma.estimateItem.deleteMany).not.toHaveBeenCalled();
      expect(prisma.estimateItem.createMany).not.toHaveBeenCalled();
    });

    it("WS8: a FAMILY product on an edited draft is refused before any write", async () => {
      prisma.product.findMany.mockResolvedValue([{ ...WIDGET, kind: "FAMILY" }]);
      await expect(
        service.update("est-1", { items: [{ productId: "p1", qty: 1 }] }, NO_PRICE_RIGHTS),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.estimate.updateMany).not.toHaveBeenCalled();
      expect(prisma.estimateItem.createMany).not.toHaveBeenCalled();
    });
  });

  describe("revertToDraft()", () => {
    it("claims DRAFT from SENT or ACCEPTED only, and counts the revision in the same claim", async () => {
      prisma.estimate.updateMany.mockResolvedValue({ count: 1 });
      prisma.estimate.findUnique.mockResolvedValue({ id: "est-1", status: "DRAFT", items: [] });
      await service.revertToDraft("est-1");
      expect(prisma.estimate.updateMany).toHaveBeenCalledWith({
        where: { id: "est-1", status: { in: ["SENT", "ACCEPTED"] } },
        data: { status: "DRAFT", revision: { increment: 1 } },
      });
    });

    it("a CONVERTED estimate stays converted (400 naming its status)", async () => {
      prisma.estimate.updateMany.mockResolvedValue({ count: 0 });
      prisma.estimate.findFirst.mockResolvedValue({ id: "est-1", status: "CONVERTED" });
      await expect(service.revertToDraft("est-1")).rejects.toThrow(
        "Converted estimates cannot be moved back to draft",
      );
    });

    it("a VOID estimate stays closed (VOID is absorbing)", async () => {
      prisma.estimate.updateMany.mockResolvedValue({ count: 0 });
      prisma.estimate.findFirst.mockResolvedValue({ id: "est-1", status: "VOID" });
      await expect(service.revertToDraft("est-1")).rejects.toThrow(
        "Void estimates cannot be moved back to draft",
      );
    });

    it("a DECLINED estimate stays closed (a void is stored as DECLINED until A2)", async () => {
      prisma.estimate.updateMany.mockResolvedValue({ count: 0 });
      prisma.estimate.findFirst.mockResolvedValue({ id: "est-1", status: "DECLINED" });
      await expect(service.revertToDraft("est-1")).rejects.toThrow(
        "Declined estimates cannot be moved back to draft",
      );
    });
  });
});
