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
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR, UserRole.CUSTOMER)
  findAll(@Query() query: ListOrdersDto, @CurrentUser() user: JwtPayload) {
    return this.ordersService.findAll(query, user);
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR, UserRole.CUSTOMER, UserRole.DRIVER)
  async create(@Body() dto: CreateOrderDto, @CurrentUser() user: JwtPayload) {
    const isStaff = user.role === UserRole.OPERATOR || (user.role as string) === "TENANT_ADMIN";
    if (isStaff && dto.customerId && !dto.forceNew) {
      const activeOrder = await this.ordersService.findActiveOrder(dto.customerId);
      if (activeOrder) {
        const mergedMap = new Map<string, number>();
        for (const li of activeOrder.lineItems) {
          mergedMap.set(li.productId, Number(li.qty));
        }
        for (const item of dto.items ?? []) {
          mergedMap.set(item.productId, (mergedMap.get(item.productId) ?? 0) + item.qty);
        }
        const mergedItems = Array.from(mergedMap.entries()).map(([productId, qty]) => ({
          productId,
          qty,
        }));
        await this.ordersService.updateOrderItems(
          activeOrder.id,
          { items: mergedItems } as any,
          user,
        );
        // Sweep any other PENDING orders for this customer into the winner.
        await this.ordersService.mergeAllPendingForCustomer(dto.customerId);
        return this.ordersService.findOne(activeOrder.id, user);
      }
    }
    const created = await this.ordersService.create(dto, user);
    // Newly-created order may share a customer with pre-existing PENDINGs
    // (e.g. driver/customer-initiated path) — consolidate them too.
    if (created.customerId) {
      const merged = await this.ordersService.mergeAllPendingForCustomer(created.customerId);
      if (merged) return merged;
    }
    return created;
  }

  @Get(":id/tracking")
  getTracking(@Param("id") id: string, @CurrentUser() user: JwtPayload) {
    return this.ordersService.getOrderTracking(id, user);
  }

  @Get(":id")
  findOne(@Param("id") id: string, @CurrentUser() user: JwtPayload) {
    return this.ordersService.findOne(id, user);
  }

  @Patch(":id/status")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR, UserRole.CUSTOMER, UserRole.DRIVER)
  changeStatus(
    @Param("id") id: string,
    @Body() dto: ChangeOrderStatusDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.ordersService.changeStatus(id, dto, user);
  }

  @Post(":id/reopen")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR)
  reopenOrder(@Param("id") id: string) {
    return this.ordersService.reopenOrder(id);
  }

  @Patch(":id/items")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR, UserRole.CUSTOMER, UserRole.DRIVER)
  updateOrderItems(
    @Param("id") id: string,
    @Body() dto: UpdateOrderItemsDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.ordersService.updateOrderItems(id, dto, user);
  }

  @Patch(":id/urgent")
  toggleUrgent(
    @Param("id") id: string,
    @Body() body: { urgent?: boolean },
    @CurrentUser() user: JwtPayload,
  ) {
    return this.ordersService.toggleUrgent(id, user, body.urgent);
  }

  @Delete("bulk")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR)
  bulkDelete(@Body() dto: { ids: string[] }) {
    return this.ordersService.bulkDeleteOrders(dto.ids);
  }

  @Delete(":id")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR)
  remove(@Param("id") id: string) {
    return this.ordersService.deleteOrder(id);
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
