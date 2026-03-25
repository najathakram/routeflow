import { Controller, Get, Post, Patch, Body, Param, Query, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { OrdersService } from "./orders.service";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { UserRole } from "@prisma/client";
import { ListOrdersDto } from "./dto/list-orders.dto";
import { CreateOrderDto } from "./dto/create-order.dto";
import { ChangeOrderStatusDto } from "./dto/change-order-status.dto";
import { UpdateOrderItemsDto } from "./dto/update-order-items.dto";
import { CompleteStopDto } from "./dto/complete-stop.dto";

@ApiTags("orders")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("orders")
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Get()
  findAll(@Query() query: ListOrdersDto, @CurrentUser() user: JwtPayload) {
    return this.ordersService.findAll(query, user);
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR, UserRole.CUSTOMER)
  create(@Body() dto: CreateOrderDto, @CurrentUser() user: JwtPayload) {
    return this.ordersService.create(dto, user);
  }

  @Get(":id")
  findOne(@Param("id") id: string, @CurrentUser() user: JwtPayload) {
    return this.ordersService.findOne(id, user);
  }

  @Patch(":id/status")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR, UserRole.CUSTOMER)
  changeStatus(
    @Param("id") id: string,
    @Body() dto: ChangeOrderStatusDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.ordersService.changeStatus(id, dto, user);
  }

  @Patch(":id/items")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR)
  updateOrderItems(@Param("id") id: string, @Body() dto: UpdateOrderItemsDto) {
    return this.ordersService.updateOrderItems(id, dto);
  }

  @Patch(":id/urgent")
  toggleUrgent(@Param("id") id: string, @CurrentUser() user: JwtPayload) {
    return this.ordersService.toggleUrgent(id, user);
  }
}

@ApiTags("route-runs")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("route-runs")
export class RouteRunDeliveryController {
  constructor(private readonly ordersService: OrdersService) {}

  @Post(":runId/stops/:stopId/complete")
  completeStop(
    @Param("runId") runId: string,
    @Param("stopId") stopId: string,
    @Body() dto: CompleteStopDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.ordersService.completeStop(runId, stopId, dto, user);
  }
}
