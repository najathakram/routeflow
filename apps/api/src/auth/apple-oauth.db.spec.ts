/**
 * #2309 (SA-418 §5) — real-Postgres proof that the two additive unique constraints from
 * migration 20260927100000_2309_apple_sign_in actually exist and behave as designed:
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
import { randomUUID } from "crypto";
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
});
