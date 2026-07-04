import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { AddonGuard } from "../billing/addon.guard";
import { RequireAddon } from "../billing/require-addon.decorator";
import { TobaccoService } from "./tobacco.service";
import { TobaccoReportService } from "./tobacco-report.service";
import { TobaccoRangeDto } from "./dto/tobacco-range.dto";
import { GenerateTobaccoReportDto } from "./dto/generate-tobacco-report.dto";
import { UpdateTobaccoSettingsDto } from "./dto/update-tobacco-settings.dto";

// Guard order matters: AddonGuard reads req.user (set by JwtAuthGuard)
@Controller("tobacco")
@UseGuards(JwtAuthGuard, RolesGuard, AddonGuard)
@Roles(UserRole.OPERATOR)
@RequireAddon("tobacco_dealer")
export class TobaccoController {
  constructor(
    private readonly tobaccoService: TobaccoService,
    private readonly reportService: TobaccoReportService,
  ) {}

  @Get("overview")
  getOverview(@Query("month") month?: string) {
    return this.tobaccoService.getOverview(month);
  }

  @Get("inventory")
  getInventory() {
    return this.tobaccoService.getInventory();
  }

  @Get("purchases")
  getPurchases(@Query() dto: TobaccoRangeDto) {
    return this.tobaccoService.getPurchases(dto);
  }

  @Get("sales")
  getSales(@Query() dto: TobaccoRangeDto) {
    return this.tobaccoService.getSales(dto);
  }

  @Get("monthly")
  getMonthly(@Query("year") year?: string) {
    return this.tobaccoService.getMonthlyTotals(year ? Number(year) : undefined);
  }

  // ─── Reports ────────────────────────────────────────────────────────────────

  @Get("reports")
  listReports() {
    return this.reportService.listReports();
  }

  @Post("reports/generate")
  generate(@Body() dto: GenerateTobaccoReportDto, @CurrentUser() user: { id: string }) {
    return this.reportService.generateForPeriod(dto.year, dto.month, { userId: user.id });
  }

  @Get("reports/:id/csv")
  downloadCsv(@Param("id") id: string) {
    return this.reportService.downloadUrl(id, "csv");
  }

  @Get("reports/:id/pdf")
  downloadPdf(@Param("id") id: string) {
    return this.reportService.downloadUrl(id, "pdf");
  }

  // ─── Settings ────────────────────────────────────────────────────────────────

  @Get("settings")
  getSettings() {
    return this.tobaccoService.getSettings();
  }

  @Patch("settings")
  @Roles(UserRole.TENANT_ADMIN)
  updateSettings(@Body() dto: UpdateTobaccoSettingsDto, @CurrentUser() user: { id: string }) {
    return this.tobaccoService.updateSettings(dto, user.id);
  }
}
