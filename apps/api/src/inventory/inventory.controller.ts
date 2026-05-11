import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { InventoryService } from "./inventory.service";
import { RecordPurchaseDto } from "./dto/record-purchase.dto";
import { RecordAdjustmentDto } from "./dto/record-adjustment.dto";
import { CommitStockCountDto } from "./dto/commit-stock-count.dto";
import { ListMovementsDto } from "./dto/list-movements.dto";
import { CreateSupplierDto } from "./dto/create-supplier.dto";
import { UpdateSupplierDto } from "./dto/update-supplier.dto";

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

  @Post("movements/purchase")
  @Roles(UserRole.OPERATOR, UserRole.DRIVER)
  recordPurchase(@Body() dto: RecordPurchaseDto, @CurrentUser() user: { id: string }) {
    return this.inventoryService.recordPurchase(dto, user.id);
  }

  @Post("movements/adjustment")
  @Roles(UserRole.OPERATOR, UserRole.DRIVER)
  recordAdjustment(@Body() dto: RecordAdjustmentDto, @CurrentUser() user: { id: string }) {
    return this.inventoryService.recordAdjustment(dto, user.id);
  }

  @Post("stock-count/commit")
  @Roles(UserRole.OPERATOR)
  commitStockCount(@Body() dto: CommitStockCountDto, @CurrentUser() user: { id: string }) {
    return this.inventoryService.commitStockCount(dto, user.id);
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
  @Roles(UserRole.OPERATOR, UserRole.DRIVER)
  createPO(@Body() dto: any, @CurrentUser() user: { id: string }) {
    return this.inventoryService.createPurchaseOrder(dto, user.id);
  }

  @Get("purchase-orders")
  @Roles(UserRole.OPERATOR, UserRole.DRIVER)
  listPOs(@Query() query: any) {
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
  @Roles(UserRole.OPERATOR, UserRole.DRIVER)
  receivePO(@Param("id") id: string, @Body() dto: any, @CurrentUser() user: { id: string }) {
    return this.inventoryService.receivePurchaseOrder(id, dto, user.id);
  }

  @Post("purchase-orders/:id/close")
  closePO(@Param("id") id: string) {
    return this.inventoryService.closePurchaseOrder(id);
  }

  // ── Forecasting ──
  @Get("forecasting")
  getForecasting() {
    return this.inventoryService.getForecasting();
  }

  @Patch("products/:productId/reorder-settings")
  setReorderPoint(@Param("productId") productId: string, @Body() dto: any) {
    return this.inventoryService.setReorderPoint(productId, dto.reorderPoint, dto.reorderQty);
  }
}
