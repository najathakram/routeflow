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
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { VendorBillsService } from "./vendor-bills.service";

@Controller("vendor-bills")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OPERATOR)
export class VendorBillsController {
  constructor(private readonly vendorBillsService: VendorBillsService) {}

  @Post() create(@Body() dto: any) {
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
  ) {
    return this.vendorBillsService.findAll(
      supplierId,
      status,
      dateFrom,
      dateTo,
      search,
      page ? +page : 1,
      limit ? +limit : 20,
    );
  }

  @Post("scan-invoice")
  @UseInterceptors(FileInterceptor("image", { limits: { fileSize: 20 * 1024 * 1024 } }))
  scanInvoice(@UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException("No file provided");
    const mimeType = file.mimetype || "image/jpeg";
    const allowed = ["image/jpeg", "image/png", "image/gif", "image/webp", "application/pdf"];
    if (!allowed.includes(mimeType)) {
      throw new BadRequestException("Only JPEG, PNG, WebP, GIF, or PDF files are accepted");
    }
    return this.vendorBillsService.scanInvoice(file.buffer, mimeType);
  }

  // Product mapping memory — must be before :id routes
  @Post("product-mappings")
  saveProductMapping(
    @Body() dto: { supplierName: string; rawDescription: string; productId: string | null },
  ) {
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

  @Get(":id") findOne(@Param("id") id: string) {
    return this.vendorBillsService.findOne(id);
  }

  @Patch(":id") updateBill(@Param("id") id: string, @Body() dto: any) {
    return this.vendorBillsService.update(id, dto);
  }

  @Post(":id/receive") receive(@Param("id") id: string) {
    return this.vendorBillsService.receive(id);
  }

  @Post(":id/revert-to-draft") revertToDraft(@Param("id") id: string) {
    return this.vendorBillsService.revertToDraft(id);
  }

  @Post(":id/void") voidBill(@Param("id") id: string) {
    return this.vendorBillsService.voidBill(id);
  }

  @Post(":id/payments") recordPayment(@Param("id") id: string, @Body() dto: any) {
    return this.vendorBillsService.recordPayment(id, dto);
  }

  @Delete(":id") deleteBill(@Param("id") id: string) {
    return this.vendorBillsService.delete(id);
  }

  @Delete() bulkDelete(@Body() dto: { ids: string[] }) {
    return this.vendorBillsService.bulkDelete(dto.ids);
  }
}
