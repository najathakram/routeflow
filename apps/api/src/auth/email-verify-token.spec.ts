import * as crypto from "crypto";
import { Test } from "@nestjs/testing";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { AuthService } from "./auth.service";
import { TenantsService } from "../tenants/tenants.service";
import { UsersService } from "../users/users.service";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { EncryptionService } from "../common/encryption.service";
import { StorageService } from "../storage/storage.service";
import { createMockPrisma } from "../testing/prisma-mock";

const SECRET = "email-verify-token-test-secret-0123456789";
const JWT_CONFIG = {
  secret: SECRET,
  refreshSecret: "email-verify-refresh-secret-0123456789",
  expiresIn: "15m",
  refreshExpiresIn: "7d",
};

// Independent oracle for the per-purpose key (HKDF-SHA256, empty salt, label as info).
const verifyKey = Buffer.from(
  crypto.hkdfSync("sha256", SECRET, Buffer.alloc(0), "email-verify-v1", 32),
);

const user = {
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
/** A clock inside the window in which a signed (legacy) verification link is still accepted. */
const IN_WINDOW = new Date("2026-10-12T00:00:00.000Z");
const claims = { sub: "user-1", tenantId: "tenant-1", type: "email_verify" };

describe("email-verify token keys and audience", () => {
  const jwt = new JwtService({ secret: SECRET });
  let auth: AuthService;
  let tenants: TenantsService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let email: { send: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();
    email = { send: jest.fn().mockResolvedValue({ delivered: true, transport: "resend" }) };
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(user);
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
              k === "jwt" ? JWT_CONFIG : k === "jwt.secret" ? SECRET : "https://app.test",
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
      ],
    }).compile();
    auth = mod.get(AuthService);
    tenants = mod.get(TenantsService);
  });

  const verify = (token: string) => auth.verifyEmailAndLogin(token, undefined, IN_WINDOW);
  const refused = (token: string) => expect(verify(token)).rejects.toMatchObject({ status: 400 });

  it("accepts a token signed with the derived key and the email-verify audience", async () => {
    const token = jwt.sign(claims, {
      secret: verifyKey,
      audience: "email-verify",
      expiresIn: "24h",
    });
    await expect(verify(token)).resolves.toHaveProperty("accessToken");
  });

  it("the signup service no longer mints a signed link: it emails a stored token in the fragment", async () => {
    (prisma.user.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.tenant.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.tenant.create as jest.Mock).mockImplementation(({ data }: any) => ({
      id: "t1",
      ...data,
    }));
    (prisma.user.create as jest.Mock).mockImplementation(({ data }: any) => ({
      ...user,
      id: "user-1",
      ...data,
    }));
    (prisma as any).tenantSubscription = { create: jest.fn().mockResolvedValue({}) };
    (prisma.$transaction as jest.Mock).mockImplementation((fn: any) =>
      fn({ ...prisma, tenantSubscription: (prisma as any).tenantSubscription }),
    );
    (prisma.userEmailVerificationToken.create as jest.Mock).mockResolvedValue({ id: "evt-1" });
    const sign = jest.spyOn(jwt, "sign");
    await tenants.register({
      slug: "acme-distribution",
      businessName: "Acme Distribution",
      adminEmail: "owner@acme.example",
      adminUsername: "acme_admin",
      adminPassword: "Sup3rSecret!",
    });
    const html: string = email.send.mock.calls[0][0].html;
    const token = html.match(/verify-email#t=([\w-]+)/)![1]!;
    expect(html).not.toContain("?token=");
    expect(token).toHaveLength(43); // 32 random bytes, base64url
    expect(token.split(".")).toHaveLength(1);
    // only the SHA-256 is stored, never the emailed token itself
    const stored = (prisma.userEmailVerificationToken.create as jest.Mock).mock.calls[0][0].data;
    expect(stored.tokenHash).toBe(crypto.createHash("sha256").update(token).digest("hex"));
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(stored.userId).toBe("user-1");
    expect(sign).not.toHaveBeenCalled();
  });

  it("refuses a raw-secret token that carries the email-verify audience", async () => {
    await refused(jwt.sign(claims, { audience: "email-verify", expiresIn: "24h" }));
  });

  it("refuses a derived-key token with the wrong audience", async () => {
    await refused(
      jwt.sign(claims, { secret: verifyKey, audience: "staff-access", expiresIn: "24h" }),
    );
  });

  it("refuses a derived-key token with no audience", async () => {
    await refused(jwt.sign(claims, { secret: verifyKey, expiresIn: "24h" }));
  });

  it("refuses a derived-key token whose type is not email_verify", async () => {
    await refused(
      jwt.sign({ ...claims, type: "other" }, { secret: verifyKey, audience: "email-verify" }),
    );
  });

  it("still accepts a legacy raw-secret email_verify link (24h fallback)", async () => {
    await expect(verify(jwt.sign(claims, { expiresIn: "24h" }))).resolves.toHaveProperty(
      "accessToken",
    );
  });

  it("refuses a legacy raw-secret link for an already-ACTIVE user (eligibility still runs)", async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({ ...user, status: "ACTIVE" });
    await expect(verify(jwt.sign(claims, { expiresIn: "24h" }))).rejects.toMatchObject({
      status: 400,
    });
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });

  it("refuses a legacy-shaped raw-secret token whose type is not email_verify", async () => {
    await refused(jwt.sign({ ...claims, type: "other" }, { expiresIn: "24h" }));
  });

  it("refuses an expired derived-key token", async () => {
    await refused(
      jwt.sign(claims, { secret: verifyKey, audience: "email-verify", expiresIn: "-1s" }),
    );
  });
});
