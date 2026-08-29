import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Headers,
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
import { AddonGuard } from "../billing/addon.guard";
import { RequireAddon } from "../billing/require-addon.decorator";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { UserRole } from "@prisma/client";
import { ListRoutesDto } from "./dto/list-routes.dto";
import { CreateRouteDto } from "./dto/create-route.dto";
import { UpdateRouteDto } from "./dto/update-route.dto";
import { AddStopDto } from "./dto/add-stop.dto";
import { CreateRouteRunDto } from "./dto/create-route-run.dto";
import { UpdateRunStatusDto } from "./dto/update-run-status.dto";
import { ListRunsDto } from "./dto/list-runs.dto";
import { CompleteStopDto } from "./dto/complete-stop.dto";
import { CompleteWithPaymentDto } from "./dto/complete-with-payment.dto";
import { AttachPodArtifactDto } from "./dto/attach-pod-artifact.dto";
import { DriverPaymentsGuard } from "./driver-payments.guard";

@ApiTags("routes")
@ApiBearerAuth()
// Owner decision 2026-08-28: /routes is SHARED between the two delivery features — an ad-hoc
// trip materializes a route template + run, so template/detail/optimize flows must keep working
// for a delivery-only tenant (mirrors RECURRING_ROUTES_PATHS in
// apps/web/app/(dashboard)/layout.tsx, which downgrades everything under /routes except the
// list/create pages to "either"). developer_mode stays accepted server-side ONLY so a dev tenant
// can exercise the still-in-development mobile driver app end-to-end — it no longer unlocks this
// UI anywhere in the web/mobile clients. Guard order matters: AddonGuard reads req.user (set by
// JwtAuthGuard).
@UseGuards(JwtAuthGuard, AddonGuard)
@Controller("routes")
@RequireAddon("recurring_routes", "order_delivery", "developer_mode")
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

  @Get("live")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR, UserRole.TENANT_ADMIN)
  getLive() {
    return this.routesService.getLiveRoutes();
  }

  @Get(":id/packing-list")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR, UserRole.DRIVER)
  getPackingList(@Param("id") id: string) {
    return this.routesService.getPackingList(id);
  }

  @Get(":id")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR, UserRole.DRIVER)
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
// Same either-gate as RoutesController above — a run is the shared execution object for both
// recurring routes and ad-hoc trips, so runs/detail/complete flows must keep working for either
// feature alone. See the rationale comment on RoutesController.
@UseGuards(JwtAuthGuard, AddonGuard)
@Controller("route-runs")
@RequireAddon("recurring_routes", "order_delivery", "developer_mode")
export class RouteRunsController {
  constructor(private readonly routesService: RoutesService) {}

  @Get()
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR, UserRole.DRIVER)
  findAll(@Query() query: ListRunsDto, @CurrentUser() user: JwtPayload) {
    return this.routesService.findAllRuns(query, user);
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR, UserRole.DRIVER)
  create(@Body() dto: CreateRouteRunDto, @CurrentUser() user: JwtPayload) {
    return this.routesService.createRun(dto, user);
  }

  @Get("my-runs")
  @UseGuards(RolesGuard)
  @Roles(UserRole.DRIVER)
  getMyRuns(@CurrentUser() user: JwtPayload) {
    return this.routesService.findMyRuns(user);
  }

  @Get("my-stats")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR, UserRole.DRIVER)
  getMyStats(@CurrentUser() user: JwtPayload) {
    return this.routesService.getMyStats(user);
  }

  @Get(":id/packing-list")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR, UserRole.DRIVER)
  getRunPackingList(@Param("id") id: string) {
    return this.routesService.getRunPackingList(id);
  }

  @Get(":id")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR, UserRole.DRIVER)
  findOne(@Param("id") id: string, @CurrentUser() user: JwtPayload) {
    return this.routesService.findOneRun(id, user);
  }

  @Post(":id/stops/:stopId/complete")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR, UserRole.DRIVER)
  completeStop(
    @Param("id") runId: string,
    @Param("stopId") stopId: string,
    @Body() body: CompleteStopDto,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.routesService.completeStop(runId, stopId, { ...body, idempotencyKey }, user);
  }

  // RF-005: Atomic complete + payment
  //
  // At-door MONEY COLLECTION is a per-tenant OPT-IN (owner decision
  // 2026-08-24): some tenants (affa) let drivers collect at the door, others
  // (bb-distro) bill on account only and the office collects. Enforced by
  // DriverPaymentsGuard on the BODY, not a blanket addon gate on the route —
  // every mobile completion (including $0 "on account") flows through this
  // endpoint for its delivered-basis invoice reconcile, so completions with
  // no payment (or amount 0) must keep working for every tenant. Only a
  // payment with amount > 0 requires the "driver_payments" TenantAddon
  // (enable from platform-admin).
  @Post(":id/stops/:stopId/complete-with-payment")
  @UseGuards(RolesGuard, DriverPaymentsGuard)
  @Roles(UserRole.OPERATOR, UserRole.DRIVER)
  completeWithPayment(
    @Param("id") runId: string,
    @Param("stopId") stopId: string,
    @Body() body: CompleteWithPaymentDto,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.routesService.completeWithPayment(runId, stopId, { ...body, idempotencyKey }, user);
  }

  // Durable POD: one artifact per JSON request (data URL, never multipart —
  // FormData is excluded from the mobile offline queue), stored under
  // tenants/<tenantId>/pod/<stopId>/ and appended to the stop.
  @Post(":id/stops/:stopId/pod-artifact")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR, UserRole.DRIVER)
  attachPodArtifact(
    @Param("id") runId: string,
    @Param("stopId") stopId: string,
    @Body() body: AttachPodArtifactDto,
  ) {
    return this.routesService.attachPodArtifact(runId, stopId, body);
  }

  @Get(":id/stops/:stopId/pod")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR, UserRole.DRIVER)
  getStopPod(@Param("id") runId: string, @Param("stopId") stopId: string) {
    return this.routesService.getStopPod(runId, stopId);
  }

  @Patch(":id/stops/:stopId")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR, UserRole.DRIVER)
  updateStopStatus(
    @Param("id") id: string,
    @Param("stopId") stopId: string,
    @Body() body: { status: "IN_PROGRESS" | "SKIPPED"; driverNote?: string },
    @CurrentUser() user: JwtPayload,
  ) {
    return this.routesService.updateStopStatus(id, stopId, body, user);
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
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR, UserRole.DRIVER)
  updateStatus(
    @Param("id") id: string,
    @Body() dto: UpdateRunStatusDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.routesService.updateRunStatus(id, dto, user);
  }

  @Post(":id/stops/:stopId/reopen")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR, UserRole.DRIVER)
  reopenStop(
    @Param("id") runId: string,
    @Param("stopId") stopId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.routesService.reopenStop(runId, stopId, user);
  }
}
