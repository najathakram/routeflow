import { Body, Controller, Get, Param, Post, Query, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { RegulatedService } from "./regulated.service";
import { RegulatedFilingService } from "./regulated-filing.service";
import { RegulatedReportService } from "./regulated-report.service";
import { ListLedgerDto } from "./dto/list-ledger.dto";
import { ListFilingsDto } from "./dto/list-filings.dto";
import { PrepareFilingDto } from "./dto/prepare-filing.dto";
import { ReportQueryDto } from "./dto/report-query.dto";

// Generic feature — no addon gate (mirrors tracked-categories; tobacco stays the
// only addon-gated surface). TENANT_ADMIN satisfies OPERATOR via the RolesGuard.
@Controller("regulated")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OPERATOR)
export class RegulatedController {
  constructor(
    private readonly regulated: RegulatedService,
    private readonly filings: RegulatedFilingService,
    private readonly reports: RegulatedReportService,
  ) {}

  @Get("ledger")
  getLedger(@Query() query: ListLedgerDto) {
    return this.regulated.getLedger(query);
  }

  // ─── Reports (WP11) ──────────────────────────────────────────────────────
  // Stateless: computed on demand, nothing persisted (filings below remain the
  // compliance archive). Static routes first, registered above `filings/:id/...`
  // so the static segment always wins — same route-order convention as Filings.

  @Get("reports/preview")
  previewReport(@Query() query: ReportQueryDto) {
    return this.reports.buildReport(query);
  }

  @Get("reports/csv")
  async downloadReportCsv(
    @Query() query: ReportQueryDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { csv, filename } = await this.reports.buildReportCsv(query);
    res.set({
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="${filename}"`,
    });
    return csv;
  }

  // ─── Filings ──────────────────────────────────────────────────────────────
  // Static routes first; the `:id` param routes stay last (route-order safety).

  @Get("filings")
  listFilings(@Query() q: ListFilingsDto) {
    return this.filings.listFilings(q.category);
  }

  @Post("filings/prepare")
  prepare(@Body() dto: PrepareFilingDto, @CurrentUser() user: { id: string }) {
    return this.filings.prepareFiling({ ...dto, userId: user.id });
  }

  @Get("filings/:id/csv")
  downloadCsv(@Param("id") id: string) {
    return this.filings.downloadUrl(id, "csv");
  }

  @Get("filings/:id/pdf")
  downloadPdf(@Param("id") id: string) {
    return this.filings.downloadUrl(id, "pdf");
  }
}
