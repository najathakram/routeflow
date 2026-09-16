import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { TenantStatusGuard } from "../tenant/tenant-status.guard";
import { roundMoney } from "@routeflow/pricing";
import { PlanCatalogService, PlanVersionWithCatalog } from "./plan-catalog.service";
import { ProrationService } from "./proration.service";
import { SubscriptionService } from "./subscription.service";
import { EntitlementsService } from "./entitlements.service";
import { BillingEventService } from "./billing-event.service";
import { StripeService } from "./stripe.service";
import { isStripeResourceMissing } from "./addon.service";
import { withAdvisoryLock, LockTimeoutError, LockUnavailableError } from "../common/db-locks";
import {
  BILLING_EVENTS,
  findPlanDefinition,
  planRank,
  planKeyFromEnum,
  planKeyToEnum,
  normalizePlanKey,
  addonSkuCode,
  SELF_SERVICE_ADDON_SKUS,
  isInviteOnlyPlanKey,
} from "./plan-catalog.constants";
import { addCycle, Cycle } from "./billing-math";
import { BillingNotificationService } from "./billing-notification.service";

export interface SubscribeInput {
  planKey: string;
  cycle: Cycle;
  addons?: Array<{ sku: string; quantity?: number }>;
}

export type PlanChangeAction =
  "SUBSCRIBE" | "UPGRADE" | "DOWNGRADE" | "NOOP" | "KEEP_CURRENT" | "CONTACT_SALES";

/** Custom (Enterprise) plans are negotiated, never self-service — the same refusal
 *  subscribe()/upgrade()/downgrade() throw, surfaced by the preview as an action. */
const CUSTOM_PLAN_MESSAGE = "Enterprise is a custom plan — contact sales.";

/** Committing an UPGRADE or a DOWNGRADE writes `cancelAtPeriodEnd: false`, so a tenant who
 *  had cancelled must be told at the decision point that the cancellation is being called off. */
const CANCELLATION_REVOKED_WARNING =
  "A cancellation is pending — this change keeps your subscription active.";

/**
 * Read-only classification of what picking `planKey`/`cycle` would DO to an existing
 * subscription — the choose-plan UI's routing decision (upgrade vs. downgrade vs. plain
 * subscribe) computed server-side so the client never has to re-derive plan rank. Ranking
 * uses the server's `planRank` (never a client-side sortOrder).
 */
export interface PlanChangePreview {
  action: PlanChangeAction;
  /** Prorated charge due now — set only for UPGRADE; null otherwise. */
  proratedNow: number | null;
  /** When a scheduled DOWNGRADE takes effect (period end); null otherwise. */
  effectiveAt: Date | null;
  /** For UPGRADE: the renewal date is unchanged (instant, same-period application). */
  keepsRenewalAt: Date | null;
  /** The plan the tenant is on, NORMALIZED (a stored legacy alias resolves to its current
   *  key) — so the chooser marks the right card as "your plan" for an alias tenant, whose
   *  stored key (BUSINESS) never matches a listed catalog key (SCALE). Null when there is
   *  nothing to change from. */
  fromPlanKey: string | null;
  /** Set for an edge case worth surfacing (e.g. a cycle switch, or a pending
   *  schedule KEEP_CURRENT would cancel), never a hard block. */
  warning?: string;
  /** TRUE only when committing this change WOULD deactivate staff: the DOWNGRADE seat-cap
   *  check found the active team over the target plan's `seatsIncluded`. ALWAYS present, so
   *  the chooser gates its "these users will be deactivated" acknowledgement on THIS flag and
   *  never on `warning` being non-empty — `warning` composes unrelated notices (a revoked
   *  cancellation, a cycle switch), and inferring the seat consequence from its mere presence
   *  made the UI demand consent to a deactivation that would never happen. */
  seatAckRequired: boolean;
}

/** A SKU a TENANT_ADMIN may add or drop themselves. Everything else "ships dark" —
 *  platform-admin grants it (see SELF_SERVICE_ADDON_SKUS). */
function isSelfServiceAddon(sku: string): boolean {
  return (SELF_SERVICE_ADDON_SKUS as readonly string[]).includes(sku);
}

/**
 * B408: the Stripe subscription statuses there is NOTHING LEFT TO CANCEL from. Reaching one of
 * these is the desired end state of a cancel, so `cancel()`'s READ_ONLY branch treats it as
 * success and drops the dead `stripeSubId` rather than throwing.
 *
 * - `canceled` — the subscription was cancelled. The end state itself.
 * - `incomplete_expired` — the FIRST invoice was never paid inside Stripe's window, so the
 *   subscription expired without ever activating. It can never be revived or charged, and
 *   `cancelSubscription` on it 400s exactly like `canceled`.
 *
 * Deliberately NOT terminal, because each can still be cancelled and a cancel there is a real
 * state change we must not swallow: `active`, `trialing`, `past_due`, `unpaid` (retries are
 * exhausted but the subscription lives and still bills on repair), `paused` (resumable), and
 * `incomplete` (the first payment can still succeed). Treating any of those as "nothing to do"
 * would drop the tenant's cancellation on the floor and keep Stripe invoicing — the opposite
 * defect, and a worse one.
 */
const STRIPE_TERMINAL_STATUSES: ReadonlySet<string> = new Set(["canceled", "incomplete_expired"]);

const ADMIN_ONLY_ADDON_MESSAGE =
  "This add-on is enabled by RouteFlow for your workspace — contact support";

/**
 * Subscription state MUTATIONS (Plans & Billing Phase 4). Owns the tenant's
 * entitlement state — plan, add-ons, cycle, schedule — and emits a BillingEvent for
 * every transition (the MRR source of truth). Every emitted `amountDelta` is a signed
 * CHANGE to the monthly run-rate, so the Phase-6 rollup = Σ amountDelta. State-write
 * and audit-emit are wrapped in ONE transaction (all-or-nothing). Upgrades apply
 * INSTANTLY (prorated); downgrades + cancels are SCHEDULED at period end (applied by
 * the Phase-5 cron); disabling an add-on keeps its row (history read-only, never deletes).
 * subscribe() REFUSES an ACTIVE, same-cycle pick (B58): a different rank belongs on
 * upgrade()/downgrade(), which apply/schedule correctly instead of resetting the period, and
 * the same rank is the plan the tenant already has (under a renamed key) — nothing to change.
 * planChangePreview() is the read-only classifier the choose-plan quote uses to route between
 * those and resume() (KEEP_CURRENT), and it compares NORMALIZED plan keys, so a legacy alias
 * reads as the plan it was renamed to. At most ONE transition is ever armed: every committing
 * path here clears the markers the others write — as do platform-admin's plan writers and the
 * Stripe webhook writers (platform-admin.service.ts, billing.service.ts).
 *
 * Payment rails (Stripe card capture) are orthogonal (BillingService/StripeService);
 * this service owns the internal entitlement state.
 */
