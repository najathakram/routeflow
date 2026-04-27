import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { SystemConfigService } from "../system-config/system-config.service";

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

export interface StopETA {
  stopId: string;
  stopNumber: number;
  customerName: string;
  arrivalTime: string; // "HH:mm"
  departureTime: string; // "HH:mm"
  travelTimeMinutes: number;
  deliveryWindowStart?: string | null;
  deliveryWindowEnd?: string | null;
  withinWindow: boolean | null;
}

/** Convert seconds from midnight to "HH:mm" */
function secToTime(sec: number): string {
  const h = Math.floor(sec / 3600) % 24;
  const m = Math.floor((sec % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class RouteOptimizationService {
  private readonly logger = new Logger(RouteOptimizationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly systemConfig: SystemConfigService,
  ) {}

  // ─── Depot resolution ──────────────────────────────────────────────────────

  async resolveDepot(
    routeId: string,
  ): Promise<{ lat: number; lng: number; address: string } | null> {
    const route = await this.prisma.forTenant().route.findUnique({
      where: { id: routeId },
    });
    if (!route) return null;

    // 1. Route-level depot override
    if (route.depotLat != null && route.depotLng != null) {
      return {
        lat: route.depotLat,
        lng: route.depotLng,
        address: route.depotAddress ?? "",
      };
    }

    // 2. System-wide default depot (cached in SystemConfig)
    const cachedLat = await this.systemConfig.get("route.defaultDepotLat");
    const cachedLng = await this.systemConfig.get("route.defaultDepotLng");
    if (cachedLat != null && cachedLng != null) {
      return {
        lat: parseFloat(cachedLat),
        lng: parseFloat(cachedLng),
        address: "",
      };
    }

    // 3. Geocode the tenant's business address and cache
    const tenantId = route.tenantId;
    if (!tenantId) return null;

    const tenantConfig = await this.prisma.forTenant().tenantConfig.findFirst({
      where: { tenantId },
    });
    if (
      !tenantConfig ||
      !tenantConfig.addressLine1 ||
      !tenantConfig.city ||
      !tenantConfig.state ||
      !tenantConfig.zip
    ) {
      return null;
    }

    const coords = await this.geocodeAddress({
      line1: tenantConfig.addressLine1,
      city: tenantConfig.city,
      state: tenantConfig.state,
      zip: tenantConfig.zip,
    });
    if (!coords) return null;

    // Cache for future calls
    await this.systemConfig.set("route.defaultDepotLat", String(coords.lat));
    await this.systemConfig.set("route.defaultDepotLng", String(coords.lng));

    return {
      lat: coords.lat,
      lng: coords.lng,
      address: `${tenantConfig.addressLine1}, ${tenantConfig.city}, ${tenantConfig.state} ${tenantConfig.zip}`,
    };
  }

  // ─── ETA calculation ───────────────────────────────────────────────────────

  calculateETAs(
    depot: { lat: number; lng: number } | null,
    stops: StopWithCoords[],
    startTime: string,
    avgSpeedKmh: number,
    serviceTimeMinutes: number,
  ): StopETA[] {
    if (stops.length === 0) return [];
    let currentTimeSec = timeToSec(startTime);
    let currentLoc: { lat: number; lng: number } = depot ?? stops[0];
    const etas: StopETA[] = [];

    for (const stop of stops) {
      const travelKm = this.haversineKm(currentLoc, stop);
      const travelTimeSec = (travelKm / avgSpeedKmh) * 3600;
      const arrivalSec = currentTimeSec + travelTimeSec;
      const departureSec = arrivalSec + serviceTimeMinutes * 60;

      let withinWindow: boolean | null = null;
      if (stop.deliveryWindowStart && stop.deliveryWindowEnd) {
        const windowStartSec = timeToSec(stop.deliveryWindowStart);
        const windowEndSec = timeToSec(stop.deliveryWindowEnd);
        withinWindow = arrivalSec >= windowStartSec && arrivalSec <= windowEndSec;
      }

      etas.push({
        stopId: stop.id,
        stopNumber: stop.stopNumber,
        customerName: stop.customerName,
        arrivalTime: secToTime(arrivalSec),
        departureTime: secToTime(departureSec),
        travelTimeMinutes: Math.round(travelTimeSec / 60),
        deliveryWindowStart: stop.deliveryWindowStart ?? null,
        deliveryWindowEnd: stop.deliveryWindowEnd ?? null,
        withinWindow,
      });

      currentTimeSec = departureSec;
      currentLoc = stop;
    }

    return etas;
  }

  // ─── Route optimization ─────────────────────────────────────────────────────

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

    // Fallback: for stops where customerAddressId FK is null, pull the customer's default address
    const stopsNeedingAddr = route.stops.filter((s) => !s.customerAddress && s.customerId);
    if (stopsNeedingAddr.length > 0) {
      const defaultAddrs = await this.prisma.forTenant().customerAddress.findMany({
        where: {
          customerId: { in: stopsNeedingAddr.map((s) => s.customerId!) },
          isDefault: true,
        },
      });
      const addrByCustomer = new Map(defaultAddrs.map((a) => [a.customerId, a]));
      for (const s of stopsNeedingAddr) {
        const addr = addrByCustomer.get(s.customerId!);
        if (addr) (s as any).customerAddress = addr;
      }
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

    // Resolve depot for route-aware optimization
    const depot = await this.resolveDepot(routeId);

    let optimizedIds: string[];
    let usedFallback = false;

    try {
      optimizedIds = await this.callOrsOptimization(stops, depot);
    } catch (err: unknown) {
      this.logger.warn(
        "ORS optimization failed — applying nearest-neighbor fallback",
        err instanceof Error ? err.message : String(err),
      );
      optimizedIds = this.nearestNeighborFallback(stops, depot);
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

  async optimizeRoute(
    routeRunId: string,
    origin?: { lat: number; lng: number } | null,
  ): Promise<OptimizeResult> {
    const run = await this.prisma.forTenant().routeRun.findUnique({
      where: { id: routeRunId },
      include: {
        stops: {
          include: {
            customerAddress: true,
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

    // For stops where the run stop has no address FK, fall back to the customer's default address.
    const stopsNeedingAddr = run.stops.filter((s) => !s.customerAddress && s.customerId);
    if (stopsNeedingAddr.length > 0) {
      const defaultAddrs = await this.prisma.forTenant().customerAddress.findMany({
        where: { customerId: { in: stopsNeedingAddr.map((s) => s.customerId!) }, isDefault: true },
      });
      const addrByCustomer = new Map(defaultAddrs.map((a) => [a.customerId, a]));
      for (const s of stopsNeedingAddr) {
        const addr = addrByCustomer.get(s.customerId!);
        if (addr) (s as any).customerAddress = addr;
      }
    }

    // Helper: resolve effective address for a run stop (run-stop FK → routeStop FK → customer default)
    const effectiveAddr = (s: (typeof run.stops)[0]) =>
      s.customerAddress ?? s.routeStop.customerAddress ?? null;

    // Geocode any stops missing lat/lng
    for (const stop of run.stops) {
      const addr = effectiveAddr(stop);
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
      (s) => effectiveAddr(s)?.lat == null || effectiveAddr(s)?.lng == null,
    );
    if (missingCoords.length > 0) {
      const names = missingCoords.map((s) => s.routeStop.customer?.businessName ?? s.id).join(", ");
      throw new BadRequestException(
        `Missing geocoded addresses for: ${names}. Set GOOGLE_MAPS_API_KEY to auto-geocode.`,
      );
    }

    const stops: StopWithCoords[] = run.stops.map((s) => {
      const addr = effectiveAddr(s)!;
      return {
        id: s.id,
        stopNumber: s.stopNumber,
        customerName: s.routeStop.customer?.businessName ?? s.id,
        lat: addr.lat!,
        lng: addr.lng!,
        deliveryWindowStart: s.routeStop.customer?.deliveryWindowStart,
        deliveryWindowEnd: s.routeStop.customer?.deliveryWindowEnd,
      };
    });

    // Resolve depot from the parent route. When the caller provides an
    // origin (e.g. driver's current GPS mid-run), use that as the vehicle
    // start instead of the depot.
    const depot = await this.resolveDepot(run.routeId);
    const start = origin ?? depot;

    let optimizedIds: string[];
    let usedFallback = false;

    try {
      optimizedIds = await this.callOrsOptimization(stops, start);
    } catch (err: unknown) {
      this.logger.warn(
        "ORS optimization failed — applying nearest-neighbor fallback",
        err instanceof Error ? err.message : String(err),
      );
      optimizedIds = this.nearestNeighborFallback(stops, start);
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

  private async callOrsOptimization(
    stops: StopWithCoords[],
    depot?: { lat: number; lng: number } | null,
  ): Promise<string[]> {
    const apiKey = this.config.get<string>("ors.apiKey") ?? "";
    if (!apiKey) throw new Error("ORS_API_KEY not configured");

    const vehicleDef: Record<string, unknown> = {
      id: 1,
      profile: "driving-car",
    };

    if (depot) {
      vehicleDef.start = [depot.lng, depot.lat]; // ORS: [lng, lat]
      vehicleDef.end = [depot.lng, depot.lat];
    } else {
      const first = stops[0];
      vehicleDef.start = [first.lng, first.lat];
    }

    const body = {
      vehicles: [vehicleDef],
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

  private nearestNeighborFallback(
    stops: StopWithCoords[],
    depot?: { lat: number; lng: number } | null,
  ): string[] {
    if (stops.length <= 2) {
      if (!depot) return stops.map((s) => s.id);
      // With depot and <=2 stops, still pick the nearest-to-depot first
      const sorted = [...stops].sort(
        (a, b) => this.haversineKm(depot, a) - this.haversineKm(depot, b),
      );
      return sorted.map((s) => s.id);
    }

    let bestRoute: StopWithCoords[];

    if (depot) {
      // ── Depot mode: single NN pass starting from depot ─────────────────
      // Find the stop nearest to the depot, use that as the starting point
      let nearestIdx = 0;
      let minDist = this.haversineKm(depot, stops[0]);
      for (let i = 1; i < stops.length; i++) {
        const d = this.haversineKm(depot, stops[i]);
        if (d < minDist) {
          minDist = d;
          nearestIdx = i;
        }
      }
      bestRoute = this.nnFrom(stops, nearestIdx);
    } else {
      // ── No depot: try all starting points, keep shortest ───────────────
      bestRoute = this.nnFrom(stops, 0);
      let bestDist = this.pathKm(bestRoute);

      for (let start = 1; start < stops.length; start++) {
        const route = this.nnFrom(stops, start);
        const dist = this.pathKm(route);
        if (dist < bestDist) {
          bestDist = dist;
          bestRoute = route;
        }
      }
    }

    // ── 2-opt improvement ──────────────────────────────────────────────────
    bestRoute = this.twoOpt(bestRoute, depot);

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
        if (d < minDist) {
          minDist = d;
          nearestIdx = i;
        }
      }
      current = unvisited.splice(nearestIdx, 1)[0];
      result.push(current);
    }
    return result;
  }

  /**
   * 2-opt local search.
   *
   * Without depot: open path, no wrap-around edge (original behaviour).
   * With depot: fixed-endpoint tour depot → stops[0] → ... → stops[n-1] → depot.
   *   Only interior segments are reversed; the depot endpoints stay pinned.
   */
  private twoOpt(
    stops: StopWithCoords[],
    depot?: { lat: number; lng: number } | null,
  ): StopWithCoords[] {
    const n = stops.length;
    if (n < 4) return stops;

    let route = [...stops];
    let improved = true;

    if (depot) {
      // ── Depot-pinned 2-opt ───────────────────────────────────────────────
      // Tour: depot → route[0] → ... → route[n-1] → depot
      // Reversing segment [i..j] affects edges:
      //   prevI → route[i]  becomes  prevI → route[j]
      //   route[j] → nextJ  becomes  route[i] → nextJ
      // Where prevI = route[i-1] if i>0, else depot
      //       nextJ = route[j+1] if j<n-1, else depot
      while (improved) {
        improved = false;
        outer: for (let i = 0; i <= n - 2; i++) {
          for (let j = i + 1; j <= n - 1; j++) {
            if (i === 0 && j === n - 1) continue; // reversing entire route is pointless for round trip
            const prevI = i > 0 ? route[i - 1] : depot;
            const nextJ = j < n - 1 ? route[j + 1] : depot;
            const oldDist = this.haversineKm(prevI, route[i]) + this.haversineKm(route[j], nextJ);
            const newDist = this.haversineKm(prevI, route[j]) + this.haversineKm(route[i], nextJ);
            if (newDist < oldDist - 0.001) {
              // Reverse segment [i..j]
              route = [
                ...route.slice(0, i),
                ...route.slice(i, j + 1).reverse(),
                ...route.slice(j + 1),
              ];
              improved = true;
              break outer;
            }
          }
        }
      }
    } else {
      // ── Open-path 2-opt (original) ───────────────────────────────────────
      while (improved) {
        improved = false;
        outer2: for (let i = 0; i <= n - 3; i++) {
          for (let j = i + 2; j <= n - 2; j++) {
            const a = route[i],
              b = route[i + 1],
              c = route[j],
              d = route[j + 1];
            const delta =
              this.haversineKm(a, b) +
              this.haversineKm(c, d) -
              this.haversineKm(a, c) -
              this.haversineKm(b, d);
            if (delta > 0.001) {
              route = [
                ...route.slice(0, i + 1),
                ...route.slice(i + 1, j + 1).reverse(),
                ...route.slice(j + 1),
              ];
              improved = true;
              break outer2;
            }
          }
        }
      }
    }

    return route;
  }

  /**
   * Total path distance in km for an ordered stop array.
   * With depot: includes depot→first and last→depot edges.
   */
  private pathKm(stops: StopWithCoords[], depot?: { lat: number; lng: number } | null): number {
    if (stops.length === 0) return 0;
    let total = 0;
    if (depot) {
      total += this.haversineKm(depot, stops[0]);
    }
    for (let i = 0; i < stops.length - 1; i++) {
      total += this.haversineKm(stops[i], stops[i + 1]);
    }
    if (depot) {
      total += this.haversineKm(stops[stops.length - 1], depot);
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
