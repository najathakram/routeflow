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
    const route = await this.prisma.route.findUnique({
      where: { id: routeId },
      include: {
        stops: {
          include: {
            customer: { select: { id: true, businessName: true, deliveryWindowStart: true, deliveryWindowEnd: true } },
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
        await this.prisma.customerAddress.update({ where: { id: addr.id }, data: coords });
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

    await this.prisma.$transaction(
      stopOrder.map(({ stopId, stopNumber }) =>
        this.prisma.routeStop.update({
          where: { id: stopId },
          data: { stopNumber },
        }),
      ),
    );

    const originalOrder = new Map(stops.map((s) => [s.id, s.stopNumber]));
    const reorderedCount = stopOrder.filter(
      ({ stopId, stopNumber }) => originalOrder.get(stopId) !== stopNumber,
    ).length;

    return { stopOrder, reorderedCount, usedFallback };
  }

  async optimizeRoute(routeRunId: string): Promise<OptimizeResult> {
    const run = await this.prisma.routeRun.findUnique({
      where: { id: routeRunId },
      include: {
        stops: {
          include: {
            routeStop: {
              include: {
                customer: { select: { id: true, businessName: true, deliveryWindowStart: true, deliveryWindowEnd: true } },
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
        await this.prisma.customerAddress.update({
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

    await this.prisma.$transaction(
      stopOrder.map(({ stopId, stopNumber }) =>
        this.prisma.routeRunStop.update({
          where: { id: stopId },
          data: { stopNumber },
        }),
      ),
    );

    await this.prisma.routeRun.update({
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

  // ─── Nearest-neighbour fallback (pure TS) ────────────────────────────────

  private nearestNeighborFallback(stops: StopWithCoords[]): string[] {
    const unvisited = [...stops];
    const result: string[] = [];
    let current = unvisited.shift()!;
    result.push(current.id);

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
      result.push(current.id);
    }
    return result;
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
