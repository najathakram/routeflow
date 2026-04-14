import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";

// ─── Types ────────────────────────────────────────────────────────────────────

interface StopWithCoords {
  id: string;
  stopNumber: number;
  customerName: string;
  lat: number;
  lng: number;
  deliveryWindowStart?: string | null;
  deliveryWindowEnd?: string | null;
}

/** Convert "HH:mm" (24h) to seconds from midnight */
function timeToSec(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 3600 + m * 60;
}

export interface OptimizeResult {
  stopOrder: Array<{ stopId: string; stopNumber: number }>;
  reorderedCount: number;
  usedFallback: boolean;
}

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class RouteOptimizationService {
  private readonly logger = new Logger(RouteOptimizationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async optimizeTemplate(routeId: string): Promise<OptimizeResult> {
    const route = await this.prisma.forTenant().route.findUnique({
      where: { id: routeId },
      include: {
        stops: {
          include: {
            customer: {
              select: {
                id: true,
                businessName: true,
                deliveryWindowStart: true,
                deliveryWindowEnd: true,
              },
            },
            customerAddress: true,
          },
          orderBy: { stopNumber: "asc" },
        },
      },
    });

    if (!route) throw new NotFoundException("Route not found");
    if (route.stops.length === 0) {
      return { stopOrder: [], reorderedCount: 0, usedFallback: false };
    }

    // Geocode any stops missing lat/lng
    for (const stop of route.stops) {
      const addr = stop.customerAddress;
      if (!addr || (addr.lat != null && addr.lng != null)) continue;
      const coords = await this.geocodeAddress(addr);
      if (coords) {
        await this.prisma
          .forTenant()
          .customerAddress.update({ where: { id: addr.id }, data: coords });
        addr.lat = coords.lat;
        addr.lng = coords.lng;
      }
    }

    // Validate all stops have coordinates
    const missingCoords = route.stops.filter(
      (s) => s.customerAddress?.lat == null || s.customerAddress?.lng == null,
    );
    if (missingCoords.length > 0) {
      const names = missingCoords.map((s) => s.customer?.businessName ?? s.id).join(", ");
      throw new BadRequestException(
        `Missing geocoded addresses for: ${names}. Set GOOGLE_MAPS_API_KEY to auto-geocode.`,
      );
    }

    const stops: StopWithCoords[] = route.stops.map((s) => ({
      id: s.id,
      stopNumber: s.stopNumber,
      customerName: s.customer?.businessName ?? s.id,
      lat: s.customerAddress!.lat!,
      lng: s.customerAddress!.lng!,
      deliveryWindowStart: s.customer?.deliveryWindowStart,
      deliveryWindowEnd: s.customer?.deliveryWindowEnd,
    }));

    let optimizedIds: string[];
    let usedFallback = false;

    try {
      optimizedIds = await this.callOrsOptimization(stops);
    } catch (err: unknown) {
      this.logger.warn(
        "ORS optimization failed — applying nearest-neighbor fallback",
        err instanceof Error ? err.message : String(err),
      );
      optimizedIds = this.nearestNeighborFallback(stops);
      usedFallback = true;
    }

    const stopOrder = optimizedIds.map((stopId, idx) => ({
      stopId,
      stopNumber: idx + 1,
    }));

    // Two-phase update to avoid @@unique([routeId, stopNumber]) violations:
    // Phase 1 shifts every stop to a temporary position (n + offset) so positions
    // 1..n are free, then Phase 2 writes the real optimized order.
    const offset = stops.length + 1;
    await this.prisma.$transaction([
      ...stops.map((s) =>
        this.prisma.forTenant().routeStop.update({
          where: { id: s.id },
          data: { stopNumber: s.stopNumber + offset },
        }),
      ),
      ...stopOrder.map(({ stopId, stopNumber }) =>
        this.prisma.forTenant().routeStop.update({
          where: { id: stopId },
          data: { stopNumber },
        }),
      ),
    ]);

    const originalOrder = new Map(stops.map((s) => [s.id, s.stopNumber]));
    const reorderedCount = stopOrder.filter(
      ({ stopId, stopNumber }) => originalOrder.get(stopId) !== stopNumber,
    ).length;

    return { stopOrder, reorderedCount, usedFallback };
  }

  async optimizeRoute(routeRunId: string): Promise<OptimizeResult> {
    const run = await this.prisma.forTenant().routeRun.findUnique({
      where: { id: routeRunId },
      include: {
        stops: {
          include: {
            routeStop: {
              include: {
                customer: {
                  select: {
                    id: true,
                    businessName: true,
                    deliveryWindowStart: true,
                    deliveryWindowEnd: true,
                  },
                },
                customerAddress: true,
              },
            },
          },
          orderBy: { stopNumber: "asc" },
        },
      },
    });

    if (!run) throw new NotFoundException("Route run not found");
    if (run.stops.length === 0) {
      return { stopOrder: [], reorderedCount: 0, usedFallback: false };
    }

    // Geocode any stops missing lat/lng
    for (const stop of run.stops) {
      const addr = stop.routeStop.customerAddress;
      if (!addr || (addr.lat != null && addr.lng != null)) continue;
      const coords = await this.geocodeAddress(addr);
      if (coords) {
        await this.prisma.forTenant().customerAddress.update({
          where: { id: addr.id },
          data: coords,
        });
        addr.lat = coords.lat;
        addr.lng = coords.lng;
      }
    }

    // Validate all stops have coordinates
    const missingCoords = run.stops.filter(
      (s) => s.routeStop.customerAddress?.lat == null || s.routeStop.customerAddress?.lng == null,
    );
    if (missingCoords.length > 0) {
      const names = missingCoords.map((s) => s.routeStop.customer?.businessName ?? s.id).join(", ");
      throw new BadRequestException(
        `Missing geocoded addresses for: ${names}. Set GOOGLE_MAPS_API_KEY to auto-geocode.`,
      );
    }

    const stops: StopWithCoords[] = run.stops.map((s) => ({
      id: s.id,
      stopNumber: s.stopNumber,
      customerName: s.routeStop.customer?.businessName ?? s.id,
      lat: s.routeStop.customerAddress!.lat!,
      lng: s.routeStop.customerAddress!.lng!,
      deliveryWindowStart: s.routeStop.customer?.deliveryWindowStart,
      deliveryWindowEnd: s.routeStop.customer?.deliveryWindowEnd,
    }));

    let optimizedIds: string[];
    let usedFallback = false;

    try {
      optimizedIds = await this.callOrsOptimization(stops);
    } catch (err: unknown) {
      this.logger.warn(
        "ORS optimization failed — applying nearest-neighbor fallback",
        err instanceof Error ? err.message : String(err),
      );
      optimizedIds = this.nearestNeighborFallback(stops);
      usedFallback = true;
    }

    const stopOrder = optimizedIds.map((stopId, idx) => ({
      stopId,
      stopNumber: idx + 1,
    }));

    // Two-phase update to avoid @@unique([routeRunId, stopNumber]) violations.
    const offset = stops.length + 1;
    await this.prisma.$transaction([
      ...stops.map((s) =>
        this.prisma.forTenant().routeRunStop.update({
          where: { id: s.id },
          data: { stopNumber: s.stopNumber + offset },
        }),
      ),
      ...stopOrder.map(({ stopId, stopNumber }) =>
        this.prisma.forTenant().routeRunStop.update({
          where: { id: stopId },
          data: { stopNumber },
        }),
      ),
    ]);

    await this.prisma.forTenant().routeRun.update({
      where: { id: routeRunId },
      data: { manuallyReordered: false },
    });

    const originalOrder = new Map(stops.map((s) => [s.id, s.stopNumber]));
    const reorderedCount = stopOrder.filter(
      ({ stopId, stopNumber }) => originalOrder.get(stopId) !== stopNumber,
    ).length;

    return { stopOrder, reorderedCount, usedFallback };
  }

  // ─── ORS Vroom API ────────────────────────────────────────────────────────

  private async callOrsOptimization(stops: StopWithCoords[]): Promise<string[]> {
    const apiKey = this.config.get<string>("ors.apiKey") ?? "";
    if (!apiKey) throw new Error("ORS_API_KEY not configured");

    const first = stops[0];
    const body = {
      vehicles: [
        {
          id: 1,
          profile: "driving-car",
          start: [first.lng, first.lat], // ORS: [lng, lat]
        },
      ],
      jobs: stops.map((s, i) => ({
        id: i + 1,
        location: [s.lng, s.lat],
        ...(s.deliveryWindowStart && s.deliveryWindowEnd
          ? { time_windows: [[timeToSec(s.deliveryWindowStart), timeToSec(s.deliveryWindowEnd)]] }
          : {}),
      })),
    };

    const res = await fetch("https://api.openrouteservice.org/optimization", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: apiKey },
      body: JSON.stringify(body),
    });

    if (res.status === 429) throw new Error("ORS rate limit exceeded");
    if (!res.ok) throw new Error(`ORS error: ${res.status} ${res.statusText}`);

    const data = (await res.json()) as {
      routes: Array<{ steps: Array<{ type: string; job?: number }> }>;
    };

    const steps = data.routes?.[0]?.steps ?? [];
    const optimizedIds = steps
      .filter((s) => s.type === "job" && s.job != null)
      .map((s) => stops[s.job! - 1].id);

    if (optimizedIds.length !== stops.length) {
      throw new Error(
        `ORS stop count mismatch: expected ${stops.length}, got ${optimizedIds.length}`,
      );
    }
    return optimizedIds;
  }

  // ─── Nearest-neighbour + 2-opt fallback (pure TS) ───────────────────────
  //
  // Strategy:
  //   1. Run nearest-neighbour from *every* starting stop, keep the shortest.
  //   2. Apply 2-opt local search until no improving swap exists.
  //
  // Greedy NN alone can produce routes that are 10–30 % longer than optimal
  // when stops cluster geographically and the "wrong" start is chosen.
  // 2-opt fixes crossed edges and typically closes that gap completely for
  // ≤ 30 stops in a few dozen iterations.

  private nearestNeighborFallback(stops: StopWithCoords[]): string[] {
    if (stops.length <= 2) return stops.map((s) => s.id);

    // ── Step 1: best nearest-neighbour across all starting points ──────────
    let bestRoute = this.nnFrom(stops, 0);
    let bestDist = this.pathKm(bestRoute);

    for (let start = 1; start < stops.length; start++) {
      const route = this.nnFrom(stops, start);
      const dist = this.pathKm(route);
      if (dist < bestDist) {
        bestDist = dist;
        bestRoute = route;
      }
    }

    // ── Step 2: 2-opt improvement ──────────────────────────────────────────
    bestRoute = this.twoOpt(bestRoute);

    return bestRoute.map((s) => s.id);
  }

  /** Run nearest-neighbour starting from stop at index `startIdx`. */
  private nnFrom(stops: StopWithCoords[], startIdx: number): StopWithCoords[] {
    const unvisited = [...stops];
    let current = unvisited.splice(startIdx, 1)[0];
    const result: StopWithCoords[] = [current];

    while (unvisited.length > 0) {
      let nearestIdx = 0;
      let minDist = this.haversineKm(current, unvisited[0]);
      for (let i = 1; i < unvisited.length; i++) {
        const d = this.haversineKm(current, unvisited[i]);
        if (d < minDist) { minDist = d; nearestIdx = i; }
      }
      current = unvisited.splice(nearestIdx, 1)[0];
      result.push(current);
    }
    return result;
  }

  /** 2-opt local search on an open path (no wrap-around edge). */
  private twoOpt(stops: StopWithCoords[]): StopWithCoords[] {
    const n = stops.length;
    if (n < 4) return stops;

    let route = [...stops];
    let improved = true;

    while (improved) {
      improved = false;
      // i..n-3 so that i+1 and j+1 are both valid indices (j ≤ n-2)
      outer: for (let i = 0; i <= n - 3; i++) {
        for (let j = i + 2; j <= n - 2; j++) {
          const a = route[i], b = route[i + 1], c = route[j], d = route[j + 1];
          // Improvement: replacing edges (a→b, c→d) with (a→c, b→d)
          const delta =
            this.haversineKm(a, b) + this.haversineKm(c, d) -
            this.haversineKm(a, c) - this.haversineKm(b, d);
          if (delta > 0.001) {
            // Reverse segment [i+1 .. j]
            route = [
              ...route.slice(0, i + 1),
              ...route.slice(i + 1, j + 1).reverse(),
              ...route.slice(j + 1),
            ];
            improved = true;
            break outer; // restart after any improvement
          }
        }
      }
    }
    return route;
  }

  /** Total path distance in km for an ordered stop array. */
  private pathKm(stops: StopWithCoords[]): number {
    let total = 0;
    for (let i = 0; i < stops.length - 1; i++) {
      total += this.haversineKm(stops[i], stops[i + 1]);
    }
    return total;
  }

  // ─── Google Maps Geocoding ────────────────────────────────────────────────

  private async geocodeAddress(address: {
    line1: string;
    city: string;
    state: string;
    zip: string;
  }): Promise<{ lat: number; lng: number } | null> {
    const key = this.config.get<string>("googleMaps.apiKey") ?? "";
    if (!key) return null;
    const q = encodeURIComponent(
      `${address.line1}, ${address.city}, ${address.state} ${address.zip}`,
    );
    try {
      const res = await fetch(
        `https://maps.googleapis.com/maps/api/geocode/json?address=${q}&key=${key}`,
      );
      if (!res.ok) return null;
      const data = (await res.json()) as {
        results: Array<{ geometry: { location: { lat: number; lng: number } } }>;
      };
      const loc = data.results?.[0]?.geometry?.location;
      return loc ? { lat: loc.lat, lng: loc.lng } : null;
    } catch (err) {
      this.logger.warn("Geocoding failed", err);
      return null;
    }
  }

  // ─── Haversine distance (km) ──────────────────────────────────────────────

  private haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
    const R = 6371;
    const dLat = ((b.lat - a.lat) * Math.PI) / 180;
    const dLng = ((b.lng - a.lng) * Math.PI) / 180;
    const lat1 = (a.lat * Math.PI) / 180;
    const lat2 = (b.lat * Math.PI) / 180;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  }
}
