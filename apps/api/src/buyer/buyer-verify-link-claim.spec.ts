import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import * as crypto from "crypto";
import { BuyerAuthService } from "./buyer-auth.service";
import { EmailService } from "../email/email.service";
import { PrismaService } from "../prisma/prisma.service";
import { AppleOAuthService } from "../auth/apple-oauth.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { FakeCall, FakeTable, installFakeTables } from "../testing/claim-fake";

/**
 * Buyer email-verification link: the consume claims the link atomically. Runs the real service
 * against in-memory tables that apply the `where` the service sends, so the loser of a race gets
 * a real count of 0 and a throwing transaction really undoes its writes.
 */
const REFUSAL = "Verification link is invalid or has already been used.";

const rawToken = "c".repeat(64);
const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");

describe("BuyerAuthService.verifyEmail — the link is claimed atomically", () => {
  let service: BuyerAuthService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let tokens: FakeTable;
  let accounts: FakeTable;
  let log: FakeCall[];

  const tokenRow = (patch: Record<string, unknown> = {}) => ({
    id: "bevt-1",
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
    emailVerified: false,
    ...patch,
  });

  function seed(
    opts: {
      token?: Record<string, unknown>;
      account?: Record<string, unknown>;
      siblings?: Record<string, unknown>[];
    } = {},
  ) {
    log = [];
    tokens = new FakeTable([tokenRow(opts.token), ...(opts.siblings ?? [])], "token", log);
    accounts = new FakeTable([accountRow(opts.account)], "account", log);
    installFakeTables(prisma, { buyerEmailVerificationToken: tokens, buyerAccount: accounts });
  }

  beforeEach(async () => {
    prisma = createMockPrisma();
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
              key === "urls" ? { web: "https://web.test", mobileWeb: "https://mobile.test" } : {},
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

  it("(a) two concurrent verifies of one link: exactly one succeeds, the other writes nothing", async () => {
    seed();
    const results = await Promise.allSettled([
      service.verifyEmail(rawToken),
      service.verifyEmail(rawToken),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(BadRequestException);
    expect(lost.reason.message).toBe(REFUSAL);

    expect(tokens.rows[0]!.usedAt).toBeInstanceOf(Date);
    expect(accounts.rows[0]!.emailVerified).toBe(true);
    // The loser never reached the account update.
    expect(log.filter((c) => c.inTx && c.op === "account.updateMany")).toHaveLength(1);
  });

  it("(a) the claim is the first statement of the transaction and is conditional", async () => {
    seed();

    await service.verifyEmail(rawToken);

    const txCalls = log.filter((c) => c.inTx);
    expect(txCalls.map((c) => c.op)).toEqual([
      "token.updateMany",
      "account.updateMany",
      "token.updateMany",
    ]);
    expect(txCalls[0]!.args.where).toEqual({
      tokenHash,
      usedAt: null,
      expiresAt: { gt: expect.any(Date) },
    });
    expect(txCalls[0]!.args.data).toEqual({ usedAt: expect.any(Date) });
    expect(txCalls[1]!.args.where).toEqual({ id: "buyer-1", status: "ACTIVE", deletedAt: null });
    expect(txCalls[1]!.args.data).toEqual({ emailVerified: true });
  });

  it.each([
    ["suspended", { status: "SUSPENDED" }],
    ["marked deleted", { status: "DELETED" }],
    ["soft-deleted", { deletedAt: new Date() }],
  ])(
    "(b) an account that is %s: the old link is refused, the claim is rolled back",
    async (_n, patch) => {
      seed({ account: patch });

      const err = await refusal(service.verifyEmail(rawToken));

      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.message).toBe(REFUSAL);
      expect(tokens.rows[0]!.usedAt).toBeNull();
      expect(accounts.rows[0]!.emailVerified).toBe(false);
    },
  );

  it("(c) a used link, an expired link and an unknown link are refused with the same message", async () => {
    const messages: string[] = [];
    for (const token of [
      { usedAt: new Date(Date.now() - 1000) },
      { expiresAt: new Date(Date.now() - 1000) },
    ]) {
      seed({ token });
      const err = await refusal(service.verifyEmail(rawToken));
      expect(err).toBeInstanceOf(BadRequestException);
      messages.push(err.message);
      expect(accounts.rows[0]!.emailVerified).toBe(false);
    }
    seed();
    messages.push((await refusal(service.verifyEmail("e".repeat(64)))).message);

    expect(new Set(messages)).toEqual(new Set([REFUSAL]));
  });

  it("(c) a link that expires between the pre-check and the claim is refused and writes nothing", async () => {
    seed({ token: { expiresAt: new Date(Date.now() + 5) } });
    const find = tokens.view().findUnique;
    prisma.buyerEmailVerificationToken.findUnique.mockImplementation(async (args: any) => {
      const row = await find(args);
      await new Promise((r) => setTimeout(r, 20));
      return row;
    });

    const err = await refusal(service.verifyEmail(rawToken));

    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toBe(REFUSAL);
    expect(accounts.rows[0]!.emailVerified).toBe(false);
  });

  it("(d) success burns the account's sibling links and leaves another account's alone", async () => {
    seed({
      siblings: [
        tokenRow({ id: "bevt-2", tokenHash: "sibling-1" }),
        tokenRow({ id: "bevt-3", tokenHash: "sibling-2", usedAt: new Date(Date.now() - 5000) }),
        tokenRow({ id: "bevt-4", tokenHash: "other", buyerAccountId: "buyer-2" }),
      ],
    });
    const priorUsedAt = tokens.rows[2]!.usedAt;

    await service.verifyEmail(rawToken);

    expect(tokens.rows[0]!.usedAt).toBeInstanceOf(Date);
    expect(tokens.rows[1]!.usedAt).toBeInstanceOf(Date); // sibling burned
    expect(tokens.rows[2]!.usedAt).toBe(priorUsedAt); // already used: not re-stamped
    expect(tokens.rows[3]!.usedAt).toBeNull(); // another account's link
  });

  it("(g) the success path still flips emailVerified and returns the same message", async () => {
    seed();

    const res = await service.verifyEmail(rawToken);

    expect(res.message).toContain("Email verified");
    expect(accounts.rows[0]!.emailVerified).toBe(true);
    expect(tokens.rows[0]!.usedAt).toBeInstanceOf(Date);
  });
});
