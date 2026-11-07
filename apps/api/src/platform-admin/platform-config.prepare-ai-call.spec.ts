import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { DEFAULT_MONTHLY_AI_CAP_USD, PlatformConfigService } from "./platform-config.service";
import { PrismaService } from "../prisma/prisma.service";
import { EncryptionService } from "../common/encryption.service";

/**
 * SA-1102 A-1 (a) and (c): every Anthropic call goes through ONE entry point, `prepareAiCall(task, businessKey?)`:
 *   1. a business is required (403 TENANT_CONTEXT_REQUIRED), BEFORE any config read;
 *   2. the key by task (a business key for `bill_scan` only, then the Railway env, then the encrypted row);
 *   3. the monthly budget, but only when the key is RouteFlow's;
 *   4. the task's model.
 * The budget (PR-B1, no migration) sums the business's AiUsageEvent rows for the current UTC month with the one
 * `modelPrice`, and refuses with 403 AI_MONTHLY_CAP_REACHED at or over the cap. `ai.monthlyCapUsd` unset = $10, "0" =
 * AI off on RouteFlow's key for every business, and that kill switch beats any per-business override.
 *
 * The service is called through `any` so these compile, and fail on the VALUE, on the code without the methods.
 */
const ENV_KEY = "sk-ant-api03-ENVENVENVENVENVENVENVENVENVENVENVEcd34";
const BUSINESS_KEY = "sk-ant-api03-BUSINESSBUSINESSBUSINESSBUSINESSef56";
const TENANT = "qa-tenant-1";

