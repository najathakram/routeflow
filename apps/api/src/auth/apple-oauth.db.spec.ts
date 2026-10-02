/**
 * #2309 (SA-418 §5) — real-Postgres proof that the two additive unique constraints from
 * migration 20260929200000_2309_apple_sign_in actually exist and behave as designed:
 *   - "User_tenantId_appleId_key" (@@unique([tenantId, appleId])): one Apple sub per
 *     TENANT, not globally — the same sub is allowed to sign in as staff in two
 *     different tenants (e.g. a contractor working two RouteFlow customers).
 *   - "BuyerAccount_appleId_key" (@unique): one Apple sub per buyer account, globally
 *     (buyers have no tenant).
 *
 * WHY THE DB LANE: a unique-constraint violation (P2002) only ever comes from Postgres
 * itself — no amount of mocking `prisma.user.create` proves the index exists. Collected
 * only by `jest.db.config.js` (`.db.spec.ts$`); run via `npm run local:test:db`.
 *
 * SAFETY: two throwaway `qa-apple-<run>-a`/`-b` tenants (`assertTestTenant`); `afterAll`
 * deletes exactly these tenants' rows, in FK order. NOT run by this session — the task
 * brief prohibits running DB-backed specs; `npm run local:test:db` runs this lane.
 */
import { createHash, randomUUID } from "crypto";
import { ConflictException } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import type { JwtService } from "@nestjs/jwt";
import * as jose from "jose";
import { AppleOAuthService } from "./apple-oauth.service";
import { PrismaClient, Prisma } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

