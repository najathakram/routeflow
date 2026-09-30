import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
  HttpException,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { BookkeepingService } from "./bookkeeping.service";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { UserRole } from "@prisma/client";
import { ListTransactionsDto } from "./dto/list-transactions.dto";
import { RecordPaymentDto } from "./dto/record-payment.dto";
import {
  CreateExpenseCategoryDto,
  CreateExpenseDto,
  UpdateExpenseDto,
  ListExpensesDto,
  CreateMileageRateDto,
  BulkCreateExpenseDto,
} from "./dto/create-expense.dto";
import { BulkMarkPaidDto } from "../vendor-bills/dto/bulk-mark-paid.dto";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { PlanFlagGuard } from "../billing/plan-flag.guard";
import { RequirePlanFlag } from "../billing/require-plan-flag.decorator";
import { AddonGuard } from "../billing/addon.guard";
import { RequireAddon } from "../billing/require-addon.decorator";
import { MB, uploadLimits } from "../common/upload-limits";

@ApiTags("bookkeeping")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OPERATOR)
@Controller("bookkeeping")
export class BookkeepingController {
  constructor(private readonly bookkeepingService: BookkeepingService) {}

  // Core money endpoints (summary, dashboard, transactions, expenses,
  // bills/bulk-mark-paid) stay UNGATED — only reports/* is behind flag.reports.
  @Get("summary")
  getSummary() {
    return this.bookkeepingService.getSummary();
  }

  @Get("dashboard")
  getDashboard() {
    return this.bookkeepingService.getMobileDashboard();
  }

  @Get("transactions")
  findAll(@Query() query: ListTransactionsDto) {
    return this.bookkeepingService.findAll(query);
  }

  @Get("transactions/:id")
  findOne(@Param("id") id: string) {
    return this.bookkeepingService.findOne(id);
  }

  @Post("transactions/:id/payments")
  @HttpCode(HttpStatus.OK)
  recordPayment(@Param("id") id: string, @Body() dto: RecordPaymentDto) {
    return this.bookkeepingService.recordPayment(id, dto);
  }

  @Get("transactions/:id/pdf")
  async getInvoicePdf(@Param("id") id: string) {
    const result = await this.bookkeepingService.getPdfUrl(id);
    if (!result) {
      // PDF not yet generated — return 202 Accepted
      throw new HttpException(
        { message: "Invoice PDF not yet available — generation in progress" },
        HttpStatus.ACCEPTED,
      );
    }
    return result;
  }

  // ── Expense Categories ──
  @Get("expense-categories")
  listExpenseCategories() {
    return this.bookkeepingService.listExpenseCategories();
  }

  @Post("expense-categories")
  createExpenseCategory(@Body() dto: CreateExpenseCategoryDto) {
    return this.bookkeepingService.createExpenseCategory(dto);
  }

  // ── Mileage Rates ──
  @Get("mileage-rates")
  listMileageRates() {
    return this.bookkeepingService.listMileageRates();
  }

  @Post("mileage-rates")
  createMileageRate(@Body() dto: CreateMileageRateDto) {
    return this.bookkeepingService.createMileageRate(dto);
  }

  @Delete("mileage-rates/:id")
  deleteMileageRate(@Param("id") id: string) {
    return this.bookkeepingService.deleteMileageRate(id);
  }

  // ── Expenses ──
  @Get("expenses")
  listExpenses(@Query() query: ListExpensesDto) {
    return this.bookkeepingService.listExpenses(query);
  }

  @Post("expenses/bulk")
  bulkCreateExpenses(@Body() dto: BulkCreateExpenseDto, @CurrentUser() user: JwtPayload) {
    return this.bookkeepingService.bulkCreateExpenses(dto.expenses, user.sub);
  }

  @Post("expenses/batch-status")
  @HttpCode(200)
  batchUpdateExpenseStatus(
    @Body() body: { ids: string[]; status: "PENDING" | "RECEIVED" | "PAID" | "VOID" },
  ) {
    return this.bookkeepingService.batchUpdateExpenseStatus(body?.ids ?? [], body?.status);
  }

