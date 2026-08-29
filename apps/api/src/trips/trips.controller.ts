import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { UserRole } from "@prisma/client";
import { TripsService } from "./trips.service";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { AddonGuard } from "../billing/addon.guard";
import { RequireAddon } from "../billing/require-addon.decorator";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { CreateTripDto } from "./dto/create-trip.dto";
import { TripEligibilityQueryDto } from "./dto/trip-eligibility.dto";
import { EligibleOrdersQueryDto } from "./dto/eligible-orders.dto";
import { RoutePlanningDto } from "./dto/route-planning.dto";

@ApiTags("trips")
@ApiBearerAuth()
// Owner decision 2026-08-28: /trips is the ad-hoc delivery builder — order_delivery-only
// (unlike /routes, /route-runs, /drivers, and route-optimization, which are shared with
// recurring routes). developer_mode stays accepted server-side ONLY so a dev tenant can
// exercise the still-in-development mobile driver app end-to-end. Guard order matters:
// AddonGuard reads req.user (set by JwtAuthGuard). One handler (updatePlanning) overrides this
// class gate — see its comment below.
@UseGuards(JwtAuthGuard, RolesGuard, AddonGuard)
@Roles(UserRole.OPERATOR)
@Controller("trips")
@RequireAddon("order_delivery", "developer_mode")
export class TripsController {
  constructor(private readonly tripsService: TripsService) {}

  @Get("eligibility")
  getEligibility(@Query() query: TripEligibilityQueryDto, @CurrentUser() user: JwtPayload) {
    return this.tripsService.getEligibility(user.tenantId!, query.orderIds);
  }

  @Get("eligible-orders")
  getEligibleOrders(@Query() query: EligibleOrdersQueryDto, @CurrentUser() user: JwtPayload) {
    return this.tripsService.getEligibleOrders(user.tenantId!, query);
  }

  @Post()
  createTrip(@Body() dto: CreateTripDto, @CurrentUser() user: JwtPayload) {
    return this.tripsService.createTrip(user.tenantId!, dto);
  }

  // Exception to the class gate: route planning (start/end, tolls, objective) is edited from
  // the SHARED run-detail page (/routes/:id), which a recurring-routes-only tenant can reach —
  // so this handler takes the same either-gate as /routes and /route-runs. Handler metadata
  // wins over the class array (reflector.getAllAndOverride checks the handler first).
  @RequireAddon("recurring_routes", "order_delivery", "developer_mode")
  @Patch("routes/:routeId/planning")
  updatePlanning(
    @Param("routeId") routeId: string,
    @Body() dto: RoutePlanningDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.tripsService.updatePlanning(user.tenantId!, routeId, dto);
  }
}
