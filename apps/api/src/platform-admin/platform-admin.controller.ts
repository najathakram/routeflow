import {
  Controller,
  Get,
  Patch,
  Post,
  Put,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
  ConflictException,
  NotFoundException,
  ParseUUIDPipe,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { SuperAdminGuard } from "../tenant/super-admin.guard";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { PlatformAdminService } from "./platform-admin.service";
import { PlatformConfigService } from "./platform-config.service";
import { BillingService } from "../billing/billing.service";
import { AddonService } from "../billing/addon.service";
import { FeatureOverrideService } from "../billing/feature-override.service";
import { UpdateTenantStatusDto } from "./dto/update-tenant-status.dto";
import { UpdateTenantPlanDto } from "./dto/update-tenant-plan.dto";
import { CreateTenantDto } from "./dto/create-tenant.dto";
import { CreateTenantAdminDto } from "./dto/create-tenant-admin.dto";
import { ExtendTrialDto } from "./dto/extend-trial.dto";
import { ActivateSubscriptionDto } from "./dto/activate-subscription.dto";
import { UpdateTenantConfigDto } from "./dto/update-tenant-config.dto";
import { UpdateTenantPriceDto } from "./dto/update-tenant-price.dto";
import { UpdatePlanPricesDto } from "./dto/update-plan-prices.dto";
import { UpdateTenantClassDto } from "./dto/update-tenant-class.dto";
import { EnableAddonDto, DisableAddonDto, UncompAddonDto } from "../billing/dto/manage-addon.dto";
import { CreateFeatureOverrideDto } from "./dto/manage-feature-override.dto";
import { SetEntitlementsModeDto } from "./dto/set-entitlements-mode.dto";
import { SetConfigSnapshotFlagDto } from "./dto/set-config-snapshot-flag.dto";
import { ExplainFeatureDiffDto } from "./dto/explain-feature-diff.dto";
import { FEATURE_REGISTRY } from "../billing/feature-registry";
import { EntitlementsModeService } from "../billing/entitlements-mode.service";
import { ConfigSnapshotFlagService } from "../billing/config-snapshot-flag.service";
import { FeatureDiffService } from "../billing/feature-diff.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { FeaturePreviewService } from "../billing/feature-preview.service";
import { TenantConfigSnapshotAdminService } from "../billing/tenant-config-snapshot-admin.service";
import { toEffectiveFeature } from "../billing/feature-resolver.service";
import type {
  AppLinks,
  AppLinksPatch,
  EffectiveFeature,
  FeatureModeState,
  FeaturePreviewRequest,
} from "@routeflow/types";
import { AdminAuditAction } from "./audit-actions.constant";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { API_ERROR_CODES } from "../common/api-error-codes";
import {
  BusinessProfileService,
  type BusinessProfileResolution,
} from "../billing/business-profile.service";
import { FeatureConfigService } from "../billing/feature-config.service";
import {
  ApplyBusinessProfileDto,
  ConfirmBusinessProfileDto,
} from "./dto/apply-business-profile.dto";
import {
  BusinessCapabilitiesDto,
  ConfirmBusinessCapabilitiesDto,
} from "./dto/business-capabilities.dto";
import type {
  BusinessCapabilitiesApplyResponse,
  BusinessCapabilitiesPreviewResponse,
  BusinessProfileApplyResponse,
  BusinessProfileBillingFailedAddon,
  BusinessCapabilities,
  BusinessProfileListResponse,
  BusinessProfilePreviewResponse,
} from "@routeflow/types";

/** Attach a config key's applied mode to its explain-trace row (B1132); no mode, no change. */
function withConfigMode(feature: EffectiveFeature, mode?: FeatureModeState): EffectiveFeature {
  return mode ? { ...feature, mode } : feature;
}

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
    private readonly featureOverrides: FeatureOverrideService,
    private readonly entitlementsMode: EntitlementsModeService,
    private readonly configSnapshotFlag: ConfigSnapshotFlagService,
    private readonly featureDiffs: FeatureDiffService,
    private readonly authority: EntitlementAuthority,
    private readonly featurePreview: FeaturePreviewService,
    private readonly snapshotAdmin: TenantConfigSnapshotAdminService,
    private readonly businessProfiles: BusinessProfileService,
    private readonly featureConfig: FeatureConfigService,
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

  @Patch("tenants/:id/class")
  @ApiOperation({ summary: "Change a tenant's classification (production/demo/test/internal)" })
  updateTenantClass(
    @Param("id") id: string,
    @Body() dto: UpdateTenantClassDto,
    @CurrentUser() admin: JwtPayload,
  ) {
    return this.svc.updateTenantClass(id, dto, admin.sub);
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

  @Get("tenants/:id/entitlements")
  @ApiOperation({
    summary: "Resolved entitlements (flags/addons/caps/planKey) + live meter usage for a tenant",
  })
  getTenantEntitlements(@Param("id") id: string) {
    return this.svc.getTenantEntitlements(id);
  }

  @Post("tenants/:id/admin")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "Create a TENANT_ADMIN account for a tenant that has none" })
  createTenantAdmin(
    @Param("id") id: string,
    @Body() dto: CreateTenantAdminDto,
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
  @ApiOperation({
    summary: "Generate a Stripe Checkout link for a tenant to subscribe",
    description: 'Optional JSON body: { interval?: "month" | "year" } — defaults to month.',
  })
  createCheckout(@Param("id") id: string, @Body("interval") interval?: "month" | "year") {
    return this.billingService.createCheckoutSession(id, interval === "year" ? "year" : "month");
  }

  @Post("tenants/:id/billing/portal")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Generate a Stripe Billing Portal link for a tenant" })
  createPortal(@Param("id") id: string) {
    return this.billingService.createBillingPortalSession(id);
  }

  @Get("tenants/:id/billing/pricing")
  @ApiOperation({
    summary: "Resolved pricing for a tenant (catalog or custom override) + live subscription state",
  })
  getTenantPricing(@Param("id") id: string) {
    return this.svc.getTenantPricing(id);
  }

  @Patch("tenants/:id/billing/price-override")
  @ApiOperation({
    summary: "Set or clear a tenant's custom price override; syncs any live Stripe subscription",
  })
  updateTenantPriceOverride(
    @Param("id") id: string,
    @Body() dto: UpdateTenantPriceDto,
    @CurrentUser() admin: JwtPayload,
  ) {
    return this.svc.updateTenantPriceOverride(id, dto, admin.sub);
  }

  @Patch("plans/:planKey/prices")
  @ApiOperation({
    summary:
      "Edit the current catalog price for a plan key; fans out to matching live subscriptions",
  })
  updatePlanPrices(
    @Param("planKey") planKey: string,
    @Body() dto: UpdatePlanPricesDto,
    @CurrentUser() admin: JwtPayload,
  ) {
    return this.svc.updatePlanPrices(planKey, dto, admin.sub);
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
    // SA-693: `comp` is read from the DTO only, never inferred from the absence of a price.
    const comp = dto.comp === true;
    const result = await this.addonService.enableAddon(
      id,
      dto.addonKey,
      dto.stripePriceId,
      dto.acknowledgeUnmetRequires,
      { comp },
    );
    if (comp) {
      // One audit row per action: a comp is ADDON_COMPED (actor = userId, plus the optional reason).
      await this.svc.recordAdminAction(id, admin.sub, AdminAuditAction.ADDON_COMPED, {
        addonKey: dto.addonKey,
        acknowledgeUnmetRequires: dto.acknowledgeUnmetRequires ?? false,
        ...(dto.reason ? { reason: dto.reason } : {}),
      });
      return result;
    }
    await this.svc.recordAdminAction(id, admin.sub, AdminAuditAction.ADDON_ENABLED, {
      addonKey: dto.addonKey,
      // B524: see the matching note on createFeatureOverride's audit payload.
      acknowledgeUnmetRequires: dto.acknowledgeUnmetRequires ?? false,
    });
    return result;
  }

  @Post("tenants/:id/addons/uncomp")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Turn a comp add-on back into a normal one. Never silently bills: flag-only without a Stripe " +
      "subscription; with one, goes through the billed enable (stripePriceId required)",
  })
  async uncompAddon(
    @Param("id") id: string,
    @Body() dto: UncompAddonDto,
    @CurrentUser() admin: JwtPayload,
  ) {
    const result = await this.addonService.uncompAddon(id, dto.addonKey, dto.stripePriceId);
    await this.svc.recordAdminAction(id, admin.sub, AdminAuditAction.ADDON_UNCOMPED, {
      addonKey: dto.addonKey,
      // The mode the service ACTUALLY took (STRIPE / MANUAL / UNBILLED), never inferred from the DTO:
      // a price id can ride along on a call that only flipped the flag.
      billing: result.billing,
      ...(dto.reason ? { reason: dto.reason } : {}),
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

  // ─── Feature overrides ────────────────────────────────────────────────────

  @Get("features/registry")
  @ApiOperation({ summary: "The full feature registry — FeatureRegistryRow[] (design contract)" })
  listFeatureRegistry() {
    return FEATURE_REGISTRY.map((f) => ({
      key: f.key,
      kind: f.kind,
      area: f.area,
      label: f.label,
      description: f.description,
      lifecycle: f.gate.state === "dark" ? "beta" : "ga",
      internal: f.internal ?? false,
      // Opus review of 8130b204, item 2: `via` lets the web warn before creating an override
      // that has no wired consultation point. "none" is a verified-no-gate key by definition
      // (catalog metadata only) -- an override there can never have any effect.
      gate: { via: f.gate.via, state: f.gate.state },
      billing: { skus: [...f.billing.skus] },
      // B519: the console needs this to warn before enabling a key whose prerequisites
      // aren't met — verbatim from the registry, never a client-side mirror.
      ...(f.requires
        ? {
            requires: {
              ...(f.requires.allOf ? { allOf: [...f.requires.allOf] } : {}),
              ...(f.requires.anyOf ? { anyOf: [...f.requires.anyOf] } : {}),
            },
          }
        : {}),
      ...(f.config
        ? {
            config: {
              fallbackMode: f.config.fallbackMode,
              modes: Object.entries(f.config.modes).map(([key, m]) => ({
                key,
                label: m.label,
                lifecycle: "ga" as const,
                ...(m.requires?.allOf ? { requires: [...m.requires.allOf] } : {}),
              })),
            },
          }
        : {}),
    }));
  }

  // ─── Feature grants v2 brief A (design 2026-09-17 §2): shadow/live switch + diff log ───────

  @Get("entitlements/mode")
  @ApiOperation({ summary: "The global shadow/live entitlements-resolver switch" })
  async getEntitlementsMode() {
    return { mode: await this.entitlementsMode.getMode() };
  }

  @Put("entitlements/mode")
  @ApiOperation({
    summary:
      "Switch shadow/live. live refuses (409) while any diff row is unexplained, unless force+reason.",
  })
  async setEntitlementsMode(@Body() dto: SetEntitlementsModeDto, @CurrentUser() admin: JwtPayload) {
    if (dto.mode === "live") {
      const hasUnexplained = await this.featureDiffs.hasUnexplained();
      if (hasUnexplained && !(dto.force && dto.reason)) {
        throw new ConflictException({
          statusCode: 409,
          code: API_ERROR_CODES.UNEXPLAINED_DIFFS,
          message:
            "Unexplained FeatureResolverDiff rows exist — explain them, or pass {force:true, reason} to override.",
        });
      }
    }
    await this.entitlementsMode.setMode(dto.mode);
    await this.svc.recordAdminAction(null, admin.sub, AdminAuditAction.ENTITLEMENTS_MODE_CHANGED, {
      mode: dto.mode,
      force: dto.force ?? false,
      reason: dto.reason ?? null,
    });
    return { mode: dto.mode };
  }

  // ─── Config snapshot flag (Lane B A2c) ────────────────────────────────────
  // One of the four production flags an agent never flips — read-only for anyone but the owner,
  // who calls PUT directly. GET never mutates. Every PUT is audited with the actor and reason,
  // regardless of the resulting value.

  @Get("entitlements/config-snapshot")
  @ApiOperation({
    summary:
      "Whether automatic config snapshot/restore on plan changes is switched on (default OFF)",
  })
  async getConfigSnapshotFlag() {
    return { enabled: await this.configSnapshotFlag.isEnabled() };
  }

  @Put("entitlements/config-snapshot")
  @ApiOperation({
    summary:
      "Switch automatic config snapshot/restore on plan changes on/off — live, no redeploy, effective across replicas within ~5 s. Audited with the reason and the actor.",
  })
  async setConfigSnapshotFlag(
    @Body() dto: SetConfigSnapshotFlagDto,
    @CurrentUser() admin: JwtPayload,
  ) {
    // The cache can be up to ~5 s stale — force a real database read before recording the
    // flip, so the audit row's `previous` is the flag's actual last-committed value, not a
    // possibly-stale cached one from before another replica's write.
    this.configSnapshotFlag.invalidate();
    const previous = await this.configSnapshotFlag.isEnabled();
    await this.configSnapshotFlag.setEnabled(dto.enabled);
    await this.svc.recordAdminAction(
      null,
      admin.sub,
      AdminAuditAction.CONFIG_SNAPSHOT_FLAG_CHANGED,
      { previous, enabled: dto.enabled, reason: dto.reason },
    );
    return { enabled: dto.enabled };
  }

  @Get("features/diffs")
  @ApiOperation({ summary: "Shadow-mode disagreements between the old path and the resolver" })
  @ApiQuery({ name: "tenantId", required: false })
  @ApiQuery({ name: "unexplainedOnly", required: false, type: Boolean })
  listFeatureDiffs(
    @Query("tenantId") tenantId?: string,
    @Query("unexplainedOnly") unexplainedOnly?: string,
  ) {
    return this.featureDiffs.list({
      tenantId: tenantId || undefined,
      unexplainedOnly: unexplainedOnly === "true" || unexplainedOnly === "1",
    });
  }

  @Post("features/diffs/:id/explain")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Record why a diff row is expected, unblocking the live switch" })
  async explainFeatureDiff(
    @Param("id") id: string,
    @Body() dto: ExplainFeatureDiffDto,
    @CurrentUser() admin: JwtPayload,
  ) {
    const result = await this.featureDiffs.explain(id, dto.explanation);
    await this.svc.recordAdminAction(null, admin.sub, AdminAuditAction.FEATURE_DIFF_EXPLAINED, {
      diffId: id,
    });
    return result;
  }

  @Get("tenants/:id/features/effective")
  @ApiOperation({ summary: "Every registry key's resolved verdict for one tenant (explain trace)" })
  async getTenantFeaturesEffective(@Param("id") id: string) {
    const [resolved, oldPathByKey, mode] = await Promise.all([
      this.authority.resolveAll(id),
      this.authority.computeOldPathAll(id),
      this.entitlementsMode.getMode(),
    ]);
    if (!resolved) {
      return { effective: [], computedAt: new Date().toISOString(), unavailable: true };
    }
    const modes = await this.configModesByKey(id);
    return {
      effective: FEATURE_REGISTRY.map((f) => {
        const entry = resolved.byKey.get(f.key)!;
        // Opus review of 9923b87c, item 5: `serving` is the OLD PATH's verdict (what's
        // actually applied while entitlements.mode is "shadow"), not the resolver's own
        // value — those two only coincide by construction, and the whole point of the
        // explain trace is to show where they diverge. `enforced` reflects the REAL mode:
        // true only once "live" makes the resolver's verdict the one that's applied.
        const serving = oldPathByKey.get(f.key) ?? entry.effective;
        return withConfigMode(
          toEffectiveFeature(
            entry,
            serving,
            resolved.planKey,
            resolved.catalogVersionId,
            mode === "live",
          ),
          modes.get(f.key),
        );
      }),
      computedAt: resolved.computedAt,
    };
  }

  @Get("tenants/:id/features/effective/:key")
  @ApiOperation({ summary: "One registry key's resolved verdict for one tenant (explain trace)" })
  async getTenantFeatureEffective(@Param("id") id: string, @Param("key") key: string) {
    const [resolved, oldPathByKey, mode] = await Promise.all([
      this.authority.resolveAll(id),
      this.authority.computeOldPathAll(id),
      this.entitlementsMode.getMode(),
    ]);
    if (!resolved) return { key, unavailable: true };
    const entry = resolved.byKey.get(key);
    if (!entry) throw new NotFoundException(`"${key}" is not a registered feature key.`);
    const serving = oldPathByKey.get(key) ?? entry.effective;
    const modes = await this.configModesByKey(id, key);
    return withConfigMode(
      toEffectiveFeature(
        entry,
        serving,
        resolved.planKey,
        resolved.catalogVersionId,
        mode === "live",
      ),
      modes.get(key),
    );
  }

  /**
   * B1132: the tenant's applied mode for every config-bearing registry key (or just `only`), from
   * `FeatureConfigService.getState`, the SAME read behind `GET .../feature-config/:key` that the
   * Setup tab's "Current setup" card shows, so the console row can never disagree with it. A failed
   * read leaves that key without a `mode` (the console falls back to its plain row) rather than
   * failing the whole explain trace.
   */
  private async configModesByKey(
    tenantId: string,
    only?: string,
  ): Promise<Map<string, FeatureModeState>> {
    const keys = FEATURE_REGISTRY.filter((f) => f.config && (only === undefined || f.key === only));
    const states = await Promise.all(
      keys.map(async (f) => {
        try {
          return [f.key, await this.featureConfig.getState(tenantId, f.key)] as const;
        } catch {
          return null;
        }
      }),
    );
    return new Map(states.filter((e): e is NonNullable<typeof e> => e !== null));
  }

  @Post("tenants/:id/features/preview")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Before/after per key for a hypothetical plan/override/mode change — writes nothing",
  })
  previewTenantFeatures(@Param("id") id: string, @Body() body: FeaturePreviewRequest) {
    return this.featurePreview.preview(id, body ?? {});
  }

  @Get("tenants/:id/feature-overrides")
  @ApiOperation({ summary: "List all feature overrides for a tenant (including revoked/expired)" })
  listFeatureOverrides(@Param("id") id: string) {
    return this.featureOverrides.list(id);
  }

  @Post("tenants/:id/feature-overrides")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: "Grant or deny a tenant a specific feature key, overriding its plan/addon state",
  })
  async createFeatureOverride(
    @Param("id") id: string,
    @Body() dto: CreateFeatureOverrideDto,
    @CurrentUser() admin: JwtPayload,
  ) {
    // B524: enforces the registry key's `requires` (allOf/anyOf) for a GRANT — DENY is never
    // checked (denying something has no prerequisite to satisfy). The actual check is
    // `EntitlementAuthority.assertFeatureRequiresMet`, shared with `AddonService.enableAddon`'s
    // identical guard — see that method's own doc for why it isn't inside
    // `FeatureOverrideService.create` itself (a real DI cycle) and why calling it from here
    // instead is safe only as long as this controller stays the ONE caller of `.create()` —
    // `feature-override-single-caller.spec.ts` (billing/) is the static guard for that.
    if (dto.effect === "GRANT") {
      await this.authority.assertFeatureRequiresMet(
        id,
        dto.featureKey,
        dto.acknowledgeUnmetRequires,
      );
    }
    const result = await this.featureOverrides.create({
      tenantId: id,
      featureKey: dto.featureKey,
      effect: dto.effect,
      kind: dto.kind,
      reason: dto.reason,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
      createdById: admin.sub,
    });
    // B524 fix round (Opus review finding F1): `FeatureOverrideService.create` only
    // invalidates its OWN 30s override cache (`allActive()`), never the resolver's separate
    // 30s cache layered on top — so a GRANT here that unblocks a `requires` check on a
    // SUBSEQUENT call (e.g. enabling `driver_payments` right after granting its prerequisite)
    // could read the pre-grant snapshot and 400 for up to 30s. Mirrors the B509 fix
    // `AddonService.enableAddon`/`disableAddon` already apply to themselves.
    this.authority.invalidate(id);
    await this.svc.recordAdminAction(id, admin.sub, AdminAuditAction.FEATURE_OVERRIDE_SET, {
      featureKey: dto.featureKey,
      effect: dto.effect,
      // result.kind (not dto.kind): the row's actual persisted value, so an omitted `kind`
      // still audits the true default (COMP) rather than `undefined`.
      kind: result.kind,
      reason: dto.reason,
      expiresAt: dto.expiresAt ?? null,
      // B524: the audit trail must show whether this write is one B524 would otherwise have
      // blocked — "who granted an inconsistent entitlement and did they knowingly override
      // the check" is exactly the question this field answers.
      acknowledgeUnmetRequires: dto.acknowledgeUnmetRequires ?? false,
    });
    return result;
  }

  @Post("tenants/:id/feature-overrides/:overrideId/revoke")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Revoke a tenant feature override (immediate — history is kept)" })
  async revokeFeatureOverride(
    @Param("id") id: string,
    @Param("overrideId") overrideId: string,
    @CurrentUser() admin: JwtPayload,
  ) {
    const result = await this.featureOverrides.revoke(id, overrideId);
    // B524 fix round (F1) — same resolver-cache staleness as createFeatureOverride above,
    // in the other direction: a revoke that removes a `requires` prerequisite must be visible
    // to the NEXT grant attempt immediately, not up to 30s later.
    this.authority.invalidate(id);
    await this.svc.recordAdminAction(id, admin.sub, AdminAuditAction.FEATURE_OVERRIDE_REVOKED, {
      overrideId,
    });
    return result;
  }

  // ─── Business profiles ─────────────────────────────────────────────────────
  // Every route here inherits the class-level SuperAdminGuard: tenant roles are refused.

  @Get("business-profiles")
  @ApiOperation({ summary: "The business profiles a platform admin can apply to a tenant" })
  listBusinessProfiles(): BusinessProfileListResponse {
    return this.businessProfiles.list();
  }

  @Get("tenants/:id/business-capabilities")
  @ApiOperation({
    summary: "The capability ticks (delivery, shipping, counter, door payments) for one tenant",
  })
  getBusinessCapabilities(@Param("id") id: string): Promise<BusinessCapabilities> {
    return this.businessProfiles.capabilities(id);
  }

  @Post("tenants/:id/business-profile/preview")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "What applying a business profile would change for this tenant — writes nothing",
  })
  previewBusinessProfile(
    @Param("id") id: string,
    @Body() dto: ApplyBusinessProfileDto,
  ): Promise<BusinessProfilePreviewResponse> {
    return this.businessProfiles.preview(id, dto.profile);
  }

  /**
   * Confirm. The plan is recomputed HERE from the tenant's current state (never trusted from the
   * client) and validated whole before the first write. Writes go through the existing audited
   * paths only — this controller's own add-on disable, the add-on comp enable (SA-769: a profile's
   * add-on grants are comp rows, never GRANT overrides) and override create/revoke, and
   * `FeatureConfigService.set` — in the order billing disables → grants → modes → denies. The
   * disables (paid modules, owner ruling) come first so a billing failure refuses the apply before
   * anything else is written; only fleet-OFF profiles have any, and their modes need no fleet.
   * Grants precede modes and modes precede denies because `set()` checks the fleet rule against
   * the SAVED state: delivery needs the fleet granted first, and a fleet is denied only after the
   * mode has moved off delivery. BO-04: this route is a thin alias - the preset goes through its ticks onto
   * the same plan and the same `applyResolvedLocked` as `business-capabilities`. Re-applying is idempotent (every step becomes a skip). Not one DB
   * transaction: a mid-way failure leaves the steps already written, each audited, and a re-apply
   * completes the rest.
   */
  @Post("tenants/:id/business-profile")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Apply a business profile to a tenant (audited; idempotent)" })
  applyBusinessProfile(
    @Param("id") id: string,
    @Body() dto: ConfirmBusinessProfileDto,
    @CurrentUser() admin: JwtPayload,
  ): Promise<BusinessProfileApplyResponse> {
    // Plan-then-apply under the add-on locks the enable path takes (#3199 review): see withConfirmLock.
    return this.businessProfiles.withConfirmLock(id, async () => {
      // BO-04 review: re-plan from the DB, not this replica's 30s mode cache (see forgetCachedModes).
      this.featureConfig.forgetCachedModes(id);
      const resolved = await this.businessProfiles.plan(id, dto.profile);
      const done = await this.applyResolvedLocked(id, resolved, dto, admin);
      return { profile: resolved.profile.key as BusinessProfileApplyResponse["profile"], ...done };
    });
  }

  @Post("tenants/:id/business-capabilities/preview")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "What ticking these capabilities would change for this tenant (and whether it is blocked) - writes nothing",
  })
  previewBusinessCapabilities(
    @Param("id") id: string,
    @Body() dto: BusinessCapabilitiesDto,
  ): Promise<BusinessCapabilitiesPreviewResponse> {
    return this.businessProfiles.previewCapabilities(id, dto);
  }

  /**
   * BO-04: confirm for capability ticks. The ticks map to the ONE planner the presets use, then the SAME
   * apply sequence runs (`applyResolvedLocked`): nothing here has its own plan or its own write order.
   */
  @Post("tenants/:id/business-capabilities")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Apply capability ticks to a tenant (audited; idempotent)" })
  applyBusinessCapabilities(
    @Param("id") id: string,
    @Body() dto: ConfirmBusinessCapabilitiesDto,
    @CurrentUser() admin: JwtPayload,
  ): Promise<BusinessCapabilitiesApplyResponse> {
    return this.businessProfiles.withConfirmLock(id, async () => {
      // BO-04 review: re-plan from the DB, not this replica's 30s mode cache (see forgetCachedModes).
      this.featureConfig.forgetCachedModes(id);
      const resolved = await this.businessProfiles.planCapabilities(id, dto);
      const done = await this.applyResolvedLocked(id, resolved, dto, admin);
      return { capabilities: resolved.capabilities, preset: resolved.preset, ...done };
    });
  }

  /**
   * The one apply sequence, for a plan already resolved from the tenant's CURRENT state (preset or ticks).
   * Order: refuse a blocked plan (carrier in transit, a comp the comp path would refuse) and a stale
   * fingerprint FIRST, before any write - so a refusal never leaves billing half stopped - then billing
   * disables -> comps and grants -> modes -> denies.
   */
  private async applyResolvedLocked(
    id: string,
    resolved: BusinessProfileResolution,
    dto: { planFingerprint: string; reason?: string },
    admin: JwtPayload,
  ): Promise<{ plan: BusinessProfileApplyResponse["plan"]; changed: string[]; summary: string[] }> {
    this.businessProfiles.assertNotBlocked(resolved); // before any write, and before the fingerprint
    this.businessProfiles.assertPlanUnchanged(resolved, dto.planFingerprint); // before any write
    const reason = dto.reason?.trim() || resolved.reason;
    const { changed } = await this.featurePreview.preview(id, resolved.previewRequest);

    // Owner ruling (money, tier 1): a module the profile switches OFF that the tenant PAYS for is
    // switched off by the EXISTING add-on disable (this controller's own route: Stripe item
    // removal + the locked ledger update in AddonService.disableAddon, then ADDON_DISABLED audit)
    // — never a billing row or Stripe call written here. These run FIRST, in reverse dependency
    // order (plan.billing is already in BILLING_DISABLE_ORDER), so a failure part-way leaves a valid
    // configuration; the apply is then refused with BUSINESS_PROFILE_BILLING_FAILED before ANY
    // mode/config/override write. Stripe calls cannot share one transaction (lead ruling).
    const alreadyDisabled: string[] = [];
    // The step in flight, so ANY failure once billing has been stopped is reported the same way.
    let current: { step: "billing" | "grant" | "mode" | "deny" | "audit"; key: string } = {
      step: "billing",
      key: "",
    };
    // Lead/SA ruling: name EXACTLY which add-ons were already switched off with billing stopped,
    // and the step that failed, so the admin can retry (a retry re-plans and runs only what is
    // left). A fixed code and message — never the server's error text.
    const billingFailed = () => {
      const label = (k: string) => FEATURE_REGISTRY.find((f) => f.key === k)?.label ?? k;
      const done = alreadyDisabled.map(label).join(", ") || "none";
      // SA-769: a COMP row has no billing to stop, so its copy says "switched off" only. The billing wording
      // stays whenever a paid add-on is involved (a paid one was stopped, or is the one that failed).
      const compOff = new Set(resolved.plan.billing.filter((b) => b.comp).map((b) => b.featureKey));
      const billingWords =
        alreadyDisabled.length > 0
          ? alreadyDisabled.some((k) => !compOff.has(k))
          : !compOff.has(current.key);
      const what =
        current.step === "billing"
          ? compOff.has(current.key)
            ? `The profile was not applied: ${label(current.key)} could not be switched off.`
            : `The profile was not applied: billing for ${label(current.key)} could not be stopped.`
          : `The profile was only partly applied: the ${current.step} step for ` +
            `${label(current.key)} failed after ` +
            (billingWords ? "billing was stopped." : "the add-ons were switched off.");
      // ROW c: say per add-on what happened. The one whose switch-off failed first, then the ones already switched
      // off (they are in the billing disable order). A comp has no billing to stop; a paid row's billing is stopped
      // exactly when its disable succeeded.
      const failedKey = current.step === "billing" ? current.key : null;
      const addons: BusinessProfileBillingFailedAddon[] = [
        ...(failedKey ? [failedKey] : []),
        ...alreadyDisabled,
      ].map((key) => {
        const wasComp = compOff.has(key);
        const switchedOff = key !== failedKey;
        return { key, wasComp, billingStopped: switchedOff && !wasComp, switchedOff };
      });
      return new ServiceUnavailableException({
        statusCode: 503,
        code: API_ERROR_CODES.BUSINESS_PROFILE_BILLING_FAILED,
        featureKey: current.key,
        alreadyDisabled: [...alreadyDisabled],
        failedStep: { ...current },
        addons,
        message:
          `${what} Already switched off${billingWords ? " with billing stopped" : ""}: ${done}. ` +
          (current.step === "billing" ? "Nothing else was changed; " : "") +
          "retry to finish.",
      });
    };

    for (const b of resolved.plan.billing) {
      current = { step: "billing", key: b.featureKey };
      try {
        await this.disableAddon(id, { addonKey: b.featureKey } as DisableAddonDto, admin);
      } catch {
        throw billingFailed();
      }
      alreadyDisabled.push(b.featureKey);
    }
    if (alreadyDisabled.length > 0) this.authority.invalidate(id);

    // SA-769 (D-S2): an add-on module the profile grants is a COMP row (the SA-693 comp path:
    // isComp, no Stripe call, nothing booked), not a GRANT override. The confirm already holds this
    // module's add-on key, so the enable runs under it (`lockHeld`) instead of waiting on itself.
    // The audit row is the same ADDON_COMPED the admin comp route writes, with the profile as reason.
    const compKeys = new Set(resolved.plan.comps.map((c) => c.featureKey));
    const compModule = async (featureKey: string) => {
      const compReason = `business profile ${resolved.profile.key}`;
      await this.addonService.enableAddon(id, featureKey, undefined, undefined, {
        comp: true,
        lockHeld: true,
        actorId: admin.sub,
        reason: compReason,
      });
      // a later module (driver_payments) `requires` this one: its comp must be visible to that check
      this.authority.invalidate(id);
      await this.svc.recordAdminAction(id, admin.sub, AdminAuditAction.ADDON_COMPED, {
        addonKey: featureKey,
        acknowledgeUnmetRequires: false,
        reason: compReason,
        profile: resolved.profile.key,
      });
    };
    const applyOverrides = async (effect: "GRANT" | "DENY") => {
      for (const o of resolved.plan.overrides) {
        if (o.effect !== effect) continue;
        current = { step: effect === "GRANT" ? "grant" : "deny", key: o.featureKey };
        if (o.action === "replace" || o.action === "revoke") {
          await this.revokeFeatureOverride(id, resolved.revokeOverrideIds[o.featureKey], admin);
        }
        if (o.action === "create" || o.action === "replace") {
          await this.createFeatureOverride(
            id,
            { featureKey: o.featureKey, effect: o.effect, reason } as CreateFeatureOverrideDto,
            admin,
          );
        }
        // module order: the fleet keys first, driver_payments last (it requires a fleet key)
        if (effect === "GRANT" && compKeys.has(o.featureKey)) await compModule(o.featureKey);
      }
    };
    try {
      await applyOverrides("GRANT");
      for (const m of resolved.plan.modes) {
        current = { step: "mode", key: m.key };
        await this.featureConfig.set(id, m.key, m.to, reason, admin.sub);
      }
      await applyOverrides("DENY");
      current = { step: "audit", key: resolved.profile.key };
      this.authority.invalidate(id);
      await this.svc.recordAdminAction(id, admin.sub, AdminAuditAction.BUSINESS_PROFILE_APPLIED, {
        // alias calls (a preset key) keep `profile`; capability calls carry `capabilities` + `preset` instead
        ...(resolved.aliasProfile ? { profile: resolved.aliasProfile } : {}),
        capabilities: resolved.capabilities,
        preset: resolved.preset,
        reason,
        plan: resolved.plan,
        // SA-769: the comp rows this apply wrote, listed so the audit row alone shows what was granted free
        comps: resolved.plan.comps.map((c) => c.featureKey),
        summary: resolved.summary,
      });
    } catch (err) {
      // SA MUST: once any billing was stopped, EVERY later failure is the same coded 503, so the
      // admin is always told billing already stopped. With nothing stopped, the error is its own.
      if (alreadyDisabled.length > 0) throw billingFailed();
      throw err;
    }
    return { plan: resolved.plan, changed, summary: resolved.summary };
  }

  // ─── Configuration snapshots (Lane B A2 step c) ───────────────────────────
  // Every route here inherits the class-level SuperAdminGuard.

  @Get("tenants/:id/config-snapshots")
  @ApiOperation({
    summary: "A tenant's archived feature-config snapshots (taken on downgrade), newest first",
  })
  listConfigSnapshots(@Param("id", ParseUUIDPipe) id: string) {
    return this.snapshotAdmin.list(id);
  }

  @Get("tenants/:id/config-snapshots/:snapshotId/preview")
  @ApiOperation({
    summary: "What restoring this snapshot would restore / keep / skip right now — writes nothing",
  })
  previewConfigSnapshotRestore(
    @Param("id", ParseUUIDPipe) id: string,
    @Param("snapshotId", ParseUUIDPipe) snapshotId: string,
  ) {
    return this.snapshotAdmin.preview(id, snapshotId);
  }

  @Post("tenants/:id/config-snapshots/:snapshotId/restore")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Restore Now — apply one snapshot as-was to the tenant's current plan" })
  async restoreConfigSnapshot(
    @Param("id", ParseUUIDPipe) id: string,
    @Param("snapshotId", ParseUUIDPipe) snapshotId: string,
    @CurrentUser() admin: JwtPayload,
  ) {
    // The audit row (with the report) is written by the service INSIDE the restore transaction.
    return this.snapshotAdmin.restoreNow(id, snapshotId, admin.sub);
  }

  // ─── Mobile app install links ─────────────────────────────────────────────

  @Get("app-links")
  @ApiOperation({ summary: "Get the global mobile app install links (Get the app page)" })
  getAppLinks(): Promise<AppLinks> {
    return this.platformConfig.getAppLinks();
  }

  @Put("app-links")
  @ApiOperation({
    summary: "Set the mobile app install links (string sets, empty or null clears, absent leaves)",
  })
  async updateAppLinks(
    @Body() dto: AppLinksPatch,
    @CurrentUser() admin: JwtPayload,
  ): Promise<AppLinks> {
    const previous = await this.platformConfig.getAppLinks();
    const next = await this.platformConfig.setAppLinks(dto);
    await this.svc.recordAdminAction(null, admin.sub, AdminAuditAction.APP_LINKS_UPDATED, {
      previous,
      next,
    });
    return next;
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

  @Get("ai-config/usage")
  @ApiOperation({
    summary: "Platform-wide Claude usage rollup (OCR/forecast scans, tokens, spend)",
  })
  @ApiQuery({ name: "days", required: false, type: Number })
  getAiUsage(@Query("days") days = "30") {
    return this.platformConfig.getAiUsage(Number(days));
  }

  @Post("ai-config/test")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Verify the stored Anthropic key against the API (stores verifiedAt)" })
  testAiConnection() {
    return this.platformConfig.testConnection();
  }
}
