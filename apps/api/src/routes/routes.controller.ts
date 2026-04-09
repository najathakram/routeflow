import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { RoutesService } from "./routes.service";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { UserRole } from "@prisma/client";
import { ListRoutesDto } from "./dto/list-routes.dto";
import { CreateRouteDto } from "./dto/create-route.dto";
import { UpdateRouteDto } from "./dto/update-route.dto";
import { AddStopDto } from "./dto/add-stop.dto";
import { CreateRouteRunDto } from "./dto/create-route-run.dto";
import { UpdateRunStatusDto } from "./dto/update-run-status.dto";
import { ListRunsDto } from "./dto/list-runs.dto";

@ApiTags("routes")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("routes")
export class RoutesController {
  constructor(private readonly routesService: RoutesService) {}

  @Get()
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR)
  findAll(@Query() query: ListRoutesDto) {
    return this.routesService.findAllRoutes(query);
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR)
  create(@Body() dto: CreateRouteDto) {
    return this.routesService.createRoute(dto);
  }

  @Get("customer-assignments")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR)
  getCustomerAssignments() {
    return this.routesService.getCustomerRouteAssignments();
  }

  @Get(":id/packing-list")
  getPackingList(@Param("id") id: string) {
    return this.routesService.getPackingList(id);
  }

  @Get(":id")
  findOne(@Param("id") id: string) {
    return this.routesService.findOneRoute(id);
  }

  @Patch(":id")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR)
  update(@Param("id") id: string, @Body() dto: UpdateRouteDto) {
    return this.routesService.updateRoute(id, dto);
  }

  @Post(":id/stops")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR)
  addStop(@Param("id") id: string, @Body() dto: AddStopDto) {
    return this.routesService.addStop(id, dto);
  }

  @Patch(":id/stops/reorder")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR)
  reorderStops(
    @Param("id") id: string,
    @Body() body: { order: { id: string; stopNumber: number }[] },
  ) {
    return this.routesService.reorderStops(id, body.order);
  }

  @Delete(":id/stops/:stopId")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR)
  removeStop(@Param("id") id: string, @Param("stopId") stopId: string) {
    return this.routesService.removeStop(id, stopId);
  }

  @Delete(":id")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR)
  deleteRoute(@Param("id") id: string) {
    return this.routesService.deleteRoute(id);
  }
}

@ApiTags("route-runs")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("route-runs")
export class RouteRunsController {
  constructor(private readonly routesService: RoutesService) {}

  @Get()
  findAll(@Query() query: ListRunsDto, @CurrentUser() user: JwtPayload) {
    return this.routesService.findAllRuns(query, user);
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR, UserRole.DRIVER)
  create(@Body() dto: CreateRouteRunDto, @CurrentUser() user: JwtPayload) {
    return this.routesService.createRun(dto, user);
  }

  @Get("my-stats")
  getMyStats(@CurrentUser() user: JwtPayload) {
    return this.routesService.getMyStats(user);
  }

  @Get(":id/packing-list")
  getRunPackingList(@Param("id") id: string) {
    return this.routesService.getRunPackingList(id);
  }

  @Get(":id")
  findOne(@Param("id") id: string, @CurrentUser() user: JwtPayload) {
    return this.routesService.findOneRun(id, user);
  }

  @Patch(":id/stops/:stopId")
  updateStopStatus(
    @Param("id") id: string,
    @Param("stopId") stopId: string,
    @Body() body: { status: "IN_PROGRESS" | "SKIPPED"; driverNote?: string },
  ) {
    return this.routesService.updateStopStatus(id, stopId, body);
  }

  @Patch(":id/stops/reorder")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR)
  reorderRunStops(
    @Param("id") id: string,
    @Body() body: { order: { id: string; stopNumber: number }[] },
  ) {
    return this.routesService.reorderRunStops(id, body.order);
  }

  @Patch(":id")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR, UserRole.DRIVER)
  updateRun(
    @Param("id") id: string,
    @Body() body: { driverId?: string | null; scheduledDate?: string; notes?: string },
    @CurrentUser() user: JwtPayload,
  ) {
    return this.routesService.updateRun(id, body, user);
  }

  @Delete(":id")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR)
  deleteRun(@Param("id") id: string) {
    return this.routesService.deleteRun(id);
  }

  @Patch(":id/status")
  updateStatus(
    @Param("id") id: string,
    @Body() dto: UpdateRunStatusDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.routesService.updateRunStatus(id, dto, user);
  }

  @Post(":id/stops/:stopId/reopen")
  reopenStop(
    @Param("id") runId: string,
    @Param("stopId") stopId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.routesService.reopenStop(runId, stopId, user);
  }
}
