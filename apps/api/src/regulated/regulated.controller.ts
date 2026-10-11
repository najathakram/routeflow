import { Body, Controller, Get, Param, Post, Query, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { AddonGuard } from "../billing/addon.guard";
import { RequireAddon } from "../billing/require-addon.decorator";
import { RegulatedService } from "./regulated.service";
import { RegulatedFilingService } from "./regulated-filing.service";
import { RegulatedReportService } from "./regulated-report.service";
import { ParkedReversalResolutionService } from "./parked-reversal-resolution.service";
import { ListLedgerDto } from "./dto/list-ledger.dto";
import { ListFilingsDto } from "./dto/list-filings.dto";
import { PrepareFilingDto } from "./dto/prepare-filing.dto";
import { LockFilingDto } from "./dto/lock-filing.dto";
import { ReportQueryDto } from "./dto/report-query.dto";
import { ResolveParkedReversalDto } from "./dto/resolve-parked-reversal.dto";
import { REPORT_TEMPLATES } from "./template-registry";

// Categorization stays free; the LEDGER/FILINGS/REPORTS surfaces are the
// Regulated compliance pack, gated on the tobacco_dealer addon (bridged to the
// REGULATED_ITEMS SKU). GET /templates stays ungated — the free product forms
// read it. Guard order matters: AddonGuard reads req.user (set by JwtAuthGuard).
@Controller("regulated")
@UseGuards(JwtAuthGuard, RolesGuard, AddonGuard)
@Roles(UserRole.OPERATOR)
export class RegulatedController {
  constructor(
    private readonly regulated: RegulatedService,
    private readonly filings: RegulatedFilingService,
    private readonly reports: RegulatedReportService,
    private readonly parkedReversals: ParkedReversalResolutionService,
  ) {}

  @Get("ledger")
  @RequireAddon("tobacco_dealer")
  getLedger(@Query() query: ListLedgerDto) {
    return this.regulated.getLedger(query);
  }

  // ─── Reports (WP11) ──────────────────────────────────────────────────────
  // Stateless: computed on demand, nothing persisted (filings below remain the
  // compliance archive). Static routes first, registered above `filings/:id/...`
  // so the static segment always wins — same route-order convention as Filings.

  /** Report-template metadata (vocabulary + column supersets) for the config UIs. */
  @Get("templates")
  getTemplates() {
    return REPORT_TEMPLATES;
  }

  @Get("reports/preview")
  @RequireAddon("tobacco_dealer")
  previewReport(@Query() query: ReportQueryDto) {
    return this.reports.buildReport(query);
  }

  @Get("reports/csv")
  @RequireAddon("tobacco_dealer")
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
  @RequireAddon("tobacco_dealer")
  listFilings(@Query() q: ListFilingsDto) {
    return this.filings.listFilings(q.category);
  }

  @Post("filings/prepare")
  @RequireAddon("tobacco_dealer")
  prepare(@Body() dto: PrepareFilingDto, @CurrentUser() user: { id: string }) {
    return this.filings.prepareFiling({ ...dto, userId: user.id });
  }

  // B297 PR5: lock a generated filing for a period that has ended. Tenant admin only; the reason is
  // required and audited; there is no unlock. After `filings/prepare` and before the `:id` downloads.
  @Post("filings/:id/lock")
  @Roles(UserRole.TENANT_ADMIN)
  @RequireAddon("tobacco_dealer")
  lockFiling(@Param("id") id: string, @Body() dto: LockFilingDto, @CurrentUser() user: JwtPayload) {
    return this.filings.lockFiling(id, { userId: user.sub, reason: dto.reason });
  }

  @Get("filings/:id/csv")
  @RequireAddon("tobacco_dealer")
  downloadCsv(@Param("id") id: string) {
    return this.filings.downloadUrl(id, "csv");
  }

  @Get("filings/:id/pdf")
  @RequireAddon("tobacco_dealer")
  downloadPdf(@Param("id") id: string) {
    return this.filings.downloadUrl(id, "pdf");
  }

  // ─── Parked reversals (SA-089/B660 PR B) ────────────────────────────────────
  // A return's regulated-ledger reversal that couldn't be classified box/piece-axis at
  // capture time (B681/SA-067(3)) blocks its period's filing until an operator resolves it
  // with the sold line's actual pack. Mirrors returns.controller.ts's parked-restocks routes.

  @Get("parked-reversals")
  @Roles(UserRole.OPERATOR, UserRole.TENANT_ADMIN)
  @RequireAddon("tobacco_dealer")
  listParkedReversals() {
    return this.parkedReversals.list();
  }

  @Post("parked-reversals/:id/resolve")
  @Roles(UserRole.OPERATOR, UserRole.TENANT_ADMIN)
  @RequireAddon("tobacco_dealer")
  resolveParkedReversal(
    @Param("id") id: string,
    @Body() dto: ResolveParkedReversalDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.parkedReversals.resolve(id, dto.pack, dto.reason, { id: user.sub });
  }
}
