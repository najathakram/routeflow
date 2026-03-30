import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { RecurringInvoicesService } from "./recurring-invoices.service";
import { CreateRecurringInvoiceDto } from "./dto/create-recurring-invoice.dto";

@Controller("recurring-invoices")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OPERATOR)
export class RecurringInvoicesController {
  constructor(private readonly recurringInvoicesService: RecurringInvoicesService) {}

  @Post()
  create(@Body() dto: CreateRecurringInvoiceDto) {
    return this.recurringInvoicesService.create(dto);
  }

  @Get()
  findAll(@Query("customerId") customerId?: string) {
    return this.recurringInvoicesService.findAll(customerId);
  }

  @Get(":id")
  findOne(@Param("id") id: string) {
    return this.recurringInvoicesService.findOne(id);
  }

  @Patch(":id")
  update(@Param("id") id: string, @Body() dto: Partial<CreateRecurringInvoiceDto>) {
    return this.recurringInvoicesService.update(id, dto);
  }

  @Delete(":id")
  deactivate(@Param("id") id: string) {
    return this.recurringInvoicesService.deactivate(id);
  }

  @Post(":id/run")
  runNow(@Param("id") id: string) {
    return this.recurringInvoicesService.runNow(id);
  }
}
