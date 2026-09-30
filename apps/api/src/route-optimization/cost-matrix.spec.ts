import { buildCostMatrices, type LatLng } from "./cost-matrix";

// `offset` shifts the whole point set into a distinct geographic area so each
// test gets its own cache key — the module-level matrix cache persists across
// tests in this file, and a cache hit would otherwise skip the very network
// call a given test exists to exercise.
function makePoints(n: number, offset = 0): LatLng[] {
  const base = 40 + offset;
  return Array.from({ length: n }, (_, i) => ({ lat: base + i * 0.01, lng: -73 - i * 0.01 }));
}

function mockFetchOnce(response: { ok: boolean; status?: number; json?: () => Promise<unknown> }) {
  (global.fetch as jest.Mock).mockResolvedValueOnce({
    ok: response.ok,
    status: response.status ?? (response.ok ? 200 : 500),
    json: response.json ?? (async () => []),
  });
}

const sixExistsElements = [
  {
    originIndex: 0,
    destinationIndex: 1,
    duration: "120s",
    distanceMeters: 1000,
    condition: "ROUTE_EXISTS",
  },
  {
    originIndex: 0,
    destinationIndex: 2,
    duration: "240s",
    distanceMeters: 2000,
    condition: "ROUTE_EXISTS",
  },
  {
    originIndex: 1,
    destinationIndex: 0,
    duration: "130s",
    distanceMeters: 1100,
    condition: "ROUTE_EXISTS",
  },
  {
    originIndex: 1,
    destinationIndex: 2,
    duration: "150s",
    distanceMeters: 1300,
    condition: "ROUTE_EXISTS",
  },
  {
    originIndex: 2,
    destinationIndex: 0,
    duration: "250s",
    distanceMeters: 2100,
    condition: "ROUTE_EXISTS",
  },
  {
    originIndex: 2,
    destinationIndex: 1,
    duration: "160s",
    distanceMeters: 1400,
    condition: "ROUTE_EXISTS",
  },
];

