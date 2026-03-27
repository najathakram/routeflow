import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { InvoicesService } from "./invoices.service";
import { CreateInvoiceDto, RecordInvoicePaymentDto } from "./dto/create-invoice.dto";
import { ListInvoicesDto } from "./dto/list-invoices.dto";

@Controller("invoices")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OPERATOR)
export class InvoicesController {
  constructor(private readonly invoicesService: InvoicesService) {}

  @Post() create(@Body() dto: CreateInvoiceDto) { return this.invoicesService.create(dto); }

  @Get()
  @Roles(UserRole.OPERATOR, UserRole.CUSTOMER, UserRole.DRIVER)
  findAll(@Query() query: ListInvoicesDto, @CurrentUser() user: JwtPayload) {
    return this.invoicesService.findAll(query, user);
  }

  @Get(":id")
  @Roles(UserRole.OPERATOR, UserRole.CUSTOMER, UserRole.DRIVER)
  findOne(@Param("id") id: string, @CurrentUser() user: JwtPayload) {
    return this.invoicesService.findOne(id, user);
  }

  @Patch(":id") update(@Param("id") id: string, @Body() dto: Partial<CreateInvoiceDto>) { return this.invoicesService.update(id, dto); }
  @Post(":id/send") send(@Param("id") id: string) { return this.invoicesService.send(id); }
  @Post(":id/void") void(@Param("id") id: string) { return this.invoicesService.voidInvoice(id); }
  @Post(":id/duplicate") duplicate(@Param("id") id: string) { return this.invoicesService.duplicate(id); }
  @Post(":id/payments")
  @Roles(UserRole.OPERATOR, UserRole.DRIVER)
  recordPayment(@Param("id") id: string, @Body() dto: RecordInvoicePaymentDto) { return this.invoicesService.recordPayment(id, dto); }
}
