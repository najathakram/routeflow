import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { ReturnKind } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { PlanFlagGuard } from "../billing/plan-flag.guard";
import { RequirePlanFlag } from "../billing/require-plan-flag.decorator";
import { AddonGuard } from "../billing/addon.guard";
import { RequireAddon } from "../billing/require-addon.decorator";
import { ReturnsService } from "./returns.service";
import { ParkedRestockResolutionService } from "./parked-restock-resolution.service";
import { ResolveParkedRestockDto } from "./dto/resolve-parked-restock.dto";
import { InlineReturnsQuoteService } from "./inline-returns-quote.service";
import { InlineReturnsService } from "./inline-returns.service";
import { ReceiveReturnDto } from "./dto/receive-return.dto";
import { ProcessRefundDto } from "./dto/process-refund.dto";
import { QuoteInlineReturnDto } from "./dto/quote-inline-return.dto";
import { CaptureInlineReturnDto } from "./dto/capture-inline-return.dto";
import { ApproveInlineReturnDto } from "./dto/approve-inline-return.dto";
import { RefundInlineReturnDto } from "./dto/refund-inline-return.dto";

/** #2406: `GET /returns?kind=` whitelist — the Prisma `ReturnKind` enum (the same set as the
 * shared RETURN_KIND_VALUES, pinned by enum-parity.spec.ts) plus the read-only "ALL" filter.
 * Anything else is a 400 BEFORE the service/prisma is touched — never a raw string into
 * `where.kind`. NOT imported from @routeflow/types: that package ships TS source, and a VALUE
 * import crashes the compiled api at boot (runtime-routeflow-types-imports.spec.ts). */
const RETURN_KIND_FILTER_VALUES = [...Object.values(ReturnKind), "ALL"] as const;
type ReturnKindFilter = (typeof RETURN_KIND_FILTER_VALUES)[number];
const isReturnKindFilter = (value: string): value is ReturnKindFilter =>
  (RETURN_KIND_FILTER_VALUES as readonly string[]).includes(value);

// This controller also serves CUSTOMER and DRIVER roles (not just OPERATOR), so
// gating it must stay behind the kill switch until the v7-STARTER audit question
// (flag.returns is granted to v8 STARTER but not v7 STARTER) is answered.
@Controller("returns")
@UseGuards(JwtAuthGuard, RolesGuard, PlanFlagGuard)
@Roles(UserRole.OPERATOR)
@RequirePlanFlag("flag.returns")
export class ReturnsController {
  constructor(
    private readonly returnsService: ReturnsService,
    private readonly inlineQuote: InlineReturnsQuoteService,
    private readonly inlineReturns: InlineReturnsService,
    private readonly parkedRestocks: ParkedRestockResolutionService,
  ) {}

  /** An optional `Idempotency-Key` header collapses a retried submission into the
   * first one (mirrors routes.controller.ts). Omitting it is unchanged behaviour. */
  @Post()
  @Roles(UserRole.OPERATOR, UserRole.DRIVER, UserRole.CUSTOMER)
  create(
    @Body() dto: any,
    @CurrentUser() user: JwtPayload,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    return this.returnsService.create(dto, user.sub, user.role, idempotencyKey);
  }

  /**
   * Returns Inside Order Creation — PR-1b. Read-only quote: matches the requested
   * qty against the customer's invoiced sales and prices it (§3). Never writes a
   * Return row (capture is PR-1c/1d). CUSTOMER is refused (Q5: buyers keep the
   * post-delivery request flow); DRIVER is scoped to their own in-progress stop
   * (M8, enforced inside InlineReturnsQuoteService before any other read).
   */
  @Post("inline/quote")
  @Roles(UserRole.OPERATOR, UserRole.TENANT_ADMIN, UserRole.DRIVER)
  @UseGuards(AddonGuard)
  @RequireAddon("orders_inline_returns")
  quoteInline(@Body() dto: QuoteInlineReturnDto, @CurrentUser() user: JwtPayload) {
    return this.inlineQuote.quote(dto, user);
  }

  /**
   * Returns Inside Order Creation — PR-1c: captures a return against an EXISTING carrying
   * order (the mobile at-stop/operator edit-items "Add return" surface — design.md §7). The
   * `POST /orders` + `inlineReturn` / `POST /orders/:id/inline-returns` order-CREATION hook
   * is PR-1d. CUSTOMER is refused inside the service before any DB read (Q5).
   */
  @Post("inline/capture")
  @Roles(UserRole.OPERATOR, UserRole.TENANT_ADMIN, UserRole.DRIVER)
  @UseGuards(AddonGuard)
  @RequireAddon("orders_inline_returns")
  captureInline(@Body() dto: CaptureInlineReturnDto, @CurrentUser() user: JwtPayload) {
    return this.inlineReturns.capture(dto, user);
  }

  /** N-5/Q-C: approves (optionally reducing) a driver-cap hold and issues its credit note. */
  @Post("inline/:id/approve")
  @Roles(UserRole.OPERATOR, UserRole.TENANT_ADMIN)
  @UseGuards(AddonGuard)
  @RequireAddon("orders_inline_returns")
  approveInline(
    @Param("id") id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: ApproveInlineReturnDto,
  ) {
    return this.inlineReturns.approve(id, user, dto);
  }