describe("buildCostMatrices", () => {
  const logger = { warn: jest.fn(), log: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    (global as any).fetch = jest.fn();
  });

  it("parses the Google element-array response shape into a nested matrix", async () => {
    const points = makePoints(3, 1);
    mockFetchOnce({ ok: true, json: async () => sixExistsElements });

    const result = await buildCostMatrices(points, {
      avoidTolls: false,
      apiKey: "test-key",
      logger,
    });

    expect(result.source).toBe("google");
    expect(result.durationSec[0][1]).toBe(120);
    expect(result.distanceMeters[0][1]).toBe(1000);
    expect(result.durationSec[1][0]).toBe(130);
    expect(result.durationSec[2][1]).toBe(160);
    expect(result.durationSec[0][0]).toBe(0);
    expect(result.durationSec[1][1]).toBe(0);
    expect(result.durationSec[2][2]).toBe(0);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("falls back to haversine when the response is sparse (missing off-diagonal cells)", async () => {
    const points = makePoints(3, 2);
    // Only 2 of the required 6 off-diagonal elements are returned.
    const elements = [
      {
        originIndex: 0,
        destinationIndex: 1,
        duration: "120s",
        distanceMeters: 1000,
        condition: "ROUTE_EXISTS",
      },
      {
        originIndex: 1,
        destinationIndex: 0,
        duration: "130s",
        distanceMeters: 1100,
        condition: "ROUTE_EXISTS",
      },
    ];
    mockFetchOnce({ ok: true, json: async () => elements });

    const result = await buildCostMatrices(points, {
      avoidTolls: false,
      apiKey: "test-key",
      logger,
    });

    expect(result.source).toBe("haversine");
    expect(result.durationSec[0][0]).toBe(0);
    expect(result.distanceMeters[0][1]).toBeGreaterThan(0);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("haversine fallback"));
  });

  it("falls back to haversine when a ROUTE_NOT_FOUND condition is present", async () => {
    const points = makePoints(3, 3);
    const elements = [
      { originIndex: 0, destinationIndex: 1, condition: "ROUTE_NOT_FOUND" },
      {
        originIndex: 0,
        destinationIndex: 2,
        duration: "240s",
        distanceMeters: 2000,
        condition: "ROUTE_EXISTS",
      },
      {
        originIndex: 1,
        destinationIndex: 0,
        duration: "130s",
        distanceMeters: 1100,
        condition: "ROUTE_EXISTS",
      },
      {
        originIndex: 1,
        destinationIndex: 2,
        duration: "150s",
        distanceMeters: 1300,
        condition: "ROUTE_EXISTS",
      },
      {
        originIndex: 2,
        destinationIndex: 0,
        duration: "250s",
        distanceMeters: 2100,
        condition: "ROUTE_EXISTS",
      },
      {
        originIndex: 2,
        destinationIndex: 1,
        duration: "160s",
        distanceMeters: 1400,
        condition: "ROUTE_EXISTS",
      },
    ];
    mockFetchOnce({ ok: true, json: async () => elements });

    const result = await buildCostMatrices(points, {
      avoidTolls: false,
      apiKey: "test-key",
      logger,
    });
    expect(result.source).toBe("haversine");
  });

  it("falls back to haversine on a non-ok HTTP response", async () => {
    const points = makePoints(3, 4);
    mockFetchOnce({ ok: false, status: 429 });

    const result = await buildCostMatrices(points, {
      avoidTolls: false,
      apiKey: "test-key",
      logger,
    });

    expect(result.source).toBe("haversine");
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("computeRouteMatrix 429"));
    // Billing telemetry fires only once the call is known to have been
    // accepted — a rejected request costs nothing and must not be counted.
    expect(logger.log).not.toHaveBeenCalled();
  });

  it("falls back to haversine without calling fetch when no apiKey is provided", async () => {
    const points = makePoints(3, 5);
    const result = await buildCostMatrices(points, { avoidTolls: false, logger });
    expect(result.source).toBe("haversine");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("falls back to haversine without calling fetch when n exceeds MAX_MATRIX_POINTS (25)", async () => {
    const points = makePoints(26, 6);
    const result = await buildCostMatrices(points, {
      avoidTolls: false,
      apiKey: "test-key",
      logger,
    });
    expect(result.source).toBe("haversine");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("falls back to haversine without calling fetch when fewer than 2 points are given", async () => {
    const result = await buildCostMatrices(makePoints(1, 7), {
      avoidTolls: false,
      apiKey: "test-key",
      logger,
    });
    expect(result.source).toBe("haversine");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("stays within the matrix size limit exactly at n=25 (uses Google)", async () => {
    const points = makePoints(25, 8);
    const elements: Array<{
      originIndex: number;
      destinationIndex: number;
      duration: string;
      distanceMeters: number;
      condition: string;
    }> = [];
    for (let i = 0; i < 25; i++) {
      for (let j = 0; j < 25; j++) {
        if (i === j) continue;
        elements.push({
          originIndex: i,
          destinationIndex: j,
          duration: "100s",
          distanceMeters: 500,
          condition: "ROUTE_EXISTS",
        });
      }
    }
    mockFetchOnce({ ok: true, json: async () => elements });

    const result = await buildCostMatrices(points, {
      avoidTolls: false,
      apiKey: "test-key",
      logger,
    });
    expect(result.source).toBe("google");
  });

  it("forwards avoidTolls into the computeRouteMatrix request body", async () => {
    const points = makePoints(2, 9);
    mockFetchOnce({
      ok: true,
      json: async () => [
        {
          originIndex: 0,
          destinationIndex: 1,
          duration: "60s",
          distanceMeters: 500,
          condition: "ROUTE_EXISTS",
        },
        {
          originIndex: 1,
          destinationIndex: 0,
          duration: "60s",
          distanceMeters: 500,
          condition: "ROUTE_EXISTS",
        },
      ],
    });

    await buildCostMatrices(points, { avoidTolls: true, apiKey: "test-key", logger });

    const fetchMock = global.fetch as jest.Mock;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix");
    const body = JSON.parse(init.body as string);
    expect(body.routeModifiers).toEqual({ avoidTolls: true });
    expect(init.headers["X-Goog-Api-Key"]).toBe("test-key");
  });

  it("omits routeModifiers when avoidTolls is false", async () => {
    const points = makePoints(2, 10);
    mockFetchOnce({
      ok: true,
      json: async () => [
        {
          originIndex: 0,
          destinationIndex: 1,
          duration: "60s",
          distanceMeters: 500,
          condition: "ROUTE_EXISTS",
        },
        {
          originIndex: 1,
          destinationIndex: 0,
          duration: "60s",
          distanceMeters: 500,
          condition: "ROUTE_EXISTS",
        },
      ],
    });

    await buildCostMatrices(points, { avoidTolls: false, apiKey: "test-key", logger });

    const fetchMock = global.fetch as jest.Mock;
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.routeModifiers).toBeUndefined();
  });

  it("falls back to haversine when fetch throws (network error)", async () => {
    const points = makePoints(3, 11);
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const result = await buildCostMatrices(points, {
      avoidTolls: false,
      apiKey: "test-key",
      logger,
    });
    expect(result.source).toBe("haversine");
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("ECONNREFUSED"));
  });

  // ─── Cost control: matrix cache + billing telemetry ────────────────────

  it("emits a routes-billing telemetry line with the element count for a real matrix call", async () => {
    const points = makePoints(3, 12);
    mockFetchOnce({ ok: true, json: async () => sixExistsElements });

    await buildCostMatrices(points, {
      avoidTolls: false,
      apiKey: "test-key",
      tenantId: "tenant-42",
      logger,
    });

    expect(logger.log).toHaveBeenCalledWith("routes-billing matrix elements=9 tenant=tenant-42");
  });

  it("caches a successful Google result: two identical calls only fetch once", async () => {
    const points = makePoints(3, 13);
    mockFetchOnce({ ok: true, json: async () => sixExistsElements });

    const first = await buildCostMatrices(points, {
      avoidTolls: false,
      apiKey: "test-key",
      logger,
    });
    const second = await buildCostMatrices(points, {
      avoidTolls: false,
      apiKey: "test-key",
      logger,
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(second.source).toBe("google");
    expect(second).toEqual(first);
    // Telemetry only fires for the real (first) call — a cache hit makes no
    // billable request.
    expect(logger.log).toHaveBeenCalledTimes(1);
  });

  it("does not serve a cached result across a different avoidTolls setting (distinct cache key)", async () => {
    const points = makePoints(3, 14);
    mockFetchOnce({ ok: true, json: async () => sixExistsElements });
    mockFetchOnce({ ok: true, json: async () => sixExistsElements });

    await buildCostMatrices(points, { avoidTolls: false, apiKey: "test-key", logger });
    await buildCostMatrices(points, { avoidTolls: true, apiKey: "test-key", logger });

    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("tolerates elements that omit index 0 (proto3 JSON default omission)", async () => {
    // Google's JSON mapping drops int32 fields equal to their default, so
    // originIndex/destinationIndex 0 can arrive as absent keys. Without the
    // `?? 0` defaulting this throws and silently drops to haversine forever.
    const points = makePoints(2, 16);
    mockFetchOnce({
      ok: true,
      json: async () => [
        // origin 0 → destination 1: originIndex omitted.
        { destinationIndex: 1, duration: "60s", distanceMeters: 500, condition: "ROUTE_EXISTS" },
        // origin 1 → destination 0: destinationIndex omitted.
        { originIndex: 1, duration: "90s", distanceMeters: 800, condition: "ROUTE_EXISTS" },
      ],
    });

    const result = await buildCostMatrices(points, {
      avoidTolls: false,
      apiKey: "test-key",
      logger,
    });

    expect(result.source).toBe("google");
    expect(result.durationSec[0][1]).toBe(60);
    expect(result.distanceMeters[0][1]).toBe(500);
    expect(result.durationSec[1][0]).toBe(90);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("hands back an independent copy, so a caller mutating the result can't poison the cache", async () => {
    const points = makePoints(3, 17);
    mockFetchOnce({ ok: true, json: async () => sixExistsElements });

    const first = await buildCostMatrices(points, {
      avoidTolls: false,
      apiKey: "test-key",
      logger,
    });
    first.durationSec[0][1] = 99999;

    const second = await buildCostMatrices(points, {
      avoidTolls: false,
      apiKey: "test-key",
      logger,
    });

    expect(global.fetch).toHaveBeenCalledTimes(1); // still a cache hit
    expect(second.durationSec[0][1]).toBe(120); // unaffected by the mutation
  });

  it("never caches a haversine fallback result — a second identical call still fetches", async () => {
    const points = makePoints(3, 15);
    // First call: Google returns a sparse response, falls back to haversine.
    mockFetchOnce({
      ok: true,
      json: async () => [
        {
          originIndex: 0,
          destinationIndex: 1,
          duration: "120s",
          distanceMeters: 1000,
          condition: "ROUTE_EXISTS",
        },
      ],
    });
    // Second call with the identical points/avoidTolls: since nothing was
    // cached, this should hit the network again (and this time succeed).
    mockFetchOnce({ ok: true, json: async () => sixExistsElements });

    const first = await buildCostMatrices(points, {
      avoidTolls: false,
      apiKey: "test-key",
      logger,
    });
    const second = await buildCostMatrices(points, {
      avoidTolls: false,
      apiKey: "test-key",
      logger,
    });

    expect(first.source).toBe("haversine");
    expect(second.source).toBe("google");
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});
