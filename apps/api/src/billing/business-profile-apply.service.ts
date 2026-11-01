import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import type {
  BusinessProfileApplyResponse,
  BusinessProfileBillingFailedAddon,
} from "@routeflow/types";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { AddonService, PROFILE_APPLY_SOURCE } from "./addon.service";
import { BusinessProfileService, type BusinessProfileResolution } from "./business-profile.service";
import { EntitlementAuthority } from "./entitlement-authority.service";
import { FeatureConfigService } from "./feature-config.service";
import { FeaturePreviewService } from "./feature-preview.service";
import { FEATURE_REGISTRY } from "./feature-registry";

/** Who is applying. The back office is the only caller today; the id is written to the add-on log and the mode history. */
export interface ApplyActor {
  id: string;
}

/**
 * The three admin writes and the audit the apply sequence reaches back into its caller for. They stay with the
 * caller because each carries that caller's own audit and guards (the platform-admin controller's routes).
 */
export interface ApplyIo {
  disableAddon(addonKey: string): Promise<unknown>;
  createOverride(input: {
    featureKey: string;
    effect: "GRANT" | "DENY";
    reason: string;
  }): Promise<unknown>;
  revokeOverride(overrideId: string): Promise<unknown>;
  audit(
    action: "ADDON_COMPED" | "BUSINESS_PROFILE_APPLIED",
    details: Record<string, unknown>,
  ): Promise<unknown>;
}

/**
 * The one apply sequence for a business profile or a set of capability ticks. It moved here from
 * `PlatformAdminController` unchanged in what it writes and in what order, so a second caller can run the same
 * sequence (W1). It holds no lock of its own: the caller takes `BusinessProfileService.withConfirmLock` first.
 */
@Injectable()
export class BusinessProfileApplyService {
  constructor(
    private readonly addonService: AddonService,
    private readonly authority: EntitlementAuthority,
    private readonly featureConfig: FeatureConfigService,
    private readonly featurePreview: FeaturePreviewService,
    private readonly businessProfiles: BusinessProfileService,
  ) {}

  /**
   * The one apply sequence, for a plan already resolved from the tenant's CURRENT state (preset or ticks).
   * Order: refuse a blocked plan (carrier in transit, a comp the comp path would refuse) and a stale
   * fingerprint FIRST, before any write - so a refusal never leaves billing half stopped - then billing
   * disables -> comps and grants -> modes -> denies.
   */
  async applyResolvedLocked(
    id: string,
    resolved: BusinessProfileResolution,
    dto: { planFingerprint: string; reason?: string },
    actor: ApplyActor,
    io: ApplyIo,
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
        await io.disableAddon(b.featureKey);
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
        source: PROFILE_APPLY_SOURCE,
        actorId: actor.id,
        reason: compReason,
      });
      // a later module (driver_payments) `requires` this one: its comp must be visible to that check
      this.authority.invalidate(id);
      await io.audit("ADDON_COMPED", {
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
          await io.revokeOverride(resolved.revokeOverrideIds[o.featureKey]);
        }
        if (o.action === "create" || o.action === "replace") {
          await io.createOverride({ featureKey: o.featureKey, effect: o.effect, reason });
        }
        // module order: the fleet keys first, driver_payments last (it requires a fleet key)
        if (effect === "GRANT" && compKeys.has(o.featureKey)) await compModule(o.featureKey);
      }
    };
    try {
      await applyOverrides("GRANT");
      for (const m of resolved.plan.modes) {
        current = { step: "mode", key: m.key };
        await this.featureConfig.set(id, m.key, m.to, reason, actor.id);
      }
      await applyOverrides("DENY");
      current = { step: "audit", key: resolved.profile.key };
      this.authority.invalidate(id);
      await io.audit("BUSINESS_PROFILE_APPLIED", {
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
}
