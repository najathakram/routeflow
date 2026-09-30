import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { ConflictException, ForbiddenException, Logger } from "@nestjs/common";
import { GoogleOAuthService } from "./google-oauth.service";

/**
 * SA-598 P1 / #2495 for Google (#2775): the staff, platform, buyer and link-account paths resolve
 * by googleId FIRST, then the ordered email match, and link by compare-and-set through the shared
 * oauth-account-link helper (the same one Apple uses).
 */
describe("GoogleOAuthService — SA-598 P1 sub-first resolve + CAS link (#2495 for Google)", () => {
  const TENANT = { id: "tenant-1", slug: "acme", status: "ACTIVE" };
  const STAFF = {
    id: "user-1",
    tenantId: "tenant-1",
    username: "op1",
    role: "OPERATOR",
    status: "ACTIVE",
    email: "op@acme.example",
    googleId: null as string | null,
    forcePasswordChange: false,
  };
  const BUYER = {
    id: "buyer-1",
    email: "b@example.com",
    name: "B",
    status: "ACTIVE",
    passwordSet: true,
    emailVerified: true,
    googleId: null as string | null,
  };

  function build() {
    const config = {
      get: (key: string) =>
        key === "jwt"
          ? {
              secret: "test-jwt-secret-for-oauth-state",
              refreshSecret: "r",
              expiresIn: "15m",
              refreshExpiresIn: "30d",
            }
          : undefined,
    } as unknown as ConfigService;
    const prisma = {
      tenant: { findFirst: jest.fn().mockResolvedValue(TENANT) },
      user: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn(),
      },
      buyerAccount: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        create: jest.fn(),
      },
      buyerRefreshToken: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      refreshToken: { upsert: jest.fn().mockResolvedValue({}) },
      customerLink: { count: jest.fn().mockResolvedValue(0) },
    } as any;
    const emailService = { send: jest.fn().mockResolvedValue({ delivered: true }) };
    const service = new GoogleOAuthService(
      prisma,
      {
        sign: jest.fn(() => "signed"),
        decode: jest.fn(() => ({ exp: Math.floor(Date.now() / 1000) + 3600 })),
      } as unknown as JwtService,
      config,
      emailService as any,
      { claimsFor: jest.fn().mockResolvedValue(null) } as any,
    );
    // buyer refresh-token issue path
    prisma.buyerRefreshToken.upsert = jest.fn().mockResolvedValue({});
    return { service, prisma, emailService };
  }

  const staffProfile = (over: Record<string, unknown> = {}) =>
    ({
      type: "tenant",
      googleId: "google-sub-1",
      email: STAFF.email,
      tenantSlug: "acme",
      ...over,
    }) as any;
  const buyerProfile = (over: Record<string, unknown> = {}) =>
    ({
      type: "tenant",
      context: "buyer-standalone",
      googleId: "google-sub-1",
      email: BUYER.email,
      name: "B",
      ...over,
    }) as any;

  describe("staff", () => {
    it("resolves by googleId FIRST: an email-sharing row is never queried or written", async () => {
      const { service, prisma } = build();
      prisma.user.findFirst.mockResolvedValueOnce({ ...STAFF, googleId: "google-sub-1" });

      await expect(service.findOrCreateUser(staffProfile())).resolves.toMatchObject({
        kind: "staff",
      });

      expect(prisma.user.findFirst).toHaveBeenCalledTimes(1);
      const where = prisma.user.findFirst.mock.calls[0][0].where;
      expect(where).toMatchObject({ tenantId: "tenant-1", googleId: "google-sub-1" });
      expect(where.OR).toBeUndefined();
      expect(prisma.user.updateMany).not.toHaveBeenCalled();
    });

    it("the email fallback is ordered createdAt,id, tenant-scoped, and links by CAS on id + googleId:null", async () => {
      const { service, prisma } = build();
      prisma.user.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ ...STAFF });
      prisma.user.updateMany.mockResolvedValue({ count: 1 });

      await service.findOrCreateUser(staffProfile());

      expect(prisma.user.findFirst.mock.calls[1][0]).toMatchObject({
        where: { tenantId: "tenant-1", deletedAt: null, email: STAFF.email },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      expect(prisma.user.updateMany).toHaveBeenCalledWith({
        where: { id: "user-1", googleId: null },
        data: { googleId: "google-sub-1", forcePasswordChange: false },
      });
    });

    it("an email row bound to a DIFFERENT googleId is a 409 google_account_mismatch with no write", async () => {
      const { service, prisma } = build();
      prisma.user.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ ...STAFF, googleId: "someone-else" });

      const err = await service.findOrCreateUser(staffProfile()).catch((e) => e);

      expect(err).toBeInstanceOf(ConflictException);
      expect(err.message).toBe("google_account_mismatch");
      expect(prisma.user.updateMany).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it("a CAS lost race to a DIFFERENT sub is a 409", async () => {
      const { service, prisma } = build();
      prisma.user.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ ...STAFF });
      prisma.user.updateMany.mockResolvedValue({ count: 0 });
      prisma.user.findUnique.mockResolvedValue({ ...STAFF, googleId: "attacker" });

      await expect(service.findOrCreateUser(staffProfile())).rejects.toThrow(
        new ConflictException("google_account_mismatch"),
      );
    });

    it("a CAS lost race to the SAME sub proceeds", async () => {
      const { service, prisma } = build();
      prisma.user.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ ...STAFF });
      prisma.user.updateMany.mockResolvedValue({ count: 0 });
      prisma.user.findUnique.mockResolvedValue({ ...STAFF, googleId: "google-sub-1" });

      await expect(service.findOrCreateUser(staffProfile())).resolves.toMatchObject({
        kind: "staff",
      });
    });

    it("a falsy sub or email is refused with ZERO prisma calls", async () => {
      for (const over of [{ googleId: "" }, { email: "" }]) {
        const { service, prisma } = build();
        await expect(service.findOrCreateUser(staffProfile(over))).rejects.toThrow(
          ForbiddenException,
        );
        expect(prisma.user.findFirst).not.toHaveBeenCalled();
        expect(prisma.buyerAccount.findFirst).not.toHaveBeenCalled();
        expect(prisma.user.updateMany).not.toHaveBeenCalled();
      }
    });

    it("an inactive staff row still refuses with unauthorized and no link write", async () => {
      const { service, prisma } = build();
      prisma.user.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ ...STAFF, status: "SUSPENDED" });
      await expect(service.findOrCreateUser(staffProfile())).rejects.toThrow(
        new ForbiddenException("unauthorized"),
      );
      expect(prisma.user.updateMany).not.toHaveBeenCalled();
    });
  });

  describe("platform", () => {
    const ADMIN = { ...STAFF, tenantId: null, role: "SUPER_ADMIN" };
    const platformProfile = (over: Record<string, unknown> = {}) =>
      ({ type: "platform", googleId: "google-sub-1", email: ADMIN.email, ...over }) as any;

    it("resolves by googleId first, then the ordered email match; different bound sub is a 409", async () => {
      const { service, prisma } = build();
      prisma.user.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ ...ADMIN, googleId: "someone-else" });

      await expect(service.findOrCreateUser(platformProfile())).rejects.toThrow(
        new ConflictException("google_account_mismatch"),
      );
      expect(prisma.user.findFirst.mock.calls[0][0].where).toMatchObject({
        tenantId: null,
        role: "SUPER_ADMIN",
        googleId: "google-sub-1",
      });
      expect(prisma.user.findFirst.mock.calls[1][0].orderBy).toEqual([
        { createdAt: "asc" },
        { id: "asc" },
      ]);
      expect(prisma.user.updateMany).not.toHaveBeenCalled();
    });

    it("links an unbound admin by CAS", async () => {
      const { service, prisma } = build();
      prisma.user.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ ...ADMIN });
      prisma.user.updateMany.mockResolvedValue({ count: 1 });

      await expect(service.findOrCreateUser(platformProfile())).resolves.toMatchObject({
        kind: "platform",
      });
      expect(prisma.user.updateMany).toHaveBeenCalledWith({
        where: { id: "user-1", googleId: null },
        data: { googleId: "google-sub-1", forcePasswordChange: false },
      });
    });
  });

  describe("buyer", () => {
    it("resolves by googleId FIRST: the email is never queried when the sub matches", async () => {
      const { service, prisma } = build();
      prisma.buyerAccount.findFirst.mockResolvedValueOnce({ ...BUYER, googleId: "google-sub-1" });

      await expect(service.findOrCreateUser(buyerProfile())).resolves.toMatchObject({
        kind: "buyer",
      });
      expect(prisma.buyerAccount.findFirst).toHaveBeenCalledTimes(1);
      const where = prisma.buyerAccount.findFirst.mock.calls[0][0].where;
      expect(where).toMatchObject({ deletedAt: null, googleId: "google-sub-1" });
      expect(where.OR).toBeUndefined();
    });

    it("the email fallback is ordered createdAt,id", async () => {
      const { service, prisma } = build();
      prisma.buyerAccount.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ ...BUYER });
      prisma.buyerAccount.updateMany.mockResolvedValue({ count: 1 });

      await service.findOrCreateUser(buyerProfile());

      expect(prisma.buyerAccount.findFirst.mock.calls[1][0]).toMatchObject({
        where: { deletedAt: null, email: BUYER.email },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
    });

    it("an email row bound to a DIFFERENT googleId is a 409 with no write, no create, no revoke", async () => {
      const { service, prisma, emailService } = build();
      prisma.buyerAccount.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ ...BUYER, googleId: "someone-else" });

      await expect(service.findOrCreateUser(buyerProfile())).rejects.toThrow(
        new ConflictException("google_account_mismatch"),
      );
      expect(prisma.buyerAccount.updateMany).not.toHaveBeenCalled();
      expect(prisma.buyerAccount.update).not.toHaveBeenCalled();
      expect(prisma.buyerAccount.create).not.toHaveBeenCalled();
      expect(prisma.buyerRefreshToken.deleteMany).not.toHaveBeenCalled();
      expect(emailService.send).not.toHaveBeenCalled();
    });

    it("a CAS lost race to a DIFFERENT sub is a 409: no revoke, no email", async () => {
      const { service, prisma, emailService } = build();
      prisma.buyerAccount.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ ...BUYER, emailVerified: false });
      prisma.buyerAccount.updateMany.mockResolvedValue({ count: 0 });
      prisma.buyerAccount.findUnique.mockResolvedValue({ ...BUYER, googleId: "attacker" });

      await expect(service.findOrCreateUser(buyerProfile())).rejects.toThrow(
        new ConflictException("google_account_mismatch"),
      );
      expect(prisma.buyerRefreshToken.deleteMany).not.toHaveBeenCalled();
      expect(emailService.send).not.toHaveBeenCalled();
    });

    it("a CAS lost race to the SAME sub proceeds WITHOUT revoking or emailing", async () => {
      const { service, prisma, emailService } = build();
      prisma.buyerAccount.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ ...BUYER, emailVerified: false });
      prisma.buyerAccount.updateMany.mockResolvedValue({ count: 0 });
      prisma.buyerAccount.findUnique.mockResolvedValue({
        ...BUYER,
        googleId: "google-sub-1",
        emailVerified: true,
      });

      await expect(service.findOrCreateUser(buyerProfile())).resolves.toMatchObject({
        kind: "buyer",
      });
      expect(prisma.buyerRefreshToken.deleteMany).not.toHaveBeenCalled();
      expect(emailService.send).not.toHaveBeenCalled();
    });

    it("when THIS request links, it emails (and revokes for a squatted password)", async () => {
      const { service, prisma, emailService } = build();
      prisma.buyerAccount.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ ...BUYER, emailVerified: false });
      prisma.buyerAccount.updateMany.mockResolvedValue({ count: 1 });

      await service.findOrCreateUser(buyerProfile());
      await Promise.resolve();

      expect(prisma.buyerAccount.updateMany).toHaveBeenCalledWith({
        where: { id: "buyer-1", googleId: null },
        data: expect.objectContaining({
          googleId: "google-sub-1",
          emailVerified: true,
          passwordSet: false,
        }),
      });
      expect(prisma.buyerRefreshToken.deleteMany).toHaveBeenCalledWith({
        where: { buyerAccountId: "buyer-1" },
      });
      expect(emailService.send).toHaveBeenCalledTimes(1);
    });

    it("a falsy sub or email is refused with ZERO prisma calls", async () => {
      for (const over of [{ googleId: "" }, { email: "" }]) {
        const { service, prisma } = build();
        await expect(service.findOrCreateUser(buyerProfile(over))).rejects.toThrow(
          ForbiddenException,
        );
        expect(prisma.buyerAccount.findFirst).not.toHaveBeenCalled();
        expect(prisma.buyerAccount.create).not.toHaveBeenCalled();
      }
    });
  });

  describe("no PII or credentials in logs (B906)", () => {
    const EMAIL = "newbuyer@example.com";
    const spies: jest.SpyInstance[] = [];

    function spyLogs() {
      const seen: string[] = [];
      for (const level of ["log", "warn", "error", "debug", "verbose", "fatal"] as const) {
        spies.push(
          jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
            seen.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
          }),
        );
      }
      return seen;
    }

    afterEach(() => {
      while (spies.length) spies.pop()!.mockRestore();
    });

    it("a buyer created via Google logs the account id, never the email or a credential", async () => {
      const seen = spyLogs();
      const { service, prisma } = build();
      prisma.buyerAccount.findFirst.mockResolvedValue(null);
      prisma.buyerAccount.create.mockResolvedValue({
        id: "buyer-new",
        email: EMAIL,
        status: "ACTIVE",
        passwordSet: false,
      });
      await service.findOrCreateUser(
        buyerProfile({
          email: EMAIL,
          googleId: "google-sub-pii",
          inviteToken: "invite-token-secret",
          nonce: "nonce-secret",
          idToken: "id-token-secret",
          code: "auth-code-secret",
        }),
      );

      const logs = seen.join("\n");
      expect(logs).toContain("buyer-new");
      for (const secret of [
        EMAIL,
        "invite-token-secret",
        "nonce-secret",
        "id-token-secret",
        "auth-code-secret",
      ])
        expect(logs).not.toContain(secret);
    });

    it("a staff account linked via Google logs the user id, never the email", async () => {
      const seen = spyLogs();
      const { service, prisma } = build();
      prisma.user.findUnique.mockResolvedValue({
        id: "user-1",
        tenantId: "tenant-1",
        deletedAt: null,
        googleId: null,
        email: "op@acme.example",
      });
      prisma.user.findFirst.mockResolvedValue(null);
      prisma.user.updateMany.mockResolvedValue({ count: 1 });
      await service.linkGoogleAccount({
        linkUserId: "user-1",
        googleId: "google-sub-pii",
        email: "op@acme.example",
      } as any);

      const logs = seen.join("\n");
      expect(logs).toContain("user-1");
      expect(logs).not.toContain("op@acme.example");
    });

    it("the spy is discriminating: it sees a log call that does carry an email", () => {
      const seen = spyLogs();
      new Logger("probe").log(`linked (${EMAIL})`);
      expect(seen.join("\n")).toContain(EMAIL);
    });
  });
});