function isP2002(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

describeDb("#2309 (SA-418 §5) — Apple sign-in unique constraints on real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  const run = randomUUID().slice(0, 8);
  const slugA = assertTestTenant(`qa-apple-${run}-a`, "apple-oauth.db.spec.ts");
  const slugB = assertTestTenant(`qa-apple-${run}-b`, "apple-oauth.db.spec.ts");
  let tenantAId = "";
  let tenantBId = "";

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    tenantAId = (await raw.tenant.create({ data: { slug: slugA, name: `Apple QA A ${run}` } })).id;
    tenantBId = (await raw.tenant.create({ data: { slug: slugB, name: `Apple QA B ${run}` } })).id;
  }, 60_000);

  afterAll(async () => {
    for (const tenantId of [tenantAId, tenantBId]) {
      if (!tenantId) continue;
      await raw.user.deleteMany({ where: { tenantId } });
      await raw.tenant.deleteMany({ where: { id: tenantId } });
    }
    await raw.buyerAccount.deleteMany({ where: { email: { contains: `apple-${run}` } } });
    await raw?.$disconnect();
    await pool?.end();
  }, 60_000);

  it("User_tenantId_appleId_key: a same-tenant duplicate appleId is rejected (P2002)", async () => {
    const appleId = `apple-sub-${run}-dup`;
    await raw.user.create({
      data: {
        tenantId: tenantAId,
        email: `staff1-${run}@example.test`,
        username: `staff1-${run}`,
        role: "OPERATOR",
        appleId,
      },
    });

    let error: unknown;
    try {
      await raw.user.create({
        data: {
          tenantId: tenantAId,
          email: `staff2-${run}@example.test`,
          username: `staff2-${run}`,
          role: "OPERATOR",
          appleId,
        },
      });
    } catch (e) {
      error = e;
    }
    expect(isP2002(error)).toBe(true);
  });

  it("the same appleId in two different tenants is allowed", async () => {
    const appleId = `apple-sub-${run}-cross-tenant`;
    await raw.user.create({
      data: {
        tenantId: tenantAId,
        email: `staff3-${run}@example.test`,
        username: `staff3-${run}`,
        role: "OPERATOR",
        appleId,
      },
    });

    // Must NOT throw — @@unique is scoped to (tenantId, appleId), not appleId alone.
    const userInTenantB = await raw.user.create({
      data: {
        tenantId: tenantBId,
        email: `staff4-${run}@example.test`,
        username: `staff4-${run}`,
        role: "OPERATOR",
        appleId,
      },
    });
    expect(userInTenantB.appleId).toBe(appleId);
  });

  it("BuyerAccount_appleId_key: a duplicate appleId across buyer accounts is rejected (P2002)", async () => {
    const appleId = `apple-sub-${run}-buyer-dup`;
    await raw.buyerAccount.create({
      data: {
        email: `buyer1-apple-${run}@example.test`,
        passwordHash: "placeholder",
        passwordSet: false,
        name: "QA Buyer One",
        appleId,
      },
    });

    let error: unknown;
    try {
      await raw.buyerAccount.create({
        data: {
          email: `buyer2-apple-${run}@example.test`,
          passwordHash: "placeholder",
          passwordSet: false,
          name: "QA Buyer Two",
          appleId,
        },
      });
    } catch (e) {
      error = e;
    }
    expect(isP2002(error)).toBe(true);
  });
  it("#2495 / SA-598 P1: the sub-first then email-ordered resolve picks the sub row over an older email-sharing row", async () => {
    // Two rows match one Apple identity: an OLDER staff row that merely shares the email
    // (appleId null) and a NEWER row already bound to the sub (a different email). The old
    // `OR: [{ appleId }, { email }]` with no orderBy could return either.
    const sub = `apple-sub-${run}-two-rows`;
    const sharedEmail = `shared-${run}@example.test`;
    const older = await raw.user.create({
      data: {
        tenantId: tenantAId,
        email: sharedEmail,
        username: `older-${run}`,
        role: "OPERATOR",
      },
    });
    const bound = await raw.user.create({
      data: {
        tenantId: tenantAId,
        email: `bound-${run}@example.test`,
        username: `bound-${run}`,
        role: "OPERATOR",
        appleId: sub,
      },
    });

    const base = { tenantId: tenantAId, deletedAt: null };
    const bySub = await raw.user.findFirst({ where: { ...base, appleId: sub } });
    expect(bySub?.id).toBe(bound.id);

    // No sub match for a different identity: the email fallback is deterministic, oldest first.
    const byEmail = await raw.user.findFirst({
      where: { ...base, email: sharedEmail },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    expect(byEmail?.id).toBe(older.id);
    // The CAS write itself is proven through the service in the forced-interleave case below.
  });

  it("SA-598 P1 (service path, forced interleave): two callers linking DIFFERENT subs to one user both pass the read, and exactly one wins the CAS", async () => {
    // Drives AppleOAuthService.linkAppleAccount against real Postgres. The user row is read by
    // both callers BEFORE either writes (a barrier on the first two `user.findUnique` calls, which
    // sit between the "not linked yet" read and the conditional update), so only the
    // `updateMany({ id, tenantId, appleId: null })` guard decides the winner. Reverting that guard
    // lets both writes land: two fulfilled calls, the last write wins -> RED.
    const BUNDLE = "com.routeflow.app";
    const KID = "db-race-kid";
    const subA = `apple-sub-${run}-race-a`;
    const subB = `apple-sub-${run}-race-b`;
    const user = await raw.user.create({
      data: {
        tenantId: tenantAId,
        email: `race-${run}@example.test`,
        username: `race-${run}`,
        role: "OPERATOR",
      },
    });

    // Barrier: releases once BOTH callers have arrived; a lone arrival fails fast (< 5 s, inside
    // the Prisma/Jest limits) instead of hanging the lane. Later findUnique calls (the loser's
    // post-CAS refetch) pass straight through.
    let arrived = 0;
    let release!: () => void;
    const both = new Promise<void>((resolve) => (release = resolve));
    const gate = async () => {
      arrived += 1;
      if (arrived > 2) return;
      if (arrived === 2) release();
      await Promise.race([
        both,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("barrier: the second caller never arrived")), 3000),
        ),
      ]);
    };
    const prismaShim = {
      user: {
        findUnique: async (args: Prisma.UserFindUniqueArgs) => {
          const row = await raw.user.findUnique(args);
          await gate();
          return row;
        },
        findFirst: (args: Prisma.UserFindFirstArgs) => raw.user.findFirst(args),
        updateMany: (args: Prisma.UserUpdateManyArgs) => raw.user.updateMany(args),
      },
    };
    const emailSend = jest.fn().mockResolvedValue(undefined);
    const config = {
      get: (k: string) =>
        k === "jwt"
          ? { secret: "s", refreshSecret: "r", expiresIn: "15m", refreshExpiresIn: "30d" }
          : ({ APPLE_BUNDLE_ID: BUNDLE, APPLE_TEAM_ID: "T", APPLE_KEY_ID: "K" } as any)[k],
    } as unknown as ConfigService;
    const service = new AppleOAuthService(
      prismaShim as any,
      { sign: jest.fn(), decode: jest.fn() } as unknown as JwtService,
      config,
      { send: emailSend } as any,
      { claimsFor: jest.fn().mockResolvedValue(null) } as any,
      { encrypt: jest.fn(), decrypt: jest.fn() } as any,
    );
    (service as any).redis?.disconnect?.();
    const store = new Map<string, string>();
    (service as any).redis = {
      set: async (key: string, val: string) => (store.set(key, val), "OK"),
      getdel: async (key: string) => {
        const v = store.get(key) ?? null;
        store.delete(key);
        return v;
      },
      eval: async () => null,
      on: () => undefined,
      disconnect: () => undefined,
    };
    const { publicKey, privateKey } = await jose.generateKeyPair("RS256");
    const jwk = await jose.exportJWK(publicKey);
    Object.assign(jwk, { kid: KID, alg: "RS256", use: "sig" });
    (service as any).jwks = jose.createLocalJWKSet({ keys: [jwk] });

    const token = async (sub: string) => {
      const { nonce } = await service.mintNonce(undefined, "staff");
      const identityToken = await new jose.SignJWT({
        email: user.email,
        email_verified: true,
        nonce: createHash("sha256").update(nonce).digest("hex"),
      })
        .setProtectedHeader({ alg: "RS256", kid: KID })
        .setIssuer("https://appleid.apple.com")
        .setAudience(BUNDLE)
        .setSubject(sub)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);
      return { identityToken, nonce };
    };
    const a = await token(subA);
    const b = await token(subB);

    const results = await Promise.allSettled([
      service.linkAppleAccount(user.id, a.identityToken, a.nonce),
      service.linkAppleAccount(user.id, b.identityToken, b.nonce),
    ]);

    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(arrived).toBeGreaterThanOrEqual(2); // the interleave really happened
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0].reason).toBeInstanceOf(ConflictException);
    expect((lost[0].reason as ConflictException).message).toBe("apple_account_mismatch");
    const after = await raw.user.findUnique({ where: { id: user.id } });
    expect([subA, subB]).toContain(after?.appleId);
    expect(emailSend).toHaveBeenCalledTimes(1); // only the winner sends the linked email
  });
});
