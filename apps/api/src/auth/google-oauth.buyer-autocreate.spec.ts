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
    const emailService = { send: jest.fn().mockResolvedValue(undefined) };
    const service = new GoogleOAuthService(
      prisma as any,
      jwt,
      config,
      emailService as any, // email
      { claimsFor: jest.fn().mockResolvedValue(null) } as any, // entitlements
    );
    return { service, emailService };
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

    const { service } = buildService(prisma);
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
    // #2495 LOW: the link write is now a CAS (updateMany scoped to googleId:null)
    // and the service merges `data` onto the row it already read rather than
    // reading back a fresh row — count:1 means this request won the race.
    prisma.buyerAccount.updateMany.mockResolvedValue({ count: 1 } as any);
    prisma.customerLink.count.mockResolvedValue(1);
    prisma.buyerRefreshToken.upsert.mockResolvedValue({} as any);

    const { service, emailService } = buildService(prisma);
    const result: any = await service.findOrCreateUser(profile as any);

    // googleId gets linked, but passwordHash/passwordSet are untouched — and
    // emailVerified is NOT set: Google attested new-buyer@example.com, not this
    // account's own (different) email.
    expect(prisma.buyerAccount.updateMany).toHaveBeenCalledWith({
      where: { id: "buyer-1", googleId: null },
      data: { googleId: "google-1" },
    });
    expect(result.buyer).toMatchObject({ hasPassword: true });
    // B421 pinning: the first-link "Google Sign-In linked" notice is platform-sent.
    expect(emailService.send).toHaveBeenCalledWith(
      expect.objectContaining({ senderClass: "platform" }),
    );
  });

  // ── Google attests the mailbox → satisfies the registration verification gate ──

  it("auto-link with a MATCHING email also flips emailVerified (Google attested the mailbox)", async () => {
    const prisma = createMockPrisma();
    prisma.buyerAccount.findFirst.mockResolvedValue({
      id: "buyer-1",
      email: "new-buyer@example.com", // same mailbox Google just authenticated
      name: "Existing",
      googleId: null,
      passwordSet: true,
      emailVerified: false,
      status: "ACTIVE",
      deletedAt: null,
    } as any);
    // SECURITY: an unproven password (passwordSet && !emailVerified) is a squat —
    // Google verifying the mailbox now must neutralize the credential, not just flip
    // emailVerified. #2495 LOW: the link write is now a CAS (updateMany).
    prisma.buyerAccount.updateMany.mockResolvedValue({ count: 1 } as any);
    prisma.buyerRefreshToken.deleteMany.mockResolvedValue({ count: 0 } as any);
    prisma.customerLink.count.mockResolvedValue(1);
    prisma.buyerRefreshToken.upsert.mockResolvedValue({} as any);

    const { service } = buildService(prisma);
    await service.findOrCreateUser(profile as any);

    expect(prisma.buyerAccount.updateMany).toHaveBeenCalledWith({
      where: { id: "buyer-1", googleId: null },
      data: expect.objectContaining({
        googleId: "google-1",
        emailVerified: true,
        passwordSet: false,
        passwordHash: expect.any(String),
      }),
    });
    expect(prisma.buyerRefreshToken.deleteMany).toHaveBeenCalledWith({
      where: { buyerAccountId: "buyer-1" },
    });
  });

  it("an already-linked unverified account gets verified on a matching Google sign-in", async () => {
    const prisma = createMockPrisma();
    prisma.buyerAccount.findFirst.mockResolvedValue({
      id: "buyer-1",
      email: "new-buyer@example.com",
      name: "Existing",
      googleId: "google-1", // linked before the verification gate existed
      passwordSet: true,
      emailVerified: false,
      status: "ACTIVE",
      deletedAt: null,
    } as any);
    // SECURITY: same squat exposure as the first-link path — the already-linked
    // account still carries an unproven password.
    prisma.buyerAccount.update.mockResolvedValue({
      id: "buyer-1",
      email: "new-buyer@example.com",
      name: "Existing",
      passwordSet: false,
      emailVerified: true,
      googleId: "google-1",
      status: "ACTIVE",
    } as any);
    prisma.buyerRefreshToken.deleteMany.mockResolvedValue({ count: 0 } as any);
    prisma.customerLink.count.mockResolvedValue(1);
    prisma.buyerRefreshToken.upsert.mockResolvedValue({} as any);

    const { service } = buildService(prisma);
    await service.findOrCreateUser(profile as any);

    expect(prisma.buyerAccount.update).toHaveBeenCalledWith({
      where: { id: "buyer-1" },
      data: expect.objectContaining({
        emailVerified: true,
        passwordSet: false,
        passwordHash: expect.any(String),
      }),
    });
    expect(prisma.buyerRefreshToken.deleteMany).toHaveBeenCalledWith({
      where: { buyerAccountId: "buyer-1" },
    });
  });

  it("an already-linked VERIFIED account triggers no account write at all", async () => {
    const prisma = createMockPrisma();
    prisma.buyerAccount.findFirst.mockResolvedValue({
      id: "buyer-1",
      email: "new-buyer@example.com",
      name: "Existing",
      googleId: "google-1",
      passwordSet: true,
      emailVerified: true,
      status: "ACTIVE",
      deletedAt: null,
    } as any);
    prisma.customerLink.count.mockResolvedValue(1);
    prisma.buyerRefreshToken.upsert.mockResolvedValue({} as any);

    const { service } = buildService(prisma);
    await service.findOrCreateUser(profile as any);

    expect(prisma.buyerAccount.update).not.toHaveBeenCalled();
    expect(prisma.buyerRefreshToken.deleteMany).not.toHaveBeenCalled();
  });

  it("a Google merge into an unverified password account revokes credentials", async () => {
    const prisma = createMockPrisma();
    const priorHash = "$2b$10$prior.squatted.hash.that.must.not.survive";
    prisma.buyerAccount.findFirst.mockResolvedValue({
      id: "buyer-1",
      email: "victim@corp.com",
      name: "Victim",
      googleId: null,
      passwordSet: true,
      passwordHash: priorHash,
      emailVerified: false,
      status: "ACTIVE",
      deletedAt: null,
    } as any);
    // #2495 LOW: the link write is now a CAS (updateMany scoped to googleId:null).
    prisma.buyerAccount.updateMany.mockResolvedValue({ count: 1 } as any);
    prisma.buyerRefreshToken.deleteMany.mockResolvedValue({ count: 2 } as any);
    prisma.customerLink.count.mockResolvedValue(0);
    prisma.buyerRefreshToken.upsert.mockResolvedValue({} as any);

    const victimProfile = { ...profile, email: "victim@corp.com" };
    const { service } = buildService(prisma);
    await service.findOrCreateUser(victimProfile as any);

    expect(prisma.buyerAccount.updateMany).toHaveBeenCalledWith({
      where: { id: "buyer-1", googleId: null },
      data: expect.objectContaining({
        googleId: "google-1",
        emailVerified: true,
        passwordSet: false,
        passwordHash: expect.any(String),
      }),
    });
    const call = prisma.buyerAccount.updateMany.mock.calls[0][0];
    expect(call.data.passwordHash).not.toBe(priorHash);
    expect(prisma.buyerRefreshToken.deleteMany).toHaveBeenCalledWith({
      where: { buyerAccountId: "buyer-1" },
    });
  });

  // ── B964-1: the provider-supplied name is NEUTRALISED, never a reason to refuse a sign-in ──

  describe("a formula-led Google display name (B964-1)", () => {
    const create = async (name: string | undefined, email = "new-buyer@example.com") => {
      const prisma = createMockPrisma();
      prisma.buyerAccount.findFirst.mockResolvedValue(null);
      prisma.buyerAccount.create.mockImplementation(({ data }: any) =>
        Promise.resolve({ id: "buyer-new", ...data }),
      );
      prisma.customerLink.count.mockResolvedValue(0);
      prisma.buyerRefreshToken.upsert.mockResolvedValue({} as any);
      const { service } = buildService(prisma);
      const result: any = await service.findOrCreateUser({ ...profile, name, email } as any);
      return { prisma, result };
    };

    it("still creates the account and signs in, with the email local-part as the display name", async () => {
      const { prisma, result } = await create("=HYPERLINK(1)", "pat.lee@example.com");
      expect(result.kind).toBe("buyer");
      expect(prisma.buyerAccount.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ name: "pat.lee" }),
      });
    });

    it("if the email local-part is itself formula-led, the display name is 'Customer'", async () => {
      const { prisma } = await create("+x", "=evil@example.com");
      expect(prisma.buyerAccount.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ name: "Customer" }),
      });
    });

    it("a normal name is kept as it was", async () => {
      const { prisma } = await create("Pat Lee");
      expect(prisma.buyerAccount.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ name: "Pat Lee" }),
      });
    });
  });
});
