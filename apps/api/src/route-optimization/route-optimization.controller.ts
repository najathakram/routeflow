import { Body, Controller, Param, Post, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { UserRole } from "@prisma/client";

// F9-007: route optimization/analysis hit the external ORS matrix API + run a
// TSP solve — far heavier than a normal request. The global 100/60s limit is
// too loose to protect them, so cap these routes tightly per client.
const OPTIMIZE_THROTTLE = { default: { ttl: 60_000, limit: 10 } } as const;
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { AddonGuard } from "../billing/addon.guard";
import { RequireAddon } from "../billing/require-addon.decorator";
import { RouteOptimizationService } from "./route-optimization.service";
import { RouteAnalysisService } from "./route-analysis.service";
import { ApplyRouteVariantDto } from "./dto/apply-route-variant.dto";

@ApiTags("route-runs")
@ApiBearerAuth()
// Owner decision 2026-08-28: optimize/analyze are SHARED between the two delivery features — an
// ad-hoc trip materializes a route run just like a recurring route, so these flows must keep
// working for a delivery-only tenant. developer_mode stays accepted server-side ONLY so a dev
// tenant can exercise the still-in-development mobile driver app end-to-end. Guard order
// matters: AddonGuard reads req.user (set by JwtAuthGuard).
@UseGuards(JwtAuthGuard, RolesGuard, AddonGuard)
@Controller("route-runs")
@RequireAddon("recurring_routes", "order_delivery", "developer_mode")
export class RouteOptimizationController {
  constructor(
    private readonly service: RouteOptimizationService,
    private readonly analysisService: RouteAnalysisService,
  ) {}

  @Post(":id/optimize")
  @Throttle(OPTIMIZE_THROTTLE)
  @Roles(UserRole.OPERATOR, UserRole.DRIVER)
  optimize(
    @Param("id") id: string,
    @Body() body?: { originLat?: number; originLng?: number; startTime?: string },
  ) {
    const origin =
      typeof body?.originLat === "number" && typeof body?.originLng === "number"
        ? { lat: body.originLat, lng: body.originLng }
        : null;
    // The caller's CURRENT departure clock, for a mid-run re-optimize: without
    // it an underway run's windows would be judged against its scheduled
    // departure. Same "HH:mm" shape the route-settings/run DTOs validate.
    const startTime =
      typeof body?.startTime === "string" && /^\d{2}:\d{2}$/.test(body.startTime)
        ? body.startTime
        : undefined;
    return this.service.optimizeRoute(id, origin, startTime);
  }

  @Post(":id/analyze")
  @Throttle(OPTIMIZE_THROTTLE)
  @Roles(UserRole.OPERATOR)
  analyze(@Param("id") id: string, @Body() body?: { startTime?: string }) {
    return this.analysisService.analyzeRouteRun(id, body?.startTime);
  }
}

@ApiTags("routes")
@ApiBearerAuth()
// Same either-gate as RouteOptimizationController above — see the rationale comment there.
@UseGuards(JwtAuthGuard, RolesGuard, AddonGuard)
@Roles(UserRole.OPERATOR)
@Controller("routes")
@RequireAddon("recurring_routes", "order_delivery", "developer_mode")
export class RouteTemplateOptimizationController {
  constructor(
    private readonly service: RouteOptimizationService,
    private readonly analysisService: RouteAnalysisService,
  ) {}

  @Post(":id/optimize")
  @Throttle(OPTIMIZE_THROTTLE)
  optimize(@Param("id") id: string) {
    return this.service.optimizeTemplate(id);
  }

  @Post(":id/analyze")
  @Throttle(OPTIMIZE_THROTTLE)
  // `windowsOnly` returns the deterministic ETA/window pass and skips the
  // Anthropic call entirely — what the dispatch modals need, with no AI spend.
  analyze(@Param("id") id: string, @Body() body?: { startTime?: string; windowsOnly?: boolean }) {
    return this.analysisService.analyzeRoute(id, body?.startTime, {
      windowsOnly: body?.windowsOnly === true,
    });
  }

  @Post(":id/variants")
  @Throttle(OPTIMIZE_THROTTLE)
  variants(@Param("id") id: string) {
    return this.service.getRouteVariants(id);
  }

  @Post(":id/variants/apply")
  @Throttle(OPTIMIZE_THROTTLE)
  applyVariant(@Param("id") id: string, @Body() body: ApplyRouteVariantDto) {
    return this.service.applyRouteVariant(id, body);
  }
}
