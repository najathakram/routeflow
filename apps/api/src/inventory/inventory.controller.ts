import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { PlanFlagGuard } from "../billing/plan-flag.guard";
import { RequirePlanFlag } from "../billing/require-plan-flag.decorator";
import { InventoryService } from "./inventory.service";
import { RecordPurchaseDto } from "./dto/record-purchase.dto";
import { RecordAdjustmentDto } from "./dto/record-adjustment.dto";
import { CommitStockCountDto } from "./dto/commit-stock-count.dto";
import { ListMovementsDto } from "./dto/list-movements.dto";
import { ListPurchaseOrdersDto } from "./dto/list-purchase-orders.dto";
import { CreateSupplierDto } from "./dto/create-supplier.dto";
import { UpdateSupplierDto } from "./dto/update-supplier.dto";
import { SetCostBasisDto } from "./dto/set-cost-basis.dto";
import { BulkSetCostBasisDto } from "./dto/bulk-set-cost-basis.dto";
import { RecomputeCostsDto } from "./dto/recompute-costs.dto";
import {
  CommitStockCountSessionDto,
  ListStockCountSessionsDto,
  StartStockCountDto,
  UpsertStockCountLineDto,
} from "./dto/stock-count-session.dto";
import { VariantAssignDto } from "./dto/variant-assign.dto";

