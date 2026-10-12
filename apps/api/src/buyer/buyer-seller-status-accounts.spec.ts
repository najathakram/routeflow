import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { ForbiddenException, Logger, NotFoundException } from "@nestjs/common";
import { BuyerService } from "./buyer.service";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { createMockPrisma } from "../testing/prisma-mock";

/**
 * SA-776 GAP-2: the buyer's account-level routes (accept an invite, request a seller) follow the seller's workspace
 * status through the SAME rule the seller-scoped routes use (buyer/seller-status-gate.ts). A refusal writes
 * nothing (the invite token stays on the row). Leaving a seller (DELETE sellers/:sellerSlug) is not gated.
 */
describe("buyer account-level link writes follow the seller's workspace status", () => {
  const saved = process.env.SELLER_READ_ONLY_BUYER_GATE;
  let prisma: ReturnType<typeof createMockPrisma>;
  let service: BuyerService;
  let warn: jest.SpyInstance;

  beforeEach(async () => {
    delete process.env.SELLER_READ_ONLY_BUYER_GATE;
    warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    prisma = createMockPrisma();
    prisma.tenantConfig.findFirst.mockResolvedValue({ businessName: "Acme Foods" } as any);
    prisma.user.findMany.mockResolvedValue([{ email: "ops@acme-foods.example" }] as any);
    const mod = await Test.createTestingModule({
      providers: [
        BuyerService,
        { provide: PrismaService, useValue: prisma },
        { provide: EmailService, useValue: { send: jest.fn().mockResolvedValue({}) } },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        {
          provide: RouteFlowGateway,
          useValue: { emitBuyerAutoLinked: jest.fn(), emitBuyerConnectRequest: jest.fn() },
        },
      ],
    }).compile();
    service = mod.get(BuyerService);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if (saved === undefined) delete process.env.SELLER_READ_ONLY_BUYER_GATE;
    else process.env.SELLER_READ_ONLY_BUYER_GATE = saved;
  });

  const wouldDeny = () =>
    warn.mock.calls.map((c: any[]) => String(c[0])).filter((l: string) => /would_deny/.test(l));

  describe("POST invites/:token/accept (acceptInvite)", () => {
    const setup = (sellerStatus: string) => {
      prisma.customerLink.findUnique.mockResolvedValue({
        id: "link-1",
        tenantId: "tn-1",
        status: "INVITED",
        inviteToken: "tok",
        inviteExpiresAt: null,
        tenant: { name: "Acme Foods", slug: "acme-foods", status: sellerStatus },
      } as any);
      prisma.customerLink.findFirst.mockResolvedValue(null);
      prisma.customerLink.update.mockResolvedValue({ id: "link-1" } as any);
    };

    it.each(["SUSPENDED", "CANCELLED"])(
      "%s seller: 403 SELLER_UNAVAILABLE and no link write (the invite stays)",
      async (status) => {
        setup(status);
        const err: any = await service.acceptInvite("tok", "buyer-1").catch((e) => e);
        expect(err).toBeInstanceOf(ForbiddenException);
        expect(err.getResponse()).toMatchObject({ code: "SELLER_UNAVAILABLE" });
        expect(prisma.customerLink.update).not.toHaveBeenCalled();
      },
    );

    it("READ_ONLY seller + gate enforced: 403 SELLER_UNAVAILABLE and no link write", async () => {
      process.env.SELLER_READ_ONLY_BUYER_GATE = "enforced";
      setup("READ_ONLY");
      const err: any = await service.acceptInvite("tok", "buyer-1").catch((e) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(err.getResponse()).toMatchObject({ code: "SELLER_UNAVAILABLE" });
      expect(prisma.customerLink.update).not.toHaveBeenCalled();
    });

    it("READ_ONLY seller + gate dark (default): accepted, and one would-deny line is logged", async () => {
      setup("READ_ONLY");
      await expect(service.acceptInvite("tok", "buyer-1")).resolves.toMatchObject({
        tenantSlug: "acme-foods",
      });
      expect(prisma.customerLink.update).toHaveBeenCalledTimes(1);
      expect(wouldDeny()).toHaveLength(1);
      expect(wouldDeny()[0]).toContain("seller=tn-1");
    });

    it.each(["ACTIVE", "TRIAL"])("%s seller: accepted as before", async (status) => {
      process.env.SELLER_READ_ONLY_BUYER_GATE = "enforced";
      setup(status);
      await service.acceptInvite("tok", "buyer-1");
      expect(prisma.customerLink.update).toHaveBeenCalledTimes(1);
      expect(wouldDeny()).toHaveLength(0);
    });
  });

  describe("POST sellers/request (requestSeller)", () => {
    const setup = (sellerStatus: string) => {
      prisma.buyerAccount.findUnique.mockResolvedValue({
        email: "buyer@example.com",
        name: "Buyer",
        emailVerified: true,
      } as any);
      prisma.tenant.findUnique.mockResolvedValue({
        id: "tn-1",
        slug: "acme-foods",
        name: "Acme Foods",
        status: sellerStatus,
      } as any);
      prisma.customer.findFirst.mockResolvedValue({
        id: "cust-1",
        businessName: "Retail Corner",
        email: "buyer@example.com",
        user: null,
      } as any);
      prisma.customerLink.findFirst.mockResolvedValue(null);
      prisma.customerLink.upsert.mockResolvedValue({ id: "link-1" } as any);
    };
    const dto = { sellerSlug: "acme-foods", emailAtSeller: "buyer@example.com" };

    it.each(["SUSPENDED", "CANCELLED"])("%s seller: refused and no link write", async (status) => {
      setup(status);
      await expect(service.requestSeller("buyer-1", dto)).rejects.toThrow(NotFoundException);
      expect(prisma.customerLink.upsert).not.toHaveBeenCalled();
      expect(prisma.customerLink.update).not.toHaveBeenCalled();
    });

    it("READ_ONLY seller + gate enforced: 403 SELLER_UNAVAILABLE and no link write", async () => {
      process.env.SELLER_READ_ONLY_BUYER_GATE = "enforced";
      setup("READ_ONLY");
      const err: any = await service.requestSeller("buyer-1", dto).catch((e) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(err.getResponse()).toMatchObject({ code: "SELLER_UNAVAILABLE" });
      expect(prisma.customerLink.upsert).not.toHaveBeenCalled();
      expect(prisma.customerLink.update).not.toHaveBeenCalled();
    });

    it("READ_ONLY seller + gate dark (default): proceeds, and one would-deny line is logged", async () => {
      setup("READ_ONLY");
      await expect(service.requestSeller("buyer-1", dto)).resolves.toMatchObject({
        linkId: "link-1",
      });
      expect(prisma.customerLink.upsert).toHaveBeenCalledTimes(1);
      expect(wouldDeny()).toHaveLength(1);
    });

    it.each(["ACTIVE", "TRIAL"])("%s seller: proceeds as before", async (status) => {
      process.env.SELLER_READ_ONLY_BUYER_GATE = "enforced";
      setup(status);
      await expect(service.requestSeller("buyer-1", dto)).resolves.toMatchObject({
        linkId: "link-1",
      });
      expect(wouldDeny()).toHaveLength(0);
    });
  });

  describe("DELETE sellers/:sellerSlug (disconnectSelf) stays allowed whatever the seller's state", () => {
    it.each(["READ_ONLY", "SUSPENDED", "CANCELLED"])(
      "%s seller: the link is removed",
      async (s) => {
        process.env.SELLER_READ_ONLY_BUYER_GATE = "enforced";
        prisma.tenant.findUnique.mockResolvedValue({ id: "tn-1", slug: "acme", status: s } as any);
        prisma.customerLink.findFirst.mockResolvedValue({ id: "link-1", status: "ACTIVE" } as any);
        prisma.customerLink.update.mockResolvedValue({} as any);
        await service.disconnectSelf("buyer-1", "acme");
        expect(prisma.customerLink.update).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { id: "link-1" },
            data: expect.objectContaining({ status: "DISCONNECTED" }),
          }),
        );
      },
    );
  });
});
