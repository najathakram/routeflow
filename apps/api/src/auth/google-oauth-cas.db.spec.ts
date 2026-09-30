/**
 * #2775 (SA-598 P1 for Google) — real-Postgres proof that GoogleOAuthService.linkGoogleAccount
 * links by compare-and-set through the shared oauth-account-link helper: two concurrent calls for
 * two DIFFERENT Google subs on one staff user both pass the "not linked yet" read, and only the
 * `updateMany({ id, tenantId, googleId: null })` guard decides the winner.
 *
 * WHY THE DB LANE: a lost-update race only exists against a real Postgres; mocks cannot interleave.
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`); run via `npm run local:test:db`.
 *
 * SAFETY: one throwaway `qa-google-<run>-a` tenant (`assertTestTenant`); `afterAll` deletes exactly
 * that tenant's rows. NOT run by the author session — the brief prohibits running DB-backed specs.
 * linkGoogleAccount takes an already-verified profile, so no Google token verification is stubbed.
 */
import { randomUUID } from "crypto";
import { ConflictException } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import type { JwtService } from "@nestjs/jwt";
import { GoogleOAuthService } from "./google-oauth.service";
import { PrismaClient, Prisma } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb("#2775 (SA-598 P1) — Google link CAS on real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  const run = randomUUID().slice(0, 8);
  const slugA = assertTestTenant(`qa-google-${run}-a`, "google-oauth-cas.db.spec.ts");
  let tenantAId = "";

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    tenantAId = (await raw.tenant.create({ data: { slug: slugA, name: `Google QA A ${run}` } })).id;
  }, 60_000);

  afterAll(async () => {
    if (tenantAId) {
      await raw.user.deleteMany({ where: { tenantId: tenantAId } });
      await raw.tenant.deleteMany({ where: { id: tenantAId } });
    }
    await raw?.$disconnect();
    await pool?.end();
  }, 60_000);

  it("SA-598 P1 (service path, forced interleave): two callers linking DIFFERENT subs to one user both pass the read, and exactly one wins the CAS", async () => {
    // Drives GoogleOAuthService.linkGoogleAccount against real Postgres. The user row is read by
    // both callers BEFORE either writes (a barrier on the first two `user.findUnique` calls, which
    // sit between the "not linked yet" read and the conditional update), so only the
    // `updateMany({ id, tenantId, googleId: null })` guard decides the winner. Reverting that guard
    // lets both writes land: two fulfilled calls, the last write wins -> RED.
    const subA = `google-sub-${run}-race-a`;
    const subB = `google-sub-${run}-race-b`;
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
          : undefined,
    } as unknown as ConfigService;
    const service = new GoogleOAuthService(
      prismaShim as any,
      { sign: jest.fn(), decode: jest.fn() } as unknown as JwtService,
      config,
      { send: emailSend } as any,
      { claimsFor: jest.fn().mockResolvedValue(null) } as any,
    );
    // The constructor opens a Redis client this path never uses; close it and stub the surface.
    (service as any).redis?.disconnect?.();
    (service as any).redis = {
      set: async () => "OK",
      getdel: async () => null,
      eval: async () => null,
      on: () => undefined,
      disconnect: () => undefined,
    };

    const results = await Promise.allSettled([
      service.linkGoogleAccount({
        linkUserId: user.id,
        googleId: subA,
        email: user.email,
      } as any),
      service.linkGoogleAccount({
        linkUserId: user.id,
        googleId: subB,
        email: user.email,
      } as any),
    ]);

    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(arrived).toBeGreaterThanOrEqual(2); // the interleave really happened
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0].reason).toBeInstanceOf(ConflictException);
    expect((lost[0].reason as ConflictException).message).toBe("google_account_mismatch");
    const after = await raw.user.findUnique({ where: { id: user.id } });
    expect([subA, subB]).toContain(after?.googleId);
    await Promise.resolve(); // flush the fire-and-forget send
    expect(emailSend).toHaveBeenCalledTimes(1); // only the winner sends the linked email
  });
});
