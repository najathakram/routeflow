/// <reference types="multer" />
import {
  Controller,
  Post,
  Get,
  Delete,
  Param,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { UserRole } from "@prisma/client";
import { ImportService } from "./import.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";

@Controller("import")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OPERATOR)
export class ImportController {
  constructor(private readonly importService: ImportService) {}

  @Post("contacts")
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 10 * 1024 * 1024 } }))
  importContacts(@UploadedFile() file: Express.Multer.File, @CurrentUser() user: JwtPayload) {
    if (!file) throw new BadRequestException("No file uploaded");
    return this.importService.importContacts(file.buffer, user.sub);
  }

  @Post("invoices")
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 50 * 1024 * 1024 } }))
  importInvoices(@UploadedFile() file: Express.Multer.File, @CurrentUser() user: JwtPayload) {
    if (!file) throw new BadRequestException("No file uploaded");
    return this.importService.importInvoices(file.buffer, user.sub);
  }

  @Post("payments")
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 10 * 1024 * 1024 } }))
  importPayments(@UploadedFile() file: Express.Multer.File, @CurrentUser() user: JwtPayload) {
    if (!file) throw new BadRequestException("No file uploaded");
    return this.importService.importPayments(file.buffer, user.sub);
  }

  @Post("expenses")
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 10 * 1024 * 1024 } }))
  importExpenses(@UploadedFile() file: Express.Multer.File, @CurrentUser() user: JwtPayload) {
    if (!file) throw new BadRequestException("No file uploaded");
    return this.importService.importExpenses(file.buffer, user.sub);
  }

  /** List the 20 most recent expense import batches (with counts and totals). */
  @Get("expenses/batches")
  listExpenseBatches() {
    return this.importService.listExpenseBatches();
  }

  /**
   * Repair: convert any existing INVENTORY_PURCHASE expenses that were imported
   * before vendor-bill creation was added. Safe to call multiple times.
   */
  @Post("expenses/repair-inventory")
  @HttpCode(HttpStatus.OK)
  repairInventoryPurchaseExpenses() {
    return this.importService.repairInventoryPurchaseExpenses();
  }

  /**
   * Roll back an entire expense import batch by soft-deleting every expense
   * that was created in that batch. Safe to call multiple times.
   */
  @Delete("expenses/batch/:batchId")
  @HttpCode(HttpStatus.OK)
  rollbackExpenseBatch(@Param("batchId") batchId: string) {
    return this.importService.rollbackExpenseBatch(batchId);
  }

  @Post("products")
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 10 * 1024 * 1024 } }))
  importProducts(@UploadedFile() file: Express.Multer.File, @CurrentUser() user: JwtPayload) {
    if (!file) throw new BadRequestException("No file uploaded");
    return this.importService.importProducts(file.buffer, user.sub);
  }

  @Post("inventory")
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 10 * 1024 * 1024 } }))
  importInventory(@UploadedFile() file: Express.Multer.File, @CurrentUser() user: JwtPayload) {
    if (!file) throw new BadRequestException("No file uploaded");
    return this.importService.importInventory(file.buffer, user.sub);
  }

  @Post("expense-suppliers")
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 10 * 1024 * 1024 } }))
  importExpenseSuppliers(@UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException("No file uploaded");
    return this.importService.importExpenseSuppliers(file.buffer);
  }

  /**
   * Mark supplier-only customers: find customers with no orders whose name
   * matches an existing supplier, and flag them supplierOnly=true so they
   * are hidden from the Customers list but their data is preserved.
   */
  @Post("contacts/mark-supplier-only")
  @HttpCode(HttpStatus.OK)
  markSupplierOnlyCustomers() {
    return this.importService.markSupplierOnlyCustomers();
  }

  /**
   * Diagnose: find customers with a zohoContactId that belong to a different
   * (or null) tenant — i.e. orphaned from a super-admin import.
   */
  @Get("contacts/orphans")
  diagnoseOrphanedContacts(@CurrentUser() user: JwtPayload) {
    if (!user.tenantId) throw new BadRequestException("No tenant context");
    return this.importService.diagnoseOrphanedContacts(user.tenantId);
  }

  /**
   * Repair: adopt all orphaned Zoho contacts into the current tenant.
   * Use after confirming via GET /import/contacts/orphans.
   */
  @Post("contacts/adopt-orphans")
  @HttpCode(HttpStatus.OK)
  adoptOrphanedContacts(@CurrentUser() user: JwtPayload) {
    if (!user.tenantId) throw new BadRequestException("No tenant context");
    return this.importService.adoptOrphanedContacts(user.tenantId);
  }
}
