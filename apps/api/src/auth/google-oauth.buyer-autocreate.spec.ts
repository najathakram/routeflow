import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { GoogleOAuthService } from "./google-oauth.service";
import { createMockPrisma } from "../testing/prisma-mock";

jest.mock("google-auth-library", () => ({
  OAuth2Client: jest.fn(),
}));

/**
 * Buyer auto-creation via Google sign-in must mark the account passwordSet=false
 * so /buyer/auth/set-password can later distinguish the random placeholder hash
 * from a real password. Also pins hasPassword riding the auth result.
 */
describe("GoogleOAuthService — buyer auto-create passwordSet", () => {
  function buildService(prisma: ReturnType<typeof createMockPrisma>) {
    const config = {
      get: (key: string) => {
        if (key === "jwt")
          return {
            secret: "s",
            refreshSecret: "rs",
            expiresIn: "15m",
            refreshExpiresIn: "30d",
          };
        return undefined;
      },
    } as unknown as ConfigService;
    const jwt = {
      sign: jest.fn().mockReturnValue("tok"),
      decode: jest.fn().mockReturnValue({ exp: Math.floor(Date.now() / 1000) + 3600 }),
    } as unknown as JwtService;
    return new GoogleOAuthService(
      prisma as any,
      jwt,
      config,
      { send: jest.fn().mockResolvedValue(undefined) } as any, // email
      { claimsFor: jest.fn().mockResolvedValue(null) } as any, // entitlements
    );
  }

  const profile = {
    type: "tenant" as const,
    context: "buyer-standalone" as const,
    googleId: "google-1",
    email: "new-buyer@example.com",
    name: "New Buyer",
  };

  it("creates the account with passwordSet=false and returns hasPassword=false", async () => {
    const prisma = createMockPrisma();
    prisma.buyerAccount.findFirst.mockResolvedValue(null); // no existing account
    prisma.buyerAccount.create.mockImplementation(({ data }: any) =>
      Promise.resolve({ id: "buyer-new", ...data }),
    );
    prisma.customerLink.count.mockResolvedValue(0);
    prisma.buyerRefreshToken.upsert.mockResolvedValue({} as any);

    const service = buildService(prisma);
    const result: any = await service.findOrCreateUser(profile as any);

    expect(prisma.buyerAccount.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        email: "new-buyer@example.com",
        passwordSet: false,
        googleId: "google-1",
      }),
    });
    expect(result.kind).toBe("buyer");
    expect(result.buyer).toMatchObject({ hasPassword: false });
  });

  it("an existing buyer keeps their passwordSet value (no downgrade on Google link)", async () => {
    const prisma = createMockPrisma();
    prisma.buyerAccount.findFirst.mockResolvedValue({
      id: "buyer-1",
      email: "existing@example.com",
      name: "Existing",
      googleId: null,
      passwordSet: true,
      status: "ACTIVE",
      deletedAt: null,
    } as any);
    prisma.buyerAccount.update.mockResolvedValue({} as any);
    prisma.customerLink.count.mockResolvedValue(1);
    prisma.buyerRefreshToken.upsert.mockResolvedValue({} as any);

    const service = buildService(prisma);
    const result: any = await service.findOrCreateUser(profile as any);

    // googleId gets linked, but passwordHash/passwordSet are untouched
    expect(prisma.buyerAccount.update).toHaveBeenCalledWith({
      where: { id: "buyer-1" },
      data: { googleId: "google-1" },
    });
    expect(result.buyer).toMatchObject({ hasPassword: true });
  });
});
