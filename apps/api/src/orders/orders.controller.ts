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
import { normalizeBoxesPieces } from "../common/pricing";

interface MergeLineSnapshot {
  productId?: string | null;
  name?: string | null;
  // Prisma Decimal on the real OrderItem row (coerced via Number() below) —
  // typed loosely here so this accepts both a live findActiveOrder() payload
  // and a plain test fixture.
  qty: unknown;
  boxes?: number | null;
  pieces?: number | null;
  unitsPerBox?: number | null;
  unitPrice?: unknown;
  // PriceType of the existing row — decides whether its unitPrice is an
  // operator OVERRIDE (MANUAL: survives the merge verbatim) or a DERIVED price
  // (STANDARD/SPECIAL/DISCOUNTED/PROMO: omitted so updateOrderItems re-prices
  // at the MERGED quantity — tier breaks and promo selection legitimately
  // change when qty changes, and re-stamping a derived price as a manual
  // override freezes it wrongly forever). R0 of the F30 close-out.
  priceType?: string | null;
  notes?: string | null;
}

interface MergeIncomingItem {
  productId?: string;
  name?: string;
  qty: number;
  boxes?: number;
  pieces?: number;
  unitPrice?: number;
  notes?: string;
}

/**
 * Box size for one box-carrying row, WITHOUT a product lookup.
 *
 * `OrderItem.unitsPerBox` is only snapshotted on box-split lines and is
 * explicitly null on lines created before that snapshot shipped (schema
 * comment: "fall back to live upb"). Treating a null as 0 is what silently
 * collapsed a boxed line to its loose pieces, so fall back to the row's own
 * arithmetic instead: a box-carrying row states its TOTAL pieces in `qty`, so
 * `(qty - pieces) / boxes` IS the box size that row was written with. Returns
 * 0 when nothing resolves — callers must then pass boxes/pieces through
 * untouched and let updateOrderItems re-derive from the LIVE product.
 */
function deriveUnitsPerBox(row: {
  qty?: unknown;
  boxes?: number | null;
  pieces?: number | null;
  unitsPerBox?: number | null;
}): number {
  const snapshot = Math.trunc(Number(row.unitsPerBox ?? 0));
  if (snapshot > 1) return snapshot;
  const boxes = Math.trunc(Number(row.boxes ?? 0));
  if (boxes > 0) {
    const totalPieces = Math.trunc(Number(row.qty ?? 0));
    const loosePieces = Math.trunc(Number(row.pieces ?? 0));
    const derived = (totalPieces - loosePieces) / boxes;
    if (Number.isInteger(derived) && derived > 1) return derived;
  }
  return 0;
}

/**
 * F30/R11 (B199): fold an incoming scan/add batch into an existing order's
 * lines WITHOUT flattening denominations. A box-split line stores its qty in
 * PIECES (boxes × unitsPerBox + pieces) — summing that flat against a plain
 * qty (or against another product's box count) mixed units and, worse, fed
 * the wrong number into box-price proration (a 2-box + 5-piece line became
 * 7 BOXES, repriced ×unitsPerBox). Boxes fold with boxes, pieces fold with
 * pieces, an incoming item with no box data is loose pieces, and
 * normalizeBoxesPieces re-derives the canonical split (with rollover) exactly
 * like every other money-math path in this codebase. unitPrice/notes are
 * preserved from the EXISTING line — a merge is never where an operator's
 * price override or line note silently disappears.
 *
 * The result is the order's COMPLETE new line set (absolute totals, not a
 * delta), so the caller must hand it to updateOrderItems as an explicit
 * `replaceAll: true` — see the merge branch below.
 */
