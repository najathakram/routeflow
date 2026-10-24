/**
 * #2495 — real Postgres. `GoogleOAuthService.handleTenantAuth`'s staff lookup used to resolve
 * via `findFirst({ OR: [{ googleId }, { email }] })`, which is nondeterministic when TWO rows
 * match: one already bound to the signing-in Google sub, another merely sharing the email.
 * Postgres gives no ordering guarantee over an unordered OR with no ORDER BY, so which row
 * "won" the ambiguous match could vary across runs/planner choices. This pins the fix
 * (resolve by sub FIRST, only fall back to email) against a REAL two-matching-rows scenario
 * that a mocked Prisma client can't meaningfully exercise, plus the different-bound-sub 409.
 *
 * Real PrismaClient; stand-ins only for JwtService/EmailService/EntitlementsService, none of
 * which this path's assertions depend on. Throwaway `qa-*` tenant (assertTestTenant). DB lane.
 */
import { randomUUID } from "crypto";
import { PrismaClient, TenantStatus } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { ConflictException } from "@nestjs/common";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { GoogleOAuthService } from "./google-oauth.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb("#2495 GoogleOAuthService staff lookup resolves by sub first (real Postgres)", () => {
  let url: string;
  let pool: Pool;
  let prisma: PrismaClient;
  let service: GoogleOAuthService;
  const tenantIds: string[] = [];
  const run = randomUUID().slice(0, 8);

  beforeAll(async () => {
    url = requireLocalDatabaseUrl();
    pool = new Pool({ connectionString: url });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

    const jwt = {
      sign: jest.fn().mockReturnValue("tok"),
      decode: jest.fn().mockReturnValue({ exp: Math.floor(Date.now() / 1000) + 3600 }),
    } as any;
    const config = {
      get: (key: string) => {
        if (key === "jwt") {
          return {
            secret: "qa-2495-secret-0123456789-abcdefghijklmnop",
            refreshSecret: "rs",
            expiresIn: "15m",
            refreshExpiresIn: "30d",
          };
        }
        return undefined;
      },
    } as any;
    const email = { send: jest.fn().mockResolvedValue(undefined) } as any;
    const entitlements = { claimsFor: jest.fn().mockResolvedValue(null) } as any;

    service = new GoogleOAuthService(prisma as any, jwt, config, email, entitlements);
  });

  afterAll(async () => {
    if (tenantIds.length) {
      await prisma.user.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    }
    await prisma.$disconnect();
    await pool.end();
  });

  async function makeTenant(tag: string): Promise<string> {
    const slug = assertTestTenant(`qa-2495-${tag}-${run}`, "google-oauth-linking.db.spec.ts");
    const tenant = await prisma.tenant.create({
      data: { slug, name: slug, status: TenantStatus.ACTIVE },
    });
    tenantIds.push(tenant.id);
    return tenant.id;
  }

  it("TWO-MATCHING-ROWS: a sub-bound row and a googleId-NULL email-sharing row in the same tenant — sign-in resolves to the sub-bound row deterministically", async () => {
    const tenantId = await makeTenant("twomatch");
    const sub = `google-sub-${run}`;
    const profileEmail = `shared-${run}@example.test`;

    // Row A: already bound to this exact Google sub, a DIFFERENT email.
    const rowA = await prisma.user.create({
      data: {
        tenantId,
        email: `bound-${run}@example.test`,
        username: `bound_${run}`,
        role: "OPERATOR",
        status: "ACTIVE",
        googleId: sub,
      },
    });
    // Row B: no Google link yet, but shares the EMAIL the signing-in profile presents.
    await prisma.user.create({
      data: {
        tenantId,
        email: profileEmail,
        username: `email_match_${run}`,
        role: "OPERATOR",
        status: "ACTIVE",
        googleId: null,
      },
    });

    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const profile = {
      type: "tenant" as const,
      tenantSlug: tenant.slug,
      googleId: sub,
      email: profileEmail,
      name: "QA Staff",
    };

    // Run it several times — an OR-based query's ambiguous-row ordering could vary by
    // planner/vacuum state across calls; the fix must be deterministic every time.
    for (let i = 0; i < 5; i++) {
      const result: any = await service.findOrCreateUser(profile as any);
      expect(result.kind).toBe("staff");
      expect(result.user.id).toBe(rowA.id);
    }

    const rowAAfter = await prisma.user.findUniqueOrThrow({ where: { id: rowA.id } });
    expect(rowAAfter.googleId).toBe(sub); // untouched — it already had this sub bound
  }, 30_000);

  it("DIFFERENT-BOUND-SUB: an email match already bound to another Google sub is refused with 409, no update", async () => {
    const tenantId = await makeTenant("mismatch");
    const victimSub = `google-victim-${run}`;
    const attackerSub = `google-attacker-${run}`;
    const profileEmail = `victim-${run}@example.test`;

    const victim = await prisma.user.create({
      data: {
        tenantId,
        email: profileEmail,
        username: `victim_${run}`,
        role: "TENANT_ADMIN",
        status: "ACTIVE",
        googleId: victimSub,
      },
    });

    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const profile = {
      type: "tenant" as const,
      tenantSlug: tenant.slug,
      googleId: attackerSub,
      email: profileEmail,
      name: "Attacker",
    };

    await expect(service.findOrCreateUser(profile as any)).rejects.toThrow(
      new ConflictException("google_account_mismatch"),
    );

    const victimAfter = await prisma.user.findUniqueOrThrow({ where: { id: victim.id } });
    expect(victimAfter.googleId).toBe(victimSub); // untouched
    expect(victimAfter.lastLoginAt).toBeNull(); // no sign-in ever issued
  }, 30_000);
});
