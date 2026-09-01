import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Headers,
  UseGuards,
  BadRequestException,
  ConflictException,
} from "@nestjs/common";
import { ApiTags, ApiBearerAuth, ApiHeader } from "@nestjs/swagger";
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
import { foldMergeItems } from "./merge-items";

@ApiTags("orders")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("orders")
export class OrdersController {
  constructor(
    private readonly ordersService: OrdersService,
    private readonly changeRequestsService: ChangeRequestsService,
  ) {}

  // F30/R11 (B199): per-order lock for the staff merge's read-fold-write
  // critical section. Keyed by orderId; entries are removed once their turn
  // fully settles, so this never grows unbounded.
  private readonly mergeLocksByOrder = new Map<string, Promise<void>>();

  /**
   * Serializes concurrent merges onto the SAME active order so two requests
   * racing (two scanners hitting Confirm within milliseconds, a queue replay
   * racing a live request) can't both read the same pre-write snapshot and
   * clobber each other's delta on write — the lost-update B199 reported.
   * Chaining `fn` onto the prior turn's settled promise (rather than relying
   * on incidental timing) guarantees the second-in-line caller's `fn` doesn't
   * start until the first's write has actually completed, so a fresh read
   * taken INSIDE `fn` sees it.
   *
   * SCOPE: this Map lives on the controller instance, so it serializes merges
   * within ONE API process only. Two replicas merging the same order still
   * race their controller-side reads (updateOrderItems' SELECT … FOR UPDATE
   * serializes the WRITE, not the read the absolute totals were computed
   * from).
   *
   * DEFERRED — DELIBERATELY, ON EVIDENCE (2026-08-31). The @routeflow/api
   * service runs exactly ONE instance, verified three independent ways:
   * apps/api/railway.toml declares no numReplicas; Railway's API reports
   * numReplicas = null for every service (so no dashboard override exists
   * either); and the live deployment reports 1 running instance. With one
   * process the cross-replica race is UNREACHABLE, and this lock is
   * sufficient — restructuring a money-critical write path to close a race
   * that cannot occur would be the larger risk.
   *
   * ⚠️ THE TRIGGER IS SCALING, AND IT IS SILENT. The day anyone runs this
   * service on 2+ replicas, merged order lines start getting clobbered with
   * no error, no log and no failing test — the money is simply wrong. The
   * guard therefore lives where that decision is made, in
   * apps/api/railway.toml's [deploy] block; do not remove it. Nothing in the
   * process can self-detect this: Railway injects no replica-count variable.
   *
   * WHEN IT IS PICKED UP, three designs, cheapest first:
   *   1. Redis lock — swap mergeLocksByOrder for a Redis key (SET NX PX +
   *      token-checked release). Redis is ALREADY a dependency (the Socket.io
   *      adapter), the diff stays inside this method, the money path is not
   *      restructured, and the T-B199 spec's one-instance framing stays valid.
   *   2. Optimistic claim — CAS on the order's version/updatedAt inside
   *      updateOrderItems' transaction; 409 + client retry on mismatch.
   *      Cheap server-side, but every merge caller must handle the retry.
   *   3. Fold inside updateOrderItems' transaction (the "full" fix). Most
   *      correct, most invasive: it moves money math into a locked section
   *      and REQUIRES rewriting orders.scan-hardening.spec.ts's concurrency
   *      block, which drives this controller against a fully mocked
   *      OrdersService and is titled "two concurrent merges on ONE INSTANCE
   *      serialize". Move that block; never delete it.
   */
  private withOrderMergeLock<T>(orderId: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.mergeLocksByOrder.get(orderId) ?? Promise.resolve();
    const result = prior.then(fn, fn);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.mergeLocksByOrder.set(orderId, settled);
    void settled.then(() => {
      if (this.mergeLocksByOrder.get(orderId) === settled) this.mergeLocksByOrder.delete(orderId);
    });
    return result;
  }

  /**
   * F30/R8 (B196): `Idempotency-Key` arrives as a raw, entirely client-chosen
   * header and is written straight into a btree unique index — an oversized
   * one fails the INSERT with a raw index-row-size error that surfaces as a
   * 500. Bound it here, at the edge, before it reaches Prisma: a single
   * printable-ASCII token of at most 128 chars (the client sends a uuid). An
   * absent or blank header means "no key", never "the empty key".
   */
  private normalizeIdempotencyKey(raw: string | undefined): string | undefined {
    if (raw == null) return undefined;
    const key = raw.trim();
    if (!key) return undefined;
    if (!/^[\x21-\x7e]{1,128}$/.test(key)) {
      throw new BadRequestException(
        "Idempotency-Key must be at most 128 printable characters with no spaces",
      );
    }
    return key;
  }