function foldMergeItems(
  existingLines: MergeLineSnapshot[],
  incoming: MergeIncomingItem[],
): Array<Record<string, unknown>> {
  const byProduct = new Map<
    string,
    {
      boxes: number;
      pieces: number;
      unitsPerBox: number;
      /** Any side of this fold carried a boxes/pieces split. */
      boxAware: boolean;
      /** The order already had a line for this product… */
      hadExisting: boolean;
      /** …and that line was itself box-split. */
      existingBoxAware: boolean;
      unitPrice?: number;
      existingPriceType?: string | null;
      notes?: string | null;
    }
  >();
  // Unlisted lines (no productId) can't be keyed by product — pass them
  // through as their own line items so a merge never drops them.
  const unlisted: Array<{ name?: string; qty: number; unitPrice: number; notes?: string }> = [];

  for (const li of existingLines) {
    if (!li.productId) {
      unlisted.push({
        name: li.name ?? undefined,
        qty: Number(li.qty),
        unitPrice: Number(li.unitPrice ?? 0),
        ...(li.notes ? { notes: li.notes } : {}),
      });
      continue;
    }
    const hasBoxData = li.boxes != null || li.pieces != null;
    byProduct.set(li.productId, {
      boxes: hasBoxData ? Number(li.boxes ?? 0) : 0,
      // A plain (box-unaware) line's whole qty folds in as loose pieces.
      pieces: hasBoxData ? Number(li.pieces ?? 0) : Number(li.qty ?? 0),
      unitsPerBox: deriveUnitsPerBox(li),
      boxAware: hasBoxData,
      hadExisting: true,
      existingBoxAware: hasBoxData,
      unitPrice: li.unitPrice != null ? Number(li.unitPrice) : undefined,
      existingPriceType: li.priceType ?? null,
      notes: li.notes ?? null,
    });
  }

  for (const item of incoming) {
    if (!item.productId) {
      unlisted.push({
        name: item.name,
        qty: item.qty,
        unitPrice: item.unitPrice ?? 0,
        ...(item.notes ? { notes: item.notes } : {}),
      });
      continue;
    }
    const incomingHasBoxData = item.boxes != null || item.pieces != null;
    // A scanned case arrives as {qty: totalPieces, boxes, pieces}, so the
    // incoming item states its own box size even for a product that isn't on
    // the order yet — no lookup needed.
    const incomingUnitsPerBox = deriveUnitsPerBox(item);
    const acc = byProduct.get(item.productId);
    if (!acc) {
      // Brand-new line for this merge — no existing accumulator to fold into.
      byProduct.set(item.productId, {
        boxes: incomingHasBoxData ? Number(item.boxes ?? 0) : 0,
        pieces: incomingHasBoxData ? Number(item.pieces ?? 0) : Number(item.qty ?? 0),
        unitsPerBox: incomingUnitsPerBox,
        boxAware: incomingHasBoxData,
        hadExisting: false,
        existingBoxAware: false,
        unitPrice: item.unitPrice,
        notes: item.notes ?? null,
      });
      continue;
    }
    acc.boxes += incomingHasBoxData ? Number(item.boxes ?? 0) : 0;
    acc.pieces += incomingHasBoxData ? Number(item.pieces ?? 0) : Number(item.qty ?? 0);
    if (incomingHasBoxData) acc.boxAware = true;
    if (acc.unitsPerBox <= 1 && incomingUnitsPerBox > 1) acc.unitsPerBox = incomingUnitsPerBox;
    // R11: the EXISTING line's price/note win — a merge never overwrites an
    // operator's override with the client's freshly-resolved catalog price.
    // Incoming values only FILL what the existing line doesn't carry (and are
    // the only source for a brand-new merged line, handled above).
    if (acc.unitPrice == null && item.unitPrice != null) acc.unitPrice = item.unitPrice;
    if (!acc.notes && item.notes) acc.notes = item.notes;
  }

  const merged: Array<Record<string, unknown>> = [];
  for (const [productId, acc] of byProduct.entries()) {
    let qty = acc.pieces;
    let boxes: number | null = null;
    let pieces: number | null = null;
    if (acc.boxAware && acc.unitsPerBox > 1) {
      const norm = normalizeBoxesPieces({
        boxes: acc.boxes,
        pieces: acc.pieces,
        unitsPerBox: acc.unitsPerBox,
      });
      qty = norm.qty;
      boxes = norm.boxes;
      pieces = norm.pieces;
    } else if (acc.boxAware) {
      // Box data with no resolvable box size. NEVER drop the boxes (that is
      // the silent-loss bug): hand the raw split down so updateOrderItems
      // re-derives the canonical split + qty from the LIVE product.
      boxes = acc.boxes;
      pieces = acc.pieces;
    }
    // A plain existing line's unitPrice is a PIECE price; once the merged line
    // becomes box-split the same number would be read as a BOX price and
    // prorated. Drop it instead so updateOrderItems re-prices the line from
    // the catalog/tier ladder in the right denomination.
    // Denomination rule (unchanged) AND the override rule (R0): an existing
    // line's price survives only when the operator set it by hand (MANUAL) —
    // derived prices re-derive at the merged quantity. A brand-new merged line
    // keeps the incoming price (create-path semantics, unchanged).
    const denominationOk = !(acc.hadExisting && !acc.existingBoxAware && acc.boxAware);
    const overrideOk = !acc.hadExisting || acc.existingPriceType === "MANUAL";
    const priceSurvives = denominationOk && overrideOk;
    merged.push({
      productId,
      qty,
      ...(boxes != null ? { boxes } : {}),
      ...(pieces != null ? { pieces } : {}),
      ...(acc.unitPrice != null && priceSurvives ? { unitPrice: acc.unitPrice } : {}),
      ...(acc.notes ? { notes: acc.notes } : {}),
    });
  }

  return [...merged, ...unlisted];
}

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
   * from). Closing that fully means folding inside updateOrderItems' own
   * transaction — tracked, not done here.
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
