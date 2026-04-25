import { Body, Controller, Param, Post, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { UserRole } from "@prisma/client";
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
  @Roles(UserRole.OPERATOR, UserRole.DRIVER)
  optimize(
    @Param("id") id: string,
    @Body() body?: { originLat?: number; originLng?: number },
  ) {
    const origin =
      typeof body?.originLat === "number" && typeof body?.originLng === "number"
        ? { lat: body.originLat, lng: body.originLng }
        : null;
    return this.service.optimizeRoute(id, origin);
  }

  @Post(":id/analyze")
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
  optimize(@Param("id") id: string) {
    return this.service.optimizeTemplate(id);
  }

  @Post(":id/analyze")
  analyze(@Param("id") id: string, @Body() body?: { startTime?: string }) {
    return this.analysisService.analyzeRoute(id, body?.startTime);
  }
}
