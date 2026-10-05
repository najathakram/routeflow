import { createHash } from "crypto";
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type {
  BusinessProfileListResponse,
  BusinessProfilePlan,
  BusinessProfilePreviewResponse,
  FeaturePreviewRequest,
} from "@routeflow/types";
import { PrismaService } from "../prisma/prisma.service";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { AddonService } from "./addon.service";
import { FeatureOverrideService } from "./feature-override.service";
import { FeatureConfigService } from "./feature-config.service";
import { FeaturePreviewService } from "./feature-preview.service";
import { FLEET_KEYS, heldAddonKeys } from "./fulfilment-capability";
import { addonCodeOf, findAddonRow } from "./addon-row";
import {
  BUSINESS_PROFILES,
  PROFILE_MODULE_KEYS,
  businessProfileByKey,
  describeBusinessProfilePlan,
  describeBusinessProfileSections,
  planBusinessProfile,
  postApplyViolations,
  toBusinessProfileSummary,
  unavailableModes,
  type BusinessProfileDef,
  type BusinessProfileState,
} from "./business-profiles";

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
  /** featureKey → the active opposite override to revoke, for every `replace` action. */
  revokeOverrideIds: Record<string, string>;
  /** The request the existing FeaturePreviewService runs for this plan. */
  previewRequest: FeaturePreviewRequest;
  summary: string[];
  /** The default audit reason, "Business profile: <label>". */
  reason: string;
}

/**
 * Business profiles: list, plan and preview. READ-ONLY by design. It reads the tenant through the
 * existing services (overrides, `FeatureConfigService.can()`/`getState()`) and previews through
 * the existing `FeaturePreviewService`. The writes happen in `PlatformAdminController`'s confirm
 * route, through its own audited override path (the single caller of
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
    return { profiles: BUSINESS_PROFILES.map(toBusinessProfileSummary) };
  }

  /**
   * The plan for one tenant, recomputed from its CURRENT state. 400 BUSINESS_PROFILE_UNKNOWN;
   * 400 BUSINESS_PROFILE_UNAVAILABLE when the feature registry does not offer one of its modes
   * (checked before reading the tenant, so an unchanged mode is never a bypass — SA-671 M1);
   * 404 for a missing tenant; 409 when the post-apply state would break a mode rule. All before
   * anything is written.
   */
  async plan(tenantId: string, profileKey: string): Promise<BusinessProfileResolution> {
    const profile = businessProfileByKey(profileKey);
    if (!profile) {
      throw new BadRequestException({
        statusCode: 400,
        code: API_ERROR_CODES.BUSINESS_PROFILE_UNKNOWN,
        message: `"${profileKey}" is not a business profile.`,
      });
    }
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
    const reason = `Business profile: ${profile.label}`;
    const revokeOverrideIds: Record<string, string> = {};
    for (const o of plan.overrides) {
      if (o.action === "replace") revokeOverrideIds[o.featureKey] = activeIds.get(o.featureKey)!;
    }
    return {
      profile,
      plan,
      revokeOverrideIds,
      previewRequest: {
        // The preview models the END state: a module switched off by its billing disable is
        // shown as off (a DENY in the hypothetical), in module order.
        overrides: plan.overrides
          .filter(
            (o) => o.action !== "skip" || plan.billing.some((b) => b.featureKey === o.featureKey),
          )
          .map((o) => ({ featureKey: o.featureKey, effect: o.effect, reason })),
        modes: { ...profile.modes },
      },
      summary: describeBusinessProfilePlan(plan),
      reason,
    };
  }

  /** A dry run through the existing feature preview — writes nothing. */
  async preview(tenantId: string, profileKey: string): Promise<BusinessProfilePreviewResponse> {
    const resolved = await this.plan(tenantId, profileKey);
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
   * Confirm re-plans from the tenant's CURRENT state; anything that changed since the preview (an
   * add-on turned on in between, say) would be applied unseen. A different plan is a 409
   * PROFILE_PLAN_CHANGED before any write: the web re-previews and the admin confirms again.
   */
  assertPlanUnchanged(resolved: BusinessProfileResolution, previewed: string): void {
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
    const paying = new Set<string>();
    const manualPay = new Set<string>();
    if (!profile.fleet) {
      for (const key of PROFILE_MODULE_KEYS) {
        const row = await findAddonRow(this.prisma, tenantId, addonCodeOf(key));
        if (!row?.active) continue;
        if (row.stripeItemId) paying.add(key);
        else if (Number(row.priceSnapshot ?? 0) > 0) {
          paying.add(key);
          manualPay.add(key);
        }
      }
    }
    return { state: { overrides, holds, paying, manualPay, modes }, activeIds };
  }
}