  /** N-5/Q-C: declines a driver-cap hold outright — no credit note is ever minted for it. */
  @Post("inline/:id/reject")
  @Roles(UserRole.OPERATOR, UserRole.TENANT_ADMIN)
  @UseGuards(AddonGuard)
  @RequireAddon("orders_inline_returns")
  rejectInline(@Param("id") id: string, @CurrentUser() user: JwtPayload) {
    return this.inlineReturns.reject(id, user);
  }

  /**
   * SA-727: resolves a captured inline return with a cash/card/check refund instead of store credit. Office roles only
   * (the same gate as the STANDARD `:id/refund`); the amount is the server's, `expectedAmount` only confirms it. It sits
   * under `inline/` because `POST :id/refund` is the STANDARD flow's route and refuses INLINE returns.
   */
  @Post("inline/:id/refund")
  @Roles(UserRole.OPERATOR, UserRole.TENANT_ADMIN)
  @UseGuards(AddonGuard)
  @RequireAddon("orders_inline_returns")
  refundInline(
    @Param("id") id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: RefundInlineReturnDto,
  ) {
    return this.inlineReturns.refund(id, dto, user);
  }

  /** m-5: undoes a captured inline return (restock/ledger/credit) and cancels the row. */
  @Post("inline/:id/cancel")
  @Roles(UserRole.OPERATOR, UserRole.TENANT_ADMIN)
  @UseGuards(AddonGuard)
  @RequireAddon("orders_inline_returns")
  cancelInline(@Param("id") id: string, @CurrentUser() user: JwtPayload) {
    return this.inlineReturns.cancel(id, user);
  }

  // Parked restocks (B665 follow-up): a STANDARD return's restock whose sold-line pack was unknown. Declared
  // BEFORE the `:id` routes so `parked-restocks` is never read as a return id. The operator supplies the
  // PACK only; the quantity is the stored one. No tobacco addon: returns exist for every tenant.
  @Get("parked-restocks")
  @Roles(UserRole.OPERATOR)
  listParkedRestocks() {
    return this.parkedRestocks.list();
  }

  @Post("parked-restocks/:id/resolve")
  @Roles(UserRole.OPERATOR)
  resolveParkedRestock(
    @Param("id") id: string,
    @Body() dto: ResolveParkedRestockDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.parkedRestocks.resolve(id, dto.unitsPerBoxSupplied, { id: user.sub });
  }

  @Get()
  @Roles(UserRole.OPERATOR, UserRole.DRIVER, UserRole.CUSTOMER)
  findAll(
    @CurrentUser() user: JwtPayload,
    @Query("orderId") orderId?: string,
    @Query("customerId") customerId?: string,
    @Query("status") status?: string,
    @Query("reason") reason?: string,
    @Query("search") search?: string,
    @Query("page") page?: string,
    @Query("limit") limit?: string,
    @Query("kind") kind?: string,
  ) {
    // #2406: default STANDARD keeps the existing Returns list unchanged; INLINE/ALL are opt-in.
    // Whitelisted BEFORE the service is called — an unrecognized value never reaches `where.kind`.
    if (kind !== undefined && !isReturnKindFilter(kind)) {
      throw new BadRequestException(`Invalid kind filter: ${kind}`);
    }
    return this.returnsService.findAllForUser(user, {
      orderId,
      customerId,
      status,
      reason,
      search,
      kind: (kind as ReturnKindFilter | undefined) ?? "STANDARD",
      page: page ? +page : 1,
      limit: limit ? +limit : 20,
    });
  }

  /** RF-081: Restricted to OPERATOR | TENANT_ADMIN | CUSTOMER (no DRIVER).
   * CUSTOMER role gets an ownership check inside findOneForUser(). */
  @Get(":id")
  @Roles(UserRole.OPERATOR, UserRole.TENANT_ADMIN, UserRole.CUSTOMER)
  findOne(@Param("id") id: string, @CurrentUser() user: JwtPayload) {
    return this.returnsService.findOneForUser(id, user);
  }

  @Post(":id/approve")
  @Roles(UserRole.OPERATOR)
  approve(@Param("id") id: string) {
    return this.returnsService.approve(id);
  }

  @Post(":id/reject")
  @Roles(UserRole.OPERATOR)
  reject(@Param("id") id: string) {
    return this.returnsService.reject(id);
  }

  @Post(":id/in-transit")
  @Roles(UserRole.OPERATOR)
  markInTransit(@Param("id") id: string) {
    return this.returnsService.markInTransit(id);
  }

  @Post(":id/receive")
  @Roles(UserRole.OPERATOR)
  receive(@Param("id") id: string, @CurrentUser() user: JwtPayload, @Body() dto: ReceiveReturnDto) {
    return this.returnsService.receive(id, user.sub, { restock: dto?.restock });
  }

  @Post(":id/refund")
  @Roles(UserRole.OPERATOR)
  processRefund(@Param("id") id: string, @Body() dto: ProcessRefundDto) {
    return this.returnsService.processRefund(id, dto);
  }

  @Post(":id/cancel")
  @Roles(UserRole.OPERATOR, UserRole.CUSTOMER)
  cancel(@Param("id") id: string, @CurrentUser() user: JwtPayload) {
    return this.returnsService.cancel(id, user);
  }
}
