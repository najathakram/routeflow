/**
 * SA-1102 B1 (rows C-1, C-2, C-3, C-4, C-5) against a real database: `prepareAiCall` sums the business's AiUsageEvent
 * rows for the current UTC month with the one modelPrice, and refuses with 403 AI_MONTHLY_CAP_REACHED at or over the
 * cap, only when the key is RouteFlow's. Another business's spend never counts, nor does last month's.
 *
 * Runs only under `npm run local:test:db`. Every tenant is a throwaway `qa-1102b-<run>-<n>` slug (`assertTestTenant`).
 * `ai.monthlyCapUsd` is a platform-wide row; the spec restores it.
 */
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "crypto";
import { PlatformConfigService } from "./platform-config.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { EncryptionService } from "../common/encryption.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);
const ENV_KEY = "sk-ant-api03-ENVENVENVENVENVENVENVENVENVENVENVEcd34";
const BUSINESS_KEY = "sk-ant-api03-BUSINESSBUSINESSBUSINESSBUSINESSef56";

describeDb("AI monthly budget (SA-1102 B1)", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let service: PlatformConfigService;
  let priorCap: string | null = null;
  const tenantIds: string[] = [];

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const config = { get: (k: string) => (k === "ANTHROPIC_API_KEY" ? ENV_KEY : undefined) };
    service = new PlatformConfigService(
      prisma,
      config as unknown as ConfigService,
      new EncryptionService({ get: () => undefined } as unknown as ConfigService),
    );
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
    for (const tenantId of tenantIds) {
      await prisma.$executeRaw`DELETE FROM "AiUsageEvent" WHERE "tenantId" = ${tenantId}`.catch(
        swallow,
      );
      await prisma.tenant.delete({ where: { id: tenantId } }).catch(swallow);
    }
    await prisma?.$disconnect();
  });

  async function makeTenant(n: number) {
    const slug = assertTestTenant(`qa-1102b-${RUN}-${n}`, "platform-config.ai-budget.db.spec.ts");
    const t = await prisma.tenant.create({ data: { slug, name: `1102b ${slug}` } });
    tenantIds.push(t.id);
    return t.id;
  }

  /** Sonnet 5.5 output is $10 per 1M tokens, so `usd` dollars is usd/10 million tokens. */
  async function spend(tenantId: string, usd: number, createdAt = new Date()) {
    const out = Math.round((usd / 10) * 1e6);
    await prisma.$executeRaw`
      INSERT INTO "AiUsageEvent" ("id","tenantId","feature","model","inputTokens","outputTokens","success","createdAt")
      VALUES (gen_random_uuid()::text, ${tenantId}, 'ocr.expense_receipt', 'claude-sonnet-5-5', 0, ${out}, true, ${createdAt})`;
  }

  const prepare = (tenantId: string, task: "receipt_scan" | "bill_scan", businessKey?: string) =>
    tenantCtx.run(tenantId, () => service.prepareAiCall(task, businessKey));

  it("C-1: a business at $9.99 this month can make one more call", async () => {
    const t = await makeTenant(1);
    await spend(t, 9.99);
    await expect(prepare(t, "receipt_scan")).resolves.toMatchObject({
      source: "routeflow",
      tenantId: t,
    });
  });

  it("C-2: a business at $10 this month is refused 403 AI_MONTHLY_CAP_REACHED; another business is not", async () => {
    const over = await makeTenant(2);
    const other = await makeTenant(3);
    await spend(over, 10);
    await expect(prepare(over, "receipt_scan")).rejects.toMatchObject({
      response: expect.objectContaining({ code: "AI_MONTHLY_CAP_REACHED" }),
    });
    await expect(prepare(other, "receipt_scan")).resolves.toBeDefined();
  });

  it("C-3: the same business on its OWN key for a bill scan is allowed", async () => {
    const t = await makeTenant(4);
    await spend(t, 90);
    await expect(prepare(t, "bill_scan", BUSINESS_KEY)).resolves.toMatchObject({
      source: "business",
    });
  });

  it("C-4: a cap of 0 refuses every call on RouteFlow's key, even with no spend", async () => {
    const t = await makeTenant(5);
    await service.updateAiConfig({ monthlyCapUsd: 0 });
    try {
      await expect(prepare(t, "receipt_scan")).rejects.toMatchObject({
        response: expect.objectContaining({ code: "AI_MONTHLY_CAP_REACHED" }),
      });
      await expect(prepare(t, "bill_scan", BUSINESS_KEY)).resolves.toBeDefined();
    } finally {
      await prisma.$executeRaw`DELETE FROM "PlatformConfig" WHERE key = 'ai.monthlyCapUsd'`;
    }
  });

  it("C-5: spend from a previous month does not count", async () => {
    const t = await makeTenant(6);
    const now = new Date();
    const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) - 60_000);
    await spend(t, 500, lastMonth);
    await expect(prepare(t, "receipt_scan")).resolves.toBeDefined();
  });

  it("O-1: the per-business override (the real Tenant column) replaces the platform cap, up or down", async () => {
    const lower = await makeTenant(10);
    const higher = await makeTenant(11);
    await spend(lower, 6);
    await spend(higher, 30);
    await prisma.tenant.update({ where: { id: lower }, data: { aiMonthlyCapUsd: 5 } });
    await prisma.tenant.update({ where: { id: higher }, data: { aiMonthlyCapUsd: 50 } });
    await expect(prepare(lower, "receipt_scan")).rejects.toMatchObject({
      response: expect.objectContaining({ code: "AI_MONTHLY_CAP_REACHED" }),
    });
    await expect(prepare(higher, "receipt_scan")).resolves.toBeDefined(); // over the $10 platform default
  });

  it("O-2: an override of 0 is AI off on RouteFlow's key for that business only", async () => {
    const off = await makeTenant(12);
    const on = await makeTenant(13);
    await prisma.tenant.update({ where: { id: off }, data: { aiMonthlyCapUsd: 0 } });
    await expect(prepare(off, "receipt_scan")).rejects.toMatchObject({
      response: expect.objectContaining({ code: "AI_MONTHLY_CAP_REACHED" }),
    });
    await expect(prepare(off, "bill_scan", BUSINESS_KEY)).resolves.toBeDefined();
    await expect(prepare(on, "receipt_scan")).resolves.toBeDefined();
  });

  it("O-3: clearing the override (null) puts the platform cap back", async () => {
    const t = await makeTenant(14);
    await spend(t, 30);
    await prisma.tenant.update({ where: { id: t }, data: { aiMonthlyCapUsd: 50 } });
    await expect(prepare(t, "receipt_scan")).resolves.toBeDefined();
    await prisma.tenant.update({ where: { id: t }, data: { aiMonthlyCapUsd: null } });
    await expect(prepare(t, "receipt_scan")).rejects.toMatchObject({
      response: expect.objectContaining({ code: "AI_MONTHLY_CAP_REACHED" }),
    });
  });

  it("O-5: the platform's 0 (kill switch) beats an override of 50, on the real column", async () => {
    const t = await makeTenant(15);
    await prisma.tenant.update({ where: { id: t }, data: { aiMonthlyCapUsd: 50 } });
    await expect(prepare(t, "receipt_scan")).resolves.toBeDefined();
    await service.updateAiConfig({ monthlyCapUsd: 0 });
    try {
      await expect(prepare(t, "receipt_scan")).rejects.toMatchObject({
        response: expect.objectContaining({ code: "AI_MONTHLY_CAP_REACHED" }),
      });
    } finally {
      await prisma.$executeRaw`DELETE FROM "PlatformConfig" WHERE key = 'ai.monthlyCapUsd'`;
    }
  });

  it("O-4: the cap sum is served by the (tenantId, createdAt) index", async () => {
    const rows = await prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'AiUsageEvent' AND indexname = 'AiUsageEvent_tenantId_createdAt_idx'`;
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toMatch(/("tenantId", "createdAt")/);
  });

  it("a call with no business is refused 403 before anything is read", async () => {
    await expect(
      tenantCtx.run(null, () => service.prepareAiCall("receipt_scan")),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: "TENANT_CONTEXT_REQUIRED" }),
    });
  });
});
