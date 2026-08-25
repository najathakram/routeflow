import { Body, Controller, Get, Post, Query, UseGuards } from "@nestjs/common";
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

  @Post()
  createTrip(@Body() dto: CreateTripDto, @CurrentUser() user: JwtPayload) {
    return this.tripsService.createTrip(user.tenantId!, dto);
  }
}
