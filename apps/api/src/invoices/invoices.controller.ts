import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { InvoicesService } from "./invoices.service";
import { InvoicePdfService } from "./invoice-pdf.service";
import {
  CreateInvoiceDto,
  RecordInvoicePaymentDto,
  StandalonePaymentDto,
  UpdatePaymentDto,
  WriteOffDto,
} from "./dto/create-invoice.dto";
import { CreatePartialInvoiceDto } from "./dto/create-partial-invoice.dto";
import { ListInvoicesDto } from "./dto/list-invoices.dto";
import { PriceAdjustmentDto } from "./dto/price-adjustment.dto";
import { UpdateShipmentDto } from "../orders/dto/update-shipment.dto";

@Controller("invoices")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OPERATOR)
export class InvoicesController {
  constructor(
    private readonly invoicesService: InvoicesService,
    private readonly invoicePdfService: InvoicePdfService,
  ) {}

  @Post()
  create(@Body() dto: CreateInvoiceDto) {
    return this.invoicesService.create(dto);
  }

  @Post("from-order/:orderId")
  @Roles(UserRole.OPERATOR)
  createFromOrder(@Param("orderId") orderId: string) {
    return this.invoicesService.createInvoiceFromOrder(orderId);
  }

  /**
   * Create one of many partial invoices for an order. Operator (or driver, at delivery
   * time) picks which OrderItem rows + how many of each to bill on this invoice, plus a
   * due date. Each call increments OrderItem.invoicedQty so the order can't be over-billed.
   */
  @Post("from-order/:orderId/partial")
  @Roles(UserRole.OPERATOR, UserRole.DRIVER)
  createPartialFromOrder(@Param("orderId") orderId: string, @Body() dto: CreatePartialInvoiceDto) {
    return this.invoicesService.createPartialFromOrder(orderId, dto);
  }

  @Get()
  @Roles(UserRole.OPERATOR, UserRole.CUSTOMER)
  findAll(@Query() query: ListInvoicesDto, @CurrentUser() user: JwtPayload) {
    return this.invoicesService.findAll(query, user);
  }

  @Get("payments/export")
  async exportPayments(@Query() query: any, @Res() res: Response) {
    const csv = await this.invoicesService.exportPayments(query);
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", 'attachment; filename="payments.csv"');
    res.send(csv);
  }

  @Post("payments/record")
  @Roles(UserRole.OPERATOR)
  recordStandalonePayment(@Body() dto: StandalonePaymentDto) {
    return this.invoicesService.recordStandalonePayment(dto);
  }

  @Get("payments/:paymentId")
  findPayment(@Param("paymentId") paymentId: string) {
    return this.invoicesService.findPaymentById(paymentId);
  }

  @Get("payments")
  listAllPayments(
    @Query("page") page?: string,
    @Query("limit") limit?: string,
    @Query("customerId") customerId?: string,
    @Query("method") method?: string,
    @Query("status") status?: string,
    @Query("dateFrom") dateFrom?: string,
    @Query("dateTo") dateTo?: string,
    @Query("search") search?: string,
    @Query("sortBy") sortBy?: string,
    @Query("sortDir") sortDir?: string,
  ) {
    return this.invoicesService.listAllPayments({
      page: page ? parseInt(page) : 1,
      limit: limit ? parseInt(limit) : 25,
      customerId,
      method,
      status,
      dateFrom,
      dateTo,
      search,
      sortBy,
      sortDir,
    });
  }

  @Get(":id")
  @Roles(UserRole.OPERATOR, UserRole.CUSTOMER, UserRole.DRIVER)
  findOne(@Param("id") id: string, @CurrentUser() user: JwtPayload) {
    return this.invoicesService.findOne(id, user);
  }

  @Patch(":id") update(@Param("id") id: string, @Body() dto: Partial<CreateInvoiceDto>) {
    return this.invoicesService.update(id, dto);
  }

