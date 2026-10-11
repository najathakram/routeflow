/**
 * The admin responses that echo a whole customer link never carry an invite token column, and the
 * admin writes that change a link's standing null both columns so no earlier invite stays live.
 */
import { Test } from "@nestjs/testing";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { BuyerAdminService } from "./buyer-admin.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";

const HASH = "a".repeat(64);
const PLAIN = "b".repeat(64);
const linkRow = (patch: Record<string, unknown> = {}) => ({
  id: "l1",
  status: "INVITED",
  buyerAccountId: "b1",
  customerId: "c1",
  tenantId: "t1",
  inviteToken: PLAIN,
  inviteTokenHash: HASH,
  inviteExpiresAt: null,
  ...patch,
});

describe("BuyerAdminService: invite secrets and link writes", () => {
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

  const noSecrets = (value: unknown) => {
    const json = JSON.stringify(value);
    expect(json).not.toContain(HASH);
    expect(json).not.toContain(PLAIN);
    expect(json).not.toMatch(/inviteToken/);
  };

  it("getBuyer strips both token columns from every link", async () => {
    prisma.buyerAccount.findUnique.mockResolvedValue({
      id: "b1",
      email: "a@acme.example",
      customerLinks: [linkRow(), linkRow({ id: "l2" })],
    } as any);

    const res: any = await service.getBuyer("b1");

    expect(res.customerLinks).toHaveLength(2);
    expect(res.customerLinks[0]).toMatchObject({ id: "l1", status: "INVITED" });
    noSecrets(res);
  });

  it("listLinks strips both token columns from every row and keeps the paging meta", async () => {
    prisma.customerLink.findMany.mockResolvedValue([linkRow(), linkRow({ id: "l2" })] as any);
    prisma.customerLink.count.mockResolvedValue(2);

    const res: any = await service.listLinks({ page: 1, limit: 20 });

    expect(res.data.map((l: any) => l.id)).toEqual(["l1", "l2"]);
    expect(res.meta).toEqual({ total: 2, page: 1, limit: 20, totalPages: 1 });
    noSecrets(res);
  });

  describe("addBuyerLink", () => {
    beforeEach(() => {
      prisma.buyerAccount.findUnique.mockResolvedValue({ id: "b1" } as any);
      prisma.tenant.findUnique.mockResolvedValue({ id: "t1" } as any);
      prisma.customer.findFirst.mockResolvedValue({ id: "c1", tenantId: "t1" } as any);
    });

    it("a reassignment nulls both token columns and does not echo them", async () => {
      prisma.customerLink.findUnique.mockResolvedValue(
        linkRow({ buyerAccountId: "b2", status: "INVITED" }) as any,
      );
      prisma.customerLink.update.mockResolvedValue(linkRow({ status: "ACTIVE" }) as any);

      const res = await service.addBuyerLink("b1", { tenantId: "t1", customerId: "c1" });

      const data = (prisma.customerLink.update as jest.Mock).mock.calls[0][0].data;
      expect(data).toMatchObject({ status: "ACTIVE", inviteToken: null, inviteTokenHash: null });
      noSecrets(res);
    });

    it("a fresh link does not echo token columns", async () => {
      prisma.customerLink.findUnique.mockResolvedValue(null);
      prisma.customerLink.create.mockResolvedValue(linkRow({ status: "ACTIVE" }) as any);

      const res = await service.addBuyerLink("b1", { tenantId: "t1", customerId: "c1" });

      noSecrets(res);
    });
  });

  it("removeLink nulls both token columns with the status change", async () => {
    prisma.customerLink.findUnique.mockResolvedValue(linkRow() as any);
    prisma.customerLink.update.mockResolvedValue({} as any);

    await service.removeLink("l1");

    const data = (prisma.customerLink.update as jest.Mock).mock.calls[0][0].data;
    expect(data).toMatchObject({
      status: "DISCONNECTED",
      buyerAccountId: null,
      inviteToken: null,
      inviteTokenHash: null,
    });
  });
});
