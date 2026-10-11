import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { AuthService } from "./auth.service";
import { EmailService } from "../email/email.service";
import { UsersService } from "../users/users.service";
import { PrismaService } from "../prisma/prisma.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { FakeCall, FakeTable, installFakeTables } from "../testing/claim-fake";
import { hashEmailVerifyToken } from "./email-verification-token";
import { VERIFY_LINK_DEAD_MESSAGE } from "./email-verification-consume";

/**
 * Staff email verification with a stored single-use token. Runs the real service against
 * in-memory tables that apply the `where` the service sends, so the loser of a race gets a real
 * count of 0 and a throwing transaction really undoes its writes.
 */
const TOKEN = "T".repeat(43);
const NOW = new Date("2026-10-12T12:00:00.000Z");

const SECRET = "claim-spec-jwt-secret-0123456789-abcdefghij";

describe("AuthService.verifyEmailAndLogin — stored single-use token", () => {
  let service: AuthService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let tokens: FakeTable;
  let users: FakeTable;
  let sessions: FakeTable;
  let log: FakeCall[];

  const tokenRow = (patch: Record<string, unknown> = {}) => ({
    id: "evt-1",
    userId: "user-1",
    tokenHash: hashEmailVerifyToken(TOKEN),
    expiresAt: new Date(NOW.getTime() + 60_000),
    usedAt: null as Date | null,
    createdAt: new Date(NOW.getTime() - 60_000),
    ...patch,
  });
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
    // a created-before-the-resend-cut-off account: the cut-off applies at issue, never at consume
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    refreshTokens: [] as unknown[],
    ...patch,
  });

  function seed(
    opts: {
      token?: Record<string, unknown>;
      user?: Record<string, unknown>;
      siblings?: Array<Record<string, unknown>>;
    } = {},
  ) {
    log = [];
    tokens = new FakeTable(
      [
        tokenRow(opts.token),
        ...(opts.siblings ?? []).map((s, i) =>
          tokenRow({ id: `sib-${i}`, tokenHash: `h-${i}`, ...s }),
        ),
      ],
      "token",
      log,
    );
    users = new FakeTable([userRow(opts.user)], "user", log);
    sessions = new FakeTable([], "session", log);
    installFakeTables(prisma, {
      userEmailVerificationToken: tokens,
      user: users,
      refreshToken: sessions,
    });
    (prisma.tenant.findUnique as jest.Mock).mockResolvedValue({ slug: "acme" });
    (prisma.refreshToken.upsert as jest.Mock).mockResolvedValue({});
  }

  beforeEach(async () => {
    prisma = createMockPrisma();
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
                    refreshSecret: "claim-spec-refresh-secret-0123456789",
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

  const verify = (token = TOKEN) => service.verifyEmailAndLogin(token, undefined, NOW);
  const refusal = (p: Promise<unknown>) =>
    p.then(
      () => {
        throw new Error("expected a refusal");
      },
      (e) => e,
    );

  it("consumes a token for an account created before the issue cut-off: no creation-date check at consume", async () => {
    seed(); // user createdAt = 2026-09-01, before VERIFY_RESEND_CUTOFF

    const res: any = await verify();

    expect(res).toHaveProperty("accessToken");
    expect(users.rows[0]!.status).toBe("ACTIVE");
    // neither the claim nor the activation predicate mentions a creation date, and the consume
    // never counts session rows through the old eligibility helper
    const txWheres = log
      .filter((c) => c.inTx && c.op.endsWith(".updateMany"))
      .map((c) => c.args.where);
    for (const where of txWheres) expect(JSON.stringify(where)).not.toContain("createdAt");
    expect(prisma.refreshToken.count).not.toHaveBeenCalled();
  });

  it("the first statement of the transaction is the conditional claim; the activation is the whole eligibility test", async () => {
    seed();

    await verify();

    const txCalls = log.filter((c) => c.inTx);
    expect(txCalls.map((c) => c.op)).toEqual([
      "token.updateMany", // the claim
      "user.updateMany", // the activation
      "token.updateMany", // the sibling burn
    ]);
    expect(txCalls[0]!.args.where).toEqual({
      tokenHash: hashEmailVerifyToken(TOKEN),
      usedAt: null,
      expiresAt: { gt: NOW },
    });
    expect(txCalls[0]!.args.data).toEqual({ usedAt: NOW });
    expect(txCalls[1]!.args.where).toEqual({
      id: "user-1",
      status: "INACTIVE",
      role: "TENANT_ADMIN",
      lastLoginAt: null,
      emailVerifiedAt: null,
      deletedAt: null,
      refreshTokens: { none: {} },
    });
    expect(txCalls[1]!.args.data).toEqual({ status: "ACTIVE", emailVerifiedAt: NOW });
  });

  it("sets emailVerifiedAt and burns the account's sibling tokens in the same transaction", async () => {
    seed({
      siblings: [
        {}, // a second live link
        { usedAt: new Date(NOW.getTime() - 1000) }, // already used: left as it was
      ],
    });
    const earlier = tokens.rows[2]!.usedAt;

    await verify();

    expect(users.rows[0]!.emailVerifiedAt).toEqual(NOW);
    expect(tokens.rows[0]!.usedAt).toEqual(NOW); // the consumed one
    expect(tokens.rows[1]!.usedAt).toEqual(NOW); // the live sibling is burned
    expect(tokens.rows[2]!.usedAt).toBe(earlier);
  });

  it("two concurrent consumes of one link: exactly one succeeds, the other writes nothing", async () => {
    seed();

    const results = await Promise.allSettled([verify(), verify()]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(BadRequestException);
    expect(lost.reason.message).toBe(VERIFY_LINK_DEAD_MESSAGE);
    expect(users.rows[0]!.status).toBe("ACTIVE");
    // the audit row was written once
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["already ACTIVE", { status: "ACTIVE" }],
    ["suspended", { status: "SUSPENDED" }],
    ["signed in before", { lastLoginAt: new Date("2026-10-02T00:00:00Z") }],
    ["already verified", { emailVerifiedAt: new Date("2026-10-02T00:00:00Z") }],
    ["not a tenant admin", { role: "OPERATOR" }],
    ["deleted", { deletedAt: new Date("2026-10-02T00:00:00Z") }],
    ["holding a session row", { refreshTokens: [{ id: "rt-1" }] }],
  ])(
    "an account that is %s: refused with the generic copy, the claim rolled back",
    async (_n, patch) => {
      seed({ user: patch });
      const before = JSON.stringify(users.rows[0]);

      const err = await refusal(verify());

      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.message).toBe(VERIFY_LINK_DEAD_MESSAGE);
      expect(tokens.rows[0]!.usedAt).toBeNull();
      expect(JSON.stringify(users.rows[0])).toBe(before);
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
      expect(prisma.refreshToken.upsert).not.toHaveBeenCalled();
    },
  );

  it("a used, an expired and an unknown token are refused with the same message", async () => {
    const messages: string[] = [];
    for (const [patch, token] of [
      [{ usedAt: new Date(NOW.getTime() - 1000) }, TOKEN],
      [{ expiresAt: new Date(NOW.getTime() - 1000) }, TOKEN],
      [{}, "U".repeat(43)],
    ] as Array<[Record<string, unknown>, string]>) {
      seed({ token: patch });
      const err = await refusal(verify(token));
      expect(err).toBeInstanceOf(BadRequestException);
      messages.push(err.message);
      expect(users.rows[0]!.status).toBe("INACTIVE");
    }
    expect(new Set(messages)).toEqual(new Set([VERIFY_LINK_DEAD_MESSAGE]));
  });

  it("a token claimed between the read and the transaction is refused before the account is touched", async () => {
    seed();
    (prisma.userEmailVerificationToken.findUnique as jest.Mock).mockImplementationOnce(async () => {
      const seen = { ...tokens.rows[0]! };
      tokens.rows[0]!.usedAt = new Date(NOW.getTime() - 1000); // a rival claimed it just now
      return seen;
    });

    const err = await refusal(verify());

    expect(err.message).toBe(VERIFY_LINK_DEAD_MESSAGE);
    expect(users.rows[0]!.status).toBe("INACTIVE");
    expect(log.filter((c) => c.inTx && c.op.startsWith("user."))).toHaveLength(0);
  });

  it("activation and its audit record commit together", async () => {
    seed();
    (prisma.auditLog.create as jest.Mock).mockRejectedValue(new Error("audit write failed"));

    await expect(verify()).rejects.toThrow("audit write failed");

    expect(users.rows[0]!.status).toBe("INACTIVE");
    expect(tokens.rows[0]!.usedAt).toBeNull();
    expect(prisma.refreshToken.upsert).not.toHaveBeenCalled();
  });

  it.each(["", "x".repeat(600)])(
    "refuses a token of an unusable size (%#) without a lookup",
    async (token) => {
      seed();

      await expect(verify(token)).rejects.toThrow(VERIFY_LINK_DEAD_MESSAGE);
      expect(log).toHaveLength(0);
    },
  );

  it("only the SHA-256 of the token is ever used as a lookup key", async () => {
    seed();

    await verify();

    const lookups = log.filter((c) => c.op === "token.findUnique");
    expect(lookups).toHaveLength(1);
    expect(lookups[0]!.args.where).toEqual({ tokenHash: hashEmailVerifyToken(TOKEN) });
    expect(JSON.stringify(log)).not.toContain(TOKEN);
  });
});