@Injectable()
export class SubscriptionMutationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: PlanCatalogService,
    private readonly proration: ProrationService,
    private readonly subscription: SubscriptionService,
    private readonly entitlements: EntitlementsService,
    private readonly events: BillingEventService,
    private readonly tenantStatus: TenantStatusGuard,
    // STRIPE-CANCEL-1: cancel()/resume() must tell Stripe about a self-serve schedule change
    // for a row provisioned via a super-admin checkout link (stripeSubId set) — otherwise the
    // Stripe subscription keeps invoicing after our local cancellation. Already provided by
    // BillingModule; no module change needed.
    private readonly stripe: StripeService,
    private readonly billingNotification: BillingNotificationService,
  ) {}

  private readonly logger = new Logger(SubscriptionMutationService.name);

  /**
   * The plan the tenant is changing FROM. `TenantSubscription.planKey` is nullable — a
   * subscription that predates plans-as-data carries its plan only in the legacy
   * `Tenant.plan` enum — so resolve it the way `entitlements.service` and
   * `platform-pricing.service` already do before ranking. Reading `planKey` alone reads a
   * legacy row as "no plan at all" and drops it onto subscribe()'s period-resetting path,
   * which is the exact harm the B58 guard exists to prevent. Null only when there is neither
   * a subscription planKey nor a loaded tenant row — `Tenant.plan` is non-nullable
   * (`@default(STARTER)`), so a loaded tenant always resolves to a key. Callers must NOT use
   * its nullness as a "has a subscription" check: that is `sub.planKey` (plus the tenant's
   * status for a legacy row that carries its plan only in the enum).
   */
  private resolveFromPlanKey(
    subPlanKey: string | null | undefined,
    tenantPlan: string | null | undefined,
  ): string | null {
    return normalizePlanKey(subPlanKey) ?? (tenantPlan ? planKeyFromEnum(tenantPlan) : null);
  }

  private planMonthly(version: PlanVersionWithCatalog, planKey: string | null | undefined): number {
    if (!planKey) return 0;
    const d = findPlanDefinition(version.definitions, planKey);
    return d?.monthlyPrice != null ? Number(d.monthlyPrice) : 0;
  }

  /** Commit a subscription / convert a trial by picking a plan (+ optional add-ons). */
  async subscribe(tenantId: string, input: SubscribeInput, actorId?: string) {
    const version = await this.catalog.getPublishedCatalog();
    const def = version.definitions.find((d) => d.planKey === input.planKey);
    if (!def) throw new BadRequestException(`Unknown plan "${input.planKey}"`);
    if (def.isCustom) throw new BadRequestException("Enterprise is a custom plan — contact sales.");
    // S5/WP3a: LITE (and any future invite-only plan) can only be landed on via an explicit
    // platform-admin action — never this self-service surface. Enforced here, not just in the
    // UI, so this is the structural gate the whole invite-only lane depends on.
    if (isInviteOnlyPlanKey(input.planKey)) {
      throw new BadRequestException(
        `Plan "${input.planKey}" is available by invitation only — contact us.`,
      );
    }
    // B218: `def` only proves `input.planKey` matches a PUBLISHED catalog definition
    // verbatim — nothing stops a published PlanDefinition's key from being outside
    // PLAN_KEYS (a catalog-publishing bug), and this IS the client-reachable path (the
    // client picks from whatever /billing/quote actually offers). Left unchecked,
    // planKeyToEnum() below now THROWS instead of silently writing STARTER, which would
    // otherwise crash the request with a 500 for what is really a 400 — refuse it here,
    // the same seam planChangePreview() already guards for the ranking paths.
    if (!normalizePlanKey(input.planKey)) {
      throw new BadRequestException(
        `Plan "${input.planKey}" is not a recognized plan key — contact support.`,
      );
    }
    const quote = await this.proration.quote({
      planKey: input.planKey,
      cycle: input.cycle,
      addons: input.addons,
    });

    // Prior state — MRR is accounted as the CHANGE from this baseline.
    const [tenant, priorSub, priorAddons] = await Promise.all([
      this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { status: true, plan: true },
      }),
      this.prisma.tenantSubscription.findUnique({
        where: { tenantId },
        select: { planKey: true, cycle: true, periodEnd: true },
      }),
      this.prisma.tenantAddon.findMany({ where: { tenantId, active: true } }),
    ]);
    if (!tenant) throw new NotFoundException("Tenant not found");

    // The plan we are changing FROM — resolved through the legacy enum, so a subscription
    // predating plans-as-data (planKey NULL) is ranked instead of read as "no plan".
    const fromKey = this.resolveFromPlanKey(priorSub?.planKey, tenant.plan);

    // An ACTIVE, same-cycle pick belongs anywhere but here — subscribe() resetting
    // periodStart/periodEnd would silently re-bucket metering and jump the renewal date (B58).
    // A DIFFERENT rank belongs on upgrade()/downgrade() (instant-prorated vs.
    // scheduled-at-period-end). The SAME rank is the same plan under a renamed key (a v7
    // BUSINESS re-picked as the v8 SCALE): there is nothing to change, and re-subscribing to
    // "re-pin" the catalog version would pay for that pin with the same period reset — so it is
    // refused too, and the re-pin is left to platform-admin / the cron that already write it.
    // A subscription with NO periodEnd has no live cycle to protect (and downgrade() could not
    // schedule against it), so it stays here: subscribe() is what heals the missing period.
    if (
      tenant.status === "ACTIVE" &&
      priorSub &&
      fromKey &&
      priorSub.periodEnd != null &&
      priorSub.cycle === input.cycle
    ) {
      const sameRank = planRank(input.planKey) === planRank(fromKey);
      // The ONE same-rank pick that really is a change: a row with no stored planKey (the
      // manual-activation shape) contributes 0 to the MRR snapshot until it gains one, and
      // upgrade() only moves UP — so subscribe() is what heals it, and refusing it here would
      // strand the row plan-less forever.
      if (!sameRank || priorSub.planKey != null) {
        // A handled 4xx is otherwise invisible — SentryExceptionFilter captures >= 500 only and
        // there is no access log — so a money-path refusal logs like addon.guard.ts's denials.
        this.logger.warn(
          `B58 guard refused subscribe tenant=${tenantId} from=${fromKey} to=${input.planKey} cycle=${input.cycle} sameRank=${sameRank}`,
        );
        throw new ConflictException(
          sameRank
            ? "You are already on this plan — nothing to change"
            : "Your subscription is active — use upgrade or downgrade to change plan",
        );
      }
    }

    const wasTrial = tenant.status === "TRIAL";
    const now = new Date();
    const periodEnd = addCycle(now, input.cycle);

    const skuByCode = new Map(version.addonSkus.map((s) => [s.sku, s]));
    const monthlyOf = (code: string) => {
      const m = skuByCode.get(code);
      return m ? Number(m.monthlyPrice) : 0;
    };

    // Reconcile desired (from input) against prior-active add-ons. This is the same
    // TENANT_ADMIN self-service surface as enableAddon(), so an admin-only ("ships dark")
    // SKU is a 403 here too — otherwise subscribe() is a back door around that gate.
    const desired = new Map<string, number>();
    for (const a of input.addons ?? []) {
      if (!skuByCode.has(a.sku)) continue;
      if (!isSelfServiceAddon(a.sku)) throw new ForbiddenException(ADMIN_ONLY_ADDON_MESSAGE);
      desired.set(a.sku, Math.max(1, Math.trunc(a.quantity ?? 1)));
    }
    const priorByCode = new Map<string, { id: string; qty: number }>();
    for (const row of priorAddons) {
      const code = addonSkuCode(row);
      if (code) priorByCode.set(code, { id: row.id, qty: row.quantity });
    }
    // Only self-service add-ons are the tenant's to drop: an admin-granted SKU the payload
    // is not even allowed to name must not be revoked by omitting it.
    const toDisable = [...priorByCode.keys()].filter(
      (c) => !desired.has(c) && isSelfServiceAddon(c),
    );

    // Coming from a NON-paying status (READ_ONLY / SUSPENDED / CANCELLED / TRIAL) the tenant
    // still carries its old planKey but contributes 0 to the run-rate — so re-entry is a full
    // +base delta, mirroring the negative delta emitted when access ended (billing-cron
    // applyScheduledCancellations). Only an already-ACTIVE tenant nets against its old plan.
    // A row with a NULL planKey is excluded from `MrrService`'s snapshot the same way
    // (`planKey: { not: null }`) — e.g. a manual platform-admin activation — so it too
    // contributes 0 and writing a planKey onto it books the full base, even though `fromKey`
    // resolves through the legacy enum for ranking.
    const oldPlanMonthly =
      tenant.status === "ACTIVE" && priorSub?.planKey ? this.planMonthly(version, fromKey) : 0;

    await this.prisma.$transaction(async (tx) => {
      await tx.tenantSubscription.upsert({
        where: { tenantId },
        create: {
          tenantId,
          planVersionId: version.id,
          planKey: input.planKey,
          currentPlan: planKeyToEnum(input.planKey),
          cycle: input.cycle,
          periodStart: now,
          periodEnd,
          basePriceSnapshot: def.monthlyPrice,
          trialConvertedAt: wasTrial ? now : null,
        },
        update: {
          planVersionId: version.id,
          planKey: input.planKey,
          currentPlan: planKeyToEnum(input.planKey),
          cycle: input.cycle,
          periodStart: now,
          periodEnd,
          basePriceSnapshot: def.monthlyPrice,
          cancelAtPeriodEnd: false,
          downgradeToPlanKey: null,
          downgradeEffectiveAt: null,
          trialConvertedAt: wasTrial ? now : undefined,
        },
      });
      await tx.tenant.update({
        where: { id: tenantId },
        data: {
          status: "ACTIVE",
          planVersionId: version.id,
          plan: planKeyToEnum(input.planKey),
          // An ACTIVE tenant otherwise keeps a stale "trial_cancelled"/"trial_expired" forever
          // (RO-1 now ships this to the client) — subscribing clears it.
          readOnlyReason: null,
        },
      });
      for (const [code, qty] of desired) {
        const meta = skuByCode.get(code)!;
        await tx.tenantAddon.upsert({
          where: { tenantId_addonKey: { tenantId, addonKey: code } },
          create: {
            tenantId,
            addonKey: code,
            sku: code,
            quantity: qty,
            active: true,
            priceSnapshot: meta.monthlyPrice,
          },
          update: { sku: code, quantity: qty, active: true, priceSnapshot: meta.monthlyPrice },
        });
      }
      for (const code of toDisable) {
        await tx.tenantAddon.update({
          where: { id: priorByCode.get(code)!.id },
          data: { active: false },
        });
      }

      // ── Events (MRR = signed CHANGE) inside the same transaction ──
      if (wasTrial) {
        await this.events.emit(
          tenantId,
          BILLING_EVENTS.TRIAL_CONVERTED,
          { planKey: input.planKey },
          { actorId, tx },
        );
      }
      await this.events.emit(
        tenantId,
        BILLING_EVENTS.PLAN_CHANGED,
        { fromPlan: priorSub?.planKey ?? null, toPlan: input.planKey, cycle: input.cycle },
        { amountDelta: roundMoney(Number(def.monthlyPrice ?? 0) - oldPlanMonthly), actorId, tx },
      );
      for (const [code, qty] of desired) {
        const prior = priorByCode.get(code);
        const deltaQty = qty - (prior?.qty ?? 0);
        if (deltaQty === 0) continue; // already active at this quantity → no MRR change
        await this.events.emit(
          tenantId,
          BILLING_EVENTS.ADDON_ENABLED,
          { sku: code, quantity: qty },
          { amountDelta: roundMoney(monthlyOf(code) * deltaQty), actorId, tx },
        );
        if (code === "SEAT_EXTRA" && !prior) {
          await this.events.emit(
            tenantId,
            BILLING_EVENTS.SEAT_ADDED,
            { quantity: qty },
            { actorId, tx },
          );
        }
      }
      for (const code of toDisable) {
        const prior = priorByCode.get(code)!;
        await this.events.emit(
          tenantId,
          BILLING_EVENTS.ADDON_DISABLED,
          { sku: code },
          { amountDelta: roundMoney(-monthlyOf(code) * prior.qty), actorId, tx },
        );
        if (code === "SEAT_EXTRA") {
          await this.events.emit(
            tenantId,
            BILLING_EVENTS.SEAT_FREED,
            { quantity: prior.qty },
            { actorId, tx },
          );
        }
      }
    });

    this.entitlements.invalidate(tenantId);
    this.tenantStatus.invalidate(tenantId);
    return { quote, subscription: await this.subscription.getSubscription(tenantId) };
  }

  /**
   * Classify what picking `planKey`/`cycle` would DO to the tenant's current subscription,
   * for /billing/quote's choose-plan routing (REG-B58): a fresh subscribe, an instant
   * prorated upgrade, a scheduled-at-period-end downgrade, a no-op, or KEEP_CURRENT —
   * re-picking the plan you are already on WHILE a downgrade or cancellation is armed,
   * which is the tenant's self-service undo (it clears the schedule via resume(), never by
   * re-subscribing, since that would reset the period). Never mutates anything — read-only,
   * safe to call on every quote.
   */
  async planChangePreview(
    tenantId: string,
    planKey: string,
    cycle: Cycle,
  ): Promise<PlanChangePreview> {
    const toKey = normalizePlanKey(planKey);

    const [tenant, priorSub] = await Promise.all([
      this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { status: true, plan: true },
      }),
      this.prisma.tenantSubscription.findUnique({
        where: { tenantId },
        select: {
          planKey: true,
          planVersionId: true,
          cycle: true,
          periodStart: true,
          periodEnd: true,
          downgradeToPlanKey: true,
          cancelAtPeriodEnd: true,
        },
      }),
    ]);

    // Ranking reads the plan through the legacy enum (a pre-plans-as-data row has a NULL
    // planKey). A subscription with no periodEnd has no cycle to upgrade within or schedule
    // against — the cron only ever picks up a non-null downgradeEffectiveAt — so it routes to
    // SUBSCRIBE, which is what sets the period.
    const fromKey = this.resolveFromPlanKey(priorSub?.planKey, tenant?.plan);
    if (tenant?.status !== "ACTIVE" || !priorSub || !fromKey || priorSub.periodEnd == null) {
      return {
        action: "SUBSCRIBE",
        proratedNow: null,
        effectiveAt: null,
        keepsRenewalAt: null,
        fromPlanKey: fromKey,
        seatAckRequired: false,
      };
    }

    // A key outside PLAN_KEYS ranks -1 — "lower than every plan" — so ranking it would
    // classify it as a DOWNGRADE from anything, and downgrade() would accept the schedule the
    // cron then applies with a NULL base price. A published definition whose key is not in
    // PLAN_KEYS is a publishing error: refuse it at the seam instead of ranking it — but ONLY
    // on the paths that actually RANK. Refusing above the branch took the whole /billing/quote
    // down for every tenant on that card, including the fresh-subscribe path, which never ranks
    // and prices the definition correctly from the published catalog.
    if (!toKey) throw new BadRequestException(`Unknown plan "${planKey}"`);

    // Same-plan compares NORMALIZED keys on both sides: a tenant whose stored key is a legacy
    // alias (v7 BUSINESS) IS on the plan the catalog now lists as SCALE, so re-picking it is
    // "your current plan", never a change. Comparing the raw stored key made that pick fall
    // through to SUBSCRIBE, which resets periodStart/periodEnd (the B58 harm) and wipes a
    // pending downgrade — and left an alias tenant unable to reach NOOP/KEEP_CURRENT at all.
    const samePlan = fromKey === toKey;
    const sameCycle = priorSub.cycle === cycle;

    if (samePlan && sameCycle) {
      // Re-picking your own plan with a transition armed is the ONLY self-service way to call
      // one off: subscribe() used to clear these fields as a side effect, and nothing else
      // clears downgradeToPlanKey except the cron that applies it.
      if (priorSub.downgradeToPlanKey != null || priorSub.cancelAtPeriodEnd) {
        return {
          action: "KEEP_CURRENT",
          proratedNow: null,
          effectiveAt: null,
          keepsRenewalAt: priorSub.periodEnd,
          fromPlanKey: fromKey,
          seatAckRequired: false,
          warning: "A scheduled change is pending — keeping your current plan cancels it.",
        };
      }
      return {
        action: "NOOP",
        proratedNow: null,
        effectiveAt: null,
        keepsRenewalAt: null,
        fromPlanKey: fromKey,
        seatAckRequired: false,
      };
    }

    // Fetched HERE, not at the top: `getPublishedCatalog()` is uncached and `proration.quote`
    // already runs it on every /billing/quote — the SUBSCRIBE/NOOP/KEEP_CURRENT returns above
    // must not pay for it a second time. Every branch below reads it.
    const version = await this.catalog.getPublishedCatalog();
    const publishedTargetDef = findPlanDefinition(version.definitions, toKey);
    const publishedSourceDef = findPlanDefinition(version.definitions, fromKey);
    // Custom (Enterprise) plans are negotiated, on BOTH sides: subscribe() and upgrade() already
    // refuse a custom target, and downgrade() now refuses a custom source — whose negotiated fee
    // lives in `priceOverrideMonthly` with a NULL catalog price, so ranking it would quote a
    // negative "due today" going in and book a POSITIVE MRR delta coming out. Screened before
    // ranking; a same-plan custom source still reaches NOOP/KEEP_CURRENT above.
    if (publishedTargetDef?.isCustom || publishedSourceDef?.isCustom) {
      return {
        action: "CONTACT_SALES",
        proratedNow: null,
        effectiveAt: null,
        keepsRenewalAt: null,
        fromPlanKey: fromKey,
        seatAckRequired: false,
        warning: CUSTOM_PLAN_MESSAGE,
      };
    }

    if (!sameCycle) {
      // A cycle switch is a residual (no self-service credited path yet) — routed through
      // subscribe() like a fresh pick, flagged so the UI can warn the tenant. Equal-rank pairs
      // reach SUBSCRIBE only HERE now: same rank means the same normalized plan, which with the
      // same cycle is NOOP/KEEP_CURRENT above.
      // subscribe()'s upsert `update` branch writes `cancelAtPeriodEnd: false`,
      // `downgradeToPlanKey: null` and `downgradeEffectiveAt: null`, so committing a cycle
      // switch disarms whatever transition was armed — the same silent revocation the
      // UPGRADE/DOWNGRADE branches warn about. Composed with the proration notice, never traded.
      const cycleWarnings = [
        "Switching billing cycle takes effect immediately and is not prorated.",
      ];
      if (priorSub.cancelAtPeriodEnd) cycleWarnings.push(CANCELLATION_REVOKED_WARNING);
      if (priorSub.downgradeToPlanKey != null) {
        cycleWarnings.push("A scheduled downgrade is pending — switching cycle cancels it.");
      }
      return {
        action: "SUBSCRIBE",
        proratedNow: null,
        effectiveAt: null,
        keepsRenewalAt: null,
        fromPlanKey: fromKey,
        seatAckRequired: false,
        warning: cycleWarnings.join(" "),
      };
    }

    const rankFrom = planRank(fromKey);
    const rankTo = planRank(toKey);
    if (rankTo > rankFrom) {
      const oldMonthly = this.planMonthly(version, fromKey);
      const newMonthly =
        publishedTargetDef?.monthlyPrice != null ? Number(publishedTargetDef.monthlyPrice) : 0;
      const proratedNow = this.proration.proratedDiff(
        { cycle: priorSub.cycle, periodStart: priorSub.periodStart, periodEnd: priorSub.periodEnd },
        newMonthly - oldMonthly,
      );
      return {
        action: "UPGRADE",
        proratedNow,
        effectiveAt: null,
        keepsRenewalAt: priorSub.periodEnd,
        fromPlanKey: fromKey,
        seatAckRequired: false,
        // upgrade() writes `cancelAtPeriodEnd: false` — say so before the tenant commits.
        ...(priorSub.cancelAtPeriodEnd ? { warning: CANCELLATION_REVOKED_WARNING } : {}),
      };
    }
    // Seat consequence, surfaced at the decision point: a scheduled downgrade is applied by
    // billing-cron.service.ts `applyScheduledDowngrades`, which — when the active team is over
    // the target plan's cap — deactivates every OPERATOR/DRIVER not in `retainedUserIds` (the
    // self-service path schedules with an empty list). BOTH sides of the warning read the cron's
    // sources: the same activeTeam where-clause, and the same catalog version — the tenant's
    // PINNED `planVersionId` via `getVersionForTenant` (grandfathering), never the published one,
    // which for a tenant pinned to an older version quotes a different seat cap than the sweep
    // enforces. So the warning fires exactly when the sweep would, with that version's numbers.
    const downgradeVersion = await this.catalog.getVersionForTenant(priorSub.planVersionId);
    const targetDef = findPlanDefinition(downgradeVersion.definitions, toKey);
    const seatsIncluded = targetDef?.seatsIncluded ?? null;
    // downgrade() writes `cancelAtPeriodEnd: false` — the same silent revocation the UPGRADE
    // branch warns about. Both notices can apply at once, so they are composed, never traded.
    const warnings: string[] = [];
    // The seat consequence as its OWN signal: true only here, so a preview carrying an
    // unrelated warning (a revoked cancellation) never reads as "staff will be deactivated".
    let seatAckRequired = false;
    if (priorSub.cancelAtPeriodEnd) warnings.push(CANCELLATION_REVOKED_WARNING);
    if (seatsIncluded != null) {
      const activeTeam = await this.prisma.user.count({
        where: {
          tenantId,
          role: { in: ["TENANT_ADMIN", "OPERATOR", "DRIVER"] },
          status: "ACTIVE",
          deletedAt: null,
        },
      });
      if (activeTeam > seatsIncluded) {
        seatAckRequired = true;
        warnings.push(
          `Your team has ${activeTeam} active users but the ${targetDef?.name ?? planKey} plan ` +
            `includes ${seatsIncluded} seats — every operator and driver account will be ` +
            `deactivated when the downgrade takes effect. Contact support before then to choose ` +
            `which users to keep.`,
        );
      }
    }
    return {
      action: "DOWNGRADE",
      proratedNow: null,
      effectiveAt: priorSub.periodEnd,
      keepsRenewalAt: null,
      fromPlanKey: fromKey,
      seatAckRequired,
      ...(warnings.length ? { warning: warnings.join(" ") } : {}),
    };
  }

  /** Upgrade to a higher plan — instant, with the prorated price difference charged now. */
  async upgrade(tenantId: string, planKey: string, actorId?: string) {
    const version = await this.catalog.getPublishedCatalog();
    const def = version.definitions.find((d) => d.planKey === planKey);
    if (!def) throw new BadRequestException(`Unknown plan "${planKey}"`);
    if (def.isCustom) throw new BadRequestException("Enterprise is a custom plan — contact sales.");
    // S5/WP3a: same invite-only gate as subscribe() — blocks moving TO an invite-only plan
    // (LITE) only; moving AWAY from one (the upsell path, R2.6) is never touched by this check.
    if (isInviteOnlyPlanKey(planKey)) {
      throw new BadRequestException(
        `Plan "${planKey}" is available by invitation only — contact us.`,
      );
    }

    const [sub, tenant] = await Promise.all([
      this.prisma.tenantSubscription.findUnique({ where: { tenantId } }),
      this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { plan: true, status: true },
      }),
    ]);
    const fromKey = this.resolveFromPlanKey(sub?.planKey, tenant?.plan);
    // `fromKey` is never null for a loaded tenant (Tenant.plan defaults to STARTER), so it is
    // NOT the precondition. A row with no planKey of its own is only a real subscription when
    // the tenant is already ACTIVE (the manual-activation shape); otherwise it is a stub minted
    // by Stripe-customer creation or the customer-cap grace window on a tenant that never
    // subscribed — upgrading that would convert a trial without ever setting a period.
    // (`!fromKey` retained only for the one case it can still be null — no tenant row at all —
    // which was refused before this guard existed, and it narrows the type.)
    if (!sub || !fromKey || (!sub.planKey && tenant?.status !== "ACTIVE")) {
      throw new BadRequestException("No active subscription — subscribe first.");
    }
    // B218: this ALSO already refuses an off-catalog `planKey` before planKeyToEnum() is ever
    // called below — `planRank` normalizes and returns -1 for anything outside PLAN_KEYS /
    // LEGACY_PLAN_KEY_ALIASES, `fromKey` is always a real (non-negative) rank by this point
    // (guarded above), and -1 can never be > a real rank, so the check below rejects it as
    // "not an upgrade" rather than ranking it. The message doesn't name the real reason, but
    // no separate off-catalog guard is needed here — adding one would be redundant.
    if (planRank(planKey) <= planRank(fromKey)) {
      throw new BadRequestException("Target is not an upgrade — use downgrade for a lower plan.");
    }

    const oldMonthly = this.planMonthly(version, fromKey);
    const newMonthly = def.monthlyPrice != null ? Number(def.monthlyPrice) : 0;
    // The ledger nets against what the MRR snapshot actually counted, which excludes rows with
    // a NULL planKey (`MrrService` filters `planKey: { not: null }`) — such a row contributes 0
    // to the run-rate, so gaining a planKey books the FULL base. The prorated charge nets against
    // the entitlement instead: the tenant already holds `fromKey` and owes only the difference.
    const ledgerOldMonthly = sub.planKey ? oldMonthly : 0;
    const amountDelta = roundMoney(newMonthly - ledgerOldMonthly);
    const proratedNow = this.proration.proratedDiff(sub, newMonthly - oldMonthly);

    await this.prisma.$transaction(async (tx) => {
      // Optimistic guard: only apply if still on the expected plan (blocks a concurrent
      // double-upgrade from re-emitting the delta). Matches the STORED key (null matches
      // IS NULL), never the resolved one.
      const applied = await tx.tenantSubscription.updateMany({
        where: { tenantId, planKey: sub.planKey },
        data: {
          planKey,
          currentPlan: planKeyToEnum(planKey),
          planVersionId: version.id,
          basePriceSnapshot: def.monthlyPrice,
          // Committing a plan change disarms every OTHER pending transition — the same fields
          // subscribe() clears. Leaving a downgrade armed would silently drop the tenant back
          // off the plan they just paid to upgrade to (billing-cron applyScheduledDowngrades
          // filters on downgradeEffectiveAt alone, never on rank or current plan), and a left
          // cancellation would take them READ_ONLY at period end.
          cancelAtPeriodEnd: false,
          downgradeToPlanKey: null,
          downgradeEffectiveAt: null,
        },
      });
      if (applied.count === 0) {
        throw new BadRequestException("Plan changed concurrently — please retry.");
      }
      await tx.tenant.update({
        where: { id: tenantId },
        data: { plan: planKeyToEnum(planKey), planVersionId: version.id },
      });
      await this.events.emit(
        tenantId,
        BILLING_EVENTS.PLAN_CHANGED,
        { fromPlan: fromKey, toPlan: planKey, instant: true, prorated: proratedNow },
        { amountDelta, actorId, tx },
      );
    });

    this.entitlements.invalidate(tenantId);

    // N3: best-effort admin notification, never blocks the upgrade above. `proratedNow` is
    // the SAME value just committed to the event/ledger above — never recomputed here.
    const fromDef = version.definitions.find((d) => d.planKey === fromKey);
    try {
      await this.billingNotification.notifyUpgradeConfirmed(
        tenantId,
        fromDef?.name ?? fromKey,
        def.name,
        proratedNow,
      );
    } catch (e) {
      this.logger.error(
        `N3 notifyUpgradeConfirmed threw unexpectedly for tenant ${tenantId}`,
        e as Error,
      );
    }

    return { proratedNow, subscription: await this.subscription.getSubscription(tenantId) };
  }

  /** Schedule a downgrade at period end (no proration/credit; nothing deleted). */
  async downgrade(
    tenantId: string,
    targetPlanKey: string,
    retainedUserIds: string[],
    actorId?: string,
  ) {
    const version = await this.catalog.getPublishedCatalog();
    const def = version.definitions.find((d) => d.planKey === targetPlanKey);
    if (!def) throw new BadRequestException(`Unknown plan "${targetPlanKey}"`);
    // A published key outside PLAN_KEYS ranks -1, which passes the rank check below against
    // every plan and schedules a downgrade the cron applies with a NULL base price (free
    // tenant). Refuse it here rather than letting -1 read as "the lowest plan".
    if (planRank(targetPlanKey) < 0) {
      throw new BadRequestException(`Unknown plan "${targetPlanKey}"`);
    }
    // S5/WP3a: same invite-only gate as subscribe()/upgrade() — a downgrade landing ON LITE is
    // still a self-service pick of an invite-only plan and must be refused the same way.
    if (isInviteOnlyPlanKey(targetPlanKey)) {
      throw new BadRequestException(
        `Plan "${targetPlanKey}" is available by invitation only — contact us.`,
      );
    }
    const [sub, tenant] = await Promise.all([
      this.prisma.tenantSubscription.findUnique({ where: { tenantId } }),
      this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { plan: true, status: true },
      }),
    ]);
    const fromKey = this.resolveFromPlanKey(sub?.planKey, tenant?.plan);
    // Same precondition as upgrade() (see there): a planKey-NULL row is a real subscription
    // only on an already-ACTIVE tenant, never a stub on one that never subscribed.
    if (!sub || !fromKey || (!sub.planKey && tenant?.status !== "ACTIVE")) {
      throw new BadRequestException("No active subscription.");
    }
    // Custom (Enterprise) on EITHER side is negotiated, exactly as subscribe()/upgrade() already
    // refuse a custom target. A custom SOURCE prices from `priceOverrideMonthly` with a NULL
    // catalog price, so the cron would book `0 − 0 = +targetPrice` as the "downgrade" delta and
    // overwrite the negotiated basePriceSnapshot with the catalog's.
    if (def.isCustom || findPlanDefinition(version.definitions, fromKey)?.isCustom) {
      throw new BadRequestException(CUSTOM_PLAN_MESSAGE);
    }
    if (planRank(targetPlanKey) >= planRank(fromKey)) {
      throw new BadRequestException("Target is not a downgrade — use upgrade for a higher plan.");
    }
    // A null periodEnd would persist `downgradeEffectiveAt: null`, which
    // applyScheduledDowngrades filters OUT — a schedule the UI reports as accepted and the
    // cron can never apply. Refuse instead of writing one.
    if (!sub.periodEnd) {
      throw new BadRequestException(
        "This subscription has no billing period end — subscribe to set one before scheduling a downgrade.",
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.tenantSubscription.update({
        where: { tenantId },
        data: {
          downgradeToPlanKey: targetPlanKey,
          downgradeEffectiveAt: sub.periodEnd,
          retainedUserIds,
          // Exactly one transition may be armed: scheduling a downgrade replaces a pending
          // cancellation rather than stacking on top of it.
          cancelAtPeriodEnd: false,
        },
      });
      await this.events.emit(
        tenantId,
        BILLING_EVENTS.PLAN_DOWNGRADE_SCHEDULED,
        { toPlan: targetPlanKey, effectiveAt: sub.periodEnd, retainedUserIds },
        { amountDelta: 0, actorId, tx },
      );
    });

    // N3: best-effort admin notification, never blocks the schedule write above.
    const fromDefDown = version.definitions.find((d) => d.planKey === fromKey);
    try {
      await this.billingNotification.notifyDowngradeScheduled(
        tenantId,
        fromDefDown?.name ?? fromKey,
        def.name,
        sub.periodEnd,
      );
    } catch (e) {
      this.logger.error(
        `N3 notifyDowngradeScheduled threw unexpectedly for tenant ${tenantId}`,
        e as Error,
      );
    }

    // Entitlements unchanged until the cron applies it at period end.
    return this.subscription.getSubscription(tenantId);
  }

  /**
   * Schedule cancellation at period end (reversible via resume) — OR, for a tenant with no
   * `TenantSubscription` row (every fresh trial: `register()`/`createTenant()` write no row;
   * see build-plan.md S0), key on `Tenant.status` directly instead of 404ing.
   *
   * TRIAL-1: the no-row state is TEMPORARY (a Phase 0 reconciliation will backfill rows
   * later) — this must be correct in BOTH worlds, so it never assumes no-row is steady
   * state. READ_ONLY short-circuits FIRST, regardless of row: a read-only tenant is already
   * where cancellation lands, so a repeat call is an idempotent no-op — never a fresh write
   * or a fresh SUBSCRIPTION_CANCELED ledger row. `TRIAL` → end the trial now (mirrors
   * `billing-cron.service.ts` `expireTrials()`) via a compare-and-swap on `Tenant.status`,
   * deliberately leaving any `TenantSubscription` row untouched (see below for why). Any
   * other status with no row → the existing 404 (a genuine anomaly today).
   */
  async cancel(tenantId: string, actorId?: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { status: true },
    });

    // Already read-only — with or without a row — is where cancellation lands. Checked
    // FIRST and unconditionally: the old with-row path below re-armed cancelAtPeriodEnd and
    // wrote a fresh SUBSCRIPTION_CANCELED ledger row on every repeat call.
    if (tenant?.status === "READ_ONLY") {
      // STRIPE-CANCEL-2: applyScheduledCancellations (billing-cron.service.ts) flips a tenant
      // to READ_ONLY without ever touching stripeSubId — a tenant cancelled locally BEFORE
      // STRIPE-CANCEL-1 existed is exactly this un-repaired legacy cohort, and the web hides
      // the Cancel control for READ_ONLY tenants, so there is no self-serve way out. Tell
      // Stripe FIRST, before returning the short-circuit — never touch the local row, which is
      // already correct either way. A row with no stripeSubId (the common, already-correct
      // case: self-serve cancel already propagated, or a plans-as-data tenant with no Stripe at
      // all) skips the Stripe call; the row is still read, because only it can say so.
      const sub = await this.prisma.tenantSubscription.findUnique({ where: { tenantId } });
      if (sub?.stripeSubId) {
        // CHANGE-1 RULING (2026-09-13, lead — overturnable, owner informed): this READ_ONLY
        // tenant already lost service at its LAST period end, so scheduling cancellation at
        // the NEXT one (propagateCancelToStripe()'s `cancel_at_period_end: true`, what every
        // other cancel() path uses) would let Stripe invoice a full period the tenant gets
        // nothing for — a charge that cannot be defended ("forfeiting a paid period" does not
        // apply: this cohort was suspended for non-payment). Cancel immediately instead.
        // Reversal is a ONE-LINE swap: replace the call below with
        // `await this.propagateCancelToStripe(tenantId, sub.stripeSubId);`.
        await this.cancelReadOnlyStripeSubImmediately(tenantId, sub.stripeSubId);
      }
      return { cancelled: "already_read_only" as const };
    }

    if (tenant?.status === "TRIAL") {
      const now = new Date();
      const result = await this.prisma.$transaction(async (tx) => {
        // Compare-and-swap: only end the trial if it is STILL TRIAL — a concurrent
        // cancel/webhook can race this call between the read above and here.
        const { count } = await tx.tenant.updateMany({
          where: { id: tenantId, status: "TRIAL" },
          data: { status: "READ_ONLY", readOnlyReason: "trial_cancelled", trialEndsAt: now },
        });
        if (count !== 1) {
          const current = await tx.tenant.findUnique({
            where: { id: tenantId },
            select: { status: true },
          });
          if (current?.status === "READ_ONLY") {
            // A concurrent cancel already won the race — already where this call wanted
            // to land.
            return { cancelled: "already_read_only" as const };
          }
          // A concurrent subscribe/webhook made the tenant ACTIVE in the meantime — never
          // overwrite a paying tenant with a stale trial-cancellation.
          throw new ConflictException(
            "Tenant status changed while ending the trial; refresh and try again.",
          );
        }
        // Deliberately leaves any TenantSubscription row untouched: the
        // scheduled-cancellation sweep filters tenant.status ACTIVE, so an armed
        // cancelAtPeriodEnd could never fire for this READ_ONLY tenant — but it WOULD
        // survive a later Stripe reactivation (onCheckoutCompleted clears only the
        // downgrade fields) and churn a paying tenant at period end, and it surfaces a
        // "Keep my plan" control that resume() cannot honour.
        await this.events.emit(
          tenantId,
          BILLING_EVENTS.TRIAL_CANCELLED,
          { at: now.toISOString() },
          { actorId, tx },
        );
        return { cancelled: "trial" as const };
      });
      // Invalidate only on the "trial" outcome — invalidating on already_read_only is
      // harmless but unnecessary (nothing changed).
      if (result.cancelled === "trial") {
        this.entitlements.invalidate(tenantId);
        this.tenantStatus.invalidate(tenantId);
      }
      return result;
    }

    const sub = await this.prisma.tenantSubscription.findUnique({ where: { tenantId } });
    if (!sub) {
      // Any other status with no row is a genuine anomaly today (e.g. ACTIVE with a missing
      // row) — revisit when Phase 0 subscription reconciliation lands: this case should
      // become unreachable, not stay a 404 forever.
      throw new NotFoundException("No subscription to cancel.");
    }

    // STRIPE-CANCEL-1: a row provisioned by a super-admin checkout link carries a stripeSubId —
    // Stripe itself must be told, or its subscription keeps invoicing after this "cancellation"
    // only ever flips our local flag. Deliberately BEFORE the local write: if Stripe succeeds and
    // the DB write below then fails, Stripe has still stopped invoicing and the
    // subscription.deleted webhook (onSubscriptionDeleted) churns the tenant correctly at period
    // end. The reverse order would leave a tenant who thinks they cancelled still being charged.
    // A row with no stripeSubId (plans-as-data / manual) takes the path below byte-identically.
    if (sub.stripeSubId) {
      await this.propagateCancelToStripe(tenantId, sub.stripeSubId);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.tenantSubscription.update({
        where: { tenantId },
        // A cancellation SUPERSEDES any scheduled downgrade — leaving one armed would let
        // applyScheduledDowngrades re-price the row (rewriting basePriceSnapshot) before
        // applyScheduledCancellations books the churn delta from it, so the negative MRR
        // delta would depend on which cron ran first. Book it from the plan the tenant is on.
        data: {
          cancelAtPeriodEnd: true,
          downgradeToPlanKey: null,
          downgradeEffectiveAt: null,
          retainedUserIds: [],
        },
      });
      await this.events.emit(
        tenantId,
        BILLING_EVENTS.SUBSCRIPTION_CANCELED,
        { effectiveAt: sub.periodEnd },
        { actorId, tx },
      );
    });
    return this.subscription.getSubscription(tenantId);
  }

  /**
   * Undo a scheduled transition — a cancellation OR a scheduled downgrade. Nothing else
   * clears `downgradeToPlanKey` except the cron that applies it, so this is the tenant's
   * only self-service "keep my current plan"; it never touches planKey or the period.
   */
  async resume(tenantId: string, actorId?: string) {
    const sub = await this.prisma.tenantSubscription.findUnique({ where: { tenantId } });
    if (!sub) throw new NotFoundException("No subscription.");

    // STRIPE-CANCEL-1: the mirror of cancel()'s Stripe-first write — undo the scheduled
    // cancellation with Stripe before touching our own row. A row with no stripeSubId takes the
    // existing path unchanged, and skips the tenant read below entirely: the `stripeSubId ==
    // null` branch is 100% of real production resumes today, so it must never pay for a query
    // it has no use for (a pool timeout on that read would 500 a resume that used to succeed).
    //
    // R1 (Opus F1+F2): call Stripe ONLY when cancelAtPeriodEnd is actually ARMED on a tenant
    // Stripe is still charging (tenant.status === "ACTIVE"). Two money defects otherwise:
    // (F1) a READ_ONLY tenant with a live Stripe sub — the un-repaired legacy cohort our cron
    // cancelled locally without ever telling Stripe — reaches resume() (the route is
    // allowlisted for READ_ONLY, and the web "Keep current plan" downgrade-undo control is
    // gated only on downgradeToPlanKey): an unconditional call here would RESUME Stripe
    // billing while resume() never restores tenant.status — the tenant pays for nothing.
    // (F2) when cancelAtPeriodEnd is already false (undoing a scheduled DOWNGRADE, never a
    // cancellation), calling Stripe here could silently revoke a cancellation the tenant made
    // in the Stripe customer portal that our local row never learned about — only
    // onSubscriptionUpdated syncs Stripe→local, and there is no ordering guard against this call.
    if (sub.stripeSubId && sub.cancelAtPeriodEnd === true) {
      const tenant = await this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { status: true },
      });
      if (tenant?.status === "ACTIVE") {
        try {
          await this.stripe.updateSubscription(sub.stripeSubId, { cancel_at_period_end: false });
        } catch (err) {
          if (isStripeResourceMissing(err)) {
            // Nothing to resume — the provider subscription is gone, so there is no local write.
            throw new ConflictException(
              "The payment-provider subscription no longer exists — subscribe again to restore service.",
            );
          }
          this.logger.error(
            `STRIPE-CANCEL-1: resume() failed to resume the Stripe subscription for tenant ${tenantId} (stripeSubId ${sub.stripeSubId})`,
          );
          // R3: same UNCERTAIN-provider-outcome wording as cancel()'s 503.
          throw new ServiceUnavailableException(
            "The payment provider did not confirm the change — it may still apply. Check your subscription in a moment before retrying, or contact support.",
          );
        }
      } else {
        // STRIPE-RESUME-1: the tenant is not ACTIVE (e.g. READ_ONLY — the un-repaired legacy
        // cohort our cron cancelled locally without ever telling Stripe), so Stripe is
        // correctly skipped above — but there is nothing legitimate to "resume" locally
        // either: clearing cancelAtPeriodEnd here with nothing having changed at Stripe would
        // disarm the exact guard onPaymentSucceeded() reads (billing.service.ts), reinstating
        // the tenant ACTIVE (and booking a +1 MRR delta) the next time Stripe happens to fire
        // an invoice.payment_succeeded webhook for a subscription it was never told to stop.
        // Refuse instead, mirroring cancel()'s own handling of a state it cannot honour.
        throw new ConflictException(
          "The subscription cannot be resumed while the workspace is read-only; subscribe again to restore service.",
        );
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.tenantSubscription.update({
        where: { tenantId },
        data: {
          cancelAtPeriodEnd: false,
          downgradeToPlanKey: null,
          downgradeEffectiveAt: null,
          retainedUserIds: [],
        },
      });
      await this.events.emit(tenantId, BILLING_EVENTS.SUBSCRIPTION_RESUMED, {}, { actorId, tx });
    });
    return this.subscription.getSubscription(tenantId);
  }

  /**
   * STRIPE-CANCEL-2: the shared Stripe-propagation call `cancel()` makes both from the
   * READ_ONLY short-circuit (a live sub the cron cancelled locally without ever telling
   * Stripe) and from the ordinary with-row cancellation path — same call, same B107 error
   * semantics, one place to keep them identical.
   */
  private async propagateCancelToStripe(tenantId: string, stripeSubId: string): Promise<void> {
    try {
      await this.stripe.updateSubscription(stripeSubId, { cancel_at_period_end: true });
    } catch (err) {
      if (isStripeResourceMissing(err)) {
        // The Stripe subscription is already gone — nothing left to stop invoicing; the
        // deleted-subscription webhook handles the churn. Proceed with the local cancellation.
        this.logger.warn(
          `STRIPE-CANCEL-1: cancel() found Stripe subscription already gone for tenant ${tenantId} (stripeSubId ${stripeSubId}) — proceeding with local cancellation`,
        );
      } else {
        // Never log the raw error (may carry Stripe request/auth details) — tenantId +
        // stripeSubId only.
        this.logger.error(
          `STRIPE-CANCEL-1: cancel() failed to schedule the Stripe cancellation for tenant ${tenantId} (stripeSubId ${stripeSubId})`,
        );
        // R3: the local row really is unchanged, but claiming Stripe changed nothing too is
        // false on a timeout Stripe actually applied — describe the provider outcome as
        // UNCERTAIN instead.
        throw new ServiceUnavailableException(
          "The payment provider did not confirm the change — it may still apply. Check your subscription in a moment before retrying, or contact support.",
        );
      }
    }
  }

  /**
   * CHANGE-1 RULING (2026-09-13, lead — overturnable, owner informed): the READ_ONLY cohort's
   * ONLY Stripe instrument — cancels the subscription IMMEDIATELY (`stripe.cancelSubscription`)
   * rather than scheduling at period end, because this cohort already lost service at its last
   * period end and a period-end cancellation would let Stripe invoice a full period of nothing.
   * Every other cancel() path keeps using `propagateCancelToStripe()` unchanged. Same B107
   * error semantics as that helper: `resource_missing` logs and proceeds to the local
   * short-circuit; anything else throws a 503 with nothing written locally. Never log the raw
   * error. If this ruling is overturned, swap the ONE call site in `cancel()` back to
   * `propagateCancelToStripe()` — this method can then be deleted.
   */
  private async cancelReadOnlyStripeSubImmediately(
    tenantId: string,
    stripeSubId: string,
  ): Promise<void> {
    try {
      await this.stripe.cancelSubscription(stripeSubId);
    } catch (err) {
      if (isStripeResourceMissing(err)) {
        // The Stripe subscription is already gone — nothing left to cancel. Proceed with the
        // local short-circuit.
        this.logger.warn(
          `STRIPE-CANCEL-2: cancel() found Stripe subscription already gone for tenant ${tenantId} (stripeSubId ${stripeSubId}) — proceeding with the READ_ONLY short-circuit`,
        );
      } else if (await this.stripeSubIsTerminal(stripeSubId)) {
        // B408: cancelling a subscription that is ALREADY in a terminal state is not
        // `resource_missing` — the object still exists, so Stripe returns a 400
        // invalid_request_error ("a subscription with status `canceled` may not be updated").
        // Falling to the generic branch threw 503 on every retry while the local pointer was
        // never cleared, so the tenant could never get out. A terminal state IS the desired end
        // state. See STRIPE_TERMINAL_STATUSES for which statuses qualify and, just as
        // importantly, which do not.
        this.logger.warn(
          `STRIPE-CANCEL-2/B408: cancel() found Stripe subscription already in a terminal state for tenant ${tenantId} (stripeSubId ${stripeSubId}) — proceeding with the READ_ONLY short-circuit`,
        );
      } else {
        // Never log the raw error (may carry Stripe request/auth details) — tenantId +
        // stripeSubId only.
        this.logger.error(
          `STRIPE-CANCEL-2: cancel() failed to cancel the Stripe subscription immediately for tenant ${tenantId} (stripeSubId ${stripeSubId})`,
        );
        // Same UNCERTAIN-provider-outcome wording as propagateCancelToStripe()'s 503. Nothing
        // has been written locally at this point, and nothing below runs.
        throw new ServiceUnavailableException(
          "The payment provider did not confirm the change — it may still apply. Check your subscription in a moment before retrying, or contact support.",
        );
      }
    }

    // FINDING-2: the pointer is dead once the subscription is confirmed cancelled or gone.
    // Dropping it makes a repeat cancel() short-circuit without touching Stripe at all, which
    // is what makes this branch idempotent rather than merely tolerant of a second call. Scoped
    // to the SAME stripeSubId so a concurrent re-subscribe that already wrote a new pointer is
    // never clobbered. This is the one local write the READ_ONLY branch makes, and it happens
    // only after a confirmed provider outcome.
    await this.prisma.tenantSubscription.updateMany({
      where: { tenantId, stripeSubId },
      data: { stripeSubId: null },
    });
  }

  /**
   * B408: is this subscription in a TERMINAL Stripe state — one there is nothing left to cancel
   * from? Re-reads the subscription rather than matching error text (Stripe exposes no dedicated
   * code, and a message match is the brittle discriminator B218 already had to replace once). A
   * 404 on the re-read means it is gone entirely, which is equally "nothing left to cancel"; any
   * other failure is inconclusive and returns false so the caller still surfaces the 503.
   *
   * This used to test `status === "canceled"` alone, which is how B408 happened: the fix was
   * written against the ONE status the repro produced, so every OTHER terminal status still fell
   * to the generic branch and threw 503 forever with `stripeSubId` intact — the exact permanent
   * lockout that fix existed to remove. The membership test is now the SET.
   */
  private async stripeSubIsTerminal(stripeSubId: string): Promise<boolean> {
    try {
      const sub = await this.stripe.getSubscription(stripeSubId);
      return typeof sub?.status === "string" && STRIPE_TERMINAL_STATUSES.has(sub.status);
    } catch (err) {
      return isStripeResourceMissing(err);
    }
  }

  /**
   * Enable an add-on (prorated for the current cycle; SEAT_EXTRA adds seats).
   *
   * F1 (W1 review-fix round): the existence read, the delta-quantity computation, the row
   * write and the ledger emit below are a check-then-act sequence — without serialisation,
   * two concurrent calls for the same (tenantId, sku) can both read `priorQty` from the
   * pre-write state and both emit `ADDON_ENABLED` at the full delta, overstating MRR by a
   * ledger entry that never self-heals (the ledger is a running Σ amountDelta). This is the
   * SAME race `AddonService.enableAddon` (`addon.service.ts`) closed for the platform-admin
   * grant path — this tenant self-serve path (`POST /billing/addons/:sku/enable`, callable
   * by any OPERATOR) is more exposed and had no lock at all. The whole window is now wrapped
   * in `withAdvisoryLock`, on the SAME `"billing"` lock family and the SAME
   * `addon:<tenantId>:<sku>` key shape as the admin path, so an admin enable and a tenant
   * enable of the same add-on serialise against EACH OTHER too, not merely against
   * themselves. A second, now-serialised call re-reads the first call's committed write, so
   * `priorQty` already reflects it — an identical re-enable still nets `deltaQty === 0` and
   * emits nothing (the existing idempotent-repeat behaviour, unchanged: this method has no
   * "already active" refusal the way the admin path's boolean enable/disable does), and a
   * genuine quantity bump nets only the real incremental delta. Never add a second,
   * in-process lock on top of this (see `common/db-locks.ts`).
   */
  async enableAddon(tenantId: string, sku: string, quantity: number | undefined, actorId?: string) {
    const version = await this.catalog.getPublishedCatalog();
    const skuDef = version.addonSkus.find((s) => s.sku === sku);
    if (!skuDef) throw new BadRequestException(`Unknown add-on "${sku}"`);
    if (!isSelfServiceAddon(sku)) throw new ForbiddenException(ADMIN_ONLY_ADDON_MESSAGE);
    const qty = Math.max(1, Math.trunc(quantity ?? 1));
    const preview = await this.proration.prorationPreview(tenantId, sku);

    // FINDING-3 (round 3 review): same family and the same SKU-keyed shape as the admin path in
    // addon.service.ts, so the two paths serialise against each other and not merely within
    // themselves. This side is already SKU-native; the admin side normalises its addonKey
    // through LEGACY_ADDON_KEY_TO_SKU to land on this same key.
    const lockKey = `addon:${tenantId}:${sku}`;
    try {
      const result = await withAdvisoryLock(
        { family: "billing", key: lockKey, mode: "wait", waitMs: 10_000 },
        async () => {
          const existing = await this.prisma.tenantAddon.findUnique({
            where: { tenantId_addonKey: { tenantId, addonKey: sku } },
          });
          const priorQty = existing?.active ? existing.quantity : 0;
          const deltaQty = qty - priorQty; // MRR change relative to prior active quantity

          await this.prisma.$transaction(async (tx) => {
            await tx.tenantAddon.upsert({
              where: { tenantId_addonKey: { tenantId, addonKey: sku } },
              create: {
                tenantId,
                addonKey: sku,
                sku,
                quantity: qty,
                active: true,
                priceSnapshot: skuDef.monthlyPrice,
              },
              update: { sku, quantity: qty, active: true, priceSnapshot: skuDef.monthlyPrice },
            });
            if (deltaQty !== 0) {
              await this.events.emit(
                tenantId,
                BILLING_EVENTS.ADDON_ENABLED,
                { sku, quantity: qty, prorated: preview.proratedToday },
                { amountDelta: roundMoney(Number(skuDef.monthlyPrice) * deltaQty), actorId, tx },
              );
              if (sku === "SEAT_EXTRA" && priorQty === 0) {
                await this.events.emit(
                  tenantId,
                  BILLING_EVENTS.SEAT_ADDED,
                  { quantity: qty },
                  { actorId, tx },
                );
              }
            }
          });
        },
      );

      if (!result.acquired) {
        // Unreachable under `mode: "wait"` (it either acquires or the catch below maps a
        // `LockTimeoutError`) — kept only so this exhaustively narrows `LockResult` without
        // a cast, matching `addon.service.ts`'s own shape.
        throw new ServiceUnavailableException(
          `Could not enable add-on "${sku}" for tenant ${tenantId} — lock unavailable`,
        );
      }
    } catch (e) {
      if (e instanceof LockTimeoutError || e instanceof LockUnavailableError) {
        this.logger.error(
          `Add-on "${sku}" lock unavailable for tenant ${tenantId}: ${(e as Error).message}`,
        );
        throw new ServiceUnavailableException(
          `Could not serialise enabling add-on "${sku}" for tenant ${tenantId} — retry shortly`,
        );
      }
      throw e;
    }

    this.entitlements.invalidate(tenantId);
    return {
      proratedNow: preview.proratedToday,
      subscription: await this.subscription.getSubscription(tenantId),
    };
  }

  /** Disable an add-on. Keeps the row (history read-only); nav/flag simply drops. */
  async disableAddon(tenantId: string, sku: string, actorId?: string) {
    const addon = await this.prisma.tenantAddon.findFirst({
      where: { tenantId, active: true, OR: [{ sku }, { addonKey: sku }] },
    });
    if (!addon) throw new NotFoundException(`Active add-on "${sku}" not found.`);
    // Resolve the CANONICAL code (bridges legacy addonKey like tobacco_dealer → REGULATED_ITEMS).
    const code = addonSkuCode(addon) ?? sku;
    // Symmetric with enableAddon: an admin-granted ("ships dark") add-on is revocable only by
    // platform-admin — self-disabling one is a dead end, since re-enabling it is a 403.
    if (!isSelfServiceAddon(code)) throw new ForbiddenException(ADMIN_ONLY_ADDON_MESSAGE);
    const version = await this.catalog.getPublishedCatalog();
    const skuDef = version.addonSkus.find((s) => s.sku === code);
    const monthly = skuDef ? roundMoney(Number(skuDef.monthlyPrice) * addon.quantity) : 0;

    await this.prisma.$transaction(async (tx) => {
      await tx.tenantAddon.update({ where: { id: addon.id }, data: { active: false } });
      await this.events.emit(
        tenantId,
        BILLING_EVENTS.ADDON_DISABLED,
        { sku: code },
        { amountDelta: -monthly, actorId, tx },
      );
      if (code === "SEAT_EXTRA") {
        await this.events.emit(
          tenantId,
          BILLING_EVENTS.SEAT_FREED,
          { quantity: addon.quantity },
          { actorId, tx },
        );
      }
    });

    this.entitlements.invalidate(tenantId);
    return this.subscription.getSubscription(tenantId);
  }
}
