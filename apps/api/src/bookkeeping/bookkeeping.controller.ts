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
} from "@nestjs/common";
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
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { JwtPayload } from "../auth/jwt-payload.interface";

@ApiTags("bookkeeping")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OPERATOR)
@Controller("bookkeeping")
export class BookkeepingController {
  constructor(private readonly bookkeepingService: BookkeepingService) {}

  @Get("summary")
  getSummary() {
    return this.bookkeepingService.getSummary();
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

  @Post("expenses")
  createExpense(@Body() dto: CreateExpenseDto, @CurrentUser() user: JwtPayload) {
    return this.bookkeepingService.createExpense(dto, user.sub);
  }

  @Patch("expenses/:id")
  updateExpense(@Param("id") id: string, @Body() dto: UpdateExpenseDto) {
    return this.bookkeepingService.updateExpense(id, dto);
  }

  @Post("expenses/:id/delete")
  deleteExpense(@Param("id") id: string) {
    return this.bookkeepingService.deleteExpense(id);
  }

  // ── Reports ──
  @Get("reports/pl")
  getPL(@Query("from") from?: string, @Query("to") to?: string) {
    return this.bookkeepingService.getProfitAndLoss(from, to);
  }

  @Get("reports/aging")
  getAging() {
    return this.bookkeepingService.getArAging();
  }

  @Get("reports/cashflow")
  getCashFlow(@Query("from") from?: string, @Query("to") to?: string) {
    return this.bookkeepingService.getCashFlow(from, to);
  }

  @Get("finance-dashboard")
  getFinanceDashboard() {
    return this.bookkeepingService.getFinanceDashboard();
  }

  // ── Extended Reports ──
  @Get("reports/ar-aging-invoices")
  getArAgingInvoices(@Query("intervalDays") intervalDays?: string) {
    const interval = intervalDays ? parseInt(intervalDays, 10) : 30;
    return this.bookkeepingService.getArAgingInvoices(interval);
  }

  @Get("reports/sales-by-customer")
  getSalesByCustomer(@Query("from") from?: string, @Query("to") to?: string) {
    return this.bookkeepingService.getSalesByCustomer(from, to);
  }

  @Get("reports/sales-by-item")
  getSalesByItem(@Query("from") from?: string, @Query("to") to?: string) {
    return this.bookkeepingService.getSalesByItem(from, to);
  }

  @Get("reports/customer-balance")
  getCustomerBalanceSummary() {
    return this.bookkeepingService.getCustomerBalanceSummary();
  }

  @Get("reports/invoice-details")
  getInvoiceDetailsReport(
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("status") status?: string,
    @Query("customerId") customerId?: string,
  ) {
    return this.bookkeepingService.getInvoiceDetailsReport(from, to, status, customerId);
  }

  @Get("reports/bad-debts")
  getBadDebtsReport() {
    return this.bookkeepingService.getBadDebtsReport();
  }

  @Get("reports/payments-received")
  getPaymentsReceivedReport(@Query("from") from?: string, @Query("to") to?: string) {
    return this.bookkeepingService.getPaymentsReceivedReport(from, to);
  }

  @Get("reports/time-to-get-paid")
  getTimeToGetPaid(@Query("from") from?: string, @Query("to") to?: string) {
    return this.bookkeepingService.getTimeToGetPaid(from, to);
  }

  @Get("reports/expense-details")
  getExpenseDetailsReport(
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("categoryId") categoryId?: string,
  ) {
    return this.bookkeepingService.getExpenseDetailsReport(from, to, categoryId);
  }

  @Get("reports/expenses-by-category")
  getExpensesByCategoryReport(@Query("from") from?: string, @Query("to") to?: string) {
    return this.bookkeepingService.getExpensesByCategoryReport(from, to);
  }

  @Get("reports/expenses-by-customer")
  getExpensesByCustomerReport(@Query("from") from?: string, @Query("to") to?: string) {
    return this.bookkeepingService.getExpensesByCustomerReport(from, to);
  }

  @Get("reports/sales-by-driver")
  getSalesByDriver(@Query("from") from?: string, @Query("to") to?: string) {
    return this.bookkeepingService.getSalesByDriver(from, to);
  }

  @Get("reports/ar-aging-details")
  getArAgingDetails(
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("customerId") customerId?: string,
  ) {
    return this.bookkeepingService.getArAgingDetails(from, to, customerId);
  }

  @Get("reports/estimate-details")
  getEstimateDetails(
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("status") status?: string,
  ) {
    return this.bookkeepingService.getEstimateDetails(from, to, status);
  }

  @Get("reports/refund-history")
  getRefundHistory(@Query("from") from?: string, @Query("to") to?: string) {
    return this.bookkeepingService.getRefundHistory(from, to);
  }

  @Get("reports/receivable-summary")
  getReceivableSummary(@Query("from") from?: string, @Query("to") to?: string) {
    return this.bookkeepingService.getReceivableSummary(from, to);
  }
}
