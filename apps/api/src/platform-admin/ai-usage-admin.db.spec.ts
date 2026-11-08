/**
 * AI limits PR-2 against a real database: `GET platform-admin/ai-usage/by-business` sums each business's AiUsageEvent rows
 * for the asked UTC month (never another month's, never another business's) beside the cap that applies: the platform value,
 * the business override, or 0 (override 0, or the platform kill switch).
 *
 * Runs only under `npm run local:test:db`. Every tenant is a throwaway `qa-usage-<run>-<n>` slug (`assertTestTenant`);
 * `ai.monthlyCapUsd` is a platform-wide row the spec removes (default 10) and restores.
 */
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "crypto";
import { AiUsageAdminService } from "./ai-usage-admin.service";
import { PlatformConfigService } from "./platform-config.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { EncryptionService } from "../common/encryption.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);

describeDb("AI usage by business (AI limits PR-2)", () => {
  let prisma: PrismaService;
  let svc: AiUsageAdminService;
  let priorCap: string | null = null;
  const ids: string[] = [];
  const now = new Date();
  const thisMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const lastMonthDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));
  const lastMonth = `${lastMonthDate.getUTCFullYear()}-${String(lastMonthDate.getUTCMonth() + 1).padStart(2, "0")}`;

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    prisma = new PrismaService(new TenantContextService());
    await prisma.$connect();
    const platform = new PlatformConfigService(
      prisma,
      { get: () => undefined } as unknown as ConfigService,
      new EncryptionService({ get: () => undefined } as unknown as ConfigService),
    );
    svc = new AiUsageAdminService(prisma, platform);
    const rows = await prisma.$queryRaw<{ value: string }[]>`
      SELECT value FROM "PlatformConfig" WHERE key = 'ai.monthlyCapUsd'`;
    priorCap = rows[0]?.value ?? null;
    await prisma.$executeRaw`DELETE FROM "PlatformConfig" WHERE key = 'ai.monthlyCapUsd'`;
  });

  afterAll(async () => {
    const swallow = () => undefined;
    await prisma.$executeRaw`DELETE FROM "PlatformConfig" WHERE key = 'ai.monthlyCapUsd'`.catch(
      swallow,
    );
    if (priorCap !== null) {
      await prisma.$executeRaw`INSERT INTO "PlatformConfig" ("id","key","value","updatedAt")
          VALUES (gen_random_uuid()::text, 'ai.monthlyCapUsd', ${priorCap}, now())`.catch(swallow);
    }
    for (const id of ids) {
      await prisma.$executeRaw`DELETE FROM "AiUsageEvent" WHERE "tenantId" = ${id}`.catch(swallow);
      await prisma.tenant.delete({ where: { id } }).catch(swallow);
    }
    await prisma?.$disconnect();
  });

  async function makeTenant(n: number, aiMonthlyCapUsd: number | null) {
    const slug = assertTestTenant(`qa-usage-${RUN}-${n}`, "ai-usage-admin.db.spec.ts");
    const t = await prisma.tenant.create({
      data: { slug, name: `usage ${slug}`, aiMonthlyCapUsd },
    });
    ids.push(t.id);
    return t.id;
  }

  /** Sonnet 5.5 output is $10 per 1M tokens, so `usd` dollars is usd/10 million output tokens. */
  async function spend(tenantId: string, usd: number, createdAt = new Date()) {
    const out = Math.round((usd / 10) * 1e6);
    await prisma.$executeRaw`INSERT INTO "AiUsageEvent" ("id","tenantId","feature","model","inputTokens","outputTokens","createdAt")
        VALUES (gen_random_uuid()::text, ${tenantId}, 'ocr', 'claude-sonnet-5-5', 0, ${out}, ${createdAt})`;
  }

  const mine = async (month?: string) =>
    Object.fromEntries(
      (await svc.byBusiness(month)).businesses
        .filter((b) => ids.includes(b.tenantId))
        .map((b) => [b.tenantId, b]),
    );

  it("U-1: three businesses: spend this month, the cap that applies, the percent; another month never counts", async () => {
    const a = await makeTenant(1, null);
    const b = await makeTenant(2, 50);
    const c = await makeTenant(3, 0);
    await spend(a, 4);
    await spend(b, 20);
    await spend(b, 7, lastMonthDate);
    const now1 = await mine();
    expect(now1[a]).toMatchObject({ spendUsd: 4, capUsd: 10, percentUsed: 40, aiOff: false });
    expect(now1[b]).toMatchObject({ spendUsd: 20, capUsd: 50, percentUsed: 40 });
    expect(now1[c]).toMatchObject({ spendUsd: 0, capUsd: 0, percentUsed: null, aiOff: true });
    const prev = await mine(lastMonth);
    expect(prev[b]).toMatchObject({ spendUsd: 7 });
    expect(prev[a]).toMatchObject({ spendUsd: 0 });
    expect((await svc.byBusiness(thisMonth)).month).toBe(thisMonth);
  });

  it("U-3: a soft-deleted business with usage this month is not listed", async () => {
    const live = await makeTenant(4, null);
    const gone = await makeTenant(5, null);
    await spend(live, 3);
    await spend(gone, 8);
    await prisma.tenant.update({ where: { id: gone }, data: { deletedAt: new Date() } });
    const out = await svc.byBusiness();
    expect(out.businesses.some((b) => b.tenantId === gone)).toBe(false);
    expect(out.businesses.find((b) => b.tenantId === live)).toMatchObject({ spendUsd: 3 });
  });

  it("U-2: the platform kill switch shows every business as AI off, whatever its override", async () => {
    await prisma.$executeRaw`INSERT INTO "PlatformConfig" ("id","key","value","updatedAt")
        VALUES (gen_random_uuid()::text, 'ai.monthlyCapUsd', '0', now())`;
    const off = await mine();
    expect(Object.values(off).every((x) => x.capUsd === 0 && x.aiOff)).toBe(true);
    await prisma.$executeRaw`DELETE FROM "PlatformConfig" WHERE key = 'ai.monthlyCapUsd'`;
  });
});
