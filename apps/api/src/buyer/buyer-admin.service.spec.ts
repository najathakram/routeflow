import { Test, TestingModule } from "@nestjs/testing";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { ConflictException } from "@nestjs/common";
import { BuyerAdminService } from "./buyer-admin.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";

/**
 * F2 (buyer-connect auth hardening): a super-admin email change must not leave
 * verification tokens mailed to the OLD address redeemable, nor leave existing
 * sessions alive on the account's new identity. `updateBuyer` wraps the update
 * in a transaction that also revokes both when — and only when — the email
 * actually changes.
 */

const EXISTING_BUYER = {
  id: "b1",
  email: "old@x.com",
  name: "Old Name",
  phone: null,
  mobile: null,
  status: "ACTIVE" as const,
  emailVerified: true,
};

describe("BuyerAdminService.updateBuyer", () => {
  let service: BuyerAdminService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BuyerAdminService,
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: { sign: jest.fn().mockReturnValue("tok") } },
        { provide: ConfigService, useValue: { get: () => ({ secret: "s" }) } },
      ],
    }).compile();

    service = module.get(BuyerAdminService);
  });

  it("email change: deletes stale verification tokens and refresh tokens in the same transaction", async () => {
    prisma.buyerAccount.findUnique
      .mockResolvedValueOnce(EXISTING_BUYER as any) // load the account
      .mockResolvedValueOnce(null); // conflict check: no other account holds the new email

    await service.updateBuyer("b1", { email: "new@x.com" });

    expect(prisma.buyerAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "b1" },
        data: expect.objectContaining({ email: "new@x.com", emailVerified: false }),
      }),
    );
    expect(prisma.buyerEmailVerificationToken.deleteMany).toHaveBeenCalledWith({
      where: { buyerAccountId: "b1" },
    });
    expect(prisma.buyerRefreshToken.deleteMany).toHaveBeenCalledWith({
      where: { buyerAccountId: "b1" },
    });
  });

  it("no email change: touches neither token model", async () => {
    prisma.buyerAccount.findUnique.mockResolvedValueOnce(EXISTING_BUYER as any);

    await service.updateBuyer("b1", { name: "New Name" });

    expect(prisma.buyerAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "b1" },
        data: expect.objectContaining({ name: "New Name" }),
      }),
    );
    expect(prisma.buyerEmailVerificationToken.deleteMany).not.toHaveBeenCalled();
    expect(prisma.buyerRefreshToken.deleteMany).not.toHaveBeenCalled();
  });

  it("unchanged email echoed back by the admin UI: does not de-verify the account", async () => {
    prisma.buyerAccount.findUnique.mockResolvedValueOnce(EXISTING_BUYER as any);

    // The platform-admin buyer editor prefills the email input from the loaded buyer, so a
    // phone-only save still carries the current address.
    await service.updateBuyer("b1", { email: "old@x.com", phone: "555-0100" });

    // Exact `data` (not objectContaining): proves neither `email` nor `emailVerified` is written.
    expect(prisma.buyerAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "b1" }, data: { phone: "555-0100" } }),
    );
    expect(prisma.buyerEmailVerificationToken.deleteMany).not.toHaveBeenCalled();
    expect(prisma.buyerRefreshToken.deleteMany).not.toHaveBeenCalled();
  });

  it("email conflict: rejects before any write or token revocation", async () => {
    prisma.buyerAccount.findUnique
      .mockResolvedValueOnce(EXISTING_BUYER as any) // load the account
      .mockResolvedValueOnce({ id: "other", email: "new@x.com" } as any); // conflict

    await expect(service.updateBuyer("b1", { email: "new@x.com" })).rejects.toThrow(
      ConflictException,
    );

    expect(prisma.buyerAccount.update).not.toHaveBeenCalled();
    expect(prisma.buyerEmailVerificationToken.deleteMany).not.toHaveBeenCalled();
    expect(prisma.buyerRefreshToken.deleteMany).not.toHaveBeenCalled();
  });
});

