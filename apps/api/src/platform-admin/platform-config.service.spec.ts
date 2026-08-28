import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { PlatformConfigService } from "./platform-config.service";
import { PrismaService } from "../prisma/prisma.service";

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
      // haiku: 0.7M×$0.8 + 0.14M×$4 = 1.12 ; sonnet: 0.3M×$3 + 0.06M×$15 = 1.8
      // opus: 0.5M×$15 + 0.1M×$75 = 15 ; sonnet: 0.04M×$3 + 0.008M×$15 = 0.24 → 18.16
      expect(u.estSpendUsd).toBe(18.16);
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
});
