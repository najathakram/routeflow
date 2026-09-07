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
  let resolveStartTime: jest.Mock;
  let calculateETAs: jest.Mock;

  // Deliberately NOT "08:00": that is the literal analyzeRoute falls back to
  // inline today (`route-analysis.service.ts:76`), so a clock that only
  // coincides with the fallback would prove nothing. T6 asserts THIS value
  // reaches the ETA pass.
  const RESOLVED_START_TIME = "06:45";

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
    // F12/P1: analyzeRoute is expected to route its start-time precedence
    // through the shared RouteOptimizationService.resolveStartTime helper
    // instead of inlining it — this mock exists so the four pre-existing
    // tests below keep resolving a start time once that call is wired in.
    // `mockReturnValue` works whether the helper ends up sync or async
    // (`await "06:45"` is "06:45").
    resolveStartTime = jest.fn().mockReturnValue(RESOLVED_START_TIME);
    calculateETAs = jest.fn().mockReturnValue(etas);
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
            calculateETAs,
            resolveStartTime,
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

  // T8 (F12, review finding #0): the dispatch modals only need the
  // deterministic ETA/window pass, so `windowsOnly` must answer from it and
  // never reach the metered Anthropic path — WITH a key configured (the
  // beforeEach default), which is what makes this distinct from the
  // no-API-key test below.
  it("windowsOnly returns the ETA pass without calling the model or recording usage", async () => {
    const result = await service.analyzeRoute("route-1", undefined, { windowsOnly: true });

    expect(result.etas).toEqual(etas);
    expect(result.configured).toBe(false);
    expect(resolveAnthropicKey).not.toHaveBeenCalled();
    expect(mockAnthropicCreate).not.toHaveBeenCalled();
    expect(recordAiUsage).not.toHaveBeenCalled();
  });

  it("records nothing when no API key is configured (no model call happens)", async () => {
    resolveAnthropicKey.mockResolvedValue(null);

    const result = await service.analyzeRoute("route-1");

    expect(result.configured).toBe(false);
    expect(mockAnthropicCreate).not.toHaveBeenCalled();
    expect(recordAiUsage).not.toHaveBeenCalled();
  });

  // T6 (F12, tagged REG-B177 so the red gate's -t filter collects it):
  // analyzeRoute's ETA pass must resolve its start time through the SAME
  // resolveStartTime helper optimize uses (B177's invariant — one clock for
  // the solver and the ETA pass) — never re-derive the precedence inline —
  // while still returning configured:false with no API key.
  //
  // The load-bearing oracle is the THIRD calculateETAs argument: it must be
  // the value the helper resolved (RESOLVED_START_TIME), not the inline
  // `startTime ?? defaultStartTimeRaw ?? "08:00"` chain at
  // route-analysis.service.ts:76. Argument-shape of resolveStartTime itself is
  // deliberately NOT pinned (the ruling leaves `resolveStartTime(run?, route?)`
  // free to take the run/route/explicit override in any arrangement) — what is
  // pinned is that it is consulted and that its answer is what the ETA pass runs on.
  it("REG-B177: analyzeRoute runs its ETA pass on the clock resolveStartTime returned, and returns configured:false without an API key", async () => {
    resolveAnthropicKey.mockResolvedValue(null);

    const result = await service.analyzeRoute("route-1");

    // Distinguishing oracle FIRST: today this fails on the value
    // (expected "06:45", received the inlined "08:00"), not on an absence.
    expect(calculateETAs).toHaveBeenCalledWith(
      null, // resolveDepot → null
      expect.any(Array),
      RESOLVED_START_TIME,
      expect.any(Number), // avgSpeedKmh
      expect.any(Number), // serviceTimeMinutes
    );
    expect(resolveStartTime).toHaveBeenCalled();
    expect(result.configured).toBe(false);
    expect(mockAnthropicCreate).not.toHaveBeenCalled();
  });

  // T7-run (F12, tagged REG-B177): analyzeRouteRun must resolve its clock
  // through the SAME helper — and with the SAME precedence — as optimize: an
  // explicit operator override first, the run's snapshotted startTime second.
  // The load-bearing oracle is the ARGUMENT ORDER: with the arguments swapped
  // (`resolveStartTime(run.startTime, startTime)`) the snapshot would silently
  // beat the operator's override, and the third `calculateETAs` argument would
  // still be a plausible clock — so both are asserted.
  it("REG-B177: analyzeRouteRun resolves its clock with the explicit override ahead of the run's snapshot", async () => {
    resolveAnthropicKey.mockResolvedValue(null);
    prisma.routeRun.findUnique.mockResolvedValue({
      id: "run-1",
      routeId: "route-1",
      startTime: "07:30", // the run's snapshot — must LOSE to the override
      depotLat: 0.5,
      depotLng: 1.5,
      depotAddress: "Depot",
      route: { id: "route-1", depotAddress: "Depot" },
      stops: [
        {
          id: "run-stop-1",
          stopNumber: 1,
          routeStop: {
            customer: {
              id: "cust-1",
              businessName: "Acme",
              deliveryWindowStart: null,
              deliveryWindowEnd: null,
            },
            customerAddress: { lat: 1.5, lng: 2.5 },
          },
        },
      ],
    });

    const result = await service.analyzeRouteRun("run-1", "09:15");

    expect(resolveStartTime).toHaveBeenCalledWith("09:15", "07:30");
    expect(calculateETAs).toHaveBeenCalledWith(
      { lat: 0.5, lng: 1.5 }, // the run's snapshotted depot
      expect.any(Array),
      RESOLVED_START_TIME,
      expect.any(Number), // avgSpeedKmh
      expect.any(Number), // serviceTimeMinutes
    );
    expect(result.configured).toBe(false);
  });
});
