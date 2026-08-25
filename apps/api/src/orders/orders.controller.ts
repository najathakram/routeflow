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
  BadRequestException,
  ConflictException,
} from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { OrdersService } from "./orders.service";
import { ChangeRequestsService } from "./change-requests.service";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { UserRole } from "@prisma/client";
import { ListOrdersDto } from "./dto/list-orders.dto";
import { CreateOrderDto } from "./dto/create-order.dto";
import { CreateSaleDto } from "./dto/create-sale.dto";
import { ChangeOrderStatusDto } from "./dto/change-order-status.dto";
import { UpdateOrderItemsDto } from "./dto/update-order-items.dto";
import { UpdateShipmentDto } from "./dto/update-shipment.dto";
import { UpdateFulfillPathDto } from "./dto/update-fulfill-path.dto";
import { CreateChangeRequestDto } from "./dto/create-change-request.dto";
import { ResolveChangeRequestDto } from "./dto/resolve-change-request.dto";

@ApiTags("orders")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("orders")
export class OrdersController {
  constructor(
    private readonly ordersService: OrdersService,
    private readonly changeRequestsService: ChangeRequestsService,
  ) {}

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
    // Legacy: forceNew=true is treated as an explicit "separate" choice.
    const choice: "merge" | "separate" | undefined =
      dto.mergeChoice ?? (dto.forceNew ? "separate" : undefined);

    if (isStaff && dto.customerId) {
      const activeOrder = await this.ordersService.findActiveOrder(dto.customerId);
      if (activeOrder) {
        // Operator hasn't told us what to do — make them choose.
        if (!choice) {
          throw new ConflictException({
            code: "MERGE_CHOICE_REQUIRED",
            message: "An open draft/pending order exists for this customer.",
            activeOrder: {
              id: activeOrder.id,
              orderNumber: activeOrder.orderNumber,
              status: activeOrder.status,
              itemCount: activeOrder.lineItems.length,
              total: Number(activeOrder.total),
              createdAt: activeOrder.createdAt,
            },
          });
        }
        if (choice === "merge") {
          // The merge writes items onto the existing order, whose own business date
          // stays authoritative — OrdersService.create (the only place orderDate is
          // parsed and stored) never runs on this branch, so accepting a date here
          // would silently drop it.
          if (dto.orderDate) {
            throw new BadRequestException(
              "A backdated order cannot be merged. Enter it as a separate order.",
            );
          }
          const mergedMap = new Map<string, number>();
          // Unlisted lines (no productId) can't be keyed by product — pass them
          // through as their own line items so a merge never drops them.
          const unlisted: Array<{ name?: string; qty: number; unitPrice: number }> = [];
          for (const li of activeOrder.lineItems) {
            if (!li.productId) {
              unlisted.push({
                name: li.name ?? undefined,
                qty: Number(li.qty),
                unitPrice: Number(li.unitPrice),
              });
              continue;
            }
            mergedMap.set(li.productId, Number(li.qty));
          }
          for (const item of dto.items ?? []) {
            if (!item.productId) {
              unlisted.push({ name: item.name, qty: item.qty, unitPrice: item.unitPrice ?? 0 });
              continue;
            }
            mergedMap.set(item.productId, (mergedMap.get(item.productId) ?? 0) + item.qty);
          }
          const mergedItems = [
            ...Array.from(mergedMap.entries()).map(([productId, qty]) => ({ productId, qty })),
            ...unlisted,
          ];
          await this.ordersService.updateOrderItems(
            activeOrder.id,
            {
              items: mergedItems,
              // Thread the operator's credit-note selection into the merge winner
              // so the existing sync+settle logic applies it (else it's dropped).
              ...(dto.appliedCreditNotes !== undefined
                ? { appliedCreditNotes: dto.appliedCreditNotes }
                : {}),
            } as any,
            user,
          );
          // After merging, sweep any other unflagged PENDING orders for this customer.
          await this.ordersService.mergeAllPendingForCustomer(dto.customerId);
          return this.ordersService.findOne(activeOrder.id, user);
        }
        // choice === "separate" — fall through to plain create with skipAutoMerge=true
      }
    }

