import {
  Controller,
  Get,
  Patch,
  Post,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { SuperAdminGuard } from "../tenant/super-admin.guard";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { PlatformAdminService } from "./platform-admin.service";
import { PlatformConfigService } from "./platform-config.service";
import { BillingService } from "../billing/billing.service";
import { AddonService } from "../billing/addon.service";
import { UpdateTenantStatusDto } from "./dto/update-tenant-status.dto";
import { UpdateTenantPlanDto } from "./dto/update-tenant-plan.dto";
import { CreateTenantDto } from "./dto/create-tenant.dto";
import { ExtendTrialDto } from "./dto/extend-trial.dto";
import { ActivateSubscriptionDto } from "./dto/activate-subscription.dto";
import { UpdateTenantConfigDto } from "./dto/update-tenant-config.dto";
import { EnableAddonDto, DisableAddonDto } from "../billing/dto/manage-addon.dto";
import type { JwtPayload } from "../auth/jwt-payload.interface";

@ApiTags("platform-admin")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, SuperAdminGuard)
@Controller("platform-admin")
export class PlatformAdminController {
  constructor(
    private readonly svc: PlatformAdminService,
    private readonly platformConfig: PlatformConfigService,
    private readonly billingService: BillingService,
    private readonly addonService: AddonService,
  ) {}

  @Get("stats")
  @ApiOperation({ summary: "Platform-wide aggregate stats" })
  getStats() {
    return this.svc.getStats();
  }

  @Get("tenants")
  @ApiOperation({ summary: "Paginated list of all tenants with stats" })
  @ApiQuery({ name: "page", required: false, type: Number })
  @ApiQuery({ name: "limit", required: false, type: Number })
  listTenants(@Query("page") page = "1", @Query("limit") limit = "20") {
    return this.svc.listTenants(Number(page), Number(limit));
  }