  // Bulk mark-paid for vendor bills and expenses — full-remaining payments through
  // the normal ledger, not a status jump. Real DTO (landmine 6): this moves money.
  // Route lives under "bills/" because InventoryPurchasesTab (the vendor-bills
  // list) is the primary caller; ids may also be Expense ids (see service).
  @Post("bills/bulk-mark-paid")
  @HttpCode(HttpStatus.OK)
  bulkMarkPaid(@Body() dto: BulkMarkPaidDto) {
    return this.bookkeepingService.bulkMarkPaid(dto);
  }

  @Post("expenses")
  createExpense(@Body() dto: CreateExpenseDto, @CurrentUser() user: JwtPayload) {
    return this.bookkeepingService.createExpense(dto, user.sub);
  }

  @Get("expenses/:id")
  getExpense(@Param("id") id: string) {
    return this.bookkeepingService.getExpense(id);
  }

  @Patch("expenses/:id")
  updateExpense(@Param("id") id: string, @Body() dto: UpdateExpenseDto) {
    return this.bookkeepingService.updateExpense(id, dto);
  }

  @Post("expenses/:id/delete")
  deleteExpense(@Param("id") id: string) {
    return this.bookkeepingService.deleteExpense(id);
  }

  @Post("expenses/:id/receipt")
  @UseInterceptors(FileInterceptor("file", { limits: uploadLimits(MB(10)) }))
  uploadReceipt(@Param("id") id: string, @UploadedFile() file: Express.Multer.File) {
    if (!file) throw new HttpException("No file uploaded", HttpStatus.BAD_REQUEST);
    return this.bookkeepingService.uploadExpenseReceipt(
      id,
      file.buffer,
      file.originalname,
      file.mimetype,
    );
  }

  @Get("expenses/:id/receipt")
  getReceipt(@Param("id") id: string) {
    return this.bookkeepingService.getExpenseReceiptUrl(id);
  }

  @Delete("expenses/:id/receipt")
  deleteReceipt(@Param("id") id: string) {
    return this.bookkeepingService.deleteExpenseReceipt(id);
  }

  // AI OCR is entitlement-gated (owner decision 2026-08-28) — OCR_ADDON in
  // packages/types is the client-side mirror of this key.
  @Post("expenses/:id/extract-items")
  @UseGuards(AddonGuard)
  @RequireAddon("ocr")
  extractItems(@Param("id") id: string) {
    return this.bookkeepingService.extractExpenseItems(id);
  }

  // ── Reports ── every reports/* route is gated on flag.reports.
  @Get("reports/pl")
  @UseGuards(PlanFlagGuard)
  @RequirePlanFlag("flag.reports")
  getPL(@Query("from") from?: string, @Query("to") to?: string) {
    return this.bookkeepingService.getProfitAndLoss(from, to);
  }

  @Get("reports/aging")
  @UseGuards(PlanFlagGuard)
  @RequirePlanFlag("flag.reports")
  getAging() {
    return this.bookkeepingService.getArAging();
  }

  @Get("reports/cashflow")
  @UseGuards(PlanFlagGuard)
  @RequirePlanFlag("flag.reports")
  getCashFlow(@Query("from") from?: string, @Query("to") to?: string) {
    return this.bookkeepingService.getCashFlow(from, to);
  }

  // Core money endpoint — stays UNGATED (owner decision pending). Not reports/*.
  @Get("finance-dashboard")
  getFinanceDashboard() {
    return this.bookkeepingService.getFinanceDashboard();
  }

  // ── Extended Reports ── every reports/* route is gated on flag.reports.
  @Get("reports/ar-aging-invoices")
  @UseGuards(PlanFlagGuard)
  @RequirePlanFlag("flag.reports")
  getArAgingInvoices(@Query("intervalDays") intervalDays?: string) {
    const interval = intervalDays ? parseInt(intervalDays, 10) : 30;
    return this.bookkeepingService.getArAgingInvoices(interval);
  }

  @Get("reports/sales-by-customer")
  @UseGuards(PlanFlagGuard)
  @RequirePlanFlag("flag.reports")
  getSalesByCustomer(@Query("from") from?: string, @Query("to") to?: string) {
    return this.bookkeepingService.getSalesByCustomer(from, to);
  }

