import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { PlatformConfigService } from "./platform-config.service";
import { PrismaService } from "../prisma/prisma.service";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { BadRequestException } from "@nestjs/common";

describe("PlatformConfigService — AI usage + test connection", () => {
  let service: PlatformConfigService;
  let prisma: { $queryRaw: jest.Mock; $executeRaw: jest.Mock };
  const originalFetch = global.fetch;

  beforeEach(async () => {
    prisma = { $queryRaw: jest.fn(), $executeRaw: jest.fn().mockResolvedValue(0) };
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        PlatformConfigService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(undefined) } },
      ],
    }).compile();
    service = mod.get(PlatformConfigService);
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe("getAiUsage", () => {
    it("rolls up scans, tokens, est spend, and error rate by model + feature", async () => {
      prisma.$queryRaw.mockResolvedValue([
        {
          model: "claude-haiku-4-5",
          feature: "ocr.vendor_bill",
          calls: 7,
          inTok: 700_000,
          outTok: 140_000,
          failures: 1,
        },
        {
          model: "claude-sonnet-5",
          feature: "ocr.supplier_statement",
          calls: 3,
          inTok: 300_000,
          outTok: 60_000,
          failures: 0,
        },
        {
          model: "claude-opus-4-5",
          feature: "forecast",
          calls: 5,
          inTok: 500_000,
          outTok: 100_000,
          failures: 0,
        },
        {
          model: "claude-sonnet-4-5",
          feature: "insights.route",
          calls: 4,
          inTok: 40_000,
          outTok: 8_000,
          failures: 0,
        },
      ]);

      const u = await service.getAiUsage(30);

      // Both ocr.* features roll into ocrScans; insights.* into insightRuns.
      expect(u.ocrScans).toBe(10);
      expect(u.forecastRuns).toBe(5);
      expect(u.insightRuns).toBe(4);
      expect(u.tokensIn).toBe(1_540_000);
      expect(u.tokensOut).toBe(308_000);
      // haiku: 0.7M×$1 + 0.14M×$5 = 1.40 ; sonnet: 0.3M×$2 + 0.06M×$10 = 1.20
      // opus: 0.5M×$5 + 0.1M×$25 = 5.00 ; sonnet: 0.04M×$2 + 0.008M×$10 = 0.16 → 7.76
      expect(u.estSpendUsd).toBe(7.76);
      // 1 failure / 19 calls = 5.3%
      expect(u.errorRate).toBe(5.3);
    });

    it("returns zeros when the table is empty / the query fails", async () => {
      prisma.$queryRaw.mockRejectedValue(new Error("relation does not exist"));
      const u = await service.getAiUsage();
      expect(u).toMatchObject({
        ocrScans: 0,
        forecastRuns: 0,
        insightRuns: 0,
        tokensIn: 0,
        tokensOut: 0,
        estSpendUsd: 0,
        errorRate: 0,
      });
    });
  });

  describe("AI models (SA-1035)", () => {
    /** getValue's tagged-template call is ($queryRaw(strings, key)): answer by key. */
    const rows = (stored: Record<string, string>) =>
      prisma.$queryRaw.mockImplementation(async (_s: unknown, key: string) =>
        key in stored ? [{ value: stored[key] }] : [],
      );

    it("M-R1: the pickers offer the four latest models, with labels", async () => {
      rows({});
      const cfg = await service.getAiConfig();
      expect(cfg.availableModels).toEqual([
        { id: "claude-fable-5-1", label: "Fable 5.1" },
        { id: "claude-opus-5-5", label: "Opus 5.5" },
        { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
        { id: "claude-haiku-5-5", label: "Haiku 5.5" },
      ]);
    });

    it("M-R6: unset general and scan models read the 5.x fallbacks", async () => {
      rows({});
      expect(await service.resolveModelFor("general")).toBe("claude-sonnet-5-5");
      expect(await service.resolveModelFor("bill_scan")).toBe("claude-haiku-5-5");
      expect(await service.resolveModelFor("receipt_scan")).toBe("claude-opus-5-5");
      const cfg = await service.getAiConfig();
      expect(cfg.model).toBe("claude-sonnet-5-5");
      expect(cfg.scanModel).toBe("claude-haiku-5-5");
    });

    it("a stored scan model is read for bill_scan only", async () => {
      rows({ "claude.scanModel": "claude-sonnet-5-5", "claude.model": "claude-opus-5-5" });
      expect(await service.resolveModelFor("bill_scan")).toBe("claude-sonnet-5-5");
      expect(await service.resolveModelFor("general")).toBe("claude-opus-5-5");
      // the receipt task has no picker: a stored row never reaches it
      expect(await service.resolveModelFor("receipt_scan")).toBe("claude-opus-5-5");
    });

    it("M-G1: a stored older id resolves as stored and is reported as current", async () => {
      rows({ "claude.model": "claude-sonnet-4-5", "claude.scanModel": "claude-haiku-4-5" });
      expect(await service.resolveModelFor("general")).toBe("claude-sonnet-4-5");
      expect(await service.resolveModelFor("bill_scan")).toBe("claude-haiku-4-5");
      const cfg = await service.getAiConfig();
      expect(cfg.model).toBe("claude-sonnet-4-5");
      expect(cfg.scanModel).toBe("claude-haiku-4-5");
    });

    it("M-G2: resolveModel() is the general model and never reads the scan row", async () => {
      rows({ "claude.model": "claude-opus-5-5", "claude.scanModel": "claude-haiku-5-5" });
      expect(await service.resolveModel()).toBe("claude-opus-5-5");
      const keysRead = prisma.$queryRaw.mock.calls.map((c: unknown[]) => c[1]);
      expect(keysRead).not.toContain("claude.scanModel");
    });

    it.each([
      ["model", "claude-3-opus-20240229"],
      ["model", "nonsense"],
      ["scanModel", "claude-haiku-4-5"],
      ["scanModel", "nonsense"],
    ])(
      "M-R4: PATCH %s=%s is a coded 400 AI_MODEL_UNKNOWN and writes nothing",
      async (field, id) => {
        rows({});
        const err = await service.updateAiConfig({ [field]: id } as never).catch((e) => e);
        expect(err).toBeInstanceOf(BadRequestException);
        expect((err as BadRequestException).getResponse()).toMatchObject({
          code: API_ERROR_CODES.AI_MODEL_UNKNOWN,
        });
        expect(prisma.$executeRaw).not.toHaveBeenCalled();
      },
    );

    it("PATCH stores both models on their own keys", async () => {
      rows({});
      await service.updateAiConfig({ model: "claude-opus-5-5", scanModel: "claude-haiku-5-5" });
      const written = prisma.$executeRaw.mock.calls.map((c: unknown[]) => c[1]);
      expect(written).toEqual(expect.arrayContaining(["claude.model", "claude.scanModel"]));
    });

    it("prices a Fable id as Fable and a current Haiku as Haiku 5.5, not as Sonnet", async () => {
      prisma.$queryRaw.mockResolvedValue([
        {
          model: "claude-fable-5-1",
          feature: "forecast",
          calls: 1,
          inTok: 1_000_000,
          outTok: 1_000_000,
          failures: 0,
        },
        {
          model: "claude-haiku-5-5",
          feature: "ocr.vendor_bill",
          calls: 1,
          inTok: 1_000_000,
          outTok: 1_000_000,
          failures: 0,
        },
      ]);
      const u = await service.getAiUsage(30);
      // fable $10 in / $50 out; haiku 5.5 $0.10 in / $0.50 out (rates from Anthropic's pricing page, 2026-10-28)
      expect(u.estSpendUsd).toBeCloseTo(60.6, 2);
    });
  });

  describe("testConnection", () => {
    it("pings Anthropic and persists verifiedAt on success", async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([{ value: "sk-ant-test" }]) // resolveAnthropicKey
        .mockResolvedValueOnce([{ value: "claude-sonnet-4-5" }]); // resolveModel
      global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) }) as any;

      const res = await service.testConnection();

      expect(res.ok).toBe(true);
      expect((res as { verifiedAt?: string }).verifiedAt).toBeTruthy();
      // setValue("claude.verifiedAt", ...) is an $executeRaw upsert.
      expect(prisma.$executeRaw).toHaveBeenCalled();
    });

    it("returns ok:false with the API error message on failure", async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([{ value: "sk-ant-bad" }])
        .mockResolvedValueOnce([{ value: "claude-sonnet-4-5" }]);
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ error: { message: "invalid x-api-key" } }),
      }) as any;

      const res = await service.testConnection();

      expect(res.ok).toBe(false);
      expect(res.error).toBe("invalid x-api-key");
    });

    it("returns ok:false when no key is configured (never calls the API)", async () => {
      prisma.$queryRaw.mockResolvedValue([]); // no stored key; env returns undefined
      const fetchSpy = jest.fn();
      global.fetch = fetchSpy as any;

      const res = await service.testConnection();

      expect(res.ok).toBe(false);
      expect(res.error).toBe("No API key configured");
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe("house tenant id", () => {
    it("T12-1: reads platform.houseTenantId, returning null when unset", async () => {
      prisma.$queryRaw.mockResolvedValueOnce([{ value: "hq-1" }]).mockResolvedValueOnce([]);

      expect(await service.getHouseTenantId()).toBe("hq-1");
      expect(await service.getHouseTenantId()).toBeNull();
      // getValue binds the key as the single template parameter.
      expect(prisma.$queryRaw.mock.calls[0].slice(1)).toEqual(["platform.houseTenantId"]);
    });

    it("T12-2: writes platform.houseTenantId through a single upsert", async () => {
      await service.setHouseTenantId("hq-1");

      expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
      expect(prisma.$executeRaw.mock.calls[0].slice(1)).toEqual(["platform.houseTenantId", "hq-1"]);
    });
  });
});