    const created = await this.ordersService.create(dto, user, {
      skipAutoMerge: choice === "separate",
    });
    // For non-staff (driver / customer) callers, keep the old auto-consolidate behaviour
    // for newly-created orders that don't have skipAutoMerge set.
    if (!isStaff && created.customerId) {
      // Only the CUSTOMER's own consolidation may earn NEW BUY_N_GET_M free units
      // for the combined quantity — a driver's order is priced like staff's.
      const merged = await this.ordersService.mergeAllPendingForCustomer(created.customerId, {
        buyerInitiated: user.role === UserRole.CUSTOMER,
      });
      if (merged) return merged;
    }
    return created;
  }

  /**
   * "Bill now": create an order and its invoice in one step (the invoice screen's "New sale" flow).
   * deliveredNow=true issues a van/cash sale (order DELIVERED + invoice SENT); deliveredNow=false
   * creates a PENDING order + linked DRAFT invoice. Returns the created Invoice so the UI can open it.
   */
  @Post("sell")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR)
  sell(@Body() dto: CreateSaleDto, @CurrentUser() user: JwtPayload) {
    return this.ordersService.createSale(dto, user);
  }

  /**
   * Returns the most recent DRAFT/PENDING order summary for a customer, or null.
   * The operator UI calls this when a customer is picked so it can prompt
   * "Merge into existing order or create separate?"
   */
  @Get("active")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR)
  async getActiveOrderForCustomer(@Query("customerId") customerId: string) {
    if (!customerId) return null;
    const order = await this.ordersService.findActiveOrder(customerId);
    if (!order) return null;
    return {
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      itemCount: order.lineItems.length,
      total: Number(order.total),
      createdAt: order.createdAt,
    };
  }

  @Get("price-history")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR)
  getCustomerPriceHistory(
    @Query("customerId") customerId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    if (!user.tenantId || !customerId) return {};
    return this.ordersService.getCustomerPriceHistory(customerId);
  }

  @Get(":id/tracking")
  getTracking(@Param("id") id: string, @CurrentUser() user: JwtPayload) {
    return this.ordersService.getOrderTracking(id, user);
  }

  /** What cancelling would do to this order's invoices and applied credits —
   *  read-only, so the confirmation can state it before the operator commits. */
  @Get(":id/cancel-impact")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR)
  cancelImpact(@Param("id") id: string) {
    return this.ordersService.cancelImpact(id);
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

  // ─── P5-09: post-dispatch change requests ───────────────────────────────────

  @Post(":id/change-requests")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR, UserRole.CUSTOMER, UserRole.DRIVER)
  createChangeRequest(
    @Param("id") id: string,
    @Body() dto: CreateChangeRequestDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.changeRequestsService.create(id, dto, user);
  }

  @Get(":id/change-requests")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR, UserRole.CUSTOMER, UserRole.DRIVER)
  listChangeRequests(@Param("id") id: string, @CurrentUser() user: JwtPayload) {
    return this.changeRequestsService.listForOrder(id, user);
  }

  // G6: driver-at-stop is the primary authority; the office (OPERATOR /
  // TENANT_ADMIN via RolesGuard) may resolve only while PENDING. First
  // resolution wins and locks — a second resolve 409s. Buyers cannot resolve.
  @Post(":id/change-requests/:crId/resolve")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR, UserRole.DRIVER)
  resolveChangeRequest(
    @Param("id") id: string,
    @Param("crId") crId: string,
    @Body() dto: ResolveChangeRequestDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.changeRequestsService.resolve(id, crId, dto, user);
  }

  // Set/clear carrier shipment tracking on an order shipped via a carrier (not
  // delivered on our own route). Mirrors the values onto its non-void invoices.
  @Patch(":id/shipment")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR, UserRole.TENANT_ADMIN)
  updateShipment(
    @Param("id") id: string,
    @Body() dto: UpdateShipmentDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.ordersService.updateShipment(id, dto, user);
  }

  // Ad-hoc trips + fulfillment mode: staff-only ROUTE/SHIP switch. Locked once
  // the order has left the "open" states (service enforces the 400).
  @Patch(":id/fulfill-path")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR, UserRole.TENANT_ADMIN)
  updateFulfillPath(
    @Param("id") id: string,
    @Body() dto: UpdateFulfillPathDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.ordersService.updateFulfillPath(id, dto, user);
  }

  // F2-005: drivers have no business flipping order urgency — restrict to the
  // office and the owning customer (service still enforces CUSTOMER own-order).
  @Patch(":id/urgent")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR, UserRole.CUSTOMER)
  toggleUrgent(
    @Param("id") id: string,
    @Body() body: { urgent?: boolean },
    @CurrentUser() user: JwtPayload,
  ) {
    return this.ordersService.toggleUrgent(id, user, body.urgent);
  }

  // Sales agents & commissions: staff-only per-order commission-rate override
  // (0 = exempt, null = clear). Body kept as an inline type — no dedicated DTO
  // file — mirroring the toggleUrgent precedent above; validated in the
  // service (setCommissionRate), same gate as parseOrderDate.
  @Patch(":id/commission-rate")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR)
  setCommissionRate(
    @Param("id") id: string,
    @Body() body: { commissionRatePct: number | null },
    @CurrentUser() user: JwtPayload,
  ) {
    return this.ordersService.setCommissionRate(id, body.commissionRatePct, user);
  }

  @Post("sweep-pending")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR)
  sweepPending() {
    return this.ordersService.sweepAllPendingOrders();
  }

  @Post("force-consolidate/:customerId")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR)
  forceConsolidate(@Param("customerId") customerId: string) {
    return this.ordersService.forceConsolidateCustomer(customerId);
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
