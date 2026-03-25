import {
  Controller,
  Get,
  Post,
  Patch,
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
import { CurrentUser } from "../auth/decorators/current-user.decorator";

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
  listExpenseCategories() { return this.bookkeepingService.listExpenseCategories(); }

  @Post("expense-categories")
  createExpenseCategory(@Body() dto: any) { return this.bookkeepingService.createExpenseCategory(dto); }

  // ── Expenses ──
  @Get("expenses")
  listExpenses(@Query() query: any) { return this.bookkeepingService.listExpenses(query); }

  @Post("expenses")
  createExpense(@Body() dto: any, @CurrentUser() user: any) { return this.bookkeepingService.createExpense(dto, user.sub); }

  @Patch("expenses/:id")
  updateExpense(@Param("id") id: string, @Body() dto: any) { return this.bookkeepingService.updateExpense(id, dto); }

  @Post("expenses/:id/delete")
  deleteExpense(@Param("id") id: string) { return this.bookkeepingService.deleteExpense(id); }

  // ── Reports ──
  @Get("reports/pl")
  getPL(@Query("from") from?: string, @Query("to") to?: string) { return this.bookkeepingService.getProfitAndLoss(from, to); }

  @Get("reports/aging")
  getAging() { return this.bookkeepingService.getArAging(); }

  @Get("reports/cashflow")
  getCashFlow(@Query("from") from?: string, @Query("to") to?: string) { return this.bookkeepingService.getCashFlow(from, to); }
}
