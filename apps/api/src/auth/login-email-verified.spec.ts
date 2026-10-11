import { Test, TestingModule } from "@nestjs/testing";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { AuthService } from "./auth.service";
import { EmailService } from "../email/email.service";
import { UsersService } from "../users/users.service";
import { PrismaService } from "../prisma/prisma.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { createMockPrisma } from "../testing/prisma-mock";

/**
 * A sign-in stamps `emailVerifiedAt` when it is still null. The stamp is informational only: it
 * never gates recovery or an email change, and a failure of that write can never fail the login.
 */
const SECRET = "login-verified-spec-secret-0123456789-abcdef";

const row = (over: Record<string, unknown> = {}) => ({
  id: "user-1",
  username: "alice",
  email: "alice@acme.example",
  role: "OPERATOR",
  status: "ACTIVE",
  forcePasswordChange: false,
  isAdmin: false,
  canActAsDriver: false,
  tenantId: "tenant-1",
  ...over,
});

describe("AuthService.login — emailVerifiedAt stamp", () => {
  let service: AuthService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    (prisma.tenant.findUnique as jest.Mock).mockResolvedValue({ slug: "acme" });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: UsersService, useValue: {} },
        { provide: JwtService, useValue: new JwtService({ secret: SECRET }) },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) =>
              key === "jwt"
                ? {
                    secret: SECRET,
                    refreshSecret: "login-verified-refresh-secret-0123456789",
                    expiresIn: "15m",
                    refreshExpiresIn: "30d",
                  }
                : key === "jwt.secret"
                  ? SECRET
                  : undefined,
            ),
          },
        },
        { provide: EmailService, useValue: { send: jest.fn() } },
        {
          provide: EntitlementsService,
          useValue: { claimsFor: jest.fn().mockResolvedValue(null) },
        },
      ],
    }).compile();
    service = module.get(AuthService);
  });

  const stampCalls = () =>
    (prisma.user.updateMany as jest.Mock).mock.calls.filter(
      ([args]) => "emailVerifiedAt" in (args?.data ?? {}),
    );

  it("a login with a null emailVerifiedAt sets it, conditionally on it still being null", async () => {
    await service.login(row({ emailVerifiedAt: null }) as any);

    expect(stampCalls()).toHaveLength(1);
    expect(stampCalls()[0][0]).toEqual({
      where: { id: "user-1", emailVerifiedAt: null },
      data: { emailVerifiedAt: expect.any(Date) },
    });
  });

  it("a login for a row that does not say (no such field) also tries the conditional stamp", async () => {
    await service.login(row() as any);

    expect(stampCalls()).toHaveLength(1);
  });

  it("an already-stamped account costs no extra write", async () => {
    await service.login(row({ emailVerifiedAt: new Date("2026-10-01T00:00:00.000Z") }) as any);

    expect(stampCalls()).toHaveLength(0);
  });

  it("a failure of the stamp never fails the login", async () => {
    (prisma.user.updateMany as jest.Mock).mockRejectedValue(new Error("db hiccup"));
    const warn = jest.spyOn((service as any).logger, "warn").mockImplementation(() => undefined);

    const res = await service.login(row({ emailVerifiedAt: null }) as any);

    expect(res).toHaveProperty("accessToken");
    expect(res).toHaveProperty("refreshToken");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("emailVerifiedAt stamp failed"));
  });

  it("a failed lastLoginAt stamp does not stop the verified stamp, and neither fails the login", async () => {
    (prisma.user.update as jest.Mock).mockRejectedValue(new Error("db hiccup"));
    jest.spyOn((service as any).logger, "warn").mockImplementation(() => undefined);

    const res = await service.login(row({ emailVerifiedAt: null }) as any);

    expect(res).toHaveProperty("accessToken");
    expect(stampCalls()).toHaveLength(1);
  });
});
