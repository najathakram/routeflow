import { Test, TestingModule } from "@nestjs/testing";
import { RouteAnalysisService } from "./route-analysis.service";
import { RouteOptimizationService } from "./route-optimization.service";
import { PrismaService } from "../prisma/prisma.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { PlatformConfigService } from "../platform-admin/platform-config.service";
import { createMockPrisma } from "../testing/prisma-mock";

const mockAnthropicCreate = jest.fn();
jest.mock("@anthropic-ai/sdk", () => ({
  __esModule: true,
  default: jest.fn(() => ({ messages: { create: mockAnthropicCreate } })),
}));

describe("RouteAnalysisService — AI usage metering", () => {
  let service: RouteAnalysisService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let recordAiUsage: jest.Mock;
  let resolveAnthropicKey: jest.Mock;

  const route = {
    id: "route-1",
    name: "North loop",
    depotAddress: null,
    stops: [
      {
        id: "stop-1",
        stopNumber: 1,
        customer: {
          id: "cust-1",
          businessName: "Acme",
          deliveryWindowStart: null,
          deliveryWindowEnd: null,
        },
        customerAddress: { lat: 1.5, lng: 2.5 },
      },
    ],
  };

  const etas = [
    {
      stopNumber: 1,
      customerName: "Acme",
      arrivalTime: "08:30",
      deliveryWindowStart: null,
      deliveryWindowEnd: null,
      withinWindow: null,
    },
  ];

  beforeEach(async () => {
    prisma = createMockPrisma();
    recordAiUsage = jest.fn();
    resolveAnthropicKey = jest.fn().mockResolvedValue("test-key");
    mockAnthropicCreate.mockReset();
    prisma.route.findUnique.mockResolvedValue(route);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RouteAnalysisService,
        { provide: PrismaService, useValue: prisma },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        {
          provide: PlatformConfigService,
          useValue: {
            resolveAnthropicKey,
            resolveModel: jest.fn().mockResolvedValue("claude-sonnet-4-5"),
            recordAiUsage,
          },
        },
        {
          provide: RouteOptimizationService,
          useValue: {
            resolveDepot: jest.fn().mockResolvedValue(null),
            calculateETAs: jest.fn().mockReturnValue(etas),
          },
        },
      ],
    }).compile();
    service = module.get<RouteAnalysisService>(RouteAnalysisService);
  });

  it("records a tenant-tagged AiUsageEvent with the response's token counts on success", async () => {
    mockAnthropicCreate.mockResolvedValue({
      content: [
        { type: "text", text: JSON.stringify({ summary: "ok", stops: [], suggestions: [] }) },
      ],
      usage: { input_tokens: 777, output_tokens: 88 },
    });

    const result = await service.analyzeRoute("route-1");

    expect(result.configured).toBe(true);
    expect(result.summary).toBe("ok");
    expect(recordAiUsage).toHaveBeenCalledWith({
      tenantId: "test-tenant",
      feature: "insights.route",
      model: "claude-sonnet-4-5",
      inputTokens: 777,
      outputTokens: 88,
    });
  });

  it("records a failed AiUsageEvent when the model call errors (and still returns ETAs)", async () => {
    mockAnthropicCreate.mockRejectedValue(new Error("overloaded"));

    const result = await service.analyzeRoute("route-1");

    expect(result.summary).toMatch(/AI analysis unavailable/);
    expect(result.etas).toEqual(etas);
    expect(recordAiUsage).toHaveBeenCalledTimes(1);
    expect(recordAiUsage).toHaveBeenCalledWith(
      expect.objectContaining({ feature: "insights.route", success: false }),
    );
  });

  it("records the real spend exactly once when the call succeeds but the response is unparseable", async () => {
    mockAnthropicCreate.mockResolvedValue({
      content: [{ type: "text", text: "not json at all" }],
      usage: { input_tokens: 500, output_tokens: 50 },
    });

    const result = await service.analyzeRoute("route-1");

    // Parse failure falls back to ETAs-only, but the tokens were spent — one
    // success row, no extra failure row.
    expect(result.summary).toMatch(/AI analysis unavailable/);
    expect(recordAiUsage).toHaveBeenCalledTimes(1);
    expect(recordAiUsage).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: 500, outputTokens: 50 }),
    );
  });

  it("records nothing when no API key is configured (no model call happens)", async () => {
    resolveAnthropicKey.mockResolvedValue(null);

    const result = await service.analyzeRoute("route-1");

    expect(result.configured).toBe(false);
    expect(mockAnthropicCreate).not.toHaveBeenCalled();
    expect(recordAiUsage).not.toHaveBeenCalled();
  });
});
