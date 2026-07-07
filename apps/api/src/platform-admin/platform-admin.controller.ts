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
import { AdminAuditAction } from "./audit-actions.constant";
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
  @ApiOperation({ summary: "Paginated, filterable, sortable list of all tenants with stats" })
  @ApiQuery({ name: "page", required: false, type: Number })
  @ApiQuery({ name: "limit", required: false, type: Number })
  @ApiQuery({ name: "search", required: false })
  @ApiQuery({ name: "status", required: false })
  @ApiQuery({ name: "plan", required: false })
  @ApiQuery({
    name: "sortKey",
    required: false,
    enum: ["slug", "name", "status", "plan", "users", "createdAt"],
  })
  @ApiQuery({ name: "sortDir", required: false, enum: ["asc", "desc"] })
  @ApiQuery({ name: "includeDeleted", required: false, type: Boolean })
  listTenants(
    @Query("page") page = "1",
    @Query("limit") limit = "20",
    @Query("search") search?: string,
    @Query("status") status?: string,
    @Query("plan") plan?: string,
    @Query("sortKey") sortKey?: string,
    @Query("sortDir") sortDir?: string,
    @Query("includeDeleted") includeDeleted?: string,
  ) {
    return this.svc.listTenants(Number(page), Number(limit), {
      search: search || null,
      status: status || null,
      plan: plan || null,
      sortKey: sortKey || null,
      sortDir: sortDir === "asc" ? "asc" : sortDir === "desc" ? "desc" : null,
      includeDeleted: includeDeleted === "true" || includeDeleted === "1",
    });
  }

  @Post("tenants")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "Manually create a new tenant (admin-provisioned, starts ACTIVE)" })
  createTenant(@Body() dto: CreateTenantDto, @CurrentUser() admin: JwtPayload) {
    return this.svc.createTenant(dto, admin.sub);
  }

  @Get("tenants/:id")
  @ApiOperation({ summary: "Get a single tenant with full details" })
  getTenant(@Param("id") id: string) {
    return this.svc.getTenant(id);
  }

  @Patch("tenants/:id/config")
  @ApiOperation({ summary: "Update tenant configuration (address, phone, etc.)" })
  updateTenantConfig(
    @Param("id") id: string,
    @Body() dto: UpdateTenantConfigDto,
    @CurrentUser() admin: JwtPayload,
  ) {
    return this.svc.updateTenantConfig(id, dto, admin.sub);
  }

  @Delete("tenants/:id")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Soft-delete (cancel) a tenant" })
  deleteTenant(@Param("id") id: string, @CurrentUser() admin: JwtPayload) {
    return this.svc.deleteTenant(id, admin.sub);
  }

  @Patch("tenants/:id/status")
  @ApiOperation({ summary: "Suspend or reactivate a tenant" })
  updateStatus(
    @Param("id") id: string,
    @Body() dto: UpdateTenantStatusDto,
    @CurrentUser() admin: JwtPayload,
  ) {
    return this.svc.updateStatus(id, dto, admin.sub);
  }

  @Patch("tenants/:id/plan")
  @ApiOperation({ summary: "Change a tenant's plan" })
  updatePlan(
    @Param("id") id: string,
    @Body() dto: UpdateTenantPlanDto,
    @CurrentUser() admin: JwtPayload,
  ) {
    return this.svc.updatePlan(id, dto, admin.sub);
  }

  @Post("tenants/:id/impersonate")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Issue a 15-min impersonation token for a tenant (writes are audit-logged).",
  })
  impersonate(@Param("id") id: string, @CurrentUser() admin: JwtPayload) {
    return this.svc.impersonate(id, admin.sub);
  }

  @Post("tenants/:id/extend-trial")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Extend tenant trial period by N days from now" })
  extendTrial(
    @Param("id") id: string,
    @Body() dto: ExtendTrialDto,
    @CurrentUser() admin: JwtPayload,
  ) {
    return this.svc.extendTrial(id, dto.days, admin.sub);
  }

  @Post("tenants/:id/activate-subscription")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Manually activate a tenant subscription via external payment (Zelle, bank transfer, check, etc.)",
  })
  activateManualSubscription(
    @Param("id") id: string,
    @Body() dto: ActivateSubscriptionDto,
    @CurrentUser() admin: JwtPayload,
  ) {
    return this.svc.activateManualSubscription(id, dto, admin.sub);
  }

  @Post("tenants/:id/reset-admin-password")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Reset the TENANT_ADMIN password and force change on next login" })
  resetAdminPassword(@Param("id") id: string, @CurrentUser() admin: JwtPayload) {
    return this.svc.resetTenantAdminPassword(id, admin.sub);
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
    @CurrentUser() admin: JwtPayload,
  ) {
    return this.svc.createTenantAdmin(id, dto, admin.sub);
  }

  @Get("stats/growth")
  @ApiOperation({ summary: "Monthly tenant creation counts for charts" })
  @ApiQuery({ name: "months", required: false, type: Number })
  getGrowthStats(@Query("months") months = "12") {
    return this.svc.getGrowthStats(Number(months));
  }

  @Get("billing/overview")
  @ApiOperation({
    summary: "Billing/subscription overview: MRR rollup + filterable, paginated subs",
  })
  @ApiQuery({ name: "page", required: false, type: Number })
  @ApiQuery({ name: "limit", required: false, type: Number })
  @ApiQuery({ name: "plan", required: false })
  @ApiQuery({ name: "status", required: false })
  getBillingOverview(
    @Query("page") page = "1",
    @Query("limit") limit = "20",
    @Query("plan") plan?: string,
    @Query("status") status?: string,
  ) {
    return this.svc.getBillingOverview({
      page: Number(page),
      limit: Number(limit),
      plan: plan || null,
      status: status || null,
    });
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

  @Get("audit-logs/facets")
  @ApiOperation({ summary: "Known admin audit action codes + labels for filter dropdowns" })
  getAuditLogFacets() {
    return this.svc.getAuditLogFacets();
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
  async enableAddon(
    @Param("id") id: string,
    @Body() dto: EnableAddonDto,
    @CurrentUser() admin: JwtPayload,
  ) {
    const result = await this.addonService.enableAddon(id, dto.addonKey, dto.stripePriceId);
    await this.svc.recordAdminAction(id, admin.sub, AdminAuditAction.ADDON_ENABLED, {
      addonKey: dto.addonKey,
    });
    return result;
  }

  @Post("tenants/:id/addons/disable")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Disable an add-on feature for a tenant" })
  async disableAddon(
    @Param("id") id: string,
    @Body() dto: DisableAddonDto,
    @CurrentUser() admin: JwtPayload,
  ) {
    const result = await this.addonService.disableAddon(id, dto.addonKey);
    await this.svc.recordAdminAction(id, admin.sub, AdminAuditAction.ADDON_DISABLED, {
      addonKey: dto.addonKey,
    });
    return result;
  }

  // ─── Platform AI Configuration ────────────────────────────────────────────

  @Get("ai-config")
  @ApiOperation({ summary: "Get platform-wide Claude AI configuration" })
  getAiConfig() {
    return this.platformConfig.getAiConfig();
  }

  @Patch("ai-config")
  @ApiOperation({ summary: "Update platform-wide Claude AI configuration" })
  updateAiConfig(@Body() dto: { apiKey?: string; model?: string; maxTokens?: number }) {
    return this.platformConfig.updateAiConfig(dto);
  }
}
