/**
 * #2775 (SA-598 P1 for Google) — real-Postgres proof that GoogleOAuthService.findOrCreateUser's
 * staff link goes through the shared oauth-account-link compare-and-set: two concurrent sign-ins
 * for two DIFFERENT Google subs on one staff user both resolve the unbound row by email, and only
 * the `updateMany({ id, googleId: null })` guard decides the winner.
 *
 * WHY THE DB LANE: a lost-update race only exists against a real Postgres; mocks cannot interleave.
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`); run via `npm run local:test:db`.
 *
 * SAFETY: one throwaway `qa-google-<run>-a` tenant (`assertTestTenant`); `afterAll` deletes exactly
 * that tenant's rows. NOT run by the author session — the brief prohibits running DB-backed specs.
 * findOrCreateUser takes an already-verified profile, so no Google token verification is stubbed.
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
  const extraTenantIds: string[] = [];

  // Shared service builder for the single-caller cases (no barrier). Redis is stubbed as in the
  // interleave cases above; the shim forwards to the real DB except where a case overrides it.
  function buildService(shim: Record<string, unknown>, emailSend: jest.Mock) {
    const config = {
      get: (k: string) =>
        k === "jwt"
          ? { secret: "s", refreshSecret: "r", expiresIn: "15m", refreshExpiresIn: "30d" }
          : undefined,
    } as unknown as ConfigService;
    const service = new GoogleOAuthService(
      shim as any,
      {
        sign: jest.fn(() => "signed"),
        decode: jest.fn(() => ({ exp: Math.floor(Date.now() / 1000) + 3600 })),
      } as unknown as JwtService,
      config,
      { send: emailSend } as any,
      { claimsFor: jest.fn().mockResolvedValue(null) } as any,
    );
    (service as any).redis?.disconnect?.();
    (service as any).redis = {
      set: async () => "OK",
      getdel: async () => null,
      eval: async () => null,
      on: () => undefined,
      disconnect: () => undefined,
    };
    return service;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    tenantAId = (await raw.tenant.create({ data: { slug: slugA, name: `Google QA A ${run}` } })).id;
  }, 60_000);

  afterAll(async () => {
    const ids = [tenantAId, ...extraTenantIds].filter(Boolean);
    if (ids.length) {
      await raw.user.deleteMany({ where: { tenantId: { in: ids } } });
      await raw.tenant.deleteMany({ where: { id: { in: ids } } });
    }
    await raw?.$disconnect();
    await pool?.end();
  }, 60_000);

  it("SA-598 P1 (service path, forced interleave): two callers linking DIFFERENT subs to one user both pass the read, and exactly one wins the CAS", async () => {
    // Drives GoogleOAuthService.findOrCreateUser (staff branch) against real Postgres. The row is
    // read by email by both callers BEFORE either writes (a barrier on the first two email-fallback
    // `user.findFirst` calls, which sit between the "not linked yet" read and the conditional
    // update), so only the `updateMany({ id, googleId: null })` guard decides the winner. Reverting
    // that guard lets both writes land: two fulfilled calls, the last write wins -> RED.
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
    // the Prisma/Jest limits) instead of hanging the lane. Later calls (the loser's post-CAS
    // refetch, the sub-first lookups) pass straight through.
    let arrived = 0;
    let release!: () => void;
    const both = new Promise<void>((resolve) => (release = resolve));
    const gate = async () => {
      arrived += 1;
      if (arrived > 2) return;
      if (arrived === 2) release();
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          both,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("barrier: the second caller never arrived")),
              3000,
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    const prismaShim = {
      user: {
        findUnique: (args: Prisma.UserFindUniqueArgs) => raw.user.findUnique(args),
        findFirst: async (args: Prisma.UserFindFirstArgs) => {
          const row = await raw.user.findFirst(args);
          if ((args.where as any)?.email) await gate();
          return row;
        },
        updateMany: (args: Prisma.UserUpdateManyArgs) => raw.user.updateMany(args),
        update: (args: Prisma.UserUpdateArgs) => raw.user.update(args),
      },
      tenant: { findFirst: (args: Prisma.TenantFindFirstArgs) => raw.tenant.findFirst(args) },
      refreshToken: { upsert: jest.fn().mockResolvedValue({}) },
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
      {
        sign: jest.fn(() => "signed"),
        decode: jest.fn(() => ({ exp: Math.floor(Date.now() / 1000) + 3600 })),
      } as unknown as JwtService,
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
      service.findOrCreateUser({
        type: "tenant",
        tenantSlug: slugA,
        googleId: subA,
        email: user.email,
      } as any),
      service.findOrCreateUser({
        type: "tenant",
        tenantSlug: slugA,
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
    expect(emailSend).not.toHaveBeenCalled(); // the staff link sends no email
  });

  it("SA-599b (linkGoogleAccount, forced interleave): two callers linking DIFFERENT subs to one user both pass the read, and exactly one wins the CAS", async () => {
    // Drives GoogleOAuthService.linkGoogleAccount against real Postgres. A barrier on the first two
    // `user.findUnique` calls (each caller's initial read, before either writes) forces both past
    // the "not linked yet" pre-check, so only the shared CAS `updateMany({ id, tenantId,
    // googleId: null })` decides the winner. A bare check-then-update lets both land -> RED.
    const subA = `google-sub-${run}-link-a`;
    const subB = `google-sub-${run}-link-b`;
    const user = await raw.user.create({
      data: {
        tenantId: tenantAId,
        email: `link-${run}@example.test`,
        username: `link-${run}`,
        role: "OPERATOR",
      },
    });

    // Barrier: releases once BOTH callers have arrived; a lone arrival fails fast (< 5 s). Later
    // findUnique calls (the loser's post-CAS refetch) pass straight through.
    let arrived = 0;
    let release!: () => void;
    const both = new Promise<void>((resolve) => (release = resolve));
    const gate = async () => {
      arrived += 1;
      if (arrived > 2) return;
      if (arrived === 2) release();
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          both,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("barrier: the second caller never arrived")),
              3000,
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
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
        type: "tenant",
      } as any),
      service.linkGoogleAccount({
        linkUserId: user.id,
        googleId: subB,
        email: user.email,
        type: "tenant",
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
    expect(emailSend).toHaveBeenCalledTimes(1); // only the winner sends the linked email
  });

  it("SA-599b (a) (cross-tenant): the staff CAS write is scoped by tenantId, so a mis-scoped row resolved for tenant B writes nothing", async () => {
    // U lives in tenant A (googleId null). The shim's email-fallback `user.findFirst` returns U's
    // row with tenantId rewritten to tenant B (a stale / mis-scoped resolution); the DB row stays
    // in A. With `extraWhere: { tenantId: staffUser.tenantId }` the CAS is
    // `updateMany({ id: U.id, tenantId: B, googleId: null })` -> 0 rows -> casLinkProviderId
    // re-reads U (still googleId null, so no mismatch) and returns linked=false: the call resolves
    // (session issued for the real row), googleId stays null, nothing is emailed. Removing
    // `extraWhere: { tenantId }` from the staff CAS makes the write match on { id, googleId: null }
    // alone and land -> googleId becomes set -> the null assertion below goes RED (F2 verifies
    // the revert-red).
    const slugB = assertTestTenant(`qa-google-${run}-b`, "google-oauth-cas.db.spec.ts");
    const tenantBId = (
      await raw.tenant.create({ data: { slug: slugB, name: `Google QA B ${run}` } })
    ).id;
    extraTenantIds.push(tenantBId);
    const sub = `google-sub-${run}-xtenant`;
    const user = await raw.user.create({
      data: {
        tenantId: tenantAId,
        email: `xtenant-${run}@example.test`,
        username: `xtenant-${run}`,
        role: "OPERATOR",
      },
    });

    let rewrote = 0;
    const updateManyWheres: unknown[] = [];
    const prismaShim = {
      user: {
        findUnique: (args: Prisma.UserFindUniqueArgs) => raw.user.findUnique(args),
        findFirst: async (args: Prisma.UserFindFirstArgs) => {
          const row = await raw.user.findFirst(args);
          if ((args.where as any)?.email && row) {
            rewrote += 1;
            return { ...row, tenantId: tenantBId };
          }
          return row;
        },
        updateMany: (args: Prisma.UserUpdateManyArgs) => {
          updateManyWheres.push(args.where);
          return raw.user.updateMany(args);
        },
        update: (args: Prisma.UserUpdateArgs) => raw.user.update(args),
      },
      tenant: { findFirst: (args: Prisma.TenantFindFirstArgs) => raw.tenant.findFirst(args) },
      refreshToken: { upsert: jest.fn().mockResolvedValue({}) },
    };
    const emailSend = jest.fn().mockResolvedValue(undefined);
    const service = buildService(prismaShim, emailSend);

    await service.findOrCreateUser({
      type: "tenant",
      tenantSlug: slugA,
      googleId: sub,
      email: user.email,
    } as any);

    expect(rewrote).toBe(1); // the mis-scoped resolution really happened
    expect(updateManyWheres).toEqual([{ id: user.id, tenantId: tenantBId, googleId: null }]);
    const after = await raw.user.findUnique({ where: { id: user.id } });
    expect(after?.googleId).toBeNull(); // the scoped CAS matched 0 rows: no link written
    expect(after?.tenantId).toBe(tenantAId);
    expect(emailSend).not.toHaveBeenCalled();
  });

  it("same-sub quiet (staff path): a second sign-in with the SAME sub does not error, re-link, or send anything", async () => {
    const sub = `google-sub-${run}-same`;
    const user = await raw.user.create({
      data: {
        tenantId: tenantAId,
        email: `same-${run}@example.test`,
        username: `same-${run}`,
        role: "OPERATOR",
      },
    });
    let updateManyCalls = 0;
    const prismaShim = {
      user: {
        findUnique: (args: Prisma.UserFindUniqueArgs) => raw.user.findUnique(args),
        findFirst: (args: Prisma.UserFindFirstArgs) => raw.user.findFirst(args),
        updateMany: (args: Prisma.UserUpdateManyArgs) => {
          updateManyCalls += 1;
          return raw.user.updateMany(args);
        },
        update: (args: Prisma.UserUpdateArgs) => raw.user.update(args),
      },
      tenant: { findFirst: (args: Prisma.TenantFindFirstArgs) => raw.tenant.findFirst(args) },
      refreshToken: { upsert: jest.fn().mockResolvedValue({}) },
    };
    const emailSend = jest.fn().mockResolvedValue(undefined);
    const service = buildService(prismaShim, emailSend);
    const profile = {
      type: "tenant",
      tenantSlug: slugA,
      googleId: sub,
      email: user.email,
    } as any;

    await service.findOrCreateUser(profile); // first call wins: links the sub
    expect((await raw.user.findUnique({ where: { id: user.id } }))?.googleId).toBe(sub);
    expect(updateManyCalls).toBe(1);

    await expect(service.findOrCreateUser(profile)).resolves.toMatchObject({ kind: "staff" });
    expect((await raw.user.findUnique({ where: { id: user.id } }))?.googleId).toBe(sub);
    expect(updateManyCalls).toBe(1); // the second call resolved by sub: no second CAS write
    // The staff link path sends no email at all (only linkGoogleAccount notifies).
    expect(emailSend).not.toHaveBeenCalled();
  });

  it("same-sub quiet (linkGoogleAccount): first call links and emails once; the repeat with the same sub is refused and sends nothing", async () => {
    const sub = `google-sub-${run}-same-link`;
    const user = await raw.user.create({
      data: {
        tenantId: tenantAId,
        email: `samelink-${run}@example.test`,
        username: `samelink-${run}`,
        role: "OPERATOR",
      },
    });
    const prismaShim = {
      user: {
        findUnique: (args: Prisma.UserFindUniqueArgs) => raw.user.findUnique(args),
        findFirst: (args: Prisma.UserFindFirstArgs) => raw.user.findFirst(args),
        updateMany: (args: Prisma.UserUpdateManyArgs) => raw.user.updateMany(args),
      },
    };
    const emailSend = jest.fn().mockResolvedValue(undefined);
    const service = buildService(prismaShim, emailSend);
    const profile = {
      linkUserId: user.id,
      googleId: sub,
      email: user.email,
      type: "tenant",
    } as any;

    await service.linkGoogleAccount(profile);
    expect(emailSend).toHaveBeenCalledTimes(1);
    // The pre-check sees googleId already set and refuses (google_already_linked) before any write.
    await expect(service.linkGoogleAccount(profile)).rejects.toThrow("google_already_linked");
    expect((await raw.user.findUnique({ where: { id: user.id } }))?.googleId).toBe(sub);
    expect(emailSend).toHaveBeenCalledTimes(1); // no duplicate notification
  });
});
