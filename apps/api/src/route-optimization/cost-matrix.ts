/**
 * Cost-matrix builder for the route optimizer.
 *
 * Self-contained module (no Nest injection) so it can be unit-tested in
 * isolation and reused by both the template optimizer and the run optimizer.
 * Primary source is Google's Routes API `computeRouteMatrix`; when the API
 * key is missing, the point count exceeds the matrix size limit, or the
 * Google call fails for any reason, it falls back to a haversine-derived
 * matrix so the solver always has something to work with.
 */

export interface LatLng {
  lat: number;
  lng: number;
}

export interface CostMatrices {
  durationSec: number[][]; // [from][to]
  distanceMeters: number[][];
  source: "google" | "haversine";
}

const MATRIX_URL = "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix";
const MAX_MATRIX_POINTS = 25; // origins*destinations must stay <= 625

// ─── Matrix cache (cost control) ────────────────────────────────────────────
//
// Google bills computeRouteMatrix PER ELEMENT (n²) — a 20-stop optimize is
// ~441 billable elements. A tenant's recurring daily route (same stops, same
// avoidTolls setting) would otherwise re-pay for the identical matrix on every
// optimize call. Cache real Google results only — never haversine fallbacks,
// which cost nothing to recompute and would otherwise "poison" the cache with
// low-quality synthetic data under a Google outage.

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const CACHE_MAX_ENTRIES = 500;

interface CacheEntry {
  matrices: CostMatrices;
  at: number;
}

const matrixCache = new Map<string, CacheEntry>();

function cacheKey(points: LatLng[], avoidTolls: boolean): string {
  return points.map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join("|") + "!" + avoidTolls;
}

function cacheGet(key: string): CostMatrices | undefined {
  const entry = matrixCache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.at > CACHE_TTL_MS) {
    matrixCache.delete(key);
    return undefined;
  }
  // Refresh recency: Map iterates in insertion order, so deleting and
  // re-inserting moves this key to the back of the eviction queue. Without
  // this the cache would evict by insertion age (FIFO) and drop a tenant's
  // hottest daily route while cold one-off matrices survived.
  matrixCache.delete(key);
  matrixCache.set(key, entry);
  // Structured clone so a caller can never mutate the shared cached matrices
  // and poison every later hit on the same geography.
  return structuredClone(entry.matrices);
}

function cacheSet(key: string, matrices: CostMatrices): void {
  // Clone on the way in as well as out: the value handed back to *this* caller
  // must not alias the cached copy either.
  matrixCache.set(key, { matrices: structuredClone(matrices), at: Date.now() });
  if (matrixCache.size > CACHE_MAX_ENTRIES) {
    // Map iterates in insertion order — the first key is the oldest insertion.
    const oldestKey: string | undefined = matrixCache.keys().next().value;
    if (oldestKey !== undefined) matrixCache.delete(oldestKey);
  }
}

export async function buildCostMatrices(
  points: LatLng[],
  opts: {
    avoidTolls: boolean;
    apiKey?: string;
    tenantId?: string;
    logger?: { warn(m: string): void; log?(m: string): void };
  },
): Promise<CostMatrices> {
  const n = points.length;
  if (!opts.apiKey || n < 2 || n > MAX_MATRIX_POINTS) return haversineMatrices(points);

  const key = cacheKey(points, opts.avoidTolls);
  const cached = cacheGet(key);
  if (cached) return cached;

  try {
    const body = {
      origins: points.map((p) => ({
        waypoint: { location: { latLng: { latitude: p.lat, longitude: p.lng } } },
      })),
      destinations: points.map((p) => ({
        waypoint: { location: { latLng: { latitude: p.lat, longitude: p.lng } } },
      })),
      travelMode: "DRIVE",
      routingPreference: "TRAFFIC_UNAWARE",
      ...(opts.avoidTolls ? { routeModifiers: { avoidTolls: true } } : {}),
    };
    const res = await fetch(MATRIX_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": opts.apiKey,
        "X-Goog-FieldMask": "originIndex,destinationIndex,duration,distanceMeters,condition",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`computeRouteMatrix ${res.status}`);
    // Billing telemetry: logged only once the call is known to have been
    // accepted, so a failed (unbilled) request is never counted as spend.
    opts.logger?.log?.(
      `routes-billing matrix elements=${n * n} tenant=${opts.tenantId ?? "unknown"}`,
    );
    // Response is a JSON ARRAY of elements, not a nested matrix.
    const elements = (await res.json()) as Array<{
      originIndex?: number;
      destinationIndex?: number;
      duration?: string; // "123s"
      distanceMeters?: number;
      condition?: string; // "ROUTE_EXISTS" | "ROUTE_NOT_FOUND"
    }>;
    const dur = emptyMatrix(n);
    const dist = emptyMatrix(n);
    for (const el of elements) {
      if (el.condition && el.condition !== "ROUTE_EXISTS") throw new Error("matrix hole");
      // proto3 JSON omits int32 fields equal to their default, so index 0 can
      // arrive as an absent key. Without the `?? 0` those elements would throw
      // (dur[undefined][j]) and silently drop the whole matrix to haversine.
      const oi = el.originIndex ?? 0;
      const di = el.destinationIndex ?? 0;
      dur[oi][di] = parseFloat((el.duration ?? "0s").replace(/s$/, ""));
      dist[oi][di] = el.distanceMeters ?? 0;
    }
    // Every off-diagonal cell must be filled; a sparse response falls back.
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++)
        if (i !== j && (dur[i][j] === undefined || dist[i][j] === undefined))
          throw new Error("sparse matrix");
    const result: CostMatrices = { durationSec: dur, distanceMeters: dist, source: "google" };
    cacheSet(key, result);
    return result;
  } catch (err) {
    opts.logger?.warn(`Route matrix via Google failed (${String(err)}) — haversine fallback`);
    return haversineMatrices(points);
  }
}

// ─── Haversine fallback ─────────────────────────────────────────────────────

function haversineMatrices(points: LatLng[]): CostMatrices {
  const n = points.length;
  const durationSec = emptyMatrix(n);
  const distanceMeters = emptyMatrix(n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const meters = haversineKm(points[i], points[j]) * 1000;
      distanceMeters[i][j] = meters;
      // ~11.1 m/s (≈40 km/h urban average) — synthetic but order-consistent.
      durationSec[i][j] = meters / 11.1;
    }
  }
  return { durationSec, distanceMeters, source: "haversine" };
}

function emptyMatrix(n: number): number[][] {
  const m: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row: number[] = new Array(n).fill(undefined as unknown as number);
    row[i] = 0;
    m.push(row);
  }
  return m;
}

function haversineKm(a: LatLng, b: LatLng): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}
