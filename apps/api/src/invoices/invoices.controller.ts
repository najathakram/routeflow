import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { InvoicesService } from "./invoices.service";
import { InvoicePdfService } from "./invoice-pdf.service";
import { CreateInvoiceDto, RecordInvoicePaymentDto, UpdatePaymentDto, WriteOffDto } from "./dto/create-invoice.dto";
import { ListInvoicesDto } from "./dto/list-invoices.dto";

@Controller("invoices")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OPERATOR)
export class InvoicesController {
  constructor(
    private readonly invoicesService: InvoicesService,
    private readonly invoicePdfService: InvoicePdfService,
  ) {}

  @Post()
  @Roles(UserRole.OPERATOR, UserRole.DRIVER)
  create(@Body() dto: CreateInvoiceDto) { return this.invoicesService.create(dto); }

  @Get()
  @Roles(UserRole.OPERATOR, UserRole.CUSTOMER, UserRole.DRIVER)
  findAll(@Query() query: ListInvoicesDto, @CurrentUser() user: JwtPayload) {
    return this.invoicesService.findAll(query, user);
  }

  @Get("payments")
  listAllPayments(@Query("page") page?: string, @Query("limit") limit?: string) {
    return this.invoicesService.listAllPayments({ page: page ? parseInt(page) : 1, limit: limit ? parseInt(limit) : 25 });
  }

  @Get(":id")
  @Roles(UserRole.OPERATOR, UserRole.CUSTOMER, UserRole.DRIVER)
  findOne(@Param("id") id: string, @CurrentUser() user: JwtPayload) {
    return this.invoicesService.findOne(id, user);
  }

  @Patch(":id") update(@Param("id") id: string, @Body() dto: Partial<CreateInvoiceDto>) { return this.invoicesService.update(id, dto); }
  @Post(":id/send") send(@Param("id") id: string) { return this.invoicesService.send(id); }
  @Post(":id/void") void(@Param("id") id: string) { return this.invoicesService.voidInvoice(id); }
  @Post(":id/reopen") reopenInvoice(@Param("id") id: string) { return this.invoicesService.reopenInvoice(id); }
  @Post(":id/duplicate") duplicate(@Param("id") id: string) { return this.invoicesService.duplicate(id); }

  @Get(":id/pdf")
  async getPdf(@Param("id") id: string) {
    const url = await this.invoicePdfService.getOrGenerate(id);
    return { url };
  }

  @Post(":id/write-off")
  writeOff(@Param("id") id: string, @Body() dto: WriteOffDto) {
    return this.invoicesService.writeOff(id, dto);
  }

  @Post(":id/payments")
  @Roles(UserRole.OPERATOR, UserRole.DRIVER)
  recordPayment(@Param("id") id: string, @Body() dto: RecordInvoicePaymentDto) {
    return this.invoicesService.recordPayment(id, dto);
  }

  @Patch(":id/payments/:paymentId")
  updatePayment(@Param("id") id: string, @Param("paymentId") paymentId: string, @Body() dto: UpdatePaymentDto) {
    return this.invoicesService.updatePayment(id, paymentId, dto);
  }

  @Delete(":id/payments/:paymentId")
  deletePayment(@Param("id") id: string, @Param("paymentId") paymentId: string) {
    return this.invoicesService.deletePayment(id, paymentId);
  }
}
