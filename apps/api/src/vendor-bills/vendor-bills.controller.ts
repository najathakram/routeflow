import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
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
    @Query("page") page?: string,
    @Query("limit") limit?: string,
  ) {
    return this.vendorBillsService.findAll(
      supplierId,
      status,
      page ? +page : 1,
      limit ? +limit : 20,
    );
  }
  @Get(":id") findOne(@Param("id") id: string) {
    return this.vendorBillsService.findOne(id);
  }
  @Post(":id/receive") receive(@Param("id") id: string) {
    return this.vendorBillsService.receive(id);
  }
  @Post(":id/void") voidBill(@Param("id") id: string) {
    return this.vendorBillsService.voidBill(id);
  }
  @Post(":id/payments") recordPayment(@Param("id") id: string, @Body() dto: any) {
    return this.vendorBillsService.recordPayment(id, dto);
  }
}
