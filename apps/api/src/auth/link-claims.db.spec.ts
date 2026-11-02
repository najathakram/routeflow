/**
 * F03 slice 2 (SA-1096), real Postgres: a one-time link is CLAIMED atomically, and an account change burns the
 * account's live links.
 *
 * Mocked Prisma cannot show either property: a read-then-write consume passes every unit test, and only two real
 * transactions racing on one row show two winners. Throwaway `qa-*` tenant (assertTestTenant). DB lane.
 */
import { randomUUID, createHash } from "crypto";
import { PrismaClient, TenantStatus } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { AuthService } from "./auth.service";
import { BuyerAuthService } from "../buyer/buyer-auth.service";
import { revokeBuyerLinkTokens, revokeUserLinkTokens } from "./link-token-revocation";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const USED_TEXT = "Reset link is invalid or has already been used.";
const sha = (t: string) => createHash("sha256").update(t).digest("hex");

describeDb("F03 slice 2: atomic link claims (real Postgres)", () => {
  let pool: Pool;
  let prisma: PrismaClient;
  let auth: AuthService;
  let buyerAuth: BuyerAuthService;
  let tenantId: string;
  const run = randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const buyerIds: string[] = [];

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    const jwt = {
      sign: jest.fn().mockReturnValue("tok"),
      decode: jest.fn().mockReturnValue({ exp: Math.floor(Date.now() / 1000) + 3600 }),
    } as any;
    const config = {
      get: (key: string) =>
        key === "jwt"
          ? {
              secret: "qa-f03s2-secret-0123456789-abcdefghijklmnop",
              refreshSecret: "rs",
              expiresIn: "15m",
              refreshExpiresIn: "30d",
            }
          : { web: "https://web.test", mobileWeb: "https://mobile.test" },
    } as any;
    const email = { send: jest.fn().mockResolvedValue({ delivered: true }) } as any;
    auth = new AuthService(prisma as any, {} as any, jwt, config, email, {
      claimsFor: jest.fn().mockResolvedValue(null),
    } as any);
    buyerAuth = new BuyerAuthService(prisma as any, jwt, config, email, {} as any);
    const slug = assertTestTenant(`qa-f03s2-${run}`, "link-claims.db.spec.ts");
    tenantId = (
      await prisma.tenant.create({ data: { slug, name: slug, status: TenantStatus.ACTIVE } })
    ).id;
  });

  afterAll(async () => {
    await prisma.buyerAccount.deleteMany({ where: { id: { in: buyerIds } } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
    await prisma.$disconnect();
    await pool.end();
  });

  async function makeUser(status: "ACTIVE" | "INACTIVE" | "SUSPENDED" = "ACTIVE") {
    const tag = randomUUID().slice(0, 8);
    const user = await prisma.user.create({
      data: {
        tenantId,
        email: `u-${tag}-${run}@example.test`,
        username: `u_${tag}_${run}`,
        role: "OPERATOR",
        status,
        password: "$2b$10$old-hash-not-a-real-one",
      },
    });
    userIds.push(user.id);
    return user;
  }

  async function makeToken(userId: string) {
    const raw = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
    await prisma.passwordResetToken.create({
      data: { userId, tokenHash: sha(raw), expiresAt: new Date(Date.now() + 15 * 60_000) },
    });
    return raw;
  }

  async function makeBuyer(status: "ACTIVE" | "SUSPENDED" = "ACTIVE") {
    const tag = randomUUID().slice(0, 8);
    const b = await prisma.buyerAccount.create({
      data: {
        email: `b-${tag}-${run}@example.test`,
        passwordHash: "$2b$10$old-hash-not-a-real-one",
        name: "Test Buyer",
        status,
      },
    });
    buyerIds.push(b.id);
    return b;
  }

  describe("staff reset (C1)", () => {
    it("M1: two concurrent consumes of one link give exactly one winner, and one password write", async () => {
      for (let round = 0; round < 3; round++) {
        const user = await makeUser();
        const raw = await makeToken(user.id);
        const results = await Promise.allSettled([
          auth.resetPassword(raw, "FirstPass1!"),
          auth.resetPassword(raw, "SecondPass2!"),
        ]);
        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
        const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
        expect(after.password).not.toBe(user.password);
      }
    });

    it.each(["INACTIVE", "SUSPENDED"] as const)(
      "M5a: a live link on a %s account is refused, consumed, and writes nothing",
      async (status) => {
        const user = await makeUser(status);
        const raw = await makeToken(user.id);
        await prisma.refreshToken.create({
          data: {
            userId: user.id,
            tokenHash: sha(`rt-${raw}`),
            expiresAt: new Date(Date.now() + 1e7),
          },
        });
        await expect(auth.resetPassword(raw, "NewPass1!")).rejects.toThrow(USED_TEXT);
        const row = await prisma.passwordResetToken.findUniqueOrThrow({
          where: { tokenHash: sha(raw) },
        });
        expect(row.usedAt).not.toBeNull();
        const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
        expect(after.password).toBe(user.password);
        expect(await prisma.refreshToken.count({ where: { userId: user.id } })).toBe(1);
      },
    );

    it("M5a: a deleted account is refused the same way", async () => {
      const user = await makeUser();
      const raw = await makeToken(user.id);
      await prisma.user.update({ where: { id: user.id }, data: { deletedAt: new Date() } });
      await expect(auth.resetPassword(raw, "NewPass1!")).rejects.toThrow(USED_TEXT);
      const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(after.password).toBe(user.password);
    });

    it("M5b: the refused link stays dead after the account is reactivated", async () => {
      const user = await makeUser("INACTIVE");
      const raw = await makeToken(user.id);
      await expect(auth.resetPassword(raw, "NewPass1!")).rejects.toThrow(USED_TEXT);
      await prisma.user.update({ where: { id: user.id }, data: { status: "ACTIVE" } });
      await expect(auth.resetPassword(raw, "NewPass1!")).rejects.toThrow(/already been used/);
      const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(after.password).toBe(user.password);
    });

    it("M5c: the refusal text for a non-active account is the text of a spent link", async () => {
      const spent = await makeUser();
      const rawSpent = await makeToken(spent.id);
      await auth.resetPassword(rawSpent, "NewPass1!");
      const spentErr = await auth.resetPassword(rawSpent, "NewPass1!").catch((e: Error) => e);
      const inactive = await makeUser("INACTIVE");
      const rawInactive = await makeToken(inactive.id);
      const inactiveErr = await auth.resetPassword(rawInactive, "NewPass1!").catch((e: Error) => e);
      expect((inactiveErr as Error).message).toBe(USED_TEXT);
      expect((spentErr as Error).message).toMatch(/already been used/);
    });

    it("M9: reset racing a deactivate never deadlocks, and the link ends consumed either way", async () => {
      const rounds = 24;
      let resetWon = 0;
      for (let i = 0; i < rounds; i++) {
        const user = await makeUser();
        const raw = await makeToken(user.id);
        const [reset, deactivate] = await Promise.allSettled([
          auth.resetPassword(raw, "RacePass1!"),
          (async () => {
            // bcrypt makes the reset take ~60-100 ms before it locks: jitter the deactivate across that window
            await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 140)));
            await prisma.$transaction(async (tx) => {
              // the writer's order (users.service.ts updateStatus): the user row first, then the links
              await tx.user.update({ where: { id: user.id }, data: { status: "INACTIVE" } });
              await revokeUserLinkTokens(tx, user.id);
            });
          })(),
        ]);
        expect(deactivate.status).toBe("fulfilled");
        if (reset.status === "rejected") {
          expect(String(reset.reason?.message ?? reset.reason)).not.toMatch(/deadlock|40P01/i);
          expect(String(reset.reason?.message)).toMatch(/already been used|invalid/);
        } else {
          resetWon++;
        }
        const row = await prisma.passwordResetToken.findUniqueOrThrow({
          where: { tokenHash: sha(raw) },
        });
        expect(row.usedAt).not.toBeNull();
        const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
        expect(after.status).toBe("INACTIVE");
        if (reset.status === "fulfilled") expect(after.password).not.toBe(user.password);
        else expect(after.password).toBe(user.password);
      }
      console.log(
        `M9 staff: ${rounds} rounds, reset won ${resetWon}, deactivate first ${rounds - resetWon}`,
      );
    });

    it("M3: revokeUserLinkTokens burns a user's live reset link", async () => {
      const user = await makeUser();
      const raw = await makeToken(user.id);
      await prisma.$transaction((tx) => revokeUserLinkTokens(tx, user.id));
      await expect(auth.resetPassword(raw, "NewPass1!")).rejects.toThrow(/already been used/);
    });
  });

  describe("buyer reset and verify (C2, C3)", () => {
    async function makeBuyerReset(buyerAccountId: string) {
      const raw = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
      await prisma.buyerPasswordResetToken.create({
        data: {
          buyerAccountId,
          tokenHash: sha(raw),
          expiresAt: new Date(Date.now() + 15 * 60_000),
        },
      });
      return raw;
    }
    async function makeBuyerVerify(buyerAccountId: string) {
      const raw = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
      await prisma.buyerEmailVerificationToken.create({
        data: {
          buyerAccountId,
          tokenHash: sha(raw),
          expiresAt: new Date(Date.now() + 60 * 60_000),
        },
      });
      return raw;
    }

    it("M2: two concurrent buyer resets give exactly one winner", async () => {
      const b = await makeBuyer();
      const raw = await makeBuyerReset(b.id);
      const results = await Promise.allSettled([
        buyerAuth.resetPassword(raw, "FirstPass1!"),
        buyerAuth.resetPassword(raw, "SecondPass2!"),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    });

    it("M2: two concurrent buyer email verifications give exactly one winner", async () => {
      const b = await makeBuyer();
      const raw = await makeBuyerVerify(b.id);
      const results = await Promise.allSettled([
        buyerAuth.verifyEmail(raw),
        buyerAuth.verifyEmail(raw),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    });

    it("a live buyer reset link on a SUSPENDED account is refused, consumed, writes nothing", async () => {
      const b = await makeBuyer("SUSPENDED");
      const raw = await makeBuyerReset(b.id);
      await expect(buyerAuth.resetPassword(raw, "NewPass1!")).rejects.toThrow(USED_TEXT);
      const row = await prisma.buyerPasswordResetToken.findUniqueOrThrow({
        where: { tokenHash: sha(raw) },
      });
      expect(row.usedAt).not.toBeNull();
      const after = await prisma.buyerAccount.findUniqueOrThrow({ where: { id: b.id } });
      expect(after.passwordHash).toBe(b.passwordHash);
    });

    it("a live buyer verify link on a SUSPENDED account is refused and does not verify", async () => {
      const b = await makeBuyer("SUSPENDED");
      const raw = await makeBuyerVerify(b.id);
      await expect(buyerAuth.verifyEmail(raw)).rejects.toThrow(/invalid or has already been used/);
      const after = await prisma.buyerAccount.findUniqueOrThrow({ where: { id: b.id } });
      expect(after.emailVerified).toBe(false);
    });

    it("M3: revokeBuyerLinkTokens burns a buyer's live reset link", async () => {
      const b = await makeBuyer();
      const raw = await makeBuyerReset(b.id);
      await prisma.$transaction((tx) => revokeBuyerLinkTokens(tx, b.id));
      await expect(buyerAuth.resetPassword(raw, "NewPass1!")).rejects.toThrow(/already been used/);
    });
  });
});
