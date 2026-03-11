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
  @Roles(UserRole.OPERATOR)
  create(@Body() dto: CreateRouteRunDto) {
    return this.routesService.createRun(dto);
  }

  @Get(":id")
  findOne(@Param("id") id: string) {
    return this.routesService.findOneRun(id);
  }

  @Patch(":id/status")
  updateStatus(
    @Param("id") id: string,
    @Body() dto: UpdateRunStatusDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.routesService.updateRunStatus(id, dto, user);
  }
}
