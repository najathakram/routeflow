import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import * as bcrypt from "bcrypt";
import * as crypto from "crypto";
import { BuyerAuthService } from "./buyer-auth.service";
import { EmailService } from "../email/email.service";
import { PrismaService } from "../prisma/prisma.service";
import { AppleOAuthService } from "../auth/apple-oauth.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { FakeCall, FakeTable, installFakeTables } from "../testing/claim-fake";

jest.mock("bcrypt", () => ({ compare: jest.fn(), hash: jest.fn() }));

/**
 * Buyer reset link: the consume claims the link atomically. Runs the real service against an
 * in-memory table that applies the `where` the service sends, so the loser of a race gets a real
 * count of 0 and a throwing transaction really undoes its writes.
 */
const REFUSAL = "Reset link is invalid or has already been used.";

const rawToken = "d".repeat(64);
const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");

describe("BuyerAuthService.resetPassword — the link is claimed atomically", () => {
  let service: BuyerAuthService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let tokens: FakeTable;
  let accounts: FakeTable;
  let sessions: FakeTable;
  let log: FakeCall[];

  const tokenRow = (patch: Record<string, unknown> = {}) => ({
    id: "bprt-1",
    buyerAccountId: "buyer-1",
    tokenHash,
    expiresAt: new Date(Date.now() + 60_000),
    usedAt: null as Date | null,
    ...patch,
  });
  const accountRow = (patch: Record<string, unknown> = {}) => ({
    id: "buyer-1",
    status: "ACTIVE",
    deletedAt: null as Date | null,
    passwordHash: "old-hash",
    passwordSet: false,
    ...patch,
  });

  function seed(opts: { token?: Record<string, unknown>; account?: Record<string, unknown> } = {}) {
    log = [];
    tokens = new FakeTable([tokenRow(opts.token)], "token", log);
    accounts = new FakeTable([accountRow(opts.account)], "account", log);
    sessions = new FakeTable(
      [
        { id: "brt-1", buyerAccountId: "buyer-1" },
        { id: "brt-2", buyerAccountId: "buyer-1" },
      ],
      "session",
      log,
    );
    installFakeTables(prisma, {
      buyerPasswordResetToken: tokens,
      buyerAccount: accounts,
      buyerRefreshToken: sessions,
    });
  }

  beforeEach(async () => {
    prisma = createMockPrisma();
    (bcrypt.hash as jest.Mock).mockResolvedValue("new-hash");
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BuyerAuthService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: JwtService,
          useValue: { sign: jest.fn(), verify: jest.fn(), decode: jest.fn() },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) =>
              key === "urls"
                ? { web: "https://web.test", mobileWeb: "https://mobile.test" }
                : {
                    secret: "test-secret",
                    refreshSecret: "test-refresh-secret",
                    expiresIn: "15m",
                    refreshExpiresIn: "30d",
                  },
            ),
          },
        },
        { provide: EmailService, useValue: { send: jest.fn() } },
        { provide: AppleOAuthService, useValue: { revokeForBuyer: jest.fn() } },
      ],
    }).compile();
    service = module.get(BuyerAuthService);
  });

  const refusal = (p: Promise<unknown>) =>
    p.then(
      () => {
        throw new Error("expected a refusal");
      },
      (e) => e,
    );

  it("(a) two concurrent consumes of one link: exactly one succeeds, the other writes nothing", async () => {
    seed();
    const results = await Promise.allSettled([
      service.resetPassword(rawToken, "NewPass1!"),
      service.resetPassword(rawToken, "OtherPass2!"),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(BadRequestException);
    expect(lost.reason.message).toBe(REFUSAL);

    expect(tokens.rows[0]!.usedAt).toBeInstanceOf(Date);
    expect(accounts.rows[0]).toMatchObject({ passwordHash: "new-hash", passwordSet: true });
    expect(sessions.rows).toHaveLength(0);
    // The loser never reached the account update or the session sweep.
    expect(log.filter((c) => c.inTx && c.op === "account.updateMany")).toHaveLength(1);
    expect(log.filter((c) => c.inTx && c.op === "session.deleteMany")).toHaveLength(1);
  });

  it("(a) the claim is the first statement of the transaction and is conditional", async () => {
    seed();

    await service.resetPassword(rawToken, "NewPass1!");

    const txCalls = log.filter((c) => c.inTx);
    expect(txCalls.map((c) => c.op)).toEqual([
      "token.updateMany",
      "account.updateMany",
      "session.deleteMany",
    ]);
    expect(txCalls[0]!.args.where).toEqual({
      tokenHash,
      usedAt: null,
      expiresAt: { gt: expect.any(Date) },
    });
    expect(txCalls[0]!.args.data).toEqual({ usedAt: expect.any(Date) });
    expect(txCalls[1]!.args.where).toEqual({ id: "buyer-1", status: "ACTIVE", deletedAt: null });
    expect(txCalls[1]!.args.data).toEqual({ passwordHash: "new-hash", passwordSet: true });
  });

  it.each([
    ["suspended", { status: "SUSPENDED" }],
    ["marked deleted", { status: "DELETED" }],
    ["soft-deleted", { deletedAt: new Date() }],
  ])(
    "(b) an account that is %s: refused, the claim is rolled back, nothing else is written",
    async (_n, patch) => {
      seed({ account: patch });

      const err = await refusal(service.resetPassword(rawToken, "NewPass1!"));

      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.message).toBe(REFUSAL);
      expect(tokens.rows[0]!.usedAt).toBeNull();
      expect(accounts.rows[0]).toMatchObject({ passwordHash: "old-hash", passwordSet: false });
      expect(sessions.rows).toHaveLength(2);
    },
  );

  it("(c) a used link, an expired link and an unknown link are refused with the same message", async () => {
    const messages: string[] = [];
    for (const token of [
      { usedAt: new Date(Date.now() - 1000) },
      { expiresAt: new Date(Date.now() - 1000) },
    ]) {
      seed({ token });
      const err = await refusal(service.resetPassword(rawToken, "NewPass1!"));
      expect(err).toBeInstanceOf(BadRequestException);
      messages.push(err.message);
      expect(accounts.rows[0]!.passwordHash).toBe("old-hash");
      expect(sessions.rows).toHaveLength(2);
    }
    seed();
    const unknown = await refusal(service.resetPassword("e".repeat(64), "NewPass1!"));
    messages.push(unknown.message);

    expect(new Set(messages)).toEqual(new Set([REFUSAL]));
  });

  it("(c) a link that expires between the pre-check and the claim is refused and writes nothing", async () => {
    seed({ token: { expiresAt: new Date(Date.now() + 5) } });
    (bcrypt.hash as jest.Mock).mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return "new-hash";
    });

    const err = await refusal(service.resetPassword(rawToken, "NewPass1!"));

    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toBe(REFUSAL);
    expect(accounts.rows[0]!.passwordHash).toBe("old-hash");
    expect(sessions.rows).toHaveLength(2);
  });

  it("(g) the success path still sets the password, flips passwordSet and signs the buyer out", async () => {
    seed();

    const res = await service.resetPassword(rawToken, "NewPass1!");

    expect(res.message).toContain("Password reset successfully");
    expect(accounts.rows[0]).toMatchObject({ passwordHash: "new-hash", passwordSet: true });
    expect(sessions.rows).toHaveLength(0);
  });
});
