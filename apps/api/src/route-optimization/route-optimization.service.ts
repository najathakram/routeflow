import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma, RouteEndKind, RouteOptimizeMetric, RouteRunStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { ApplyRouteVariantDto } from "./dto/apply-route-variant.dto";
import { buildCostMatrices, type LatLng } from "./cost-matrix";

/**
 * `computeRoutes` classifies as Routes **Pro** ($10/1000, 5K free) rather than
 * Essentials ($5/1000, 10K free) once a request carries more than 10
 * intermediate waypoints. Variants beyond this size skip the polyline call and
 * fall back to the solver's own matrix totals with `encodedPolyline: null` —
 * the client then draws its own path, exactly as it does on a Google failure.
 */
const MAX_POLYLINE_INTERMEDIATES = 10;

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

export type FallbackReason =
  | "ORS_NOT_CONFIGURED"
  | "ORS_RATE_LIMITED"
  | "ORS_HTTP_ERROR"
  | "ORS_NETWORK_ERROR"
  // Google was the primary source (a key was configured) but computeRouteMatrix
  // failed or returned a sparse/erroring response, so the haversine matrix was
  // used instead. Distinct from ORS_* — the ORS pathway wasn't reached at all.
  | "GOOGLE_MATRIX_FALLBACK";

export interface OptimizeResult {
  stopOrder: Array<{ stopId: string; stopNumber: number }>;
  reorderedCount: number;
  usedFallback: boolean;
  fallbackReason?: FallbackReason;
}

export interface RouteVariant {
  key: "FASTEST" | "SHORTEST" | "NO_TOLLS";
  stopIds: string[];
  durationSec: number;
  distanceMeters: number;
  hasTolls: boolean;
  encodedPolyline: string | null;
}

interface PlanningFields {
  endKind: RouteEndKind;
  endLat: number | null;
  endLng: number | null;
}

function classifyOrsError(err: unknown): FallbackReason {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("ORS_API_KEY not configured")) return "ORS_NOT_CONFIGURED";
  if (msg.includes("rate limit")) return "ORS_RATE_LIMITED";
  if (msg.startsWith("ORS error:")) return "ORS_HTTP_ERROR";
  return "ORS_NETWORK_ERROR";
}

/** True when `a` and `b` are within `pct` (fraction, e.g. 0.01 = 1%) of each other. */
function withinPercent(a: number, b: number, pct: number): boolean {
  if (a === 0 && b === 0) return true;
  const base = Math.max(Math.abs(a), Math.abs(b), 1e-9);
  return Math.abs(a - b) / base <= pct;
}