  @Post("tenants")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "Manually create a new tenant (admin-provisioned, starts ACTIVE)" })
  createTenant(@Body() dto: CreateTenantDto) {
    return this.svc.createTenant(dto);
  }

  @Get("tenants/:id")
  @ApiOperation({ summary: "Get a single tenant with full details" })
  getTenant(@Param("id") id: string) {
    return this.svc.getTenant(id);
  }

  @Patch("tenants/:id/config")
  @ApiOperation({ summary: "Update tenant configuration (address, phone, etc.)" })
  updateTenantConfig(@Param("id") id: string, @Body() dto: UpdateTenantConfigDto) {
    return this.svc.updateTenantConfig(id, dto);
  }

  @Delete("tenants/:id")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Soft-delete (cancel) a tenant" })
  deleteTenant(@Param("id") id: string) {
    return this.svc.deleteTenant(id);
  }

  @Patch("tenants/:id/status")
  @ApiOperation({ summary: "Suspend or reactivate a tenant" })
  updateStatus(@Param("id") id: string, @Body() dto: UpdateTenantStatusDto) {
    return this.svc.updateStatus(id, dto);
  }

  @Patch("tenants/:id/plan")
  @ApiOperation({ summary: "Change a tenant's plan" })
  updatePlan(@Param("id") id: string, @Body() dto: UpdateTenantPlanDto) {
    return this.svc.updatePlan(id, dto);
  }

  @Post("tenants/:id/impersonate")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Issue a 15-min read-only impersonation token for a tenant.",
  })
  impersonate(@Param("id") id: string, @CurrentUser() admin: JwtPayload) {
    return this.svc.impersonate(id, admin.sub);
  }

  @Post("tenants/:id/extend-trial")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Extend tenant trial period by N days from now" })
  extendTrial(@Param("id") id: string, @Body() dto: ExtendTrialDto) {
    return this.svc.extendTrial(id, dto.days);
  }

  @Post("tenants/:id/activate-subscription")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Manually activate a tenant subscription via external payment (Zelle, bank transfer, check, etc.)",
  })
  activateManualSubscription(@Param("id") id: string, @Body() dto: ActivateSubscriptionDto) {
    return this.svc.activateManualSubscription(id, dto);
  }

  @Post("tenants/:id/reset-admin-password")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Reset the TENANT_ADMIN password and force change on next login" })
  resetAdminPassword(@Param("id") id: string) {
    return this.svc.resetTenantAdminPassword(id);
  }

  @Get("tenants/:id/admin")
  @ApiOperation({ summary: "Get the TENANT_ADMIN user info for a tenant (null if none)" })
  getTenantAdmin(@Param("id") id: string) {
    return this.svc.getTenantAdmin(id);
  }

  @Post("tenants/:id/admin")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "Create a TENANT_ADMIN account for a tenant that has none" })
  createTenantAdmin(
    @Param("id") id: string,
    @Body() dto: { username: string; email: string; password?: string },
  ) {
    return this.svc.createTenantAdmin(id, dto);
  }

  @Get("stats/growth")
  @ApiOperation({ summary: "Monthly tenant creation counts for charts" })
  @ApiQuery({ name: "months", required: false, type: Number })
  getGrowthStats(@Query("months") months = "12") {
    return this.svc.getGrowthStats(Number(months));
  }

  @Get("billing/overview")
  @ApiOperation({ summary: "Aggregated billing/subscription overview" })
  getBillingOverview() {
    return this.svc.getBillingOverview();
  }

  @Get("audit-logs")
  @ApiOperation({ summary: "Platform-wide audit log with filters" })
  @ApiQuery({ name: "tenantId", required: false })
  @ApiQuery({ name: "action", required: false })
  @ApiQuery({ name: "entityType", required: false })
  @ApiQuery({ name: "userId", required: false })
  @ApiQuery({ name: "from", required: false })
  @ApiQuery({ name: "to", required: false })
  @ApiQuery({ name: "page", required: false, type: Number })
  @ApiQuery({ name: "limit", required: false, type: Number })
  getAuditLogs(
    @Query("tenantId") tenantId?: string,
    @Query("action") action?: string,
    @Query("entityType") entityType?: string,
    @Query("userId") userId?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("page") page = "1",
    @Query("limit") limit = "50",
  ) {
    return this.svc.getAuditLogs(
      {
        tenantId: tenantId || null,
        action: action || null,
        entityType: entityType || null,
        userId: userId || null,
        from: from || null,
        to: to || null,
      },
      Number(page),
      Number(limit),
    );
  }

  // ─── Billing ──────────────────────────────────────────────────────────────

  @Get("tenants/:id/billing")
  @ApiOperation({ summary: "Get billing info for a tenant (Stripe subscription, plan, etc.)" })
  getTenantBilling(@Param("id") id: string) {
    return this.billingService.getTenantBillingInfo(id);
  }

  @Post("tenants/:id/billing/checkout")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Generate a Stripe Checkout link for a tenant to subscribe" })
  createCheckout(@Param("id") id: string) {
    return this.billingService.createCheckoutSession(id);
  }

  @Post("tenants/:id/billing/portal")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Generate a Stripe Billing Portal link for a tenant" })
  createPortal(@Param("id") id: string) {
    return this.billingService.createBillingPortalSession(id);
  }

  // ─── Add-ons ──────────────────────────────────────────────────────────────

  @Get("tenants/:id/addons")
  @ApiOperation({ summary: "List all add-ons for a tenant" })
  listAddons(@Param("id") id: string) {
    return this.addonService.listAddons(id);
  }

  @Post("tenants/:id/addons/enable")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Enable an add-on feature for a tenant" })
  enableAddon(@Param("id") id: string, @Body() dto: EnableAddonDto) {
    return this.addonService.enableAddon(id, dto.addonKey, dto.stripePriceId);
  }

  @Post("tenants/:id/addons/disable")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Disable an add-on feature for a tenant" })
  disableAddon(@Param("id") id: string, @Body() dto: DisableAddonDto) {
    return this.addonService.disableAddon(id, dto.addonKey);
  }

  // ─── Platform AI Configuration ────────────────────────────────────────────

  @Get("ai-config")
  @ApiOperation({ summary: "Get platform-wide Claude AI configuration" })
  getAiConfig() {
    return this.platformConfig.getAiConfig();
  }

  @Patch("ai-config")
  @ApiOperation({ summary: "Update platform-wide Claude AI configuration" })
  updateAiConfig(
    @Body() dto: { apiKey?: string; model?: string; maxTokens?: number },
  ) {
    return this.platformConfig.updateAiConfig(dto);
  }
}