  @Get("reports/sales-by-item")
  @UseGuards(PlanFlagGuard)
  @RequirePlanFlag("flag.reports")
  getSalesByItem(@Query("from") from?: string, @Query("to") to?: string) {
    return this.bookkeepingService.getSalesByItem(from, to);
  }

  @Get("reports/customer-balance")
  @UseGuards(PlanFlagGuard)
  @RequirePlanFlag("flag.reports")
  getCustomerBalanceSummary() {
    return this.bookkeepingService.getCustomerBalanceSummary();
  }

  @Get("reports/invoice-details")
  @UseGuards(PlanFlagGuard)
  @RequirePlanFlag("flag.reports")
  getInvoiceDetailsReport(
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("status") status?: string,
    @Query("customerId") customerId?: string,
  ) {
    return this.bookkeepingService.getInvoiceDetailsReport(from, to, status, customerId);
  }

  @Get("reports/bad-debts")
  @UseGuards(PlanFlagGuard)
  @RequirePlanFlag("flag.reports")
  getBadDebtsReport() {
    return this.bookkeepingService.getBadDebtsReport();
  }

  @Get("reports/payments-received")
  @UseGuards(PlanFlagGuard)
  @RequirePlanFlag("flag.reports")
  getPaymentsReceivedReport(@Query("from") from?: string, @Query("to") to?: string) {
    return this.bookkeepingService.getPaymentsReceivedReport(from, to);
  }

  @Get("reports/time-to-get-paid")
  @UseGuards(PlanFlagGuard)
  @RequirePlanFlag("flag.reports")
  getTimeToGetPaid(@Query("from") from?: string, @Query("to") to?: string) {
    return this.bookkeepingService.getTimeToGetPaid(from, to);
  }

  @Get("reports/expense-details")
  @UseGuards(PlanFlagGuard)
  @RequirePlanFlag("flag.reports")
  getExpenseDetailsReport(
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("categoryId") categoryId?: string,
  ) {
    return this.bookkeepingService.getExpenseDetailsReport(from, to, categoryId);
  }

  @Get("reports/expenses-by-category")
  @UseGuards(PlanFlagGuard)
  @RequirePlanFlag("flag.reports")
  getExpensesByCategoryReport(@Query("from") from?: string, @Query("to") to?: string) {
    return this.bookkeepingService.getExpensesByCategoryReport(from, to);
  }

  @Get("reports/expenses-by-customer")
  @UseGuards(PlanFlagGuard)
  @RequirePlanFlag("flag.reports")
  getExpensesByCustomerReport(@Query("from") from?: string, @Query("to") to?: string) {
    return this.bookkeepingService.getExpensesByCustomerReport(from, to);
  }

  @Get("reports/sales-by-driver")
  @UseGuards(PlanFlagGuard)
  @RequirePlanFlag("flag.reports")
  getSalesByDriver(@Query("from") from?: string, @Query("to") to?: string) {
    return this.bookkeepingService.getSalesByDriver(from, to);
  }

  @Get("reports/ar-aging-details")
  @UseGuards(PlanFlagGuard)
  @RequirePlanFlag("flag.reports")
  getArAgingDetails(
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("customerId") customerId?: string,
  ) {
    return this.bookkeepingService.getArAgingDetails(from, to, customerId);
  }

  @Get("reports/estimate-details")
  @UseGuards(PlanFlagGuard)
  @RequirePlanFlag("flag.reports")
  getEstimateDetails(
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("status") status?: string,
  ) {
    return this.bookkeepingService.getEstimateDetails(from, to, status);
  }

  @Get("reports/refund-history")
  @UseGuards(PlanFlagGuard)
  @RequirePlanFlag("flag.reports")
  getRefundHistory(@Query("from") from?: string, @Query("to") to?: string) {
    return this.bookkeepingService.getRefundHistory(from, to);
  }

  @Get("reports/receivable-summary")
  @UseGuards(PlanFlagGuard)
  @RequirePlanFlag("flag.reports")
  getReceivableSummary(@Query("from") from?: string, @Query("to") to?: string) {
    return this.bookkeepingService.getReceivableSummary(from, to);
  }
}
