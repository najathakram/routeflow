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
import { RouteOptimizationService } from "./route-optimization.service";
import { RouteAnalysisService } from "./route-analysis.service";

@ApiTags("route-runs")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller("route-runs")
export class RouteOptimizationController {
  constructor(
    private readonly service: RouteOptimizationService,
    private readonly analysisService: RouteAnalysisService,
  ) {}

  @Post(":id/optimize")
  @Throttle(OPTIMIZE_THROTTLE)
  @Roles(UserRole.OPERATOR, UserRole.DRIVER)
  optimize(@Param("id") id: string, @Body() body?: { originLat?: number; originLng?: number }) {
    const origin =
      typeof body?.originLat === "number" && typeof body?.originLng === "number"
        ? { lat: body.originLat, lng: body.originLng }
        : null;
    return this.service.optimizeRoute(id, origin);
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
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OPERATOR)
@Controller("routes")
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
  analyze(@Param("id") id: string, @Body() body?: { startTime?: string }) {
    return this.analysisService.analyzeRoute(id, body?.startTime);
  }
}
