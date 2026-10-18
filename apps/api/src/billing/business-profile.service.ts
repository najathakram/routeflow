import { createHash } from "crypto";
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type {
  BusinessCapabilities,
  BusinessCapabilitiesPreviewResponse,
  BusinessCapabilitiesRequest,
  BusinessCapabilityTicks,
  BusinessPlanBlocked,
  BusinessProfileKey,
  BusinessProfileListResponse,
  BusinessProfilePlan,
  BusinessProfilePreviewResponse,
  FeaturePreviewRequest,
} from "@routeflow/types";
import { PrismaService } from "../prisma/prisma.service";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { LockTimeoutError, LockUnavailableError, withAdvisoryLocks } from "../common/db-locks";
import { AddonService } from "./addon.service";
import { FeatureOverrideService } from "./feature-override.service";
import { FeatureConfigService } from "./feature-config.service";
import { FeaturePreviewService } from "./feature-preview.service";
import { FLEET_KEYS, heldAddonKeys, readFulfilmentInputs } from "./fulfilment-capability";
import { isOpensAsChoosable } from "@routeflow/types";
import {
  capabilitiesFromInputs,
  capabilityAvailability,
  presetTicks,
  ticksToProfileDef,
} from "./business-capabilities";
import { addonCodeOf, findAddonRow } from "./addon-row";
import {
  BUSINESS_PROFILES,
  PROFILE_MODULE_KEYS,
  businessProfileByKey,
  describeBusinessProfilePlan,
  describeBusinessProfileSections,
  planBusinessProfile,
  planCompRefusal,
  postApplyViolations,
  toBusinessProfileSummary,
  unavailableModes,
  wants,
  type BusinessProfileDef,
  type BusinessProfileState,
} from "./business-profiles";
import {
  carrierInTransitConflict,
  carrierInTransitCount,
} from "../orders/carrier-in-transit-guard";

/** Canonical JSON (object keys sorted, array order kept): the same plan always hashes the same. */
const canonical = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v as object)
            .sort()
            .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
        )
      : v;

/** A stable hash of a plan: what the admin was shown, so confirm can prove it applies the same. */
export function planFingerprint(plan: BusinessProfilePlan): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(plan)))
    .digest("hex");
}

/** What the confirm path needs: the plan recomputed server-side at confirm time. */
export interface BusinessProfileResolution {
  profile: BusinessProfileDef;
  plan: BusinessProfilePlan;
  /** featureKey → the active opposite override to revoke, for every `replace` and `revoke` action. */
  revokeOverrideIds: Record<string, string>;
  /** The request the existing FeaturePreviewService runs for this plan. */
  previewRequest: FeaturePreviewRequest;
  summary: string[];
  /** The default audit reason, "Business profile: <label>". */
  reason: string;
  /** BO-04: the normalised ticks this plan was made for (what the audit row and the response echo). */
  capabilities: BusinessCapabilityTicks;
  /** The preset those ticks equal, else null (a "custom" combination). */
  preset: BusinessProfileKey | null;
  /** Set only when the plan was asked for by a preset key (the alias routes): the audit row keeps `profile`. */
  aliasProfile?: BusinessProfileKey;
  /**
   * Why this plan cannot be applied right now, else null. Planning NEVER throws for these: the capabilities
   * preview returns the plan with `blocked` (Confirm disabled), and every confirm calls `assertNotBlocked`
   * right after planning, BEFORE step 1 (the billing disables), so a refusal never leaves billing half stopped.
   */
  blocked: BusinessPlanBlocked | null;
}

/**
 * Business profiles: list, plan and preview. READ-ONLY by design. It reads the tenant through the
 * existing services (overrides, `FeatureConfigService.can()`/`getState()`) and previews through
 * the existing `FeaturePreviewService`. The writes happen in `PlatformAdminController`'s confirm
 * route: add-on modules a profile grants are COMP rows through `AddonService.enableAddon({ comp })`
 * (SA-769), the rest through its own audited override path (the single caller of
 * `FeatureOverrideService.create`, feature-override-single-caller.spec.ts) and
 * `FeatureConfigService.set`.
 */
