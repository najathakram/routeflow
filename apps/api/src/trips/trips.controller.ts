import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { UserRole } from "@prisma/client";
import { TripsService } from "./trips.service";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { CreateTripDto } from "./dto/create-trip.dto";
import { TripEligibilityQueryDto } from "./dto/trip-eligibility.dto";
import { EligibleOrdersQueryDto } from "./dto/eligible-orders.dto";
import { RoutePlanningDto } from "./dto/route-planning.dto";

@ApiTags("trips")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OPERATOR)
@Controller("trips")
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

  @Patch("routes/:routeId/planning")
  updatePlanning(
    @Param("routeId") routeId: string,
    @Body() dto: RoutePlanningDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.tripsService.updatePlanning(user.tenantId!, routeId, dto);
  }
}
