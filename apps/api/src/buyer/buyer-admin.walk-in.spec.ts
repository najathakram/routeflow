/**
 * The tenant's walk-in customer is a counter-sales row, never a buyer's account: the admin link picker does
 * not list it and addBuyerLink refuses it with WALK_IN_PROTECTED before any write.
 */
import { BadRequestException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { BuyerAdminService } from "./buyer-admin.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";

describe("BuyerAdminService: the walk-in customer is never linked", () => {
  let service: BuyerAdminService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const mod = await Test.createTestingModule({
      providers: [
        BuyerAdminService,
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: { sign: jest.fn().mockReturnValue("tok") } },
        { provide: ConfigService, useValue: { get: () => ({ secret: "s" }) } },
      ],
    }).compile();
    service = mod.get(BuyerAdminService);
  });

  it("addBuyerLink refuses the walk-in customer and writes no link", async () => {
    prisma.buyerAccount.findUnique.mockResolvedValue({ id: "b1" } as any);
    prisma.tenant.findUnique.mockResolvedValue({ id: "t1", name: "Acme" } as any);
    prisma.customer.findFirst.mockResolvedValue({
      id: "c1",
      tenantId: "t1",
      isWalkIn: true,
    } as any);
    prisma.customerLink.findUnique.mockResolvedValue(null);

    const e: any = await service.addBuyerLink("b1", { tenantId: "t1", customerId: "c1" }).then(
      () => null,
      (err) => err,
    );

    expect(e).toBeInstanceOf(BadRequestException);
    expect(e.getResponse()).toMatchObject({ code: "WALK_IN_PROTECTED" });
    expect(prisma.customerLink.create).not.toHaveBeenCalled();
    expect(prisma.customerLink.update).not.toHaveBeenCalled();
  });

  it("addBuyerLink still links an ordinary customer", async () => {
    prisma.buyerAccount.findUnique.mockResolvedValue({ id: "b1" } as any);
    prisma.tenant.findUnique.mockResolvedValue({ id: "t1", name: "Acme" } as any);
    prisma.customer.findFirst.mockResolvedValue({
      id: "c1",
      tenantId: "t1",
      isWalkIn: null,
    } as any);
    prisma.customerLink.findUnique.mockResolvedValue(null);
    prisma.customerLink.create.mockResolvedValue({ id: "l1" } as any);

    await service.addBuyerLink("b1", { tenantId: "t1", customerId: "c1" });

    expect(prisma.customerLink.create).toHaveBeenCalledTimes(1);
  });

  it("the link picker's query leaves the walk-in customer out", async () => {
    prisma.tenant.findUnique.mockResolvedValue({ id: "t1", name: "Acme" } as any);
    const rows = [
      { id: "c1", businessName: "Counter Sales", isWalkIn: true },
      { id: "c2", businessName: "Shop", isWalkIn: null },
    ];
    // The query honours the exclusion the way the database would.
    prisma.customer.findMany.mockImplementation((async (args: any) =>
      JSON.stringify(args?.where ?? {}).includes("isWalkIn")
        ? rows.filter((r) => r.isWalkIn !== true)
        : rows) as any);

    const res = await service.getTenantCustomers("t1");

    expect(res.customers.map((c: any) => c.id)).toEqual(["c2"]);
  });
});
