/**
 * #2177 (SA-306c) — the FIRST mint of a sequence row, raced on two real Postgres connections.
 *
 * Every NumberingService path lazily creates its `NumberingSequence` row on the first mint of a
 * (tenant, docType, year). Two first mints racing that seed must yield consecutive numbers and must
 * never surface a unique violation (P2002) to either caller — inside a caller's transaction a
 * unique violation aborts the WHOLE transaction (SQLSTATE 25P02), so the invoice/return write the
 * mint belongs to would fail with it.
 *
 * The race is made deterministic, not left to scheduler luck: connection A mints inside its own
 * open transaction and HOLDS it (its seed row is inserted but uncommitted), then connection B
 * starts its first mint — B cannot see A's row, so it reaches its own seed INSERT and blocks on
 * A's uncommitted unique key. Only then does A commit. A seed that is not conflict-tolerant fails
 * B with P2002 here every time.
 *
 * Paths pinned:
 *   - year-scoped (`mintForYear`): INVOICE with a year and no saved card row;
 *   - the fast path (`reserveNext`'s seed + increment, non-year-scoped doc types): RETURN, the
 *     per-year fast-path caller that mints on the caller's tx (`returns.service.ts`). Before
 *     #2177 this seed was a Prisma `upsert` (select-then-insert) and failed here with P2002; it
 *     is now the same `INSERT … ON CONFLICT DO NOTHING` `mintForYear` uses. A standalone
 *     (no-tx) call runs that identical closure inside its own `tenantTransaction`, so this
 *     two-connection case covers it by construction.
 *
 * Collected only by `jest.db.config.js`; run with
 * `node scripts/local-env.mjs --db --db-specs -- "npm run test:db -w apps/api --
 * src/import/numbering-first-mint-race.db.spec.ts"`. `requireLocalDatabaseUrl()` refuses any
 * non-local host. Every tenant is a throwaway `qa-2177-<run>-<n>-<label>` slug approved by
 * `assertTestTenant`; `afterAll` deletes exactly the tenants this run created.
 */

import { Test, TestingModule } from "@nestjs/testing";
import { randomUUID } from "crypto";
import type { DocumentNumberType, Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { NumberingService } from "./numbering.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
function freshTenantSlug(label: string): string {
  tenantSeq += 1;
  return assertTestTenant(
    `qa-2177-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "numbering-first-mint-race.db.spec.ts",
  );
}

// A year no other spec mints in, so the (tenant, docType, year) row is guaranteed not to exist yet.
const YEAR = new Date().getFullYear() + 7;
/** Long enough for B to reach — and block on — its seed INSERT before A commits. */
const HOLD_MS = 750;

describeDb("#2177 first-mint seed race — real Postgres, two connections", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let numbering: NumberingService;
  const createdTenantIds: string[] = [];

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const module: TestingModule = await Test.createTestingModule({
      providers: [NumberingService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    numbering = module.get(NumberingService);
  });

  afterAll(async () => {
    for (const tenantId of createdTenantIds) {
      // eslint-disable-next-line no-await-in-loop
      await prisma.numberingSequence.deleteMany({ where: { tenantId } }).catch(() => undefined);
      // eslint-disable-next-line no-await-in-loop
      await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
    }
    await prisma?.$disconnect();
  });

  async function seedTenant(label: string): Promise<string> {
    const tenant = await prisma.tenant.create({
      data: { slug: freshTenantSlug(label), name: `#2177 ${label}` },
    });
    createdTenantIds.push(tenant.id);
    return tenant.id;
  }

  /**
   * A mints inside its own transaction and holds it open; B's first mint starts only once A has
   * its number, then A commits after HOLD_MS. Returns both outcomes, never throwing.
   */
  async function raceHeldFirstMint(
    tenantId: string,
    docType: DocumentNumberType,
  ): Promise<{ a: PromiseSettledResult<string>; b: PromiseSettledResult<string> }> {
    let signalMinted!: () => void;
    const aMinted = new Promise<void>((resolve) => (signalMinted = resolve));
    let releaseA!: () => void;
    const aReleased = new Promise<void>((resolve) => (releaseA = resolve));

    const a = tenantCtx.run(tenantId, () =>
      prisma.tenantTransaction(
        async (tx: Prisma.TransactionClient) => {
          const n = await numbering.reserveNext(docType, { year: YEAR, tenantId, tx });
          signalMinted();
          await aReleased;
          return n;
        },
        { timeout: 20_000 },
      ),
    );
    // If A fails before minting, let B start anyway so the test reports A's error, not a hang.
    await Promise.race([aMinted, a.catch(() => undefined)]);

    const b = tenantCtx.run(tenantId, () =>
      prisma.tenantTransaction(
        (tx: Prisma.TransactionClient) =>
          numbering.reserveNext(docType, { year: YEAR, tenantId, tx }),
        { timeout: 20_000 },
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
    releaseA();

    const [ra, rb] = await Promise.allSettled([a, b]);
    return { a: ra, b: rb };
  }

  function summarize(r: { a: PromiseSettledResult<string>; b: PromiseSettledResult<string> }) {
    const show = (s: PromiseSettledResult<string>) =>
      s.status === "fulfilled"
        ? s.value
        : `REJECTED ${(s.reason as { code?: string })?.code ?? ""} ${String((s.reason as Error)?.message ?? s.reason).slice(0, 160)}`;
    return { a: show(r.a), b: show(r.b) };
  }

  it("year-scoped INVOICE: a first mint racing a held first mint gets the next number, no P2002", async () => {
    const tenantId = await seedTenant("inv");
    const r = await raceHeldFirstMint(tenantId, "INVOICE");
    expect(summarize(r)).toEqual({ a: `INV-${YEAR}-0001`, b: `INV-${YEAR}-0002` });
  }, 30_000);

  it("fast-path RETURN: a first mint racing a held first mint gets the next number, no P2002", async () => {
    const tenantId = await seedTenant("ret");
    const r = await raceHeldFirstMint(tenantId, "RETURN");
    const a = summarize(r).a;
    // The fast path's exact format is not this pin's concern; consecutive and unrejected is.
    expect(r.a.status).toBe("fulfilled");
    expect(r.b.status === "fulfilled" ? "fulfilled" : summarize(r).b).toBe("fulfilled");
    const num = (s: string) => Number(s.match(/(\d+)$/)?.[1]);
    expect(num((r.b as PromiseFulfilledResult<string>).value)).toBe(num(a) + 1);
  }, 30_000);

  it("five standalone first mints of a new year, all at once: 0001..0005, none rejected", async () => {
    const tenantId = await seedTenant("five");
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        tenantCtx.run(tenantId, () => numbering.reserveNext("INVOICE", { year: YEAR, tenantId })),
      ),
    );
    expect({
      rejected: results.filter((s) => s.status === "rejected").length,
      minted: results
        .filter((s): s is PromiseFulfilledResult<string> => s.status === "fulfilled")
        .map((s) => s.value)
        .sort(),
    }).toEqual({
      rejected: 0,
      minted: [1, 2, 3, 4, 5].map((n) => `INV-${YEAR}-000${n}`),
    });
  }, 30_000);
});
