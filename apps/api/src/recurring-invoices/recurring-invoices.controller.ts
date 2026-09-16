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
import { PlanFlagGuard } from "../billing/plan-flag.guard";
import { RequirePlanFlag } from "../billing/require-plan-flag.decorator";
import { RecurringInvoicesService } from "./recurring-invoices.service";
import { CreateRecurringInvoiceDto } from "./dto/create-recurring-invoice.dto";
import { UpdateRecurringInvoiceDto } from "./dto/update-recurring-invoice.dto";

// WP5a (R3b.3, R3b.5): flag.recurring_invoices ships dark (DARK_PLAN_FLAGS in
// plan-flag-policy.ts) — this class-level guard is a courtesy allow until the
// PLAN_FLAG_ENFORCEMENT switch flips on.
@Controller("recurring-invoices")
@UseGuards(JwtAuthGuard, RolesGuard, PlanFlagGuard)
@Roles(UserRole.OPERATOR)
@RequirePlanFlag("flag.recurring_invoices")
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
  update(@Param("id") id: string, @Body() dto: UpdateRecurringInvoiceDto) {
    return this.recurringInvoicesService.update(id, dto);
  }

  @Delete(":id")
  deactivate(@Param("id") id: string) {
    return this.recurringInvoicesService.deactivate(id);
  }

  // Resume a paused template. A dedicated endpoint (mirrors DELETE=deactivate)
  // — the PATCH path can't carry `isActive` (UpdateRecurringInvoiceDto deliberately
  // omits it, and the whitelist ValidationPipe rejects it as a non-whitelisted key).
  @Post(":id/activate")
  activate(@Param("id") id: string) {
    return this.recurringInvoicesService.activate(id);
  }

  @Post(":id/run")
  runNow(@Param("id") id: string) {
    return this.recurringInvoicesService.runNow(id);
  }
}
