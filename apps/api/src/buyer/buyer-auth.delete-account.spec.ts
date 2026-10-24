import { Test, TestingModule } from "@nestjs/testing";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { BuyerAuthService } from "./buyer-auth.service";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { AppleOAuthService } from "../auth/apple-oauth.service";
import { createMockPrisma } from "../testing/prisma-mock";

/**
 * #2309 (SA-418 §4/5.1.1(v)): deleteAccount() must clear appleId AND googleId on the
 * soft-deleted row (so the stable sub can sign up again later) and call Apple's
 * /auth/revoke — mocked at the module boundary here — with a revoke failure never
 * blocking the deletion itself.
 */
describe("BuyerAuthService.deleteAccount — Apple revoke (#2309, SA-418)", () => {
  let service: BuyerAuthService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let appleOAuth: { revokeForBuyer: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();
    appleOAuth = { revokeForBuyer: jest.fn().mockResolvedValue(undefined) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BuyerAuthService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: JwtService,
          useValue: { sign: jest.fn(), decode: jest.fn(), verify: jest.fn() },
        },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: EmailService, useValue: { send: jest.fn().mockResolvedValue(undefined) } },
        { provide: AppleOAuthService, useValue: appleOAuth },
      ],
    }).compile();
    service = module.get(BuyerAuthService);
  });

  it("clears appleId and googleId on the soft-deleted row and calls revoke", async () => {
    await service.deleteAccount("buyer-1");

    expect(appleOAuth.revokeForBuyer).toHaveBeenCalledWith("buyer-1");
    expect(prisma.buyerAccount.update).toHaveBeenCalledWith({
      where: { id: "buyer-1" },
      data: expect.objectContaining({
        status: "DELETED",
        appleId: null,
        appleRefreshTokenEnc: null,
        googleId: null,
      }),
    });
  });

  it("still deletes when revoke throws", async () => {
    appleOAuth.revokeForBuyer.mockRejectedValue(new Error("Apple is down"));

    await expect(service.deleteAccount("buyer-1")).resolves.toEqual(
      expect.objectContaining({ message: expect.any(String) }),
    );
    expect(prisma.buyerAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "buyer-1" } }),
    );
  });
});