/** True when two stop-id arrays visit the same stops in the same order. */
function sameStopOrder(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
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

  /**
   * Load a template route's stops with resolved coordinates, geocoding any
   * that are missing and throwing when some still can't be resolved. Shared
   * by `optimizeTemplate` and `getRouteVariants` so both operate on the same
   * validated stop set and the route's planning settings.
   */
  private async loadRouteStops(routeId: string): Promise<{
    route: {
      id: string;
      avoidTolls: boolean;
      optimizeBy: RouteOptimizeMetric;
      endKind: RouteEndKind;
      endLat: number | null;
      endLng: number | null;
    };
    stops: StopWithCoords[];
  }> {
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

    return {
      route: {
        id: route.id,
        avoidTolls: route.avoidTolls,
        optimizeBy: route.optimizeBy,
        endKind: route.endKind,
        endLat: route.endLat,
        endLng: route.endLng,
      },
      stops,
    };
  }

  async optimizeTemplate(routeId: string): Promise<OptimizeResult> {
    const { route, stops } = await this.loadRouteStops(routeId);
    if (stops.length === 0) {
      return { stopOrder: [], reorderedCount: 0, usedFallback: false };
    }

    // Resolve depot for route-aware optimization
    const depot = await this.resolveDepot(routeId);

    let optimizedIds: string[];
    let usedFallback = false;
    let fallbackReason: FallbackReason | undefined;

    const apiKey = this.config.get<string>("googleMaps.apiKey") || undefined;
    if (apiKey && depot) {
      // Cost-matrix-based optimizer (Google Routes API, haversine fallback
      // built into buildCostMatrices itself). Only reached when a Google key
      // is configured and a fixed start point is known — otherwise the
      // pre-existing ORS/nearest-neighbor pathway below runs unchanged.
      const matrix = await this.solveWithCostMatrix(depot, stops, route, apiKey);
      optimizedIds = matrix.stopIds;
      usedFallback = matrix.usedHaversineFallback;
      if (usedFallback) fallbackReason = "GOOGLE_MATRIX_FALLBACK";
    } else {
      try {
        optimizedIds = await this.callOrsOptimization(stops, depot);
      } catch (err: unknown) {
        fallbackReason = classifyOrsError(err);
        this.logger.warn(
          `ORS optimization failed (${fallbackReason}) — applying nearest-neighbor fallback`,
          err instanceof Error ? err.message : String(err),
        );
        optimizedIds = this.nearestNeighborFallback(stops, depot);
        usedFallback = true;
      }
    }

    const stopOrder = optimizedIds.map((stopId, idx) => ({
      stopId,
      stopNumber: idx + 1,
    }));

    // Two-phase update to avoid @@unique([routeId, stopNumber]) violations:
    // Phase 1 shifts every stop to a temporary position (n + offset) so positions
    // 1..n are free, then Phase 2 writes the real optimized order. Also clears
    // the route's stored plannedPolyline — any reorder outside `applyRouteVariant`
    // invalidates it; a stale polyline is worse than none.
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
      this.prisma.forTenant().route.update({
        where: { id: routeId },
        data: { plannedPolyline: null },
      }),
    ]);

    const originalOrder = new Map(stops.map((s) => [s.id, s.stopNumber]));
    const reorderedCount = stopOrder.filter(
      ({ stopId, stopNumber }) => originalOrder.get(stopId) !== stopNumber,
    ).length;

    return { stopOrder, reorderedCount, usedFallback, fallbackReason };
  }

  async optimizeRoute(
    routeRunId: string,
    origin?: { lat: number; lng: number } | null,
  ): Promise<OptimizeResult> {
    const run = await this.prisma.forTenant().routeRun.findUnique({
      where: { id: routeRunId },
      include: {
        route: true,
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
    let fallbackReason: FallbackReason | undefined;

    const apiKey = this.config.get<string>("googleMaps.apiKey") || undefined;
    if (apiKey && start) {
      // Cost-matrix-based optimizer — see optimizeTemplate for rationale.
      // Only reached when a Google key is configured and a fixed start point
      // is known; otherwise the pre-existing ORS/nearest-neighbor pathway
      // below runs unchanged.
      const matrix = await this.solveWithCostMatrix(start, stops, run.route, apiKey);
      optimizedIds = matrix.stopIds;
      usedFallback = matrix.usedHaversineFallback;
      if (usedFallback) fallbackReason = "GOOGLE_MATRIX_FALLBACK";
    } else {
      try {
        optimizedIds = await this.callOrsOptimization(stops, start);
      } catch (err: unknown) {
        fallbackReason = classifyOrsError(err);
        this.logger.warn(
          `ORS optimization failed (${fallbackReason}) — applying nearest-neighbor fallback`,
          err instanceof Error ? err.message : String(err),
        );
        optimizedIds = this.nearestNeighborFallback(stops, start);
        usedFallback = true;
      }
    }

    const stopOrder = optimizedIds.map((stopId, idx) => ({
      stopId,
      stopNumber: idx + 1,
    }));

    // Two-phase update to avoid @@unique([routeRunId, stopNumber]) violations.
    // Also clears the parent route's stored plannedPolyline — see the same
    // note in optimizeTemplate.
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
      this.prisma.forTenant().route.update({
        where: { id: run.routeId },
        data: { plannedPolyline: null },
      }),
    ]);

    await this.prisma.forTenant().routeRun.update({
      where: { id: routeRunId },
      data: { manuallyReordered: false },
    });

    const originalOrder = new Map(stops.map((s) => [s.id, s.stopNumber]));
    const reorderedCount = stopOrder.filter(
      ({ stopId, stopNumber }) => originalOrder.get(stopId) !== stopNumber,
    ).length;

    return { stopOrder, reorderedCount, usedFallback, fallbackReason };
  }

  // ─── Cost-matrix-based solver (Google Routes API, primary) ────────────────

  /**
   * Order stops by cost matrix. Index 0 = fixed start. `endIndex` (optional) = fixed end that
   * must be LAST (not reordered). Everything else is permutable. NN from the start + 2-opt.
   * Returns the permutation of the permutable indices (matrix indices, order to visit).
   */
  private solveOrder(cost: number[][], permutable: number[], endIndex?: number): number[] {
    if (permutable.length <= 1) return [...permutable];
    const tail = endIndex === undefined ? [] : [endIndex];
    // Nearest-neighbour seed from the fixed start (index 0)
    const remaining = new Set(permutable);
    const order: number[] = [];
    let cur = 0;
    while (remaining.size) {
      let best = -1;
      let bestC = Infinity;
      for (const c of remaining)
        if (cost[cur][c] < bestC) {
          bestC = cost[cur][c];
          best = c;
        }
      order.push(best);
      remaining.delete(best);
      cur = best;
    }
    // 2-opt over the open path 0 → order... → (endIndex?)
    const tourCost = (o: number[]) => {
      let t = cost[0][o[0]];
      for (let i = 0; i < o.length - 1; i++) t += cost[o[i]][o[i + 1]];
      if (tail.length) t += cost[o[o.length - 1]][tail[0]];
      return t;
    };
    let improved = true;
    while (improved) {
      improved = false;
      for (let i = 0; i < order.length - 1; i++) {
        for (let j = i + 1; j < order.length; j++) {
          const cand = [
            ...order.slice(0, i),
            ...order.slice(i, j + 1).reverse(),
            ...order.slice(j + 1),
          ];
          if (tourCost(cand) + 1e-9 < tourCost(order)) {
            order.splice(0, order.length, ...cand);
            improved = true;
          }
        }
      }
    }
    return order;
  }

  /**
   * Build a cost matrix for [start, ...stops, end?] and solve it with `solveOrder`.
   * Shared by `optimizeTemplate`, `optimizeRoute`, and `getRouteVariants` — the only
   * thing that varies per caller is the start point and the {avoidTolls, optimizeBy}
   * settings, which come from the route's planning fields (or a variant candidate).
   */
  private async solveWithCostMatrix(
    start: LatLng,
    stops: StopWithCoords[],
    planning: PlanningFields & { avoidTolls: boolean; optimizeBy: RouteOptimizeMetric },
    apiKey: string,
  ): Promise<{
    stopIds: string[];
    durationSec: number;
    distanceMeters: number;
    usedHaversineFallback: boolean;
  }> {
    const points: LatLng[] = [start, ...stops.map((s) => ({ lat: s.lat, lng: s.lng }))];
    const hasFixedEnd =
      planning.endKind !== RouteEndKind.NONE && planning.endLat != null && planning.endLng != null;
    if (hasFixedEnd) points.push({ lat: planning.endLat!, lng: planning.endLng! });

    // With 0 or 1 permutable stops there is exactly one possible order, so a
    // billable matrix call would buy nothing. Withhold the key: haversine
    // still supplies the distance/duration totals the variants UI shows, and
    // this is NOT reported as a Google fallback (nothing was attempted).
    const trivialOrder = stops.length < 2;
    const matrices = await buildCostMatrices(points, {
      avoidTolls: planning.avoidTolls,
      apiKey: trivialOrder ? undefined : apiKey,
      logger: this.logger,
      tenantId: this.prisma.getTenantId() ?? undefined,
    });

    const cost =
      planning.optimizeBy === RouteOptimizeMetric.DISTANCE
        ? matrices.distanceMeters
        : matrices.durationSec;
    const permutable = stops.map((_, i) => i + 1); // matrix indices 1..stops.length (0 = start)
    const endIndex = hasFixedEnd ? points.length - 1 : undefined;
    const order = this.solveOrder(cost, permutable, endIndex);

    const pathIndices = [0, ...order, ...(hasFixedEnd ? [endIndex!] : [])];
    let durationSec = 0;
    let distanceMeters = 0;
    for (let i = 0; i < pathIndices.length - 1; i++) {
      durationSec += matrices.durationSec[pathIndices[i]][pathIndices[i + 1]];
      distanceMeters += matrices.distanceMeters[pathIndices[i]][pathIndices[i + 1]];
    }

    return {
      stopIds: order.map((idx) => stops[idx - 1].id),
      durationSec,
      distanceMeters,
      usedHaversineFallback: !trivialOrder && matrices.source === "haversine",
    };
  }

  // ─── Route variants (Fastest / Shortest / No-tolls) ────────────────────────

  /**
   * Solve the same stop set under {TIME}, {DISTANCE}, {TIME + avoidTolls} and, for
   * each, make ONE `computeRoutes` call for real road totals + polyline + toll
   * presence. Never throws / 500s on a Google failure — falls back to a single
   * solver-only result with `encodedPolyline: null` so the client can still render
   * something (and draw its own straight-line path).
   */
  async getRouteVariants(routeId: string): Promise<{ variants: RouteVariant[] }> {
    const { route, stops } = await this.loadRouteStops(routeId);
    if (stops.length === 0) return { variants: [] };

    const depot = await this.resolveDepot(routeId);
    if (!depot) return { variants: [] };

    const apiKey = this.config.get<string>("googleMaps.apiKey") || undefined;
    const endPoint =
      route.endKind !== RouteEndKind.NONE && route.endLat != null && route.endLng != null
        ? { lat: route.endLat, lng: route.endLng }
        : null;

    // When the route already avoids tolls, every candidate must too — a
    // "NO_TOLLS" variant would just duplicate FASTEST in that case.
    const forceAvoidTolls = route.avoidTolls === true;
    const configs: Array<{
      key: RouteVariant["key"];
      optimizeBy: RouteOptimizeMetric;
      avoidTolls: boolean;
    }> = [
      { key: "FASTEST", optimizeBy: RouteOptimizeMetric.TIME, avoidTolls: forceAvoidTolls },
      { key: "SHORTEST", optimizeBy: RouteOptimizeMetric.DISTANCE, avoidTolls: forceAvoidTolls },
    ];
    if (!forceAvoidTolls) {
      configs.push({ key: "NO_TOLLS", optimizeBy: RouteOptimizeMetric.TIME, avoidTolls: true });
    }

    try {
      if (!apiKey) throw new Error("GOOGLE_MAPS_API_KEY not configured");

      const results: RouteVariant[] = [];
      for (const cfg of configs) {
        const matrix = await this.solveWithCostMatrix(
          depot,
          stops,
          { endKind: route.endKind, endLat: route.endLat, endLng: route.endLng, ...cfg },
          apiKey,
        );
        const orderedStops = matrix.stopIds.map((id) => stops.find((s) => s.id === id)!);
        // Cost guard: past 10 intermediates computeRoutes bills at the Pro
        // tier, and this loop makes one call per variant. Above the threshold
        // keep the solver's own totals and let the client draw the path.
        const intermediateCount = endPoint
          ? orderedStops.length
          : Math.max(orderedStops.length - 1, 0);
        const computed =
          intermediateCount > MAX_POLYLINE_INTERMEDIATES
            ? {
                durationSec: matrix.durationSec,
                distanceMeters: matrix.distanceMeters,
                encodedPolyline: null,
              }
            : await this.computeRoutePolyline(
                depot,
                orderedStops,
                endPoint,
                cfg.avoidTolls,
                apiKey,
              );
        results.push({
          key: cfg.key,
          stopIds: matrix.stopIds,
          durationSec: computed.durationSec,
          distanceMeters: computed.distanceMeters,
          // Placeholder — computeRoutePolyline deliberately never requests toll
          // info (billing risk). Derived by contrast below, once every variant
          // in this batch has been computed.
          hasTolls: false,
          encodedPolyline: computed.encodedPolyline,
        });
      }
      this.applyTollContrast(results);
      return { variants: this.dedupeVariants(results) };
    } catch (err) {
      this.logger.warn(`Route variants via Google failed (${String(err)}) — solver-only fallback`);
      const matrix = await this.solveWithCostMatrix(
        depot,
        stops,
        {
          endKind: route.endKind,
          endLat: route.endLat,
          endLng: route.endLng,
          avoidTolls: route.avoidTolls,
          optimizeBy: route.optimizeBy,
        },
        apiKey ?? "",
      );
      const fallbackKey: RouteVariant["key"] =
        route.optimizeBy === RouteOptimizeMetric.DISTANCE
          ? "SHORTEST"
          : route.avoidTolls
            ? "NO_TOLLS"
            : "FASTEST";
      return {
        variants: [
          {
            key: fallbackKey,
            stopIds: matrix.stopIds,
            durationSec: matrix.durationSec,
            distanceMeters: matrix.distanceMeters,
            hasTolls: false,
            encodedPolyline: null,
          },
        ],
      };
    }
  }

  /**
   * Apply a previously-fetched variant: persist its stop order, optimizeBy/avoidTolls,
   * and polyline. `stopIds` must be an exact permutation of the route's current stops.
   *
   * This is the ONLY writer of `plannedPolyline` — every other path that moves
   * stops or start/end points nulls it instead, so a stored polyline always
   * matches the order it was computed for.
   *
   * `dto.runId` closes the run-vs-template gap: variants are solved against the
   * route TEMPLATE, but the operator is usually looking at a RUN's stop list.
   * When a run is named, its RouteRunStops are re-numbered to the same order
   * inside the SAME transaction — so the visible list and the stored polyline
   * can never disagree, and no follow-up re-optimize (which would null the
   * polyline we just wrote) is needed.
   */
  async applyRouteVariant(
    routeId: string,
    dto: ApplyRouteVariantDto,
  ): Promise<{ applied: boolean }> {
    const route = await this.prisma.forTenant().route.findUnique({
      where: { id: routeId },
      include: { stops: { select: { id: true } } },
    });
    if (!route) throw new NotFoundException("Route not found");

    const currentIds = new Set(route.stops.map((s) => s.id));
    const isPermutation =
      dto.stopIds.length === route.stops.length &&
      new Set(dto.stopIds).size === dto.stopIds.length &&
      dto.stopIds.every((id) => currentIds.has(id));
    if (!isPermutation) {
      throw new BadRequestException("stopIds must be a permutation of the route's current stops");
    }

    // Run stops to re-number alongside the template, in the variant's order.
    let runStopIdsInOrder: string[] | null = null;

    if (dto.runId) {
      const run = await this.prisma.forTenant().routeRun.findFirst({
        where: { id: dto.runId, routeId },
        include: { stops: { select: { id: true, routeStopId: true, stopNumber: true } } },
      });
      if (!run) throw new NotFoundException("Route run not found for this route");
      if (run.status !== RouteRunStatus.SCHEDULED) {
        throw new ConflictException(
          "Only a scheduled run can be reordered — finish or cancel the active run first",
        );
      }
      // Translate template stop ids → run stop ids. A run stop whose template
      // stop isn't in the variant (or vice versa) keeps its relative position
      // at the end, so the result is always a full permutation of the run's
      // stops — required for the unique [routeRunId, stopNumber] rewrite.
      const runStopByTemplateStop = new Map(run.stops.map((s) => [s.routeStopId, s.id]));
      const mapped = dto.stopIds
        .map((templateStopId) => runStopByTemplateStop.get(templateStopId))
        .filter((id): id is string => id !== undefined);
      const mappedSet = new Set(mapped);
      const leftovers = [...run.stops]
        .sort((a, b) => a.stopNumber - b.stopNumber)
        .filter((s) => !mappedSet.has(s.id))
        .map((s) => s.id);
      runStopIdsInOrder = [...mapped, ...leftovers];
    } else {
      // No run named: mirror updatePlanning's guard so a template reorder can
      // never land under a driver who is mid-delivery against the old order.
      const activeRun = await this.prisma.forTenant().routeRun.findFirst({
        where: { routeId, status: RouteRunStatus.IN_PROGRESS },
        select: { id: true },
      });
      if (activeRun) {
        throw new ConflictException(
          "Finish or cancel the active run before changing route planning",
        );
      }
    }

    // Same two-phase offset trick as optimizeTemplate to avoid unique-constraint
    // collisions on [routeId, stopNumber] while stop numbers are being rewritten.
    const offset = dto.stopIds.length + 1;
    const ops: Prisma.PrismaPromise<unknown>[] = [
      ...dto.stopIds.map((stopId, idx) =>
        this.prisma.forTenant().routeStop.update({
          where: { id: stopId },
          data: { stopNumber: idx + 1 + offset },
        }),
      ),
      ...dto.stopIds.map((stopId, idx) =>
        this.prisma.forTenant().routeStop.update({
          where: { id: stopId },
          data: { stopNumber: idx + 1 },
        }),
      ),
      this.prisma.forTenant().route.update({
        where: { id: routeId },
        data: {
          optimizeBy: dto.optimizeBy,
          avoidTolls: dto.avoidTolls,
          plannedPolyline: dto.encodedPolyline ?? null,
        },
      }),
    ];

    if (runStopIdsInOrder && runStopIdsInOrder.length > 0) {
      const runOffset = runStopIdsInOrder.length + 1;
      ops.push(
        ...runStopIdsInOrder.map((stopId, idx) =>
          this.prisma.forTenant().routeRunStop.update({
            where: { id: stopId },
            data: { stopNumber: idx + 1 + runOffset },
          }),
        ),
        ...runStopIdsInOrder.map((stopId, idx) =>
          this.prisma.forTenant().routeRunStop.update({
            where: { id: stopId },
            data: { stopNumber: idx + 1 },
          }),
        ),
        // Same bookkeeping as optimizeRoute: this order came from the solver,
        // not from a hand-drag.
        this.prisma.forTenant().routeRun.update({
          where: { id: dto.runId! },
          data: { manuallyReordered: false },
        }),
      );
    }

    await this.prisma.$transaction(ops);

    return { applied: true };
  }

  /**
   * Toll presence is derived by contrast rather than requested from Google (toll
   * computation on computeRoutes risks the Pro-tier double price). If a NO_TOLLS
   * variant exists in this batch, any other variant whose duration differs from
   * it by more than 2% OR whose stop order differs is presumed to route through
   * tolls. When NO_TOLLS is absent (the route already avoids tolls) — or every
   * comparison is within 2% with an identical stop order — hasTolls is false
   * everywhere. Mutates `results` in place.
   */
  private applyTollContrast(results: RouteVariant[]): void {
    const noTolls = results.find((r) => r.key === "NO_TOLLS");
    if (!noTolls) {
      for (const r of results) r.hasTolls = false;
      return;
    }
    for (const r of results) {
      const durationDiverges = !withinPercent(r.durationSec, noTolls.durationSec, 0.02);
      const orderDiverges = !sameStopOrder(r.stopIds, noTolls.stopIds);
      r.hasTolls = durationDiverges || orderDiverges;
    }
  }

  /** Drop a variant whose stopIds equal an earlier one AND whose duration/distance
   *  are both within 1% — same route under different settings can converge. */
  private dedupeVariants(variants: RouteVariant[]): RouteVariant[] {
    const kept: RouteVariant[] = [];
    for (const v of variants) {
      const dup = kept.find(
        (k) =>
          sameStopOrder(k.stopIds, v.stopIds) &&
          withinPercent(k.durationSec, v.durationSec, 0.01) &&
          withinPercent(k.distanceMeters, v.distanceMeters, 0.01),
      );
      if (!dup) kept.push(v);
    }
    return kept;
  }

  /**
   * ONE `computeRoutes` call for a solved stop order: real road totals + encoded
   * polyline. `intermediates` excludes the destination stop. Deliberately does NOT
   * request toll info — `travelAdvisory.tollInfo`/`extraComputations` risk the
   * Pro-tier double price on computeRoutes. Toll presence is derived by contrast
   * against the NO_TOLLS variant instead (see `applyTollContrast`).
   */
  private async computeRoutePolyline(
    start: LatLng,
    orderedStops: StopWithCoords[],
    endPoint: LatLng | null,
    avoidTolls: boolean,
    apiKey: string,
  ): Promise<{
    durationSec: number;
    distanceMeters: number;
    encodedPolyline: string | null;
  }> {
    const destination = endPoint ?? orderedStops[orderedStops.length - 1];
    const intermediates = endPoint ? orderedStops : orderedStops.slice(0, -1);

    const body = {
      origin: { location: { latLng: { latitude: start.lat, longitude: start.lng } } },
      destination: {
        location: { latLng: { latitude: destination.lat, longitude: destination.lng } },
      },
      intermediates: intermediates.map((s) => ({
        location: { latLng: { latitude: s.lat, longitude: s.lng } },
      })),
      travelMode: "DRIVE",
      routingPreference: "TRAFFIC_UNAWARE",
      ...(avoidTolls ? { routeModifiers: { avoidTolls: true } } : {}),
    };

    // Billing telemetry: this fetch is a real, billable computeRoutes call —
    // log it before making it so per-tenant Google spend is observable in
    // Railway logs before the invoice arrives.
    this.logger.log(
      `routes-billing computeRoutes calls=1 tenant=${this.prisma.getTenantId() ?? "unknown"}`,
    );

    const res = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "routes.polyline.encodedPolyline,routes.distanceMeters,routes.duration",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`computeRoutes ${res.status}`);

    const data = (await res.json()) as {
      routes?: Array<{
        polyline?: { encodedPolyline?: string };
        distanceMeters?: number;
        duration?: string;
      }>;
    };
    const r = data.routes?.[0];
    if (!r) throw new Error("computeRoutes: no route returned");

    return {
      durationSec: parseFloat((r.duration ?? "0s").replace(/s$/, "")),
      distanceMeters: r.distanceMeters ?? 0,
      encodedPolyline: r.polyline?.encodedPolyline ?? null,
    };
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
