import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FilesInterceptor } from "@nestjs/platform-express";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { PlanFlagGuard } from "../billing/plan-flag.guard";
import { RequirePlanFlag } from "../billing/require-plan-flag.decorator";
import { AddonGuard } from "../billing/addon.guard";
import { RequireAddon } from "../billing/require-addon.decorator";
import { VendorBillsService } from "./vendor-bills.service";
import { CreateVendorBillDto } from "./dto/create-vendor-bill.dto";
import { UpdateVendorBillDto } from "./dto/update-vendor-bill.dto";
import { RecordVendorBillPaymentDto } from "./dto/record-vendor-bill-payment.dto";
import { CheckVendorBillDuplicateDto } from "./dto/check-vendor-bill-duplicate.dto";
import { ReceiveVendorBillDto } from "./dto/receive-vendor-bill.dto";
import { SaveProductMappingDto } from "./dto/save-product-mapping.dto";
import { RecordSupplierPaymentDto } from "./dto/supplier-payment.dto";

// OPERATOR-only end to end. AddonGuard passes handlers without @RequireAddon
// metadata — only the AI scan endpoint below is addon-gated.
@Controller("vendor-bills")
@UseGuards(JwtAuthGuard, RolesGuard, PlanFlagGuard, AddonGuard)
@Roles(UserRole.OPERATOR)
@RequirePlanFlag("flag.ap_bills")
export class VendorBillsController {
  constructor(private readonly vendorBillsService: VendorBillsService) {}

  @Post() create(@Body() dto: CreateVendorBillDto) {
    return this.vendorBillsService.create(dto);
  }

  @Get() findAll(
    @Query("supplierId") supplierId?: string,
    @Query("status") status?: string,
    @Query("dateFrom") dateFrom?: string,
    @Query("dateTo") dateTo?: string,
    @Query("search") search?: string,
    @Query("page") page?: string,
    @Query("limit") limit?: string,
    @Query("needsMapping") needsMapping?: string,
  ) {
    return this.vendorBillsService.findAll(
      supplierId,
      status,
      dateFrom,
      dateTo,
      search,
      page ? +page : 1,
      limit ? +limit : 20,
      needsMapping === "true",
    );
  }

  // AI OCR is entitlement-gated (owner decision 2026-08-28) — OCR_ADDON in
  // packages/types is the client-side mirror of this key.
  @Post("scan-invoice")
  @RequireAddon("ocr")
  @UseInterceptors(
    // Up to 10 pages, 25MB per file, under the field name `images` (multer
    // matches the field name exactly — clients MUST use "images").
    FilesInterceptor("images", 10, { limits: { fileSize: 25 * 1024 * 1024 } }),
  )
  scanInvoice(@UploadedFiles() files: Express.Multer.File[], @CurrentUser() user: { id: string }) {
    if (!files || files.length === 0) {
      throw new BadRequestException("No file provided");
    }
    // Multer's fileSize limit is per file only — cap the aggregate so 10×25MB
    // can't buffer 250MB in memory / ship an oversized payload to Anthropic.
    const totalBytes = files.reduce((s, f) => s + (f.size ?? f.buffer?.length ?? 0), 0);
    if (totalBytes > 60 * 1024 * 1024) {
      throw new BadRequestException(
        "Combined upload is too large (max 60MB per scan). Split the pages across scans.",
      );
    }
    const allowed = [
      "image/jpeg",
      "image/png",
      "image/gif",
      "image/webp",
      "image/heic",
      "image/heif",
      "application/pdf",
    ];
    for (const f of files) {
      const mt = f.mimetype || "image/jpeg";
      if (!allowed.includes(mt)) {
        throw new BadRequestException(
          `Unsupported file type "${mt}" — accepted: JPEG, PNG, WebP, GIF, HEIC, PDF`,
        );
      }
    }
    return this.vendorBillsService.scanInvoice(
      files.map((f) => ({
        buffer: f.buffer,
        mimeType: f.mimetype || "image/jpeg",
        fileName: f.originalname,
        size: f.size,
      })),
      user.id,
    );
  }

  // Must be before :id routes
  @Post("check-duplicate") checkDuplicate(@Body() dto: CheckVendorBillDuplicateDto) {
    return this.vendorBillsService.checkDuplicate(dto);
  }

  // Scan history — must be before the :id routes or "scans" is read as a bill id.
  @Get("scans") listScans(
    @Query("status") status?: string,
    @Query("page") page?: string,
    @Query("limit") limit?: string,
  ) {
    return this.vendorBillsService.listScans(status, page ? +page : 1, limit ? +limit : 20);
  }

  @Get("scans/:id") getScan(@Param("id") id: string) {
    return this.vendorBillsService.getScan(id);
  }

  // Product mapping memory — must be before :id routes
  @Post("product-mappings")
  saveProductMapping(@Body() dto: SaveProductMappingDto) {
    return this.vendorBillsService.saveProductMapping(
      dto.supplierName,
      dto.rawDescription,
      dto.productId,
    );
  }

  @Get("product-mappings")
  getProductMappings(@Query("supplierName") supplierName: string) {
    if (!supplierName) throw new BadRequestException("supplierName is required");
    return this.vendorBillsService.getProductMappings(supplierName);
  }

  // Supplier-level payment allocation — the AP mirror of
  // POST /invoices/payments/record. Must be before the :id routes.
  @Post("payments/record") recordSupplierPayment(@Body() dto: RecordSupplierPaymentDto) {
    return this.vendorBillsService.recordSupplierPayment(dto);
  }

  // Running-balance statement for one supplier. Must be before the :id routes.
  @Get("suppliers/:supplierId/statement") getSupplierStatement(
    @Param("supplierId") supplierId: string,
  ) {
    return this.vendorBillsService.getSupplierStatement(supplierId);
  }

  @Get(":id") findOne(@Param("id") id: string) {
    return this.vendorBillsService.findOne(id);
  }

  @Patch(":id") updateBill(@Param("id") id: string, @Body() dto: UpdateVendorBillDto) {
    return this.vendorBillsService.update(id, dto);
  }

  @Post(":id/receive") receive(
    @Param("id") id: string,
    @Body() dto: ReceiveVendorBillDto | undefined,
    @CurrentUser() user: { id: string },
  ) {
    return this.vendorBillsService.receive(id, dto, user.id);
  }

  @Post(":id/revert-to-draft") revertToDraft(@Param("id") id: string) {
    return this.vendorBillsService.revertToDraft(id);
  }

  @Post(":id/void") voidBill(@Param("id") id: string, @CurrentUser() user: { id: string }) {
    return this.vendorBillsService.voidBill(id, user.id);
  }

  @Post(":id/payments") recordPayment(
    @Param("id") id: string,
    @Body() dto: RecordVendorBillPaymentDto,
  ) {
    return this.vendorBillsService.recordPayment(id, dto);
  }

  @Delete(":id") deleteBill(@Param("id") id: string) {
    return this.vendorBillsService.delete(id);
  }

  @Delete() bulkDelete(@Body() dto: { ids: string[] }) {
    return this.vendorBillsService.bulkDelete(dto.ids);
  }
}
