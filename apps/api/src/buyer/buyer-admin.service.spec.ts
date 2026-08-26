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