@Controller("inventory")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OPERATOR)
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  @Get("overview")
  @Roles(UserRole.OPERATOR, UserRole.DRIVER)
  getStockOverview() {
    return this.inventoryService.getStockOverview();
  }

  @Get("movements")
  @Roles(UserRole.OPERATOR, UserRole.DRIVER)
  listMovements(@Query() query: ListMovementsDto) {
    return this.inventoryService.listMovements(query);
  }

  // B168: writes inherit the class-level OPERATOR gate; DRIVER reads below are deliberate.
  @Post("movements/purchase")
  recordPurchase(@Body() dto: RecordPurchaseDto, @CurrentUser() user: { id: string }) {
    return this.inventoryService.recordPurchase(dto, user.id);
  }

  @Post("movements/adjustment")
  recordAdjustment(@Body() dto: RecordAdjustmentDto, @CurrentUser() user: { id: string }) {
    return this.inventoryService.recordAdjustment(dto, user.id);
  }

  @Post("stock-count/commit")
  @Roles(UserRole.OPERATOR)
  commitStockCount(@Body() dto: CommitStockCountDto, @CurrentUser() user: { id: string }) {
    return this.inventoryService.commitStockCount(dto, user.id);
  }

  // ── Variant assignment (PR-D): generic → variants, one transaction ──
  @Post("variant-assign")
  @Roles(UserRole.OPERATOR)
  assignToVariants(@Body() dto: VariantAssignDto, @CurrentUser() user: { id: string }) {
    return this.inventoryService.assignToVariants(dto, user.id);
  }

  // ── Durable stock-count sessions (PR-C) ──
  // The one-shot `stock-count/commit` above is unchanged; these add the
  // paused/resumable server-side session so a count survives a device change.

  @Post("stock-counts")
  startStockCountSession(@Body() dto: StartStockCountDto, @CurrentUser() user: { sub: string }) {
    return this.inventoryService.startStockCountSession(dto, user);
  }

  @Get("stock-counts")
  listStockCountSessions(@Query() query: ListStockCountSessionsDto) {
    return this.inventoryService.listStockCountSessions(query);
  }

  @Get("stock-counts/:id")
  getStockCountSession(@Param("id") id: string) {
    return this.inventoryService.getStockCountSession(id);
  }

  /** Autosave one counted line. Idempotent per (session, product). */
  @Put("stock-counts/:id/lines")
  upsertStockCountLine(
    @Param("id") id: string,
    @Body() dto: UpsertStockCountLineDto,
    @CurrentUser() user: { sub: string },
  ) {
    return this.inventoryService.upsertStockCountLine(id, dto, user);
  }

  @Delete("stock-counts/:id/lines/:productId")
  removeStockCountLine(@Param("id") id: string, @Param("productId") productId: string) {
    return this.inventoryService.removeStockCountLine(id, productId);
  }

  @Post("stock-counts/:id/commit")
  commitStockCountSession(
    @Param("id") id: string,
    @Body() dto: CommitStockCountSessionDto,
    @CurrentUser() user: { sub: string },
  ) {
    return this.inventoryService.commitStockCountSession(id, dto, user);
  }

  @Post("stock-counts/:id/discard")
  discardStockCountSession(@Param("id") id: string) {
    return this.inventoryService.discardStockCountSession(id);
  }

  // ── Cost basis & valuation ──
  @Get("valuation")
  getValuation() {
    return this.inventoryService.getValuation();
  }

  @Patch("products/:id/cost-basis")
  setCostBasis(
    @Param("id") id: string,
    @Body() dto: SetCostBasisDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.inventoryService.setCostBasis(id, dto, user.id);
  }

  @Post("cost-basis/bulk")
  bulkSetCostBasis(@Body() dto: BulkSetCostBasisDto, @CurrentUser() user: { id: string }) {
    return this.inventoryService.bulkSetCostBasis(dto, user.id);
  }

  // B562 (interim mitigation, owner-approved): the web and mobile UI entry points
  // that called this endpoint were deliberately removed — this recompute replays
  // purchase history but is blind to raw order decrements (order creation/edits
  // decrement stock without writing StockMovement rows), so one invocation can
  // silently rewrite a tenant's entire inventory valuation with a sales-blind
  // average, and it also overwrites `stockAfter` values, destroying the evidence
  // needed to detect it. The endpoint, its role guard, and the service logic are
  // UNCHANGED — only the UI buttons were hidden. Do NOT re-expose this in any
  // client until B562's root cause is fixed.
  @Post("recompute-costs")
  recomputeCosts(@Body() dto: RecomputeCostsDto) {
    return this.inventoryService.recomputeCosts(dto);
  }

  @Get("suppliers")
  listSuppliers() {
    return this.inventoryService.listSuppliers();
  }

  @Post("suppliers")
  createSupplier(@Body() dto: CreateSupplierDto) {
    return this.inventoryService.createSupplier(dto);
  }

  @Patch("suppliers/:id")
  updateSupplier(@Param("id") id: string, @Body() dto: UpdateSupplierDto) {
    return this.inventoryService.updateSupplier(id, dto);
  }

  // ── Purchase Orders ──
  @Post("purchase-orders")
  createPO(@Body() dto: any, @CurrentUser() user: { id: string }) {
    return this.inventoryService.createPurchaseOrder(dto, user.id);
  }

  @Get("purchase-orders")
  @Roles(UserRole.OPERATOR, UserRole.DRIVER)
  listPOs(@Query() query: ListPurchaseOrdersDto) {
    return this.inventoryService.listPurchaseOrders(query);
  }

  @Get("purchase-orders/:id")
  @Roles(UserRole.OPERATOR, UserRole.DRIVER)
  getPO(@Param("id") id: string) {
    return this.inventoryService.getPurchaseOrder(id);
  }

  @Post("purchase-orders/:id/send")
  sendPO(@Param("id") id: string) {
    return this.inventoryService.sendPurchaseOrder(id);
  }

  @Post("purchase-orders/:id/receive")
  receivePO(@Param("id") id: string, @Body() dto: any, @CurrentUser() user: { id: string }) {
    return this.inventoryService.receivePurchaseOrder(id, dto, user.id);
  }

  @Post("purchase-orders/:id/close")
  closePO(@Param("id") id: string) {
    return this.inventoryService.closePurchaseOrder(id);
  }

  // ── Forecasting ── gated on flag.forecasting; everything else on this controller is core inventory.
  @Get("forecasting")
  @UseGuards(PlanFlagGuard)
  @RequirePlanFlag("flag.forecasting")
  getForecasting() {
    return this.inventoryService.getForecasting();
  }

  @Patch("products/:productId/reorder-settings")
  @UseGuards(PlanFlagGuard)
  @RequirePlanFlag("flag.forecasting")
  setReorderPoint(@Param("productId") productId: string, @Body() dto: any) {
    return this.inventoryService.setReorderPoint(productId, dto.reorderPoint, dto.reorderQty);
  }
}
