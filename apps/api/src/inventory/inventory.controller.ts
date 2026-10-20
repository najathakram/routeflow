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
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { Request, Response } from "express";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { PlanFlagGuard } from "../billing/plan-flag.guard";
import { RequirePlanFlag } from "../billing/require-plan-flag.decorator";
import { InventoryService } from "./inventory.service";
import { InventoryMovementsExportService } from "./inventory-movements-export.service";
import { streamCsv } from "../products/products-export.stream";
import { ExportMovementsDto } from "./dto/export-movements.dto";
import { RecordPurchaseDto } from "./dto/record-purchase.dto";
import { CreatePurchaseOrderDto, ReceivePurchaseOrderDto } from "./dto/create-purchase-order.dto";
import { RecordAdjustmentDto } from "./dto/record-adjustment.dto";
import { ProductCountDto } from "./dto/product-count.dto";
import { CommitStockCountDto } from "./dto/commit-stock-count.dto";
import { ListMovementsDto } from "./dto/list-movements.dto";
import { ListPurchaseOrdersDto } from "./dto/list-purchase-orders.dto";
import { UpdatePurchaseOrderDto } from "./dto/update-purchase-order.dto";
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
  constructor(
    private readonly inventoryService: InventoryService,
    private readonly movementsExporter: InventoryMovementsExportService,
  ) {}

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

  // The movements list's own filters as a streamed CSV (never paged, capped, audit-logged). OPERATOR
  // only: the class-level gate applies (the list above admits DRIVER; this export must not). Declared
  // before any `movements/:id` route. A refused window is a JSON 400 before the first byte.
  @Get("movements/export.csv")
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  async exportMovementsCsv(
    @Query() query: ExportMovementsDto,
    @CurrentUser() user: { sub?: string; id?: string },
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const { csv, filename } = await this.movementsExporter.prepare(query, {
      userId: user?.sub ?? user?.id ?? null,
      ip: req?.ip ?? null,
    });
    await streamCsv(res, filename, csv);
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

  // SA-828 (row 657): set a product's stock to a count, or adjust it, in one of its units.
  @Post("products/:id/count")
  @Roles(UserRole.OPERATOR)
  countProduct(
    @Param("id") id: string,
    @Body() dto: ProductCountDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.inventoryService.countProduct(id, dto, user.id);
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

  // B562 PR-3 (SA-136 §4): TENANT_ADMIN only (platform admin included), dry run by default. The
  // apply path only APPENDS one dated COST_BASIS correction per product whose replayed average
  // differs — it never rewrites a movement — and refuses (reports) any product whose ledger can't
  // account for its stock. Audited on every apply. The web/mobile entry points stay hidden (#931)
  // until this deploys.
  @Post("recompute-costs")
  @Roles(UserRole.TENANT_ADMIN)
  recomputeCosts(@Body() dto: RecomputeCostsDto, @CurrentUser() user: { id: string }) {
    return this.inventoryService.recomputeCosts(dto, user?.id ?? null);
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
  createPO(@Body() dto: CreatePurchaseOrderDto, @CurrentUser() user: { id: string }) {
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

  /**
   * Edit a purchase order. A PARTIAL/RECEIVED order's line edits must carry
   * `reapplyInventory` (true = reverse + re-post stock, false = document-only);
   * see InventoryService.updatePurchaseOrder. Operator-only like the other PO writes.
   */
  @Patch("purchase-orders/:id")
  updatePO(
    @Param("id") id: string,
    @Body() dto: UpdatePurchaseOrderDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.inventoryService.updatePurchaseOrder(id, dto, user.id);
  }

  @Post("purchase-orders/:id/send")
  sendPO(@Param("id") id: string) {
    return this.inventoryService.sendPurchaseOrder(id);
  }

  @Post("purchase-orders/:id/receive")
  receivePO(
    @Param("id") id: string,
    @Body() dto: ReceivePurchaseOrderDto,
    @CurrentUser() user: { id: string },
  ) {
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