  @Get()
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR, UserRole.CUSTOMER)
  findAll(@Query() query: ListOrdersDto, @CurrentUser() user: JwtPayload) {
    return this.ordersService.findAll(query, user);
  }

  // F30/R8 (B196): a client-generated uuid-per-cart-session key. Threaded onto
  // the DTO (never a declared body field — see OrdersService.create's
  // comment) so a duplicate submit — queue self-duplication, a timed-out
  // request that actually completed — replays the ORIGINAL order instead of
  // creating a second one.
  @Post()
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR, UserRole.CUSTOMER, UserRole.DRIVER)
  @ApiHeader({ name: "Idempotency-Key", required: false })
  async create(
    @Body() dto: CreateOrderDto,
    @CurrentUser() user: JwtPayload,
    @Headers("Idempotency-Key") rawIdempotencyKey?: string,
  ) {
    const idempotencyKey = this.normalizeIdempotencyKey(rawIdempotencyKey);
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
          // F30/R11 (B199): denomination-aware fold (foldMergeItems above),
          // computed and written under a per-order lock so concurrent merges
          // serialize instead of racing a lost update. `activeOrder` above may
          // already be stale by the time this request's turn in the lock
          // arrives, so re-read fresh state INSIDE it rather than reuse that
          // snapshot — and write to / return THAT order, never the stale one.
          const merged = await this.withOrderMergeLock(activeOrder.id, async () => {
            const current =
              (await this.ordersService.findActiveOrder(dto.customerId!)) ?? activeOrder;
            // F30/R8 (B196): this branch returns without ever reaching
            // OrdersService.create, so honour the replay key HERE too — the
            // fold computes ABSOLUTE totals, so a replayed merge (queue
            // re-delivery of a frozen mergeChoice:"merge" body) would fold the
            // same incoming items in a second time and inflate the order.
            // Scoped to THIS customer as well as the key — the key is
            // client-chosen, so a bare match could replay onto another
            // customer's order (and hand it back through findOne below).
            if (idempotencyKey) {
              const replayedOrderId = await this.ordersService.findOrderIdByIdempotencyKey(
                idempotencyKey,
                dto.customerId!,
              );
              if (replayedOrderId) return { orderId: replayedOrderId, replayed: true };
            }
            const mergedItems = foldMergeItems(current.lineItems ?? [], dto.items ?? []);
            await this.ordersService.updateOrderItems(
              current.id,
              {
                items: mergedItems,
                // foldMergeItems returns the order's COMPLETE new line set, so
                // this is a full replace. R10 made `replaceAll` explicit-only —
                // without saying so out loud the merged absolute totals would
                // land in the incremental-ADD branch and be appended on top of
                // the untouched originals (every merged product duplicated).
                replaceAll: true,
                // Thread the operator's credit-note selection into the merge winner
                // so the existing sync+settle logic applies it (else it's dropped).
                ...(dto.appliedCreditNotes !== undefined
                  ? { appliedCreditNotes: dto.appliedCreditNotes }
                  : {}),
              } as any,
              user,
            );
            // Recorded only after the fold actually landed: a merge that threw
            // is retryable, and a retry must re-run rather than replay a write
            // that never happened.
            if (idempotencyKey) {
              await this.ordersService.recordIdempotencyKey(current.id, idempotencyKey);
            }
            return { orderId: current.id, replayed: false };
          });
          if (!merged.replayed) {
            // After merging, sweep any other unflagged PENDING orders for this customer.
            await this.ordersService.mergeAllPendingForCustomer(dto.customerId);
          }
          return this.ordersService.findOne(merged.orderId, user);
        }
        // choice === "separate" — fall through to plain create with skipAutoMerge=true
      }
    }

    const created = await this.ordersService.create(
      idempotencyKey ? ({ ...dto, idempotencyKey } as CreateOrderDto) : dto,
      user,
      { skipAutoMerge: choice === "separate" },
    );
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

  // Staff-only demotions (incl. the DELIVERED → CONFIRMED "Reopen Order" action
  // and PENDING → DRAFT) are gated by role INSIDE changeStatus — TENANT_ADMIN
  // must be allowed through here too, or the RolesGuard 403s before the service
  // ever gets a chance to allow it.
  @Patch(":id/status")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR, UserRole.TENANT_ADMIN, UserRole.CUSTOMER, UserRole.DRIVER)
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

  // Delete-any: staff (OPERATOR/TENANT_ADMIN) may delete an order in any status;
  // the service 409s when a linked invoice has recorded payments. `user` is
  // threaded through so the service can apply its per-role delete rules.
  @Delete("bulk")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR, UserRole.TENANT_ADMIN)
  bulkDelete(@Body() dto: { ids: string[] }, @CurrentUser() user: JwtPayload) {
    return this.ordersService.bulkDeleteOrders(dto.ids, user);
  }

  @Delete(":id")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR, UserRole.TENANT_ADMIN)
  remove(@Param("id") id: string, @CurrentUser() user: JwtPayload) {
    return this.ordersService.deleteOrder(id, user);
  }
}
