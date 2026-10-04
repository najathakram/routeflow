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
import { FeatureOverrideService } from "./feature-override.service";
import { FeatureConfigService } from "./feature-config.service";
import { FeaturePreviewService } from "./feature-preview.service";
import { FLEET_KEYS } from "./fulfilment-capability";
import {
  BUSINESS_PROFILES,
  PROFILE_MODULE_KEYS,
  businessProfileByKey,
  describeBusinessProfilePlan,
  planBusinessProfile,
  postApplyViolations,
  toBusinessProfileSummary,
  type BusinessProfileDef,
  type BusinessProfileState,
} from "./business-profiles";

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
    private readonly featureConfig: FeatureConfigService,
    private readonly featurePreview: FeaturePreviewService,
  ) {}

  list(): BusinessProfileListResponse {
    return { profiles: BUSINESS_PROFILES.map(toBusinessProfileSummary) };
  }

  /**
   * The plan for one tenant, recomputed from its CURRENT state. 400 BUSINESS_PROFILE_UNKNOWN,
   * 404 for a missing tenant, 409 when the post-apply state would break a mode rule (checked
   * before anything is written).
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
        overrides: plan.overrides
          .filter((o) => o.action !== "skip")
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
    };
  }

  private async currentState(
    tenantId: string,
    profile: BusinessProfileDef,
  ): Promise<{ state: BusinessProfileState; activeIds: Map<string, string> }> {
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
    const holds: Record<string, boolean> = {};
    for (const key of PROFILE_MODULE_KEYS) {
      holds[key] = await this.featureConfig.can(tenantId, key);
    }
    const modes: Record<string, string> = {};
    for (const key of Object.keys(profile.modes)) {
      modes[key] = (await this.featureConfig.getState(tenantId, key)).value;
    }
    return { state: { overrides, holds, modes }, activeIds };
  }
}
