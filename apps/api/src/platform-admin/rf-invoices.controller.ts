import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { SuperAdminGuard } from "../tenant/super-admin.guard";
import {
  MarkRfInvoicePaidDto,
  RfInvoiceListQueryDto,
  RfInvoiceReasonDto,
} from "./dto/rf-invoice.dto";
import { RfInvoicesAdminService } from "./rf-invoices.service";

/**
 * RouteFlow's own invoices to manual-pay tenants: the super-admin queue and its actions. Its own
 * controller (platform-admin.controller.ts is untouched); the class-level guards cover every route.
 */
@ApiTags("platform-admin")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, SuperAdminGuard)
@Controller("platform-admin")
export class RfInvoicesController {
  constructor(private readonly svc: RfInvoicesAdminService) {}

  @Get("rf-invoices")
  @ApiOperation({ summary: "Manual-pay RouteFlow invoices: the queue" })
  list(@Query() query: RfInvoiceListQueryDto) {
    return this.svc.list(query);
  }

  // Declared before any `:id` route so "summary" is never read as an id.
  @Get("rf-invoices/summary")
  @ApiOperation({ summary: "Overdue / due-soon / paid-30d totals, unpriced and stale tenants" })
  summary() {
    return this.svc.summary();
  }

  @Post("rf-invoices/:id/mark-paid")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Record an out-of-band payment (OPEN to PAID)" })
  markPaid(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: MarkRfInvoicePaidDto,
    @CurrentUser() admin: JwtPayload,
  ) {
    return this.svc.markPaid(id, dto, admin.sub);
  }

  @Post("rf-invoices/:id/reopen")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Undo a payment record (PAID to OPEN)" })
  reopen(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: RfInvoiceReasonDto,
    @CurrentUser() admin: JwtPayload,
  ) {
    return this.svc.reopen(id, dto, admin.sub);
  }

  @Post("rf-invoices/:id/void")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Void an unpaid invoice (OPEN to VOID)" })
  voidInvoice(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: RfInvoiceReasonDto,
    @CurrentUser() admin: JwtPayload,
  ) {
    return this.svc.voidInvoice(id, dto, admin.sub);
  }

  @Post("tenants/:id/rf-invoices/issue")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Issue the invoice that is due now for one manual-pay tenant" })
  issueForTenant(@Param("id", ParseUUIDPipe) id: string, @CurrentUser() admin: JwtPayload) {
    return this.svc.issueForTenant(id, admin.sub);
  }
}