describe("PlatformConfigService.prepareAiCall and the monthly budget (SA-1102 A-1)", () => {
  let service: any;
  let store: Record<string, string>;
  let env: Record<string, string | undefined>;
  let usage: Array<{ model: string; inTok: number; outTok: number }>;
  let usageQueries: unknown[][];
  let override: number | null;
  let tenantRowMissing: boolean;
  let configReads: string[];
  let tenantId: string | null;

  beforeEach(async () => {
    store = {};
    env = { ANTHROPIC_API_KEY: ENV_KEY };
    usage = [];
    usageQueries = [];
    override = null;
    tenantRowMissing = false;
    configReads = [];
    tenantId = TENANT;
    const prisma = {
      getTenantId: () => tenantId,
      $queryRaw: jest.fn(async (s: TemplateStringsArray, ...v: unknown[]) => {
        if (/AiUsageEvent/.test(s.join(""))) {
          usageQueries.push(v);
          return usage;
        }
        configReads.push(String(v[0]));
        return String(v[0]) in store ? [{ value: store[String(v[0])] }] : [];
      }),
      $executeRaw: jest.fn(),
      // O: the per-business override lives on Tenant.aiMonthlyCapUsd (null = the platform default).
      tenant: {
        findUnique: jest.fn(async () => (tenantRowMissing ? null : { aiMonthlyCapUsd: override })),
      },
    };
    const mod = await Test.createTestingModule({
      providers: [
        PlatformConfigService,
        EncryptionService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: (k: string) => env[k] } },
      ],
    }).compile();
    service = mod.get(PlatformConfigService);
  });

  const refused = async (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: any) => e,
    );
  const sonnetSpend = (usd: number) => [
    { model: "claude-sonnet-5-5", inTok: 0, outTok: (usd / 10) * 1e6 }, // $10 per 1M output tokens
  ];

  describe("a business is required first", () => {
    it("P-1: no business -> 403 TENANT_CONTEXT_REQUIRED, and nothing is read", async () => {
      tenantId = null;
      const err = await refused(service.prepareAiCall("receipt_scan"));
      expect(err?.getStatus?.()).toBe(403);
      expect(err?.getResponse?.()).toMatchObject({ code: "TENANT_CONTEXT_REQUIRED" });
      expect(err?.getResponse?.().message).toBe("Choose a business before scanning.");
      expect(configReads).toEqual([]);
      expect(usageQueries).toEqual([]);
    });

    it("P-1b: requireAiTenant() is the same check, and returns the tenant id", () => {
      expect(service.requireAiTenant()).toBe(TENANT);
      tenantId = null;
      expect(() => service.requireAiTenant()).toThrow();
    });
  });

  describe("key, budget and model, in that order", () => {
    it("P-2: a receipt scan returns RouteFlow's key, its model and the tenant, after the budget check", async () => {
      const got = await service.prepareAiCall("receipt_scan", BUSINESS_KEY);
      expect(got).toEqual({
        key: ENV_KEY,
        source: "routeflow",
        model: "claude-sonnet-5-5",
        tenantId: TENANT,
      });
      expect(usageQueries).toHaveLength(1); // the budget ran, because the key is RouteFlow's
    });

    it("P-3: a bill scan on the business's own key is returned as such and is never budget-checked", async () => {
      usage = sonnetSpend(500); // far over any cap
      const got = await service.prepareAiCall("bill_scan", BUSINESS_KEY);
      expect(got).toMatchObject({ key: BUSINESS_KEY, source: "business", tenantId: TENANT });
      expect(usageQueries).toEqual([]);
    });

    it("P-4: with no key anywhere it returns key null and runs no budget (no call will happen)", async () => {
      env = {};
      const got = await service.prepareAiCall("general");
      expect(got.key).toBeNull();
      expect(usageQueries).toEqual([]);
    });

    it("P-5: the model is the task's stored setting, else its fallback", async () => {
      store["claude.scanModel"] = "claude-sonnet-5-5";
      expect((await service.prepareAiCall("bill_scan")).model).toBe("claude-sonnet-5-5");
      expect((await service.prepareAiCall("statement_scan")).model).toBeDefined();
    });
  });

  describe("the monthly budget (C-1, C-2, C-4, C-5)", () => {
    it("C-1: $9.99 of spend this month: one more call is allowed", async () => {
      usage = sonnetSpend(9.99);
      await expect(service.prepareAiCall("receipt_scan")).resolves.toMatchObject({
        source: "routeflow",
      });
    });

    it("C-2: at or over $10: 403 AI_MONTHLY_CAP_REACHED with the one sentence", async () => {
      usage = sonnetSpend(10);
      const err = await refused(service.prepareAiCall("receipt_scan"));
      expect(err?.getStatus?.()).toBe(403);
      expect(err?.getResponse?.()).toMatchObject({ code: "AI_MONTHLY_CAP_REACHED" });
      // RA-1: the refusal carries when scans start again: the 1st of the next UTC month, the boundary the sum uses.
      const now = new Date();
      expect(err?.getResponse?.().resetsAt).toBe(
        new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString(),
      );
      expect(err?.getResponse?.().message).toBe(
        "This business has used this month's AI scans. They start again on the 1st. Contact RouteFlow to raise the limit.",
      );
    });

    it("C-2b: spend is priced with the one modelPrice (opus costs more than haiku per token)", async () => {
      usage = [{ model: "claude-haiku-5-5", inTok: 0, outTok: 18e6 }]; // 18M x $0.5 = $9
      await expect(service.prepareAiCall("general")).resolves.toBeDefined();
      usage = [{ model: "claude-opus-5-5", inTok: 0, outTok: 0.5e6 }]; // 0.5M x $20 = $10
      const err = await refused(service.prepareAiCall("general"));
      expect(err?.getResponse?.()).toMatchObject({ code: "AI_MONTHLY_CAP_REACHED" });
    });

    it("C-4: a cap of 0 turns AI off on RouteFlow's key, with no spend at all", async () => {
      store["ai.monthlyCapUsd"] = "0";
      const err = await refused(service.prepareAiCall("receipt_scan"));
      expect(err?.getResponse?.()).toMatchObject({ code: "AI_MONTHLY_CAP_REACHED" });
    });

    it("C-4b: the kill switch does not touch a business's own-key bill scan", async () => {
      store["ai.monthlyCapUsd"] = "0";
      await expect(service.prepareAiCall("bill_scan", BUSINESS_KEY)).resolves.toMatchObject({
        source: "business",
      });
    });

    it("C-7: a stored cap replaces the $10 default; an unreadable one falls back to $10", async () => {
      store["ai.monthlyCapUsd"] = "40";
      usage = sonnetSpend(30);
      await expect(service.prepareAiCall("general")).resolves.toBeDefined();
      store["ai.monthlyCapUsd"] = "not-a-number";
      const err = await refused(service.prepareAiCall("general"));
      expect(err?.getResponse?.()).toMatchObject({ code: "AI_MONTHLY_CAP_REACHED" });
      store["ai.monthlyCapUsd"] = "-5";
      expect(await service.monthlyCapUsdFor(TENANT)).toBe(10);
    });

    it("C-5: the window is the current UTC calendar month, for this tenant", async () => {
      jest.useFakeTimers().setSystemTime(new Date("2026-12-31T23:59:30Z"));
      try {
        await service.prepareAiCall("general");
        const [tenantArg, sinceArg] = usageQueries[0] as [string, Date];
        expect(tenantArg).toBe(TENANT);
        expect(new Date(sinceArg).toISOString()).toBe("2026-12-01T00:00:00.000Z");
        jest.setSystemTime(new Date("2027-01-01T00:00:05Z"));
        usageQueries.length = 0;
        await service.prepareAiCall("general");
        expect(new Date((usageQueries[0] as [string, Date])[1]).toISOString()).toBe(
          "2027-01-01T00:00:00.000Z",
        );
      } finally {
        jest.useRealTimers();
      }
    });

    it("C-6: every usage row counts (no keySource column until the B2 migration)", async () => {
      await service.prepareAiCall("general");
      expect(usageQueries).toHaveLength(1);
      // the SQL is read by the DB spec; here the contract is one sum per call, keyed by tenant and month only.
      expect(usageQueries[0]).toHaveLength(2);
    });
  });

  describe("the per-business override (O-1 to O-5)", () => {
    it("O-1: no override: the platform value applies, and the $10 fallback when that is unset", async () => {
      expect(await service.monthlyCapUsdFor(TENANT)).toBe(10);
      store["ai.monthlyCapUsd"] = "30";
      expect(await service.monthlyCapUsdFor(TENANT)).toBe(30);
    });

    it("O-2: an override replaces the platform value, up or down", async () => {
      store["ai.monthlyCapUsd"] = "10";
      override = 50;
      expect(await service.monthlyCapUsdFor(TENANT)).toBe(50);
      usage = sonnetSpend(30); // over the platform $10, under the business's $50
      await expect(service.prepareAiCall("general")).resolves.toBeDefined();
      override = 5;
      store["ai.monthlyCapUsd"] = "100";
      usage = sonnetSpend(6);
      const err = await refused(service.prepareAiCall("general"));
      expect(err?.getResponse?.()).toMatchObject({ code: "AI_MONTHLY_CAP_REACHED" });
    });

    it("O-3: an override of 0 turns AI off on RouteFlow's key for that business only", async () => {
      override = 0;
      store["ai.monthlyCapUsd"] = "100";
      const err = await refused(service.prepareAiCall("receipt_scan"));
      expect(err?.getResponse?.()).toMatchObject({ code: "AI_MONTHLY_CAP_REACHED" });
      await expect(service.prepareAiCall("bill_scan", BUSINESS_KEY)).resolves.toMatchObject({
        source: "business",
      });
    });

    it("O-4: a missing tenant row or an unusable override falls back to the platform value", async () => {
      store["ai.monthlyCapUsd"] = "10";
      tenantRowMissing = true;
      expect(await service.monthlyCapUsdFor(TENANT)).toBe(10);
      tenantRowMissing = false;
      override = -3;
      expect(await service.monthlyCapUsdFor(TENANT)).toBe(10);
    });

    it("O-6: the platform's 0 is the kill switch: it beats an override, AI is off for every business", async () => {
      store["ai.monthlyCapUsd"] = "0";
      override = 50;
      expect(await service.monthlyCapUsdFor(TENANT)).toBe(0);
      const err = await refused(service.prepareAiCall("receipt_scan"));
      expect(err?.getResponse?.()).toMatchObject({ code: "AI_MONTHLY_CAP_REACHED" });
      // the business's own key is still not touched by it (C-4b)
      await expect(service.prepareAiCall("bill_scan", BUSINESS_KEY)).resolves.toMatchObject({
        source: "business",
      });
      // any platform value above 0 leaves the override in charge
      store["ai.monthlyCapUsd"] = "1";
      expect(await service.monthlyCapUsdFor(TENANT)).toBe(50);
    });

    it("O-7: the code default is the owner's $10", () => {
      expect(DEFAULT_MONTHLY_AI_CAP_USD).toBe(10);
    });

    it("O-5: the override is read for the business in context only", async () => {
      override = 7;
      await service.prepareAiCall("general");
      const find = (service as any).prisma.tenant.findUnique as jest.Mock;
      expect(find).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: TENANT }, select: { aiMonthlyCapUsd: true } }),
      );
    });
  });
});