/**
 * Account links die with the account's standing: setBuyerStatus (any non-ACTIVE status) and an
 * email change burn the buyer's outstanding reset + verification links in the SAME transaction as
 * the write (`common/revoke-user-link-tokens.ts`); reactivation burns nothing.
 */
describe("BuyerAdminService — link revocation on standing changes", () => {
  let service: BuyerAdminService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let tx: any;

  const burned = () =>
    tx.$executeRaw.mock.calls.map(([strings, id]: any[]) => ({
      table: /UPDATE "(\w+)"/.exec(strings.join(""))![1],
      id,
    }));

  beforeEach(async () => {
    prisma = createMockPrisma();
    tx = { ...prisma, $executeRaw: jest.fn().mockResolvedValue(1) };
    // every buyer write must go through the tx client: the plain client rejects
    prisma.buyerAccount.update.mockRejectedValue(new Error("write outside the transaction"));
    tx.buyerAccount = { ...prisma.buyerAccount, update: jest.fn().mockResolvedValue({ id: "b1" }) };
    prisma.$transaction.mockImplementation((fn: any) => fn(tx));
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BuyerAdminService,
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: { sign: jest.fn().mockReturnValue("tok") } },
        { provide: ConfigService, useValue: { get: () => ({ secret: "s" }) } },
      ],
    }).compile();
    service = module.get(BuyerAdminService);
  });

  describe("setBuyerStatus", () => {
    it.each(["SUSPENDED", "DELETED"] as const)(
      "to %s: writes the status and burns both buyer link kinds in the same transaction",
      async (status) => {
        prisma.buyerAccount.findUnique.mockResolvedValue(EXISTING_BUYER as any);

        await service.setBuyerStatus("b1", status);

        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
        expect(tx.buyerAccount.update).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { id: "b1" },
            data: expect.objectContaining({ status }),
          }),
        );
        expect(burned()).toEqual([
          { table: "BuyerPasswordResetToken", id: "b1" },
          { table: "BuyerEmailVerificationToken", id: "b1" },
        ]);
      },
    );

    it("SUSPENDED -> SUSPENDED still burns the links", async () => {
      prisma.buyerAccount.findUnique.mockResolvedValue({
        ...EXISTING_BUYER,
        status: "SUSPENDED",
      } as any);

      await service.setBuyerStatus("b1", "SUSPENDED");

      expect(burned()).toHaveLength(2);
    });

    it("reactivation (to ACTIVE) writes the status and burns nothing", async () => {
      prisma.buyerAccount.findUnique.mockResolvedValue({
        ...EXISTING_BUYER,
        status: "SUSPENDED",
      } as any);

      await service.setBuyerStatus("b1", "ACTIVE");

      expect(tx.buyerAccount.update).toHaveBeenCalledTimes(1);
      expect(burned()).toEqual([]);
    });

    it("a failed burn fails the status change", async () => {
      prisma.buyerAccount.findUnique.mockResolvedValue(EXISTING_BUYER as any);
      tx.$executeRaw.mockRejectedValue(new Error("db down"));

      await expect(service.setBuyerStatus("b1", "SUSPENDED")).rejects.toThrow("db down");
    });
  });

  describe("updateBuyer", () => {
    it("an email change burns both buyer link kinds inside the same transaction", async () => {
      prisma.buyerAccount.findUnique
        .mockResolvedValueOnce(EXISTING_BUYER as any)
        .mockResolvedValueOnce(null);

      await service.updateBuyer("b1", { email: "new@x.com" });

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(tx.buyerAccount.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ email: "new@x.com" }) }),
      );
      expect(burned()).toEqual([
        { table: "BuyerPasswordResetToken", id: "b1" },
        { table: "BuyerEmailVerificationToken", id: "b1" },
      ]);
    });

    it("an edit that does not change the email burns nothing", async () => {
      prisma.buyerAccount.findUnique.mockResolvedValueOnce(EXISTING_BUYER as any);

      await service.updateBuyer("b1", { name: "New Name" });

      expect(burned()).toEqual([]);
    });
  });
});
