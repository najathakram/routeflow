import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import Anthropic from "@anthropic-ai/sdk";
import { PrismaService } from "../prisma/prisma.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { PlatformConfigService } from "../platform-admin/platform-config.service";
import { RouteOptimizationService, StopETA } from "./route-optimization.service";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RouteAnalysisResult {
  configured: boolean;
  summary?: string;
  stops?: Array<{
    stopNumber: number;
    status: "ok" | "warning" | "critical";
    message: string;
  }>;
  suggestions?: string[];
  etas: StopETA[];
}

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class RouteAnalysisService {
  private readonly logger = new Logger(RouteAnalysisService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly systemConfig: SystemConfigService,
    private readonly platformConfig: PlatformConfigService,
    private readonly optimizationService: RouteOptimizationService,
  ) {}

  /**
   * Analyze a route template for delivery window compliance.
   * Calculates ETAs and optionally uses Claude for natural language insights.
   */
  async analyzeRoute(routeId: string, startTime?: string): Promise<RouteAnalysisResult> {
    // Load route with stops + customer delivery windows
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
      return { configured: false, etas: [] };
    }

    // Resolve depot
    const depot = await this.optimizationService.resolveDepot(routeId);

    // Load route settings
    const avgSpeedRaw = await this.systemConfig.get("route.averageSpeedKmh");
    const serviceTimeRaw = await this.systemConfig.get("route.serviceTimeMinutes");
    const defaultStartTimeRaw = await this.systemConfig.get("route.defaultStartTime");

    const avgSpeed = avgSpeedRaw != null ? parseFloat(avgSpeedRaw) : 50;
    const serviceTime = serviceTimeRaw != null ? parseFloat(serviceTimeRaw) : 15;
    const effectiveStartTime = startTime ?? defaultStartTimeRaw ?? "08:00";

    // Build stop data
    const stopsWithCoords = route.stops
      .filter((s) => s.customerAddress?.lat != null && s.customerAddress?.lng != null)
      .map((s) => ({
        id: s.id,
        stopNumber: s.stopNumber,
        customerName: s.customer?.businessName ?? s.id,
        lat: s.customerAddress!.lat!,
        lng: s.customerAddress!.lng!,
        deliveryWindowStart: s.customer?.deliveryWindowStart ?? null,
        deliveryWindowEnd: s.customer?.deliveryWindowEnd ?? null,
      }));

    // Calculate ETAs
    const etas = this.optimizationService.calculateETAs(
      depot ? { lat: depot.lat, lng: depot.lng } : null,
      stopsWithCoords,
      effectiveStartTime,
      avgSpeed,
      serviceTime,
    );

    // Resolve Anthropic API key
    const tenantKey = await this.systemConfig.get("anthropic.apiKey");
    const apiKey = await this.platformConfig.resolveAnthropicKey(tenantKey);

    if (!apiKey) {
      return { configured: false, etas };
    }

    // Call Claude for analysis
    let model: string | null = null;
    let usageRecorded = false;
    try {
      const depotAddress = depot
        ? route.depotAddress || "configured depot"
        : "first stop (no depot configured)";

      const stopsDescription = etas
        .map(
          (e) =>
            `${e.stopNumber}. ${e.customerName} — ETA: ${e.arrivalTime} — Window: ${e.deliveryWindowStart || "none"}–${e.deliveryWindowEnd || "none"} — ${e.withinWindow === true ? "ON TIME" : e.withinWindow === false ? "LATE" : "no window"}`,
        )
        .join("\n");

      model = await this.platformConfig.resolveModel();
      const anthropic = new Anthropic({ apiKey });

      const response = await anthropic.messages.create({
        model,
        max_tokens: 1024,
        messages: [
          {
            role: "user",
            content: `Analyze this delivery route for timing feasibility.

Route: ${route.name}
Departure: ${effectiveStartTime} from ${depotAddress}
Average speed: ${avgSpeed} km/h | Service time per stop: ${serviceTime} min

Stops:
${stopsDescription}

Return ONLY valid JSON (no markdown, no code fences):
{
  "summary": "1-2 sentence overall assessment of the route's feasibility",
  "stops": [{"stopNumber": 1, "status": "ok|warning|critical", "message": "brief reason for the status"}],
  "suggestions": ["actionable suggestion to improve the route"]
}

Status guide:
- "ok" = arrives within delivery window or no window set
- "warning" = arrives within 15 minutes of window boundary
- "critical" = arrives outside delivery window`,
          },
        ],
      });

      // The call succeeded, so the spend is real — record it even if parsing
      // the response fails below.
      usageRecorded = true;
      await this.platformConfig.recordAiUsage({
        tenantId: this.prisma.getTenantId(),
        feature: "insights.route",
        model,
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
      });

      const textBlock = response.content.find((b) => b.type === "text");
      const rawText = textBlock?.type === "text" ? textBlock.text : "";

      // Parse JSON — handle potential markdown fences
      const jsonStr = rawText
        .replace(/```(?:json)?\s*/g, "")
        .replace(/```/g, "")
        .trim();
      const analysis = JSON.parse(jsonStr) as {
        summary?: string;
        stops?: Array<{ stopNumber: number; status: string; message: string }>;
        suggestions?: string[];
      };

      return {
        configured: true,
        summary: analysis.summary,
        stops: analysis.stops?.map((s) => ({
          stopNumber: s.stopNumber,
          status: (s.status as "ok" | "warning" | "critical") || "ok",
          message: s.message,
        })),
        suggestions: analysis.suggestions,
        etas,
      };
    } catch (err) {
      this.logger.warn("AI route analysis failed", err instanceof Error ? err.message : err);
      if (!usageRecorded) {
        await this.platformConfig.recordAiUsage({
          tenantId: this.prisma.getTenantId(),
          feature: "insights.route",
          model: model ?? "unknown",
          success: false,
        });
      }
      return { configured: true, summary: "AI analysis unavailable — showing ETAs only.", etas };
    }
  }

  /**
   * Analyze a route run using its snapshotted depot and start time.
   */
  async analyzeRouteRun(routeRunId: string, startTime?: string): Promise<RouteAnalysisResult> {
    const run = await this.prisma.forTenant().routeRun.findUnique({
      where: { id: routeRunId },
      include: {
        route: true,
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

    // Use run's snapshotted depot if available, otherwise resolve from route
    const depot =
      run.depotLat != null && run.depotLng != null
        ? { lat: run.depotLat, lng: run.depotLng, address: run.depotAddress ?? "" }
        : await this.optimizationService.resolveDepot(run.routeId);

    const effectiveStartTime =
      startTime ??
      run.startTime ??
      (await this.systemConfig.get("route.defaultStartTime")) ??
      "08:00";

    // Delegate to analyzeRoute logic using the run's route
    // But since the run has its own stop order, we use its stops directly
    const avgSpeedRaw = await this.systemConfig.get("route.averageSpeedKmh");
    const serviceTimeRaw = await this.systemConfig.get("route.serviceTimeMinutes");
    const avgSpeed = avgSpeedRaw != null ? parseFloat(avgSpeedRaw) : 50;
    const serviceTime = serviceTimeRaw != null ? parseFloat(serviceTimeRaw) : 15;

    const stopsWithCoords = run.stops
      .filter(
        (s) => s.routeStop.customerAddress?.lat != null && s.routeStop.customerAddress?.lng != null,
      )
      .map((s) => ({
        id: s.id,
        stopNumber: s.stopNumber,
        customerName: s.routeStop.customer?.businessName ?? s.id,
        lat: s.routeStop.customerAddress!.lat!,
        lng: s.routeStop.customerAddress!.lng!,
        deliveryWindowStart: s.routeStop.customer?.deliveryWindowStart ?? null,
        deliveryWindowEnd: s.routeStop.customer?.deliveryWindowEnd ?? null,
      }));

    const etas = this.optimizationService.calculateETAs(
      depot ? { lat: depot.lat, lng: depot.lng } : null,
      stopsWithCoords,
      effectiveStartTime,
      avgSpeed,
      serviceTime,
    );

    // Resolve Anthropic API key
    const tenantKey = await this.systemConfig.get("anthropic.apiKey");
    const apiKey = await this.platformConfig.resolveAnthropicKey(tenantKey);

    if (!apiKey) {
      return { configured: false, etas };
    }

    let model: string | null = null;
    let usageRecorded = false;
    try {
      const depotAddress = depot
        ? run.depotAddress || run.route.depotAddress || "configured depot"
        : "first stop (no depot configured)";

      const stopsDescription = etas
        .map(
          (e) =>
            `${e.stopNumber}. ${e.customerName} — ETA: ${e.arrivalTime} — Window: ${e.deliveryWindowStart || "none"}–${e.deliveryWindowEnd || "none"} — ${e.withinWindow === true ? "ON TIME" : e.withinWindow === false ? "LATE" : "no window"}`,
        )
        .join("\n");

      model = await this.platformConfig.resolveModel();
      const anthropic = new Anthropic({ apiKey });

      const response = await anthropic.messages.create({
        model,
        max_tokens: 1024,
        messages: [
          {
            role: "user",
            content: `Analyze this delivery route run for timing feasibility.

Route: ${run.route.name}
Departure: ${effectiveStartTime} from ${depotAddress}
Average speed: ${avgSpeed} km/h | Service time per stop: ${serviceTime} min

Stops:
${stopsDescription}

Return ONLY valid JSON (no markdown, no code fences):
{
  "summary": "1-2 sentence overall assessment of the route's feasibility",
  "stops": [{"stopNumber": 1, "status": "ok|warning|critical", "message": "brief reason for the status"}],
  "suggestions": ["actionable suggestion to improve the route"]
}

Status guide:
- "ok" = arrives within delivery window or no window set
- "warning" = arrives within 15 minutes of window boundary
- "critical" = arrives outside delivery window`,
          },
        ],
      });

      // The call succeeded, so the spend is real — record it even if parsing
      // the response fails below.
      usageRecorded = true;
      await this.platformConfig.recordAiUsage({
        tenantId: this.prisma.getTenantId(),
        feature: "insights.route",
        model,
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
      });

      const textBlock = response.content.find((b) => b.type === "text");
      const rawText = textBlock?.type === "text" ? textBlock.text : "";
      const jsonStr = rawText
        .replace(/```(?:json)?\s*/g, "")
        .replace(/```/g, "")
        .trim();
      const analysis = JSON.parse(jsonStr) as {
        summary?: string;
        stops?: Array<{ stopNumber: number; status: string; message: string }>;
        suggestions?: string[];
      };

      return {
        configured: true,
        summary: analysis.summary,
        stops: analysis.stops?.map((s) => ({
          stopNumber: s.stopNumber,
          status: (s.status as "ok" | "warning" | "critical") || "ok",
          message: s.message,
        })),
        suggestions: analysis.suggestions,
        etas,
      };
    } catch (err) {
      this.logger.warn("AI route run analysis failed", err instanceof Error ? err.message : err);
      if (!usageRecorded) {
        await this.platformConfig.recordAiUsage({
          tenantId: this.prisma.getTenantId(),
          feature: "insights.route",
          model: model ?? "unknown",
          success: false,
        });
      }
      return { configured: true, summary: "AI analysis unavailable — showing ETAs only.", etas };
    }
  }
}
