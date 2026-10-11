import { Test } from "@nestjs/testing";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { BadRequestException } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { TenantsService } from "../tenants/tenants.service";
import { RESEND_LIMITER } from "../tenants/resend-verification-limit";
import { UsersService } from "../users/users.service";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { EncryptionService } from "../common/encryption.service";
import { StorageService } from "../storage/storage.service";
import { createMockPrisma } from "../testing/prisma-mock";

const JWT_CONFIG = {
  secret: "test-jwt-secret-0123456789-abcdefghijklmnop",
  refreshSecret: "test-refresh-secret",
  expiresIn: "15m",
  refreshExpiresIn: "7d",
};

const base = {
  id: "user-1",
  email: "owner@acme.example",
  username: "acme_admin",
  password: "hashed",
  role: "TENANT_ADMIN",
  status: "INACTIVE",
  forcePasswordChange: false,
  tenantId: "tenant-1",
  deletedAt: null as Date | null,
  lastLoginAt: null as Date | null,
  createdAt: new Date("2026-10-01T00:00:00Z"),
  tenant: { id: "tenant-1", name: "Acme", slug: "acme" },
};

/** One row per refused class. */
const REFUSED: Array<[string, Record<string, unknown>, number]> = [
  ["already active", { status: "ACTIVE" }, 0],
  ["signed in before", { lastLoginAt: new Date("2026-10-02T00:00:00Z") }, 0],
  ["holding a session row", {}, 1],
  ["created before the cut-off", { createdAt: new Date("2026-09-28T23:59:59Z") }, 0],
  ["operator role", { role: "OPERATOR" }, 0],
  ["driver role", { role: "DRIVER" }, 0],
];

describe("verification link lifecycle", () => {
  let auth: AuthService;
  let tenants: TenantsService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let jwt: { sign: jest.Mock; verify: jest.Mock; decode: jest.Mock };
  let email: { send: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();
    jwt = {
      sign: jest.fn().mockReturnValue("mock-token"),
      verify: jest.fn().mockReturnValue({ sub: "user-1", type: "email_verify", tenantId: "t" }),
      decode: jest.fn().mockReturnValue({ exp: Math.floor(Date.now() / 1000) + 3600 }),
    };
    email = { send: jest.fn().mockResolvedValue({ delivered: true, transport: "resend" }) };
    (prisma.user.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    (prisma.tenant.findUnique as jest.Mock).mockResolvedValue({ slug: "acme" });
    (prisma.refreshToken.count as jest.Mock).mockResolvedValue(0);
    (prisma.refreshToken.upsert as jest.Mock).mockResolvedValue({});
    const mod = await Test.createTestingModule({
      providers: [
        AuthService,
        TenantsService,
        { provide: PrismaService, useValue: prisma },
        { provide: UsersService, useValue: {} },
        { provide: JwtService, useValue: jwt },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((k: string) =>
              k === "jwt"
                ? JWT_CONFIG
                : k === "jwt.secret"
                  ? "test-jwt-secret-0123456789-abcdefghijklmnop"
                  : "https://app.test",
            ),
          },
        },
        { provide: EmailService, useValue: email },
        {
          provide: EntitlementsService,
          useValue: { claimsFor: jest.fn().mockResolvedValue(null) },
        },
        { provide: EncryptionService, useValue: {} },
        { provide: StorageService, useValue: {} },
        // The resend is rate limited per address; a counter that never refuses.
        {
          provide: RESEND_LIMITER,
          useValue: {
            increment: jest.fn().mockResolvedValue({
              totalHits: 1,
              timeToExpire: 1,
              isBlocked: false,
              timeToBlockExpire: 0,
            }),
          },
        },
      ],
    }).compile();
    auth = mod.get(AuthService);
    tenants = mod.get(TenantsService);
  });

  const statusWrites = () =>
    [
      ...(prisma.user.update as jest.Mock).mock.calls,
      ...(prisma.user.updateMany as jest.Mock).mock.calls,
    ].filter((c) => "status" in c[0].data);

  it("verifies a signup admin who never signed in, once: active and a session", async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(base);
    const res: any = await auth.verifyEmailAndLogin("t");
    expect(res).toHaveProperty("accessToken");
    expect(statusWrites()).toHaveLength(1);
    expect(statusWrites()[0][0].data).toEqual({ status: "ACTIVE" });
  });

  it("the activation is conditional on a live signup admin who never signed in", async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(base);
    await auth.verifyEmailAndLogin("t");
    expect(statusWrites()[0][0].where).toEqual({
      id: "user-1",
      status: "INACTIVE",
      lastLoginAt: null,
      role: "TENANT_ADMIN",
      deletedAt: null,
    });
  });

  it("writes an audit row for the activation, actor is the user", async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(base);
    await auth.verifyEmailAndLogin("t");
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "user-1",
        tenantId: "tenant-1",
        entityType: "User",
        entityId: "user-1",
        meta: { reason: "email_verify" },
      }),
    });
  });

  it("activation and its audit record commit together", async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(base);
    (prisma.auditLog.create as jest.Mock).mockRejectedValue(new Error("audit write failed"));
    await expect(auth.verifyEmailAndLogin("t")).rejects.toThrow("audit write failed");
    // Both writes ran inside one transaction, so the failed audit write rolls the activation back.
    expect(prisma.tenantTransaction).toHaveBeenCalledTimes(1);
    expect(prisma.refreshToken.upsert).not.toHaveBeenCalled();
    expect(jwt.sign).not.toHaveBeenCalled();
  });

  it("refuses the same link when used again", async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      ...base,
      status: "ACTIVE",
      lastLoginAt: new Date(),
    });
    await expect(auth.verifyEmailAndLogin("t")).rejects.toBeInstanceOf(BadRequestException);
  });

  it("refuses when a concurrent use already claimed the activation", async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(base);
    (prisma.user.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
    await expect(auth.verifyEmailAndLogin("t")).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  describe.each(REFUSED)("%s", (_name, patch, sessions) => {
    beforeEach(() => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue({ ...base, ...patch });
      (prisma.user.findFirst as jest.Mock).mockResolvedValue({ ...base, ...patch });
      (prisma.refreshToken.count as jest.Mock).mockResolvedValue(sessions);
    });

    it("link is refused with a coded 400 and no session or status change", async () => {
      const err: any = await auth.verifyEmailAndLogin("t").catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toEqual(
        expect.objectContaining({
          code: "ALREADY_VERIFIED",
          message: "Already verified — please sign in",
        }),
      );
      expect(statusWrites()).toHaveLength(0);
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
      expect(prisma.refreshToken.upsert).not.toHaveBeenCalled();
    });

    it("resend sends nothing", async () => {
      const sent = await tenants.performResend("owner@acme.example");
      expect(sent).toBe(false);
      expect(email.send).not.toHaveBeenCalled();
      expect(jwt.sign).not.toHaveBeenCalled();
    });
  });

  it("resend still sends for a signup admin who never signed in", async () => {
    (prisma.user.findFirst as jest.Mock).mockResolvedValue(base);
    expect(await tenants.performResend("owner@acme.example")).toBe(true);
    expect(email.send).toHaveBeenCalledTimes(1);
  });
});
