import { Test } from "@nestjs/testing";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { BadRequestException } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { UsersService } from "../users/users.service";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { FakeCall, FakeTable, installFakeTables } from "../testing/claim-fake";
import { VERIFICATION_REFUSED } from "./verification-link-eligibility";

/**
 * The legacy stateless verification link: the activation is one conditional write, so a change
 * that lands between the reads before it and the write (a verified timestamp, a new session row)
 * refuses the activation by the `where` itself. The reads here are pinned to a clean snapshot to
 * model that window; the tables hold the state at the moment of the write.
 */
const SECRET = "legacy-claim-secret-0123456789-abcdefghij";
const LEGACY_LINK = "legacy.signed.link";
const NOW = new Date("2026-10-12T00:00:00.000Z");

const userRow = (patch: Record<string, unknown> = {}) => ({
  id: "user-1",
  username: "acme_admin",
  email: "owner@acme.example",
  password: "hash",
  role: "TENANT_ADMIN",
  status: "INACTIVE",
  forcePasswordChange: false,
  isAdmin: false,
  canActAsDriver: false,
  tenantId: "tenant-1",
  deletedAt: null as Date | null,
  lastLoginAt: null as Date | null,
  emailVerifiedAt: null as Date | null,
  createdAt: new Date("2026-10-01T00:00:00Z"),
  refreshTokens: [] as unknown[],
  ...patch,
});

describe("AuthService legacy verification link: the claim re-checks eligibility", () => {
  let auth: AuthService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let users: FakeTable;
  let tokens: FakeTable;
  let log: FakeCall[];

  function seed(atWrite: Record<string, unknown> = {}) {
    log = [];
    users = new FakeTable([userRow(atWrite)], "user", log);
    tokens = new FakeTable([], "token", log);
    installFakeTables(prisma, { user: users, userEmailVerificationToken: tokens });
    // what the reads before the claim saw: a clean, eligible account
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(userRow());
    (prisma.refreshToken.count as jest.Mock).mockResolvedValue(0);
    (prisma.tenant.findUnique as jest.Mock).mockResolvedValue({ slug: "acme" });
    (prisma.refreshToken.upsert as jest.Mock).mockResolvedValue({});
  }

  beforeEach(async () => {
    prisma = createMockPrisma();
    const mod = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: UsersService, useValue: {} },
        {
          provide: JwtService,
          useValue: {
            sign: jest.fn().mockReturnValue("signed"),
            decode: jest.fn().mockReturnValue({ exp: Math.floor(Date.now() / 1000) + 3600 }),
            verify: jest
              .fn()
              .mockReturnValue({ sub: "user-1", type: "email_verify", tenantId: "tenant-1" }),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((k: string) =>
              k === "jwt"
                ? {
                    secret: SECRET,
                    refreshSecret: "legacy-claim-refresh-secret-0123456789",
                    expiresIn: "15m",
                    refreshExpiresIn: "30d",
                  }
                : k === "jwt.secret"
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
    auth = mod.get(AuthService);
  });

  const consume = () => auth.verifyEmailAndLogin(LEGACY_LINK, undefined, NOW);

  it("the activation where requires an unverified account with no session row", async () => {
    seed();

    await consume();

    const activation = log.find((c) => c.inTx && c.op === "user.updateMany")!;
    expect(activation.args.where).toEqual({
      id: "user-1",
      status: "INACTIVE",
      lastLoginAt: null,
      role: "TENANT_ADMIN",
      deletedAt: null,
      emailVerifiedAt: null,
      refreshTokens: { none: {} },
    });
    expect(users.rows[0]!.status).toBe("ACTIVE");
  });

  it("refuses an account whose emailVerifiedAt was set before the write", async () => {
    seed({ emailVerifiedAt: new Date("2026-10-11T00:00:00Z") });

    const err: any = await consume().catch((e) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toEqual(VERIFICATION_REFUSED);
    expect(users.rows[0]!.status).toBe("INACTIVE");
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
    expect(prisma.refreshToken.upsert).not.toHaveBeenCalled();
  });

  it("refuses by the where itself when a session row appeared after the pre-transaction check", async () => {
    seed({ refreshTokens: [{ id: "rt-1" }] });

    const err: any = await consume().catch((e) => e);

    expect(prisma.refreshToken.count).toHaveBeenCalled(); // the early check saw nothing
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toEqual(VERIFICATION_REFUSED);
    expect(users.rows[0]!.status).toBe("INACTIVE");
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
    expect(prisma.refreshToken.upsert).not.toHaveBeenCalled();
  });
});