@Injectable()
export class BusinessProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly featureOverrides: FeatureOverrideService,
    private readonly addons: AddonService,
    private readonly featureConfig: FeatureConfigService,
    private readonly featurePreview: FeaturePreviewService,
  ) {}

  list(): BusinessProfileListResponse {
    return {
      profiles: BUSINESS_PROFILES.map(toBusinessProfileSummary),
      availability: capabilityAvailability(),
    };
  }

  /**
   * BO-03: the ticks for one tenant, read back (read-only). Fulfilment facts come from `readFulfilmentInputs`
   * and `capabilityFromInputs`; `driver_payments` is held the way `currentState` reads it (an active
   * override is absolute, else the add-on rows). 404 for a missing tenant.
   */
  async capabilities(tenantId: string): Promise<BusinessCapabilities> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true },
    });
    if (!tenant) throw new NotFoundException(`Tenant ${tenantId} not found.`);
    const inputs = await readFulfilmentInputs(
      {
        featureConfig: this.featureConfig,
        addonService: this.addons,
        featureOverrides: this.featureOverrides,
      },
      tenantId,
    );
    // A failed mode or fleet read must not become a guessed answer (a configured tenant read as
    // unset, or fleetHeld:false): the same 503 Settings → Fulfillment and /tenants/me/features give.
    if (inputs.fleet === null || inputs.modesFailed) {
      throw new ServiceUnavailableException({
        statusCode: 503,
        code: API_ERROR_CODES.FEATURES_UNAVAILABLE,
        message: "Feature resolution is temporarily unavailable. Please retry.",
      });
    }
    const now = Date.now();
    const rows = await this.featureOverrides.list(tenantId);
    const override = rows.find(
      (r) =>
        r.tenantId === tenantId &&
        r.featureKey === "driver_payments" &&
        !r.revokedAt &&
        !(r.expiresAt && r.expiresAt.getTime() <= now),
    );
    const held = await heldAddonKeys(this.addons, this.featureOverrides, tenantId);
    const doorPayments = override ? override.effect === "GRANT" : held.has("driver_payments");
    return capabilitiesFromInputs(inputs, doorPayments ? ["driver_payments"] : []);
  }

  /**
   * The plan for one PRESET key (the alias routes), recomputed from the tenant's CURRENT state. 400
   * BUSINESS_PROFILE_UNKNOWN; the rest is `planDef`. BO-04: the preset goes through its own ticks
   * (`presetTicks` -> `ticksToProfileDef`), the same path as a capabilities request. A carrier in transit is
   * `blocked` on the result (no longer thrown here); the alias preview and both confirms call `assertNotBlocked`.
   */
  async plan(tenantId: string, profileKey: string): Promise<BusinessProfileResolution> {
    const preset = businessProfileByKey(profileKey);
    if (!preset) {
      throw new BadRequestException({
        statusCode: 400,
        code: API_ERROR_CODES.BUSINESS_PROFILE_UNKNOWN,
        message: `"${profileKey}" is not a business profile.`,
      });
    }
    const { def, normalised } = ticksToProfileDef(presetTicks(preset));
    return this.planDef(tenantId, def, {
      capabilities: normalised,
      preset: preset.key as BusinessProfileKey,
      aliasProfile: preset.key as BusinessProfileKey,
    });
  }

  /** BO-04: the plan for a set of capability ticks. 400 BUSINESS_CAPABILITIES_EMPTY before any read. */
  async planCapabilities(
    tenantId: string,
    request: BusinessCapabilitiesRequest,
  ): Promise<BusinessProfileResolution> {
    const { def, normalised, preset } = ticksToProfileDef(request);
    return this.planDef(tenantId, def, { capabilities: normalised, preset });
  }

  /**
   * The one planner entry. 400 BUSINESS_PROFILE_UNAVAILABLE when the feature registry does not offer one of the
   * def's modes (checked before reading the tenant, so an unchanged mode is never a bypass - SA-671 M1); 404 for a
   * missing tenant; 409 when the post-apply state would break a mode rule. All before anything is written.
   * Carrier-in-transit and a comp the comp path would refuse come back as `blocked`, not as an error.
   */
  async planDef(
    tenantId: string,
    profile: BusinessProfileDef,
    extras: {
      capabilities: BusinessCapabilityTicks;
      preset: BusinessProfileKey | null;
      aliasProfile?: BusinessProfileKey;
    },
  ): Promise<BusinessProfileResolution> {
    const unavailable = unavailableModes(profile);
    if (unavailable.length > 0) {
      throw new BadRequestException({
        statusCode: 400,
        code: API_ERROR_CODES.BUSINESS_PROFILE_UNAVAILABLE,
        profile: profile.key,
        unavailable,
        message: `"${profile.label}" is not available yet.`,
      });
    }
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true },
    });
    if (!tenant) throw new NotFoundException(`Tenant ${tenantId} not found.`);

    const { state, activeIds } = await this.currentState(tenantId, profile);
    const violations = postApplyViolations(profile, state);
    if (violations.length > 0) {
      const v = violations[0];
      throw new ConflictException({
        code: API_ERROR_CODES.FULFILMENT_MODE_NEEDS_FLEET,
        key: v.key,
        mode: v.mode,
        missing: [...FLEET_KEYS],
        message: "This profile's delivery mode needs Routes or Order delivery turned on.",
      });
    }

    const plan = planBusinessProfile(profile, state);
    // Item 8 / BO-04: the same in-transit rule as Settings → Fulfillment, in its non-throwing form. The preview
    // shows it as the blocker; every confirm refuses on it right after planning, before any write.
    const model = plan.modes.find((m) => m.key === "fulfilment_model");
    const inTransit = model
      ? await carrierInTransitCount(this.prisma, tenantId, model.from, model.to)
      : 0;
    // BO-04: and the comp path's own refusal, dry-run (a refusal after the billing disables would stop billing
    // with the profile half applied).
    const blocked: BusinessPlanBlocked | null =
      inTransit > 0
        ? { code: API_ERROR_CODES.FULFILMENT_CARRIER_IN_TRANSIT, count: inTransit }
        : planCompRefusal(plan, state);
    const reason = `Business profile: ${profile.label}`;
    const revokeOverrideIds: Record<string, string> = {};
    for (const o of plan.overrides) {
      if (o.action === "replace" || o.action === "revoke") {
        revokeOverrideIds[o.featureKey] = activeIds.get(o.featureKey)!;
      }
    }
    return {
      profile,
      plan,
      revokeOverrideIds,
      previewRequest: {
        // The preview models the END state: a module switched off by its billing disable is
        // shown as off (a DENY in the hypothetical); a module comped (SA-769) is shown as on (a GRANT).
        overrides: plan.overrides
          .filter(
            (o) =>
              o.action !== "skip" ||
              plan.billing.some((b) => b.featureKey === o.featureKey) ||
              plan.comps.some((c) => c.featureKey === o.featureKey),
          )
          .map((o) => ({ featureKey: o.featureKey, effect: o.effect, reason })),
        modes: { ...profile.modes },
      },
      summary: describeBusinessProfilePlan(plan),
      reason,
      capabilities: extras.capabilities,
      preset: extras.preset,
      ...(extras.aliasProfile ? { aliasProfile: extras.aliasProfile } : {}),
      blocked,
    };
  }

  /**
   * Refuse a blocked plan with the code the underlying rule gives: 409 FULFILMENT_CARRIER_IN_TRANSIT (the
   * Settings guard's own body) or 400 FEATURE_REQUIRES_UNMET (the comp path's own body). Call it right after
   * planning in every confirm, before `assertPlanUnchanged` and before step 1 (the billing disables).
   */
  assertNotBlocked(resolved: BusinessProfileResolution): void {
    const b = resolved.blocked;
    if (!b) return;
    if (b.code === API_ERROR_CODES.FULFILMENT_CARRIER_IN_TRANSIT) {
      throw carrierInTransitConflict(b.count);
    }
    throw new BadRequestException({
      statusCode: 400,
      code: API_ERROR_CODES.FEATURE_REQUIRES_UNMET,
      key: b.key,
      missing: b.missing,
      message:
        `"${b.key}" depends on ${b.missing}, which this tenant does not currently have. ` +
        `Nothing was changed.`,
    });
  }

  /** A dry run through the existing feature preview — writes nothing. */
  async preview(tenantId: string, profileKey: string): Promise<BusinessProfilePreviewResponse> {
    const resolved = await this.plan(tenantId, profileKey);
    // The preset picker has no `blocked` field to show, so it keeps today's refusal (BO-05 retires it).
    this.assertNotBlocked(resolved);
    const response = await this.featurePreview.preview(tenantId, resolved.previewRequest);
    return {
      ...response,
      profile: resolved.profile.key as BusinessProfilePreviewResponse["profile"],
      plan: resolved.plan,
      summary: resolved.summary,
      changes: describeBusinessProfileSections(resolved.plan).changes,
      planFingerprint: planFingerprint(resolved.plan),
    };
  }

  /**
   * BO-04: the dry run for capability ticks. A blocked plan is still a 200: the plan, its fingerprint and
   * `blocked` come back so the admin sees why Confirm is disabled. Writes nothing.
   */
  async previewCapabilities(
    tenantId: string,
    request: BusinessCapabilitiesRequest,
  ): Promise<BusinessCapabilitiesPreviewResponse> {
    const resolved = await this.planCapabilities(tenantId, request);
    const response = await this.featurePreview.preview(tenantId, resolved.previewRequest);
    return {
      ...response,
      capabilities: resolved.capabilities,
      preset: resolved.preset,
      opensAs: resolved.capabilities.opensAs,
      opensAsChoosable: isOpensAsChoosable(resolved.capabilities),
      plan: resolved.plan,
      summary: resolved.summary,
      changes: describeBusinessProfileSections(resolved.plan).changes,
      planFingerprint: planFingerprint(resolved.plan),
      blocked: resolved.blocked,
    };
  }

  /**
   * Confirm re-plans from the tenant's CURRENT state; anything that changed since the preview (an
   * add-on turned on in between, say) would be applied unseen. A different plan is a 409
   * PROFILE_PLAN_CHANGED before any write: the web re-previews and the admin confirms again.
   */
  assertPlanUnchanged(resolved: BusinessProfileResolution, previewed: string | undefined): void {
    if (typeof previewed !== "string" || previewed.trim() === "") {
      throw new BadRequestException({
        statusCode: 400,
        message: "Preview the business profile first, then confirm.",
      });
    }
    if (planFingerprint(resolved.plan) === previewed) return;
    throw new ConflictException({
      code: API_ERROR_CODES.PROFILE_PLAN_CHANGED,
      message: "This account changed since the preview. Review the new preview and confirm again.",
    });
  }

  /**
   * "Held" is read the way the real gates read it (SA-671 M2): an active override is absolute,
   * otherwise the add-on rows through `heldAddonKeys` (the same helper the fleet 409 and
   * `capabilities.fulfilment` use). Never `FeatureConfigService.can()`, which treats every
   * guard-gated key as on — `driver-payments.guard.ts` 403s without a row or a GRANT.
   */
  private async currentState(
    tenantId: string,
    profile: BusinessProfileDef,
  ): Promise<{
    state: BusinessProfileState;
    activeIds: Map<string, string>;
  }> {
    const now = Date.now();
    const rows = await this.featureOverrides.list(tenantId);
    const overrides = new Map<string, "GRANT" | "DENY">();
    const activeIds = new Map<string, string>();
    for (const r of rows) {
      if (r.tenantId !== tenantId || r.revokedAt) continue;
      if (r.expiresAt && r.expiresAt.getTime() <= now) continue;
      overrides.set(r.featureKey, r.effect as "GRANT" | "DENY");
      activeIds.set(r.featureKey, r.id);
    }
    const held = await heldAddonKeys(this.addons, this.featureOverrides, tenantId);
    const holds: Record<string, boolean> = {};
    for (const key of PROFILE_MODULE_KEYS) {
      const override = overrides.get(key);
      holds[key] = override ? override === "GRANT" : held.has(key);
    }
    const modes: Record<string, string> = {};
    for (const key of Object.keys(profile.modes)) {
      modes[key] = (await this.featureConfig.getState(tenantId, key)).value;
    }
    // Owner ruling (money): "pays for" = the tenant's ACTIVE add-on row for the module — found by
    // the same predicate the existing disable uses (findAddonRow) — carrying a Stripe item or a
    // positive price snapshot. A comped row (neither) or a GRANT override is never a billing call.
    // A price with NO Stripe item = paid MANUALLY (a manual/external-payment activation): still
    // disabled, but flagged so the preview tells the admin to fix the manual invoice.
    // SA-769: the same row read also answers "does an ACTIVE row hold it" (`rowHeld`, apart from
    // `holds`, which an override overrides) and "is that row a comp" (`compRows`, `isComp`): a
    // fleet-ON profile never re-prices a held row, and a fleet-OFF profile switches a comp off
    // through the disable path with no billing call. `paying` is only decided for a module the def switches off.
    const paying = new Set<string>();
    const manualPay = new Set<string>();
    const rowHeld = new Set<string>();
    const compRows = new Set<string>();
    for (const key of PROFILE_MODULE_KEYS) {
      const row = await findAddonRow(this.prisma, tenantId, addonCodeOf(key));
      if (!row?.active) continue;
      rowHeld.add(key);
      if (row.isComp === true) compRows.add(key);
      // only a module this def switches OFF can be a billing stop (BO-04: per module, not per profile)
      if (wants(profile, key)) continue;
      if (row.stripeItemId) paying.add(key);
      else if (Number(row.priceSnapshot ?? 0) > 0) {
        paying.add(key);
        manualPay.add(key);
      }
    }
    return {
      state: { overrides, holds, paying, manualPay, rowHeld, compRows, modes },
      activeIds,
    };
  }

  /**
   * Plan-then-apply runs holding the SAME advisory locks the add-on enable takes (`addon:<tenant>:<sku>`,
   * one per profile module, in the "billing" lock family, which is the advisory-lock namespace and its
   * own small connection pool), so an add-on enabled mid-confirm waits for the confirm and is never
   * DENIED with its billing still running. All keys are taken SORTED on ONE connection
   * (`withAdvisoryLocks`), so a confirm pins one pool slot, not three. `disableAddon` takes none of
   * these locks (no re-entry). A lock that cannot be had in time is a 503 LOCK_UNAVAILABLE.
   */
  async withConfirmLock<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    const keys = PROFILE_MODULE_KEYS.map((k) => `addon:${tenantId}:${addonCodeOf(k)}`);
    try {
      return await withAdvisoryLocks({ family: "billing", keys, waitMs: 10_000 }, fn);
    } catch (e) {
      if (e instanceof LockTimeoutError || e instanceof LockUnavailableError) {
        throw new ServiceUnavailableException({
          code: API_ERROR_CODES.LOCK_UNAVAILABLE,
          message: "This account's add-ons are being changed right now. Try again in a moment.",
        });
      }
      throw e;
    }
  }
}
