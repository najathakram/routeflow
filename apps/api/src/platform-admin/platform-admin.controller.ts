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
import { EnableAddonDto, DisableAddonDto } from "../billing/dto/manage-addon.dto";
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
import type { FeaturePreviewRequest } from "@routeflow/types";
import { AdminAuditAction } from "./audit-actions.constant";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { BusinessProfileService } from "../billing/business-profile.service";
import { FeatureConfigService } from "../billing/feature-config.service";
import { ApplyBusinessProfileDto } from "./dto/apply-business-profile.dto";
import type {
  BusinessProfileApplyResponse,
  BusinessProfileListResponse,
  BusinessProfilePreviewResponse,
} from "@routeflow/types";

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
    const result = await this.addonService.enableAddon(
      id,
      dto.addonKey,
      dto.stripePriceId,
      dto.acknowledgeUnmetRequires,
    );
    await this.svc.recordAdminAction(id, admin.sub, AdminAuditAction.ADDON_ENABLED, {
      addonKey: dto.addonKey,
      // B524: see the matching note on createFeatureOverride's audit payload.
      acknowledgeUnmetRequires: dto.acknowledgeUnmetRequires ?? false,
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
    return {
      effective: FEATURE_REGISTRY.map((f) => {
        const entry = resolved.byKey.get(f.key)!;
        // Opus review of 9923b87c, item 5: `serving` is the OLD PATH's verdict (what's
        // actually applied while entitlements.mode is "shadow"), not the resolver's own
        // value — those two only coincide by construction, and the whole point of the
        // explain trace is to show where they diverge. `enforced` reflects the REAL mode:
        // true only once "live" makes the resolver's verdict the one that's applied.
        const serving = oldPathByKey.get(f.key) ?? entry.effective;
        return toEffectiveFeature(
          entry,
          serving,
          resolved.planKey,
          resolved.catalogVersionId,
          mode === "live",
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
    return toEffectiveFeature(
      entry,
      serving,
      resolved.planKey,
      resolved.catalogVersionId,
      mode === "live",
    );
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
   * paths only — this controller's own add-on disable and override create/revoke, and
   * `FeatureConfigService.set` — in the order billing disables → grants → modes → denies. The
   * disables (paid modules, owner ruling) come first so a billing failure refuses the apply before
   * anything else is written; only fleet-OFF profiles have any, and their modes need no fleet.
   * Grants precede modes and modes precede denies because `set()` checks the fleet rule against
   * the SAVED state: delivery needs the fleet granted first, and a fleet is denied only after the
   * mode has moved off delivery. Re-applying is idempotent (every step becomes a skip). Not one DB
   * transaction: a mid-way failure leaves the steps already written, each audited, and a re-apply
   * completes the rest.
   */
  @Post("tenants/:id/business-profile")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Apply a business profile to a tenant (audited; idempotent)" })
  async applyBusinessProfile(
    @Param("id") id: string,
    @Body() dto: ApplyBusinessProfileDto,
    @CurrentUser() admin: JwtPayload,
  ): Promise<BusinessProfileApplyResponse> {
    const resolved = await this.businessProfiles.plan(id, dto.profile);
    const reason = dto.reason?.trim() || resolved.reason;
    const { changed } = await this.featurePreview.preview(id, resolved.previewRequest);

    // Owner ruling (money, tier 1): a module the profile switches OFF that the tenant PAYS for is
    // switched off by the EXISTING add-on disable (this controller's own route: Stripe item
    // removal + the locked ledger update in AddonService.disableAddon, then ADDON_DISABLED audit)
    // — never a billing row or Stripe call written here. These run FIRST: if one fails, the apply
    // is refused with BUSINESS_PROFILE_BILLING_FAILED before any other write of the profile.
    const alreadyDisabled: string[] = [];
    for (const b of resolved.plan.billing) {
      try {
        await this.disableAddon(id, { addonKey: b.featureKey } as DisableAddonDto, admin);
      } catch (err) {
        throw new ServiceUnavailableException({
          statusCode: 503,
          code: API_ERROR_CODES.BUSINESS_PROFILE_BILLING_FAILED,
          featureKey: b.featureKey,
          alreadyDisabled,
          message:
            "The profile was not applied: an add-on's billing could not be stopped. Retry; " +
            "nothing else was changed.",
          cause: (err as Error)?.message,
        });
      }
      alreadyDisabled.push(b.featureKey);
    }
    if (alreadyDisabled.length > 0) this.authority.invalidate(id);

    const applyOverrides = async (effect: "GRANT" | "DENY") => {
      for (const o of resolved.plan.overrides) {
        if (o.effect !== effect || o.action === "skip") continue;
        if (o.action === "replace") {
          await this.revokeFeatureOverride(id, resolved.revokeOverrideIds[o.featureKey], admin);
        }
        await this.createFeatureOverride(
          id,
          { featureKey: o.featureKey, effect: o.effect, reason } as CreateFeatureOverrideDto,
          admin,
        );
      }
    };
    await applyOverrides("GRANT");
    for (const m of resolved.plan.modes) {
      await this.featureConfig.set(id, m.key, m.to, reason, admin.sub);
    }
    await applyOverrides("DENY");

    this.authority.invalidate(id);
    await this.svc.recordAdminAction(id, admin.sub, AdminAuditAction.BUSINESS_PROFILE_APPLIED, {
      profile: resolved.profile.key,
      reason,
      plan: resolved.plan,
      summary: resolved.summary,
    });
    return {
      profile: resolved.profile.key as BusinessProfileApplyResponse["profile"],
      plan: resolved.plan,
      changed,
      summary: resolved.summary,
    };
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