  /**
   * Set/clear carrier shipment tracking on an invoice. Works on any non-void
   * invoice (you usually ship AFTER billing, so this is not gated to DRAFT like
   * the line-item edit). Mirrors the order's `PATCH /orders/:id/shipment`.
   */
  @Patch(":id/shipment") updateShipment(@Param("id") id: string, @Body() dto: UpdateShipmentDto) {
    return this.invoicesService.updateInvoiceShipment(id, dto);
  }
  @Post(":id/send") send(@Param("id") id: string) {
    return this.invoicesService.send(id);
  }

  /** Send the invoice as an actual email (marks as SENT). Optional `variant`
   * (draft|final) controls which version of the PDF is attached. */
  @Post(":id/send-email")
  sendEmail(@Param("id") id: string, @Body() body: { email?: string; variant?: string }) {
    const variant =
      body?.variant === "draft" || body?.variant === "final" ? body.variant : undefined;
    return this.invoicesService.sendEmail(id, body?.email, variant);
  }

  /** Send a payment reminder email (does not change invoice status). */
  @Post(":id/send-reminder")
  sendReminder(@Param("id") id: string, @Body() body: { email?: string }) {
    return this.invoicesService.sendReminder(id, body?.email);
  }
  @Post(":id/void") void(@Param("id") id: string) {
    return this.invoicesService.voidInvoice(id);
  }
  @Post(":id/revert-to-draft")
  @Roles(UserRole.OPERATOR)
  revertToDraft(@Param("id") id: string) {
    return this.invoicesService.revertInvoiceToDraft(id);
  }

  @Post(":id/unvoid")
  @Roles(UserRole.OPERATOR)
  unvoid(@Param("id") id: string) {
    return this.invoicesService.unvoidInvoice(id);
  }

  @Post(":id/reopen") reopenInvoice(@Param("id") id: string) {
    return this.invoicesService.reopenInvoice(id);
  }
  @Post(":id/duplicate") duplicate(@Param("id") id: string) {
    return this.invoicesService.duplicate(id);
  }

  @Get(":id/pdf")
  async getPdf(
    @Param("id") id: string,
    @Query("refresh") refresh?: string,
    @Query("variant") variant?: string,
  ) {
    const force = refresh === "1" || refresh === "true";
    const v = variant === "draft" || variant === "final" ? variant : undefined;
    const url = await this.invoicePdfService.getOrGenerate(id, { force, variant: v });
    return { url };
  }

  @Post(":id/write-off")
  writeOff(@Param("id") id: string, @Body() dto: WriteOffDto) {
    return this.invoicesService.writeOff(id, dto);
  }

  @Post(":id/payments")
  recordPayment(@Param("id") id: string, @Body() dto: RecordInvoicePaymentDto) {
    return this.invoicesService.recordPayment(id, dto);
  }

  @Patch(":id/payments/:paymentId/void")
  @Roles(UserRole.OPERATOR)
  voidPayment(@Param("id") id: string, @Param("paymentId") paymentId: string) {
    return this.invoicesService.voidPayment(id, paymentId);
  }

  @Patch(":id/payments/:paymentId")
  updatePayment(
    @Param("id") id: string,
    @Param("paymentId") paymentId: string,
    @Body() dto: UpdatePaymentDto,
  ) {
    return this.invoicesService.updatePayment(id, paymentId, dto);
  }

  @Post(":id/price-adjustment")
  @Roles(UserRole.OPERATOR)
  applyPriceAdjustment(@Param("id") id: string, @Body() dto: PriceAdjustmentDto) {
    return this.invoicesService.applyPriceAdjustment(id, dto);
  }

  @Delete(":id")
  deleteInvoice(@Param("id") id: string) {
    return this.invoicesService.deleteInvoice(id);
  }

  @Delete(":id/payments/:paymentId")
  deletePayment(@Param("id") id: string, @Param("paymentId") paymentId: string) {
    return this.invoicesService.deletePayment(id, paymentId);
  }
}
