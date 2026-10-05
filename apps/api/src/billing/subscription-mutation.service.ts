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
import {
  CheckoutAddonItem,
  checkoutAddonItems,
  checkoutAddonLineItem,
  fromCents,
  toCents,
} from "./stripe-addon-items";
import { emitAddonDelta, lockTenantForLedger, bookAddonsOnCrossing } from "./addon-ledger";
import {
  addonCodeOf,
  addonRowMatches,
  addonRowWhere,
  billableAddonWhere,
  findAddonRow,
} from "./addon-row";
import { isPayingRow } from "./mrr.service";
import { b58GuardRefusal } from "./b58-guard";
import { withAdvisoryLock, LockTimeoutError, LockUnavailableError } from "../common/db-locks";
import {
  BILLING_EVENTS,
  findPlanDefinition,
  planRank,
  planKeyFromEnum,
  planKeyToEnum,
  normalizePlanKey,
  addonSkuCode,
  isAddonIncludedAtPlan,
  isSelfServiceAddon,
  isInviteOnlyPlanKey,
} from "./plan-catalog.constants";
import { addCycle, Cycle } from "./billing-math";
import { BillingNotificationService } from "./billing-notification.service";
import { PlanTransitionConfigService } from "./plan-transition-config.service";
import { CUSTOM_FEE_UNCHANGED, priceOverrideOf } from "./price-override";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { ADMIN_AUDIT_ENTITY, AdminAuditAction } from "../platform-admin/audit-actions.constant";
import { randomUUID } from "crypto";

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

/** Fixed tenant-facing copy for the self-serve add-on billing paths — never a Stripe/internal message. */
const ADDON_ENABLE_BILLING_FAILED =
  "We couldn't turn this add-on on because billing didn't go through. Nothing was changed. Please try again.";
const ADDON_DISABLE_BILLING_FAILED =
  "We couldn't turn this add-on off because billing didn't go through. It is still on. Please try again.";
const ADDON_ANNUAL_NOT_SUPPORTED =
  "Add-ons can't be added to an annual plan online yet. Please contact support.";

/** Deleting a checkout add-on item nothing owns: credit the unused time, fail the webhook on a Stripe error. */
const STRICT_PRORATED = { prorate: true, rethrow: true } as const;

const ADDON_RAISE_UNBILLED_ROW =
  "This add-on was set up before online billing, so its quantity can't be raised here yet. Please contact support.";

/**
 * A refusal of a self-serve add-on enable: a fixed machine code plus fixed tenant-facing copy. The
 * enable call throws it as a 409 body (`{ code, message }`) and `GET /billing/proration-preview`
 * returns the SAME object as `refusal`, so the confirm sheet can never promise what enable refuses.
 */
export interface AddonRefusal {
  code: string;
  message: string;
}

const ADDON_ANNUAL_REFUSAL: AddonRefusal = {
  code: API_ERROR_CODES.ADDON_ANNUAL_NOT_SUPPORTED,
  message: ADDON_ANNUAL_NOT_SUPPORTED,
};

/** SA-693: the fixed refusal of a tenant's quantity change on an ACTIVE comp row. */
const ADDON_COMP_REFUSAL: AddonRefusal = {
  code: API_ERROR_CODES.ADDON_COMP_MANAGED_BY_SUPPORT,
  message:
    "This add-on was set up for you by support, so its quantity can't be changed here. Please contact support.",
};

/** The fixed refusal for an add-on the tenant's plan already bundles (F3). */
function addonIncludedRefusal(addonName: string): AddonRefusal {
  return {
    code: API_ERROR_CODES.ADDON_INCLUDED_IN_PLAN,
    message: `${addonName} is already included in your plan.`,
  };
}

const refusalException = (r: AddonRefusal) =>
  new ConflictException({ code: r.code, message: r.message });

/**
 * The ONE annual predicate for self-serve add-ons (enable of a new item AND a quantity raise on a
 * billed row both use it, and so does the preview): the tenant is billed through a live Stripe
 * subscription whose interval is not monthly. Interval = `billingInterval`, else the cycle.
 */
function isAnnualStripeBilled(
  mode: AddonBilling,
  sub: {
    stripeSubId?: string | null;
    billingInterval?: string | null;
    cycle?: string | null;
  } | null,
): boolean {
  if (mode !== "STRIPE" || !sub?.stripeSubId) return false;
  const interval = sub.billingInterval ?? (sub.cycle === "ANNUAL" ? "year" : "month");
  return interval !== "month";
}

/**
 * How a tenant's self-serve add-on is billed (owner rulings 2026-10-03):
 *  - STRIPE:   a Stripe subscription item (Stripe configured AND a `stripeSubId`).
 *  - MANUAL:   an `externalPayment` tenant the owner invoices by hand — on at the CATALOG price, counted as
 *              revenue, no Stripe call, and the platform is told to add it to the next manual invoice.
 *  - UNBILLED: a free pilot (no subscription / no `stripeSubId`) or Stripe not configured — on, priced 0,
 *              books no revenue.
 */
export type AddonBilling = "STRIPE" | "MANUAL" | "UNBILLED";

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
    // Lane B A2b: downgrade -> snapshot the tenant's feature config, upgrade -> restore it, INSIDE
    // the same transaction as the plan write (live flag entitlements.configSnapshot, default off).
    private readonly planTransition: PlanTransitionConfigService,
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

  /** Log and throw a B58 refusal. A handled 4xx is otherwise invisible — SentryExceptionFilter
   *  captures >= 500 only and there is no access log — so a money-path refusal logs like
   *  addon.guard.ts's denials. */
  private refuseB58(
    tenantId: string,
    fromKey: string | null,
    input: SubscribeInput,
    refusal: { sameRank: boolean; message: string },
  ): never {
    this.logger.warn(
      `B58 guard refused subscribe tenant=${tenantId} from=${fromKey} to=${input.planKey} cycle=${input.cycle} sameRank=${refusal.sameRank}`,
    );
    throw new ConflictException(refusal.message);
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

    // Pre-tx state — used ONLY for validation (the B58 guard below) and transition planning
    // (fromKey feeds `preparedTransition`). F1 (pre-merge review, SA-277/277b): NEVER a source
    // for a ledger amount — wasPaying / oldPlanMonthly / the prior add-on snapshots are re-read
    // UNDER the tenant lock inside the transaction below, because a concurrent committed write
    // (e.g. platform-admin's `activateManualSubscription`) between this read and the tx could
    // otherwise book against a stale baseline (double-booking the base price and any add-on
    // that write already priced).
    const [tenant, priorSub] = await Promise.all([
      this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { status: true, plan: true, class: true, deletedAt: true },
      }),
      this.prisma.tenantSubscription.findUnique({
        where: { tenantId },
        select: { planKey: true, cycle: true, periodEnd: true },
      }),
    ]);
    // #2583 / SA-513: a deleted tenant is refused before the transaction.
    if (!tenant || tenant.deletedAt) throw new NotFoundException("Tenant not found");

    // The plan we are changing FROM — resolved through the legacy enum, so a subscription
    // predating plans-as-data (planKey NULL) is ranked instead of read as "no plan".
    const fromKey = this.resolveFromPlanKey(priorSub?.planKey, tenant.plan);

    // B58 (see b58-guard.ts): the fast refusal on the pre-tx read. #2189 / SA-389: the SAME
    // guard runs again inside the transaction on the rows re-read under the tenant lock.
    const refusal = b58GuardRefusal({
      status: tenant.status,
      fromKey,
      sub: priorSub,
      toPlanKey: input.planKey,
      toCycle: input.cycle,
    });
    if (refusal) this.refuseB58(tenantId, fromKey, input, refusal);

    const now = new Date();
    const periodEnd = addCycle(now, input.cycle);

    const skuByCode = new Map(version.addonSkus.map((s) => [s.sku, s]));

    // Reconcile desired (from input) against prior-active add-ons. This is the same
    // TENANT_ADMIN self-service surface as enableAddon(), so an admin-only ("ships dark")
    // SKU is a 403 here too — otherwise subscribe() is a back door around that gate.
    const desired = new Map<string, number>();
    for (const a of input.addons ?? []) {
      if (!skuByCode.has(a.sku)) continue;
      if (!isSelfServiceAddon(a.sku)) throw new ForbiddenException(ADMIN_ONLY_ADDON_MESSAGE);
      desired.set(a.sku, Math.max(1, Math.trunc(a.quantity ?? 1)));
    }

    const transition = {
      tenantId,
      fromPlanKey: fromKey,
      toPlanKey: input.planKey,
      toPlanVersionId: version.id,
      actor: { id: actorId ?? null },
    };
    // Read the catalog BEFORE the transaction (pool starvation) — see PlanTransitionConfigService.
    const preparedTransition = await this.planTransition.prepare(transition);

    // B1: a self-serve add-on this subscribe() drops (a cycle switch on /choose-plan sends no add-ons)
    // is disabled below, but its Stripe item would keep billing and a later re-enable would add a
    // SECOND one. Remove the billed items FIRST (Stripe-first, exactly like disableAddon); a Stripe
    // failure refuses the whole subscribe before anything is written. Read pre-tx (no tx held open
    // across a network call); the locked re-read below refuses, retryably, if a billed row appeared.
    // SA-690: a TRIAL keeps its add-ons across the plan pick (see `toDisable` below), so nothing is
    // dropped and no item is removed for it.
    const droppedBilled = (
      tenant.status === "TRIAL"
        ? []
        : await this.prisma.tenantAddon.findMany({ where: { tenantId, active: true } })
    )
      .map((row: any) => ({ row, code: addonSkuCode(row) }))
      .filter(
        (x: any) =>
          x.code != null &&
          !desired.has(x.code) &&
          isSelfServiceAddon(x.code) &&
          !x.row.isComp &&
          x.row.stripeItemId,
      );
    for (const { row, code } of droppedBilled) {
      await this.removeStripeAddonItem(tenantId, code as string, row.stripeItemId);
    }
    const removedItemIds = new Set(droppedBilled.map((x: any) => x.row.stripeItemId as string));

    await this.prisma.$transaction(async (tx) => {
      // B865 / SA-277 FIX-2 (house lock order): tenant row lock FIRST, before any
      // subscription/add-on read or write in this tx.
      await lockTenantForLedger(tx, tenantId);

      // F1 (pre-merge review, SA-277/277b): re-read the paying-set inputs AND the before-state
      // for every ledger booking below UNDER this lock — never from the pre-tx snapshot above.
      // A concurrent tx (e.g. platform-admin `activateManualSubscription`) that commits between
      // the pre-tx read and this lock is now fully visible here, so it can never be double-booked.
      const [lockedTenant, lockedSub, lockedAddons] = await Promise.all([
        tx.tenant.findUnique({
          where: { id: tenantId },
          select: {
            status: true,
            plan: true,
            class: true,
            deletedAt: true,
            name: true,
            slug: true,
          },
        }),
        tx.tenantSubscription.findUnique({
          where: { tenantId },
          // #2189: planKey/cycle/periodEnd feed the B58 re-check under the lock. #2223 / SA-444c: the
          // negotiated fee this subscribe() must keep; #2460 / SA-464 (2): the stored snapshot the
          // ledger nets against.
          select: {
            planKey: true,
            cycle: true,
            periodEnd: true,
            priceOverrideMonthly: true,
            basePriceSnapshot: true,
            stripeSubId: true,
            externalPayment: true,
          },
        }),
        tx.tenantAddon.findMany({ where: { tenantId, active: true } }),
      ]);
      if (!lockedTenant) throw new NotFoundException("Tenant not found");
      const lockedFromKey = this.resolveFromPlanKey(lockedSub?.planKey, lockedTenant.plan);
      // #2189 / SA-389 (2): prepare(transition) ran pre-tx (pool reasons) on `fromKey`; if the
      // plan moved before this lock, the prepared transition is stale — refuse, retryable, with
      // nothing written (the caller re-runs subscribe(), which re-prepares). Both keys are
      // normalized by resolveFromPlanKey, so a legacy alias never reads as a change.
      if (lockedFromKey !== fromKey) {
        throw new ConflictException({
          code: API_ERROR_CODES.PLAN_CHANGED_DURING_SUBSCRIBE,
          retryable: true,
          message: "Your plan changed while this was being processed — please try again.",
        });
      }
      // #2189 / SA-389 (1): the B58 guard again, on the LOCKED rows, before any write.
      const lockedRefusal = b58GuardRefusal({
        status: lockedTenant.status,
        fromKey: lockedFromKey,
        sub: lockedSub,
        toPlanKey: input.planKey,
        toCycle: input.cycle,
      });
      if (lockedRefusal) this.refuseB58(tenantId, lockedFromKey, input, lockedRefusal);
      // #2189 / SA-389 (3): one source — a trial converted concurrently is not converted again.
      const wasTrial = lockedTenant.status === "TRIAL";
      // Same paying-set basis as before (isPayingRow — class/deletedAt gate it too), now read
      // from the LOCKED row instead of the pre-tx one.
      const wasPaying = isPayingRow(lockedTenant, lockedSub?.planKey ?? null);
      // Coming from a NON-paying status (READ_ONLY / SUSPENDED / CANCELLED / TRIAL) the tenant
      // still carries its old planKey but contributes 0 to the run-rate — so re-entry is a full
      // +base delta, mirroring the negative delta emitted when access ended (billing-cron
      // applyScheduledCancellations). Only an already-ACTIVE tenant nets against its old plan.
      // A row with a NULL planKey is excluded from `MrrService`'s snapshot the same way
      // (`planKey: { not: null }`) — e.g. a manual platform-admin activation — so it too
      // contributes 0 and writing a planKey onto it books the full base, even though
      // `lockedFromKey` resolves through the legacy enum for ranking.
      // #2460 / SA-464 (2): an ACTIVE row nets against what the MRR snapshot counted — its STORED
      // basePriceSnapshot (NULL ⇒ 0) — never the catalog price of the plan it holds.
      // #2583 / SA-513: the SAME paying predicate on both sides — a non-PRODUCTION or deleted row
      // was never counted (before = 0) and never will be after (after = 0), whatever its status.
      const oldPlanMonthly = wasPaying ? Number(lockedSub?.basePriceSnapshot ?? 0) : 0;
      const isPaying = isPayingRow({ ...lockedTenant, status: "ACTIVE" }, input.planKey);
      // #2188 / SA-385 (3): a code's prior is the SAME row findAddonRow re-activates below — the
      // oldest active row matching the shared predicate — so the ledger nets against that row.
      const byAge = [...lockedAddons].sort(
        (a, b) => Number(a.createdAt ?? 0) - Number(b.createdAt ?? 0),
      );
      // SA-693: an ACTIVE comp is a platform grant, not the tenant's to drop or re-price. A plan
      // choice / cycle switch (which sends no add-ons) must never remove it, and naming it in addons[]
      // must not turn it into a billable row: it is left exactly as it is, for support to manage.
      const compCodes = new Set<string>();
      for (const row of lockedAddons) {
        const code = addonSkuCode(row);
        if (code && row.isComp) compCodes.add(code);
      }
      const desiredNow = new Map([...desired].filter(([code]) => !compCodes.has(code)));
      const codes = new Set<string>(desiredNow.keys());
      for (const row of lockedAddons) {
        const code = addonSkuCode(row);
        if (code) codes.add(code);
      }
      const priorByCode = new Map<string, { id: string; qty: number; snapshot: unknown }>();
      for (const code of codes) {
        const row = byAge.find((r) => addonRowMatches(r, code));
        if (row)
          priorByCode.set(code, { id: row.id, qty: row.quantity, snapshot: row.priceSnapshot });
      }
      // Only self-service add-ons are the tenant's to drop: an admin-granted SKU the payload
      // is not even allowed to name must not be revoked by omitting it.
      // SA-690: and a TRIAL's add-ons are never dropped here. The plan pick sends no add-ons (the
      // choose-plan call is `{planKey, cycle}`), so reading "none named" as "drop them" switched off
      // every add-on the trial had enabled — and the card checkout that bills them never saw one. They
      // stay on, price 0 and unbilled, until that checkout puts them on Stripe items; the crossing
      // below books them through `bookAddonsOnCrossing` like any other kept add-on.
      // SA-693: an ACTIVE comp is never the tenant's to drop either (`compCodes`).
      const toDisable = wasTrial
        ? []
        : [...priorByCode.keys()].filter(
            (c) => !desiredNow.has(c) && !compCodes.has(c) && isSelfServiceAddon(c),
          );

      // B1 guard: a dropped add-on whose Stripe item was NOT removed above (it appeared after the
      // pre-tx read) must never be switched off while its item keeps billing — refuse, retryable.
      for (const code of toDisable) {
        const itemId = lockedAddons.find((r) => r.id === priorByCode.get(code)?.id)?.stripeItemId;
        if (itemId && !removedItemIds.has(itemId)) {
          throw new ConflictException({
            code: API_ERROR_CODES.PLAN_CHANGED_DURING_SUBSCRIBE,
            retryable: true,
            message: "Your add-ons changed while this was being processed — please try again.",
          });
        }
      }

      await this.planTransition.onPlanChange(tx, transition, preparedTransition);
      // #2223 / SA-444c (ii): a negotiated fee is what the tenant pays — a cycle change or re-subscribe
      // moves the plan/cycle, never the price. Both upsert branches write override ?? catalog.
      const override = priceOverrideOf(lockedSub);
      const newBase = override ?? def.monthlyPrice;
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
          basePriceSnapshot: newBase,
          trialConvertedAt: wasTrial ? now : null,
        },
        update: {
          planVersionId: version.id,
          planKey: input.planKey,
          currentPlan: planKeyToEnum(input.planKey),
          cycle: input.cycle,
          periodStart: now,
          periodEnd,
          basePriceSnapshot: newBase,
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
      for (const [code, qty] of desiredNow) {
        const meta = skuByCode.get(code)!;
        // #2188 / SA-385: re-activate the tenant's row for this SKU IN PLACE — including one
        // the admin path keyed on a legacy addonKey, active or not — else create it.
        const row = await findAddonRow(tx, tenantId, code);
        await tx.tenantAddon.upsert({
          where: { tenantId_addonKey: { tenantId, addonKey: row?.addonKey ?? code } },
          create: {
            tenantId,
            addonKey: code,
            sku: code,
            quantity: qty,
            active: true,
            priceSnapshot: meta.monthlyPrice,
            isComp: false,
          },
          update: {
            sku: code,
            quantity: qty,
            active: true,
            priceSnapshot: meta.monthlyPrice,
            // SA-693: self-serve is billable; an INACTIVE comp row re-activated here stops being one.
            isComp: false,
          },
        });
      }
      for (const code of toDisable) {
        await tx.tenantAddon.update({
          where: { id: priorByCode.get(code)!.id },
          data: { active: false, stripeItemId: null },
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
        { fromPlan: lockedSub?.planKey ?? null, toPlan: input.planKey, cycle: input.cycle },
        {
          // SA-444c + SA-464 (2): the new snapshot (override ?? catalog) minus what the MRR snapshot
          // counted — a consistent override row already paying books Δ0; one entering books the fee.
          amountDelta: roundMoney((isPaying ? Number(newBase ?? 0) : 0) - oldPlanMonthly),
          actorId,
          tx,
        },
      );
      // B865 / SA-277 FIX-4: every add-on booking here routes through the ONE ledger helper —
      // `before` is the prior stored state ONLY if the tenant was already paying (a genuinely
      // already-booked add-on nets its real change); otherwise {0,0}, since a non-paying
      // tenant's add-on never booked anything to begin with, so the crossing books its FULL
      // current contribution instead of the (unbooked) prior→new delta.
      for (const [code, qty] of desiredNow) {
        const meta = skuByCode.get(code)!;
        const prior = priorByCode.get(code);
        const before =
          wasPaying && prior
            ? { priceSnapshot: prior.snapshot, quantity: prior.qty }
            : { priceSnapshot: 0, quantity: 0 };
        await emitAddonDelta(tx, this.events, {
          tenantId,
          sku: code,
          before,
          after: { priceSnapshot: meta.monthlyPrice, quantity: qty },
          actorId,
          payload: { quantity: qty },
        });
        if (code === "SEAT_EXTRA" && !prior) {
          await this.events.emit(
            tenantId,
            BILLING_EVENTS.SEAT_ADDED,
            { quantity: qty },
            { actorId, tx },
          );
        }
      }
      // (c) A manually-invoiced tenant's dropped, priced add-on: tell the platform to stop invoicing it.
      const manualTenant = this.addonModeOf(lockedSub) === "MANUAL";
      for (const code of toDisable) {
        const prior = priorByCode.get(code)!;
        const before = wasPaying
          ? { priceSnapshot: prior.snapshot, quantity: prior.qty }
          : { priceSnapshot: 0, quantity: 0 };
        await emitAddonDelta(tx, this.events, {
          tenantId,
          sku: code,
          before,
          after: { priceSnapshot: 0, quantity: 0 },
          actorId,
        });
        if (manualTenant && Number(prior.snapshot ?? 0) > 0) {
          await this.writeManualInvoiceNotice(tx, {
            tenantId,
            actorId,
            action: AdminAuditAction.ADDON_MANUAL_INVOICE_STOP,
            sku: code,
            quantity: prior.qty,
            monthlyPrice: Number(prior.snapshot ?? 0),
            kind: "stop",
            addonName: skuByCode.get(code)?.name ?? code,
            fromQty: prior.qty,
            toQty: 0,
            message: `Add-on ${skuByCode.get(code)?.name ?? code} turned off for ${
              lockedTenant.name ?? lockedTenant.slug ?? tenantId
            }: stop invoicing it`,
          });
        }
        if (code === "SEAT_EXTRA") {
          await this.events.emit(
            tenantId,
            BILLING_EVENTS.SEAT_FREED,
            { quantity: prior.qty },
            { actorId, tx },
          );
        }
      }
      // SA-277b: a prior ACTIVE add-on that is neither picked again (`desired`) nor dropped
      // (`toDisable`) — an admin-granted add-on kept across the crossing — is priced through the
      // SAME crossing helper `activateManualSubscription` uses: booked once, in full, only if
      // this subscribe() is what moves the tenant into the paying set (`!wasPaying`); if the
      // tenant was already paying, its contribution is already on the ledger and nothing changes.
      const kept = lockedAddons.filter((row) => {
        const code = addonSkuCode(row);
        return code != null && !desiredNow.has(code) && !toDisable.includes(code);
      });
      if (kept.length > 0) {
        await bookAddonsOnCrossing(
          tx,
          this.events,
          tenantId,
          kept.map((row) => ({
            sku: addonSkuCode(row)!,
            priceSnapshot: row.priceSnapshot,
            quantity: row.quantity,
          })),
          wasPaying,
          actorId,
        );
      }
    }, this.planTransition.transactionOptions(preparedTransition));

    this.planTransition.invalidateCaches(tenantId, preparedTransition);
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
          priceOverrideMonthly: true, // #2223: an override row's upgrade quotes 0
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
      // #2223 / SA-444a: an override row keeps its negotiated fee — quote 0 and say why.
      const override = priceOverrideOf(priorSub);
      const proratedNow =
        override != null
          ? 0
          : this.proration.proratedDiff(
              {
                cycle: priorSub.cycle,
                periodStart: priorSub.periodStart,
                periodEnd: priorSub.periodEnd,
              },
              newMonthly - oldMonthly,
            );
      // upgrade() writes `cancelAtPeriodEnd: false` — say so before the tenant commits.
      const notes = [
        ...(override != null ? [CUSTOM_FEE_UNCHANGED] : []),
        ...(priorSub.cancelAtPeriodEnd ? [CANCELLATION_REVOKED_WARNING] : []),
      ];
      return {
        action: "UPGRADE",
        proratedNow,
        effectiveAt: null,
        keepsRenewalAt: priorSub.periodEnd,
        fromPlanKey: fromKey,
        seatAckRequired: false,
        ...(notes.length ? { warning: notes.join(" ") } : {}),
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
    // #2223 / SA-444c (iii): the scheduled downgrade moves the plan, not a negotiated fee.
    if (priceOverrideOf(priorSub) != null) warnings.push(CUSTOM_FEE_UNCHANGED);
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
        select: { plan: true, status: true, deletedAt: true },
      }),
    ]);
    // #2583 / SA-513: a deleted tenant is refused before the transaction.
    if (tenant?.deletedAt) throw new NotFoundException("Tenant not found");
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
    // #2223 / SA-444a: an override row keeps paying its negotiated fee — the plan moves, the price
    // doesn't: quote 0, the snapshot stays the fee.
    // #2460 / SA-464 (2): for EVERY row the ledger nets against what the MRR snapshot counted — the
    // stored basePriceSnapshot, NULL ⇒ 0 (a NULL-snapshot row books the full new price and the two
    // figures re-agree). The prorated CHARGE below still nets against the catalog entitlement.
    const override = priceOverrideOf(sub);
    const newBase = override ?? newMonthly;
    const proratedNow =
      override != null ? 0 : this.proration.proratedDiff(sub, newMonthly - oldMonthly);

    const transition = {
      tenantId,
      fromPlanKey: fromKey,
      toPlanKey: planKey,
      toPlanVersionId: version.id,
      actor: { id: actorId ?? null },
    };
    const preparedTransition = await this.planTransition.prepare(transition);

    await this.prisma.$transaction(async (tx) => {
      // The hook FIRST, exactly like subscribe()/updatePlan()/the cron: every site takes the
      // snapshot/config row locks before the subscription/tenant rows, so two concurrent plan
      // changes for one tenant can never wait on each other in opposite orders (deadlock). If the
      // guard below then loses a race, the throw rolls the hook's writes back with it.
      await this.planTransition.onPlanChange(tx, transition, preparedTransition);
      // #2551 / SA-503a: the house order — Tenant row lock right after the hook, before the
      // subscription write (reconcile/updatePlan/Pricing hold Tenant, then write this row).
      await lockTenantForLedger(tx, tenantId);
      // #2583 / SA-513: "paying" decided with the shared isPayingRow on the row read UNDER that
      // lock — Δ = after − before, a non-paying side 0 (a TEST/DEMO-class, non-ACTIVE or deleted
      // tenant books nothing). The snapshot below is still written, so a later class flip rebases
      // from it (SA-464 (2)). The guarded write proves `sub` is still the committed row.
      const lockedTenant = await tx.tenant.findUnique({
        where: { id: tenantId },
        select: { status: true, class: true, deletedAt: true },
      });
      if (!lockedTenant) throw new NotFoundException("Tenant not found");
      const wasPaying = isPayingRow(lockedTenant, sub.planKey ?? null);
      const isPaying = isPayingRow(lockedTenant, planKey);
      const amountDelta = roundMoney(
        (isPaying ? newBase : 0) - (wasPaying ? Number(sub.basePriceSnapshot ?? 0) : 0),
      );
      // Optimistic guard: only apply if still on the expected plan (blocks a concurrent
      // double-upgrade from re-emitting the delta). Matches the STORED key (null matches
      // IS NULL), never the resolved one. #2470: and the negotiated fee it read (null matches
      // IS NULL) — a concurrent Pricing change makes this lose the race, never write a stale fee.
      const applied = await tx.tenantSubscription.updateMany({
        where: {
          tenantId,
          planKey: sub.planKey,
          priceOverrideMonthly: sub.priceOverrideMonthly ?? null,
          // #2470 Opus fold (1): and the snapshot it read — a Pricing change commits the fee, then
          // reconcile's snapshot; an upgrade reading between them must lose, never double-book.
          basePriceSnapshot: sub.basePriceSnapshot ?? null,
        },
        data: {
          planKey,
          currentPlan: planKeyToEnum(planKey),
          planVersionId: version.id,
          basePriceSnapshot: override ?? def.monthlyPrice, // SA-444a: what the tenant pays
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
        // #2470: a lost race is a concurrency conflict (409), like the other plan paths.
        throw new ConflictException("Plan changed concurrently — please retry.");
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
    }, this.planTransition.transactionOptions(preparedTransition));

    this.planTransition.invalidateCaches(tenantId, preparedTransition);
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
        sub.periodEnd,
      );
    } catch (e) {
      this.logger.error(
        `N3 notifyUpgradeConfirmed threw unexpectedly for tenant ${tenantId}`,
        e as Error,
      );
    }

    return {
      proratedNow,
      ...(override != null ? { note: CUSTOM_FEE_UNCHANGED } : {}),
      subscription: await this.subscription.getSubscription(tenantId),
    };
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
      await lockTenantForLedger(tx, tenantId); // #2551 / SA-503a: Tenant before the subscription
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
      await lockTenantForLedger(tx, tenantId); // #2551 / SA-503a: Tenant before the subscription
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
      await lockTenantForLedger(tx, tenantId); // #2551 / SA-503a: Tenant before the subscription
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

    // F3 (#3129 sandbox checklist): an add-on the tenant's plan already bundles is never sold
    // again. Refused before the lock and before ANY Stripe call, row write or ledger event.
    const included = await this.planIncludedRefusal(tenantId, skuDef);
    if (included) throw refusalException(included);

    // FINDING-3 (round 3 review): same family and the same SKU-keyed shape as the admin path in
    // addon.service.ts, so the two paths serialise against each other and not merely within
    // themselves. This side is already SKU-native; the admin side normalises its addonKey
    // through LEGACY_ADDON_KEY_TO_SKU to land on this same key.
    const lockKey = `addon:${tenantId}:${sku}`;
    try {
      const result = await withAdvisoryLock(
        { family: "billing", key: lockKey, mode: "wait", waitMs: 10_000 },
        () => this.enableAddonLocked(tenantId, sku, skuDef, qty, actorId),
      );

      if (!result.acquired) {
        // Unreachable under `mode: "wait"` (it either acquires or the catch below maps a
        // `LockTimeoutError`) — kept only so this exhaustively narrows `LockResult` without
        // a cast, matching `addon.service.ts`'s own shape.
        throw new ServiceUnavailableException(
          `Could not enable add-on "${sku}" for tenant ${tenantId} — lock unavailable`,
        );
      }
      const outcome = result.value;
      if (outcome.changed) this.entitlements.invalidate(tenantId);
      return {
        // Billed: what STRIPE prorated (authoritative; null when it could not be read back).
        // Unbilled: 0. The local `prorationPreview` is only an estimate and is never returned here.
        proratedNow: outcome.proratedNow,
        billing: outcome.billing,
        subscription: await this.subscription.getSubscription(tenantId),
      };
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
  }

  /**
   * How this tenant's self-serve add-ons are billed. Read-only; the preview uses it to word the
   * confirm sheet ("included at no charge" / "will appear on your next invoice" / a card charge).
   * The ONE place the billing mode is decided — switch the manual / pilot treatment here.
   */
  async addonBillingMode(tenantId: string): Promise<AddonBilling> {
    return (await this.addonBillingContext(tenantId)).mode;
  }

  private async addonBillingContext(tenantId: string) {
    const sub = await this.prisma.tenantSubscription.findUnique({
      where: { tenantId },
      select: {
        stripeSubId: true,
        stripeCustomerId: true,
        billingInterval: true,
        cycle: true,
        externalPayment: true,
      },
    });
    return { sub, mode: this.addonModeOf(sub) };
  }

  /**
   * Would a self-serve ENABLE be refused for this tenant, and why? The preview reads this so it can
   * never disagree with `enableAddon`, which throws the SAME objects: plan-included first (the
   * add-on is bundled, nothing to buy), then annual (a monthly item can't join a yearly Stripe
   * subscription online). Row-independent on purpose: the preview carries no quantity, and on
   * annual both a new item and a raise are refused. Never throws for an unknown SKU (null).
   */
  async addonEnableRefusal(tenantId: string, sku: string): Promise<AddonRefusal | null> {
    const version = await this.catalog.getPublishedCatalog();
    const skuDef = version.addonSkus.find((s) => s.sku === sku);
    if (!skuDef) return null;
    const included = await this.planIncludedRefusal(tenantId, skuDef);
    if (included) return included;
    const { sub, mode } = await this.addonBillingContext(tenantId);
    return isAnnualStripeBilled(mode, sub) ? ADDON_ANNUAL_REFUSAL : null;
  }

  /** True when the tenant's status is TRIAL (the add-on preview words its copy for a first card charge). */
  async isTrialTenant(tenantId: string): Promise<boolean> {
    const t = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { status: true },
    });
    return t?.status === "TRIAL";
  }

  /**
   * SA-690 option A — the checkout lines for the add-ons no Stripe item bills yet.
   *
   * A trial's (or a pilot's) self-serve add-on is on at price 0 with no Stripe item. The card
   * checkout is where it starts to cost money, so each such SKU becomes ONE extra monthly line at the
   * CATALOG price and the row's quantity (never the stored 0 snapshot), tagged so the completion can
   * adopt the item (see `adoptCheckoutAddons`). A SKU is unbilled only when NO active row of it holds
   * an item — never a second line for a SKU already on one. Admin-granted SKUs, a SKU the plan
   * already bundles (F3) and a SKU the catalog no longer prices get no line.
   *
   * An ANNUAL checkout that would bill an add-on is refused (the same coded 409 the enable path
   * throws) — online add-ons are monthly items. Runs before ANY Stripe call.
   */
  async checkoutAddonLines(
    tenantId: string,
    interval: "month" | "year",
  ): Promise<{ lineItems: ReturnType<typeof checkoutAddonLineItem>[]; skus: string[] }> {
    const none = { lineItems: [], skus: [] };
    // SA-693: a comp is a platform grant — never billed, so never a line and never a reason to refuse.
    const active = await this.prisma.tenantAddon.findMany({
      where: billableAddonWhere({ tenantId, active: true }),
    });
    const bySku = new Map<string, any[]>();
    for (const row of active) {
      const code = addonSkuCode(row);
      if (!code || !isSelfServiceAddon(code)) continue;
      bySku.set(code, [...(bySku.get(code) ?? []), row]);
    }
    const unbilled = [...bySku.entries()]
      .filter(([, rows]) => rows.every((r) => !r.stripeItemId))
      .sort(([a], [b]) => (a < b ? -1 : 1));
    if (unbilled.length === 0) return none;

    const version = await this.catalog.getPublishedCatalog();
    const billable: Array<{ def: PlanVersionWithCatalog["addonSkus"][number]; quantity: number }> =
      [];
    for (const [code, rows] of unbilled) {
      const def = version.addonSkus.find((s) => s.sku === code);
      if (!def) {
        this.logger.error(
          `Checkout for tenant ${tenantId}: active add-on "${code}" is not in the published catalog — no line, it stays unbilled`,
        );
        continue;
      }
      if (await this.planIncludedRefusal(tenantId, def)) continue;
      // The row findAddonRow picks (oldest) decides the quantity — the same row the completion adopts onto.
      const oldest = [...rows].sort(
        (x, y) => Number(x.createdAt ?? 0) - Number(y.createdAt ?? 0),
      )[0];
      billable.push({ def, quantity: Math.max(1, Math.trunc(Number(oldest.quantity) || 1)) });
    }
    if (billable.length === 0) return none;
    if (interval === "year") throw refusalException(ADDON_ANNUAL_REFUSAL);
    return {
      lineItems: billable.map((b) =>
        checkoutAddonLineItem({
          sku: b.def.sku,
          name: b.def.name,
          monthlyPrice: b.def.monthlyPrice,
          quantity: b.quantity,
        }),
      ),
      skus: billable.map((b) => b.def.sku),
    };
  }

  /**
   * SA-690 option A — the completion half. Called by `checkout.session.completed` AFTER the
   * activation crossing, with the subscription retrieved with its items' products expanded.
   *
   * For each add-on SKU (the checkout's tagged items, plus any active unbilled row the session had no
   * line for), under the shared `addon:<tenant>:<sku>` billing lock:
   *  - adopt: the ACTIVE row with no item takes the item — stripeItemId, Stripe's actual unit price as
   *    its priceSnapshot, the item's quantity — by compare-and-swap, and books its ONE stored → actual
   *    delta. A redelivery finds the item already set and does nothing, books nothing. The trial
   *    period is never retro-billed.
   *  - (a) the row is inactive or missing: the item is deleted Stripe-first, with prorations.
   *  - (b) the row already holds a DIFFERENT item: the row's item stays, the new one is deleted.
   *  - (c) an active row with no item and no line (enabled after the session was created): the enable
   *    path — adopt an unreferenced matching item, else create one.
   * Never two items for one SKU. One SKU failing does not strand the others; the first failure is
   * rethrown AFTER them so the webhook fails and Stripe redelivers (the whole thing is idempotent).
   */
  async adoptCheckoutAddons(
    tenantId: string,
    stripeSub: any,
    ctx: { sessionId?: string | null } = {},
  ): Promise<void> {
    const subId: string | null = typeof stripeSub?.id === "string" ? stripeSub.id : null;
    if (!subId) return;
    const bySku = new Map<string, CheckoutAddonItem[]>();
    for (const item of checkoutAddonItems(stripeSub)) {
      bySku.set(item.sku, [...(bySku.get(item.sku) ?? []), item]);
    }
    // (c): active self-serve rows nothing bills and this checkout had no line for.
    const unbilled = await this.prisma.tenantAddon.findMany({
      where: billableAddonWhere({ tenantId, active: true, stripeItemId: null }),
    });
    for (const row of unbilled) {
      const code = addonSkuCode(row);
      if (code && isSelfServiceAddon(code) && !bySku.has(code)) bySku.set(code, []);
    }
    if (bySku.size === 0) return;

    let changed = false;
    let firstError: Error | null = null;
    for (const sku of [...bySku.keys()].sort()) {
      try {
        const adopted = await this.runUnderAddonLock(tenantId, sku, () =>
          this.adoptCheckoutSku(tenantId, sku, bySku.get(sku) ?? [], subId, ctx),
        );
        changed = changed || adopted;
      } catch (err) {
        firstError ??= err instanceof Error ? err : new Error(String(err));
        this.logger.error(
          `Checkout add-on "${sku}" tenant ${tenantId}: adoption failed (the webhook is retried): ${(err as Error).message}`,
        );
      }
    }
    if (changed) this.entitlements.invalidate(tenantId);
    if (firstError) throw firstError;
  }

  /** The `addon:<tenant>:<sku>` billing lock enable/disable and the admin path hold, as a 503 on timeout. */
  private async runUnderAddonLock<T>(
    tenantId: string,
    sku: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    try {
      const result = await withAdvisoryLock(
        { family: "billing", key: `addon:${tenantId}:${sku}`, mode: "wait", waitMs: 10_000 },
        fn,
      );
      if (!result.acquired) {
        throw new ServiceUnavailableException(
          `Could not serialise add-on "${sku}" for tenant ${tenantId} — lock unavailable`,
        );
      }
      return result.value;
    } catch (e) {
      if (e instanceof LockTimeoutError || e instanceof LockUnavailableError) {
        this.logger.error(
          `Add-on "${sku}" lock unavailable for tenant ${tenantId}: ${(e as Error).message}`,
        );
        throw new ServiceUnavailableException(
          `Could not serialise add-on "${sku}" for tenant ${tenantId} — retry shortly`,
        );
      }
      throw e;
    }
  }

  /** One SKU of `adoptCheckoutAddons`, inside its lock. True when a row was written. */
  private async adoptCheckoutSku(
    tenantId: string,
    sku: string,
    items: CheckoutAddonItem[],
    subId: string,
    ctx: { sessionId?: string | null },
  ): Promise<boolean> {
    // SA-693: only a BILLABLE row (never a comp) can own an item. A SKU whose only rows are comps has
    // no row here, so a checkout item for it is an orphan (deleted), and no item is ever created for it.
    const row = await this.prisma.tenantAddon.findFirst({
      where: billableAddonWhere(addonRowWhere(tenantId, sku)),
      orderBy: [{ active: "desc" }, { createdAt: "asc" }],
    });
    if (items.length === 0) {
      return row?.active && !row.stripeItemId
        ? this.billUnbilledRow(tenantId, sku, row, subId, ctx)
        : false;
    }
    if (!row?.active) {
      // (a) nothing owns these items any more (switched off between session and completion).
      for (const i of items) await this.deleteOrphanItem(i.itemId, tenantId, sku, STRICT_PRORATED);
      return false;
    }
    if (row.stripeItemId) {
      // A redelivery (the row already holds this item) or (b) (it holds a DIFFERENT one): the row's
      // item stays and every other item of the SKU goes — never two items per SKU.
      for (const i of items.filter((x) => x.itemId !== row.stripeItemId)) {
        await this.deleteOrphanItem(i.itemId, tenantId, sku, STRICT_PRORATED);
      }
      return false;
    }
    const [keep, ...extra] = items;
    if (keep.unitAmountCents == null || keep.quantity < 1 || !(row.quantity >= 1)) {
      this.logger.error(
        `Checkout add-on "${sku}" tenant ${tenantId}: item ${keep.itemId} has no readable price/quantity — not adopted`,
      );
      return false;
    }
    const price = fromCents(keep.unitAmountCents);
    // The ROW's quantity wins (SA ruling): the tenant may have changed it after the session was
    // created, and an entitlement is never quietly cut down to what the session carried. Stripe is
    // brought to the row's quantity first (Stripe-first, prorated — a raise bills, a reduce credits),
    // exactly the billed quantity-change path; a failure fails the webhook with nothing written.
    if (keep.quantity !== row.quantity) {
      try {
        await this.stripe.client.subscriptionItems.update(keep.itemId, {
          quantity: row.quantity,
          proration_behavior: "create_prorations",
        });
      } catch (err) {
        this.logger.error(
          `Checkout add-on "${sku}" tenant ${tenantId}: could not set item ${keep.itemId} to the row's quantity ${row.quantity}: ${(err as Error).message}`,
        );
        throw new ServiceUnavailableException(ADDON_ENABLE_BILLING_FAILED);
      }
    }
    const adopted = await this.claimAddonItem(
      tenantId,
      sku,
      row.id,
      keep.itemId,
      price,
      keep.quantity,
      row.quantity,
      ctx,
    );
    // The row changed under us (switched off / given another item / another quantity): fail so the
    // retry re-reads it and lands on (a), (b) or a fresh reconcile — the item is never left unowned
    // and billing.
    if (!adopted) throw new ConflictException(ADDON_ENABLE_BILLING_FAILED);
    for (const i of extra) await this.deleteOrphanItem(i.itemId, tenantId, sku, STRICT_PRORATED);
    return true;
  }

  /**
   * The adoption write: under the tenant row lock (house order), re-read the row and — only while it
   * is still ACTIVE, still holds NO item and still has the quantity Stripe was just set to — set its
   * item and price and book its ledger delta. Compare-and-swap, so a redelivery (or a racing writer)
   * books nothing twice. The row KEEPS its own quantity (`rowQuantity`); `itemQuantity` is what the
   * Stripe item carried when it was adopted:
   *  1. adoption: stored → actual (price × itemQuantity), then
   *  2. when the two quantities differ, the quantity change at the actual price (itemQuantity →
   *     rowQuantity) — the +/- the reconcile above bills or credits in Stripe.
   * Both are signed amounts of the one run-rate; their sum is actual price × rowQuantity − stored.
   */
  private async claimAddonItem(
    tenantId: string,
    sku: string,
    rowId: string,
    itemId: string,
    price: number,
    itemQuantity: number,
    rowQuantity: number,
    ctx: { sessionId?: string | null },
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      await lockTenantForLedger(tx, tenantId);
      const current = await tx.tenantAddon.findUnique({ where: { id: rowId } });
      if (
        !current?.active ||
        current.stripeItemId ||
        current.isComp ||
        current.quantity !== rowQuantity
      ) {
        return false;
      }
      const { count } = await tx.tenantAddon.updateMany({
        where: billableAddonWhere({
          id: rowId,
          active: true,
          stripeItemId: null,
          quantity: rowQuantity,
        }),
        data: { stripeItemId: itemId, priceSnapshot: price },
      });
      if (count !== 1) return false;
      const payload = {
        billed: true,
        source: "checkout",
        ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
      };
      await emitAddonDelta(tx, this.events, {
        tenantId,
        sku,
        before: { priceSnapshot: current.priceSnapshot, quantity: rowQuantity },
        after: { priceSnapshot: price, quantity: itemQuantity },
        payload: { quantity: itemQuantity, ...payload },
      });
      if (itemQuantity !== rowQuantity) {
        await emitAddonDelta(tx, this.events, {
          tenantId,
          sku,
          before: { priceSnapshot: price, quantity: itemQuantity },
          after: { priceSnapshot: price, quantity: rowQuantity },
          payload: { quantity: rowQuantity, reconciled: true, ...payload },
        });
      }
      return true;
    });
  }

  /**
   * (c) An ACTIVE row with no Stripe item and no checkout line (enabled after the session was
   * created): bill it through the enable path — adopt an unreferenced matching item, else create one
   * (catalog price, the row's quantity) — then adopt it onto the row. Skipped, with a log, when the
   * subscription is annual (online add-ons are monthly items), the plan already bundles the SKU, or
   * the catalog no longer prices it: the row stays as it is, never retro-billed.
   */
  private async billUnbilledRow(
    tenantId: string,
    sku: string,
    row: { id: string; quantity: number },
    subId: string,
    ctx: { sessionId?: string | null },
  ): Promise<boolean> {
    const skuDef = (await this.catalog.getPublishedCatalog()).addonSkus.find((s) => s.sku === sku);
    if (!skuDef || (await this.planIncludedRefusal(tenantId, skuDef))) return false;
    const sub = await this.prisma.tenantSubscription.findUnique({
      where: { tenantId },
      select: { billingInterval: true, cycle: true },
    });
    if (isAnnualStripeBilled("STRIPE", { stripeSubId: subId, ...sub })) {
      this.logger.warn(
        `Checkout add-on "${sku}" tenant ${tenantId}: annual subscription — the add-on stays unbilled`,
      );
      return false;
    }
    if (!(row.quantity >= 1)) return false; // a row always carries at least one unit
    const quantity = row.quantity;
    const billed = await this.adoptOrCreateAddonItem(tenantId, sku, skuDef, subId, quantity);
    try {
      const adopted = await this.claimAddonItem(
        tenantId,
        sku,
        row.id,
        billed.itemId,
        Number(skuDef.monthlyPrice),
        quantity,
        row.quantity,
        ctx,
      );
      // The row went away under us: remove the item THIS call created so nothing bills unowned.
      if (!adopted && billed.createdItemId) {
        await this.deleteOrphanItem(billed.createdItemId, tenantId, sku);
      }
      return adopted;
    } catch (err) {
      if (billed.createdItemId) await this.deleteOrphanItem(billed.createdItemId, tenantId, sku);
      throw err;
    }
  }

  /**
   * The "already in your plan" refusal: the SKU's `includedAtPlan` (the plan at and above which the
   * catalog bundles it free, the same rule the choose-plan quote prices with) is at or below the
   * tenant's CURRENT plan. The plan resolves as everywhere else here: the subscription's planKey,
   * else the legacy `Tenant.plan` enum. Only SKUs that have a bundling plan cost a read.
   */
  private async planIncludedRefusal(
    tenantId: string,
    skuDef: { name: string; includedAtPlan?: string | null },
  ): Promise<AddonRefusal | null> {
    if (!skuDef.includedAtPlan) return null;
    const [sub, tenant] = await Promise.all([
      this.prisma.tenantSubscription.findUnique({ where: { tenantId }, select: { planKey: true } }),
      this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { plan: true } }),
    ]);
    const planKey = this.resolveFromPlanKey(sub?.planKey, tenant?.plan);
    return isAddonIncludedAtPlan(skuDef.includedAtPlan, planKey)
      ? addonIncludedRefusal(skuDef.name)
      : null;
  }

  /**
   * The ONE place a tenant's add-on billing mode is decided. STRIPE is checked FIRST: nothing ever
   * clears `externalPayment`, so a tenant that was manually activated and LATER pays by card carries
   * both, and must be billed through Stripe (same order as onboarding's payment.recorded). Only
   * without a live Stripe subscription does `externalPayment` mean "the owner invoices by hand".
   */
  private addonModeOf(
    sub: { stripeSubId?: string | null; externalPayment?: boolean | null } | null | undefined,
  ): AddonBilling {
    if (this.stripe.isConfigured && sub?.stripeSubId) return "STRIPE";
    if (sub?.externalPayment) return "MANUAL";
    return "UNBILLED";
  }

  /** Display name of the tenant for platform notices (never throws; falls back to the id). */
  private async tenantLabelOf(tenantId: string): Promise<string> {
    try {
      const t = await this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { slug: true, name: true },
      });
      return t?.name ?? t?.slug ?? tenantId;
    } catch {
      return tenantId;
    }
  }

  /**
   * A platform notice for a manually-invoiced tenant, in the platform-admin audit feed (the one
   * existing per-tenant notice channel; same row shape as `PlatformAdminService.recordAdminAction`),
   * written in the caller's transaction so it can never exist without the change it announces.
   */
  private async writeManualInvoiceNotice(
    tx: any,
    n: {
      tenantId: string;
      actorId?: string | null;
      action: string;
      sku: string;
      quantity: number;
      monthlyPrice: number;
      message: string;
      /** What the platform must do on the manual invoice. */
      kind: "add" | "stop" | "change";
      addonName: string;
      fromQty: number;
      toQty: number;
    },
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        tenantId: n.tenantId,
        userId: n.actorId ?? null,
        action: n.action,
        entityType: ADMIN_AUDIT_ENTITY,
        entityId: n.tenantId,
        meta: {
          platformAdmin: true,
          sku: n.sku,
          quantity: n.quantity,
          monthlyPrice: n.monthlyPrice,
          message: n.message,
          addonName: n.addonName,
          kind: n.kind,
          fromQty: n.fromQty,
          toQty: n.toQty,
        },
      },
    });
  }

  /**
   * The pending proration invoice items of `itemId` on the customer's next invoice, as Stripe holds
   * them right now. API 2026-08-26.dahlia (pinned, verified against the sandbox + the SDK types): an
   * InvoiceItem has NO `created` field (its creation time is `date`), and the subscription item a
   * proration line belongs to is `parent.subscription_details.subscription_item` (the old top-level
   * `subscription_item` is gone). null when Stripe cannot be read. Never throws.
   */
  private async pendingProrationLines(
    sub: { stripeCustomerId?: string | null } | null,
    itemId: string,
  ): Promise<any[] | null> {
    if (!sub?.stripeCustomerId) return null;
    try {
      const list = await this.stripe.client.invoiceItems.list({
        customer: sub.stripeCustomerId,
        pending: true,
        limit: 100,
      });
      return (list?.data ?? []).filter(
        (ii: any) =>
          ii?.proration === true && ii?.parent?.subscription_details?.subscription_item === itemId,
      );
    } catch (err) {
      this.logger.warn(
        `Could not read Stripe's pending proration for item ${itemId}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * The ids of `itemId`'s pending proration lines BEFORE a change — the baseline `readStripeProration`
   * diffs against. null when unreadable (the figure is then null too, never a guess).
   */
  private async pendingProrationIds(
    sub: { stripeCustomerId?: string | null } | null,
    itemId: string,
  ): Promise<Set<string> | null> {
    const lines = await this.pendingProrationLines(sub, itemId);
    return lines ? new Set(lines.map((l: any) => String(l.id))) : null;
  }

  /**
   * What Stripe actually prorated for `itemId` in THIS call — the pending proration lines of that
   * subscription item that were not there before the call (`before`, from `pendingProrationIds`), in
   * dollars. B1110 / F6: told apart by id, not by a time window: a clock window (the old `now - 2 s`)
   * let a change made within seconds of the previous one pull that change's lines into its own
   * figure (147.20 for 98.13, 49.06 for -49.07). A brand-new item has no prior lines, so `before` is
   * empty. null when it cannot be read (the add-on is on and billed regardless; the amount then simply
   * shows on the next invoice). Never throws.
   */
  private async readStripeProration(
    sub: { stripeCustomerId?: string | null } | null,
    itemId: string,
    before: ReadonlySet<string> | null,
  ): Promise<number | null> {
    if (!before) return null;
    const lines = await this.pendingProrationLines(sub, itemId);
    const mine = (lines ?? []).filter((ii: any) => !before.has(String(ii.id)));
    if (mine.length === 0) return null;
    const cents = mine.reduce((sum: number, ii: any) => sum + Number(ii.amount ?? 0), 0);
    return roundMoney(cents / 100);
  }

  /**
   * ORPHAN adoption. If Stripe created an item but every response was lost (timeout), we returned a
   * 503 with no item id and never cleaned up — a user retry would then create a SECOND item. So,
   * under the add-on lock and BEFORE creating, list the subscription's items and adopt a matching
   * (metadata {tenantId, sku}) item no row of this tenant references; delete any extra matching
   * unreferenced items. Returns the adopted item id, or null when there is nothing to adopt.
   * A listing failure refuses the enable (fail closed): we cannot rule out an orphan.
   */
  private async adoptOrphanItem(
    tenantId: string,
    sku: string,
    stripeSubId: string,
    qty: number,
  ): Promise<string | null> {
    try {
      const list = await this.stripe.client.subscriptionItems.list({
        subscription: stripeSubId,
        limit: 100,
      });
      const mine = (list?.data ?? []).filter(
        (i: any) => i?.metadata?.tenantId === tenantId && i?.metadata?.sku === sku,
      );
      if (mine.length === 0) return null;
      const referenced = await this.prisma.tenantAddon.findMany({
        where: { tenantId, stripeItemId: { in: mine.map((i: any) => i.id) } },
        select: { stripeItemId: true },
      });
      const refIds = new Set(referenced.map((r: any) => r.stripeItemId));
      const orphans = mine.filter((i: any) => !refIds.has(i.id));
      if (orphans.length === 0) return null;
      const [keep, ...extra] = orphans;
      for (const e of extra) await this.deleteOrphanItem(e.id, tenantId, sku);
      if (Number(keep.quantity) !== qty) {
        await this.stripe.client.subscriptionItems.update(keep.id, {
          quantity: qty,
          proration_behavior: "create_prorations",
        });
      }
      this.logger.warn(
        `Add-on "${sku}" tenant ${tenantId}: adopted unreferenced Stripe item ${keep.id} instead of creating another`,
      );
      return keep.id as string;
    } catch (err) {
      this.logger.error(
        `Add-on "${sku}" tenant ${tenantId}: could not check Stripe for an orphaned item: ${(err as Error).message}`,
      );
      throw new ServiceUnavailableException(ADDON_ENABLE_BILLING_FAILED);
    }
  }

  /**
   * Removal of a Stripe item no row owns. Default: best-effort (an item THIS call created but could
   * not commit a row for). `prorate` credits the unused time (`create_prorations`); `rethrow` fails the
   * caller on a Stripe error other than "already gone" — a checkout webhook must be retried, never
   * leave the customer billed for an item nothing tracks.
   */
  private async deleteOrphanItem(
    itemId: string,
    tenantId: string,
    sku: string,
    opts: { prorate?: boolean; rethrow?: boolean } = {},
  ): Promise<void> {
    try {
      if (opts.prorate) {
        await this.stripe.client.subscriptionItems.del(itemId, {
          proration_behavior: "create_prorations",
        });
      } else {
        await this.stripe.client.subscriptionItems.del(itemId);
      }
    } catch (err) {
      if (!isStripeResourceMissing(err)) {
        this.logger.error(
          `Add-on "${sku}" for tenant ${tenantId}: could not remove orphan Stripe item ${itemId}: ${(err as Error).message}`,
        );
        if (opts.rethrow) throw err;
      }
    }
  }

  /**
   * ONE Stripe item for a self-serve add-on on a live subscription: adopt a matching unreferenced
   * item (a previous attempt whose response was lost), else create the product + monthly item at the
   * CATALOG price with `create_prorations`. `createdItemId` is set only for an item THIS call created
   * (the caller removes it if no row can take it). A failure refuses with fixed copy (503).
   */
  private async adoptOrCreateAddonItem(
    tenantId: string,
    sku: string,
    skuDef: PlanVersionWithCatalog["addonSkus"][number],
    subId: string,
    qty: number,
  ): Promise<{ itemId: string; createdItemId: string | null }> {
    const adopted = await this.adoptOrphanItem(tenantId, sku, subId, qty);
    if (adopted) return { itemId: adopted, createdItemId: null };
    try {
      const product = await this.stripe.client.products.create({
        name: `RouteFlow add-on — ${skuDef.name}`,
        metadata: { tenantId, sku },
      });
      const item = await this.stripe.client.subscriptionItems.create(
        {
          subscription: subId,
          quantity: qty,
          proration_behavior: "create_prorations",
          price_data: {
            currency: "usd",
            unit_amount: toCents(skuDef.monthlyPrice),
            recurring: { interval: "month" },
            product: product.id,
          },
          metadata: { tenantId, sku },
        },
        // Per-ATTEMPT key: protects this one request against a transport retry creating a second
        // item, yet a later attempt (e.g. after an orphan was cleaned up) is never answered with
        // the earlier, deleted item.
        { idempotencyKey: `addon-item:${tenantId}:${sku}:${randomUUID()}` },
      );
      return { itemId: item.id as string, createdItemId: item.id as string };
    } catch (err) {
      this.logger.error(
        `Add-on "${sku}" tenant ${tenantId}: Stripe item create failed: ${(err as Error).message}`,
      );
      throw new ServiceUnavailableException(ADDON_ENABLE_BILLING_FAILED);
    }
  }

  /**
   * The enable critical section (runs under the `addon:<tenant>:<sku>` advisory lock).
   *
   * BILLED = Stripe configured AND the tenant has a `stripeSubId`. Then, for a new / re-activated
   * add-on, ONE Stripe subscription item is created (inline `price_data`, explicit
   * `create_prorations`) BEFORE any row is written; a Stripe failure refuses the call with fixed
   * copy and leaves no enabled row and no ledger event. The ledger books the add-on only after
   * Stripe succeeded, inside the same transaction as the row.
   *
   * UNBILLED (a free pilot with no `stripeSubId`, or Stripe not configured): the add-on is on, the
   * row's `priceSnapshot` is explicitly 0 and the ledger books nothing — never revenue we do not bill.
   * A row that was ALREADY active is never retro-billed: a same-qty re-enable is a no-op and a row
   * with no Stripe item keeps its stored snapshot.
   */
  private async enableAddonLocked(
    tenantId: string,
    sku: string,
    skuDef: PlanVersionWithCatalog["addonSkus"][number],
    qty: number,
    actorId?: string,
  ): Promise<{ changed: boolean; proratedNow: number | null; billing: AddonBilling }> {
    const { sub, mode } = await this.addonBillingContext(tenantId);
    const existing = await findAddonRow(this.prisma, tenantId, sku);
    const existingBilling: AddonBilling = existing?.stripeItemId ? "STRIPE" : mode;

    // Idempotent: already on at this quantity — nothing to create, update or book.
    if (existing?.active && existing.quantity === qty) {
      return { changed: false, proratedNow: 0, billing: existingBilling };
    }

    // SA-693: an ACTIVE comp is a platform grant: its quantity is support's to manage, never the
    // tenant's (a change here would otherwise start billing a row nobody agreed to bill). Refused
    // before any Stripe call, write or ledger event. A DISABLED comp falls through and re-bills below.
    if (existing?.active && existing.isComp) throw refusalException(ADDON_COMP_REFUSAL);

    let stripeItemId: string | null = null;
    let createdItemId: string | null = null;
    let proratedNow: number | null = 0;
    let priceSnapshot: number;
    // Set only for a MANUAL tenant: what the owner must change on the manual invoice.
    let manualNotice: { action: string; kind: "enable" | "reduce" } | null = null;

    if (existing?.active && existing.stripeItemId) {
      // F2 (B1088): a quantity RAISE on an annual Stripe subscription is refused exactly like a new
      // item (same predicate, same coded 409), before any Stripe call, write or ledger event. A
      // decrease (and a disable) stay allowed so the tenant can always shrink what it pays for.
      if (qty > existing.quantity && isAnnualStripeBilled(mode, sub)) {
        throw refusalException(ADDON_ANNUAL_REFUSAL);
      }
      // Billed row, new quantity: update the item (prorated). Its price stays the one it was
      // created at (grandfathered) — only the quantity moves.
      if (!this.stripe.isConfigured) {
        throw new ServiceUnavailableException(ADDON_ENABLE_BILLING_FAILED);
      }
      // What is already pending for this item BEFORE the change (B1110): this call's own lines are the
      // ones that appear after it.
      const priorLines = await this.pendingProrationIds(sub, existing.stripeItemId);
      try {
        await this.stripe.client.subscriptionItems.update(existing.stripeItemId, {
          quantity: qty,
          proration_behavior: "create_prorations",
        });
      } catch (err) {
        this.logger.error(
          `Add-on "${sku}" tenant ${tenantId}: Stripe quantity update failed: ${(err as Error).message}`,
        );
        throw new ServiceUnavailableException(ADDON_ENABLE_BILLING_FAILED);
      }
      stripeItemId = existing.stripeItemId;
      priceSnapshot = Number(existing.priceSnapshot ?? 0);
      proratedNow = await this.readStripeProration(sub, stripeItemId, priorLines);
    } else if (existing?.active) {
      // Already on with NO Stripe item (a legacy / pilot / manual row): never retro-bill.
      if (mode === "STRIPE" && qty > existing.quantity) {
        // Raising billable quantity on a Stripe-billed tenant's OLD unbilled row would book MRR with
        // no Stripe charge. Refuse until that row is billed (support moves it onto an item).
        throw new ConflictException(ADDON_RAISE_UNBILLED_ROW);
      }
      const stored = Number(existing.priceSnapshot ?? 0);
      if (mode === "MANUAL" && qty > existing.quantity) {
        // An INCREASE re-prices a $0 row to the catalog price and tells the owner to invoice it.
        priceSnapshot = stored > 0 ? stored : Number(skuDef.monthlyPrice);
        proratedNow = null;
        manualNotice = { action: AdminAuditAction.ADDON_MANUAL_INVOICE_DUE, kind: "enable" };
      } else {
        // A DECREASE (or any non-manual change) never re-prices: it reverses at the row's OWN price
        // (a $0 row books nothing). The owner is told to reduce the invoice only if it was invoiced.
        // UNBILLED (a pilot / Stripe not configured): nothing is billed, so ANY change stores snapshot 0
        // and books no revenue (a legacy non-zero snapshot is withdrawn, never grown).
        priceSnapshot = mode === "UNBILLED" ? 0 : stored;
        if (mode === "MANUAL" && stored > 0) {
          manualNotice = { action: AdminAuditAction.ADDON_MANUAL_INVOICE_STOP, kind: "reduce" };
        }
      }
    } else if (mode === "STRIPE" && sub?.stripeSubId) {
      if (isAnnualStripeBilled(mode, sub)) {
        // Online add-ons are monthly items; an annual subscription is refused by policy (support
        // sets it up). Fail closed, no Stripe call.
        throw refusalException(ADDON_ANNUAL_REFUSAL);
      }
      // A previous attempt may have created an item whose response was lost: adopt it, never add a second.
      const billed = await this.adoptOrCreateAddonItem(tenantId, sku, skuDef, sub.stripeSubId, qty);
      stripeItemId = billed.itemId;
      createdItemId = billed.createdItemId;
      priceSnapshot = Number(skuDef.monthlyPrice);
      // An adopted item's proration happened in an earlier attempt: no figure to show for it.
      proratedNow = createdItemId
        ? await this.readStripeProration(sub, createdItemId, new Set()) // a new item has no earlier lines
        : null;
    } else if (mode === "MANUAL") {
      // Manually-invoiced tenant (owner ruling 2026-10-03): on at the CATALOG price, counted as
      // revenue, NO Stripe call; the owner adds it to the next manual invoice (notice below).
      priceSnapshot = Number(skuDef.monthlyPrice);
      proratedNow = null;
      manualNotice = { action: AdminAuditAction.ADDON_MANUAL_INVOICE_DUE, kind: "enable" };
    } else {
      // Free pilot / Stripe not configured: on, unbilled, priced explicitly at 0 (books nothing).
      priceSnapshot = 0;
    }

    // Tenant label for the platform notice (read outside the transaction; display only).
    const tenantName = manualNotice ? await this.tenantLabelOf(tenantId) : null;

    try {
      await this.prisma.$transaction(async (tx) => {
        // B865 / SA-277 FIX-2/FIX-3 (house lock order): tenant row lock FIRST, and the existence
        // read INSIDE the tx, AFTER the lock, so `before` can never observe a stale pre-lock state.
        await lockTenantForLedger(tx, tenantId);
        // #2188 / SA-385: finds a row the admin path keyed on a legacy addonKey too.
        const current = await findAddonRow(tx, tenantId, sku);
        if (createdItemId && current?.active) {
          // Lost a race against an unlocked writer (subscribe): never leave two billing handles.
          throw new ConflictException(ADDON_ENABLE_BILLING_FAILED);
        }
        const before = current?.active
          ? { priceSnapshot: current.priceSnapshot, quantity: current.quantity }
          : { priceSnapshot: 0, quantity: 0 };

        // Re-activate an existing row IN PLACE (whichever key it carries); else create.
        await tx.tenantAddon.upsert({
          where: { tenantId_addonKey: { tenantId, addonKey: current?.addonKey ?? sku } },
          create: {
            tenantId,
            addonKey: sku,
            sku,
            quantity: qty,
            active: true,
            priceSnapshot,
            stripeItemId,
            isComp: false,
          },
          update: {
            sku,
            quantity: qty,
            active: true,
            priceSnapshot,
            // SA-693: self-serve is billable: it never writes a comp and resets a re-activated one.
            isComp: false,
            ...(stripeItemId ? { stripeItemId } : {}),
          },
        });
        await emitAddonDelta(tx, this.events, {
          tenantId,
          sku,
          before,
          after: { priceSnapshot, quantity: qty },
          actorId,
          payload: { quantity: qty, prorated: proratedNow ?? 0, billed: stripeItemId != null },
        });
        if (sku === "SEAT_EXTRA" && !current?.active) {
          await this.events.emit(
            tenantId,
            BILLING_EVENTS.SEAT_ADDED,
            { quantity: qty },
            { actorId, tx },
          );
        }
        if (manualNotice) {
          const reduce = manualNotice.kind === "reduce";
          await this.writeManualInvoiceNotice(tx, {
            tenantId,
            actorId,
            action: manualNotice.action,
            sku,
            quantity: qty,
            monthlyPrice: priceSnapshot,
            kind: reduce || current?.active ? "change" : "add",
            addonName: skuDef.name,
            fromQty: current?.active ? current.quantity : 0,
            toQty: qty,
            message: reduce
              ? `Add-on ${skuDef.name} reduced to ${qty} for ${tenantName}: reduce their next manual invoice to ${qty}`
              : `Add-on ${skuDef.name} enabled for ${tenantName}: add to their next manual invoice`,
          });
        }
      });
    } catch (err) {
      // The item exists in Stripe but no row points at it: remove it so nothing bills unowned.
      if (createdItemId) await this.deleteOrphanItem(createdItemId, tenantId, sku);
      throw err;
    }

    return {
      changed: true,
      proratedNow,
      billing: stripeItemId ? "STRIPE" : mode === "MANUAL" ? "MANUAL" : "UNBILLED",
    };
  }

  /**
   * Remove a billed add-on's Stripe item (prorated credit). `resource_missing` = already gone =
   * success; ANY other failure refuses with fixed copy so we never keep billing for an add-on the
   * tenant no longer has. A no-op without an item. With an item but Stripe NOT configured we cannot
   * remove it, so the call is refused (fixed copy) and the handle is kept: dropping the pointer would
   * leave the item billing in Stripe with nothing left to stop it.
   */
  private async removeStripeAddonItem(
    tenantId: string,
    code: string,
    itemId: string | null | undefined,
  ): Promise<void> {
    if (!itemId) return;
    if (!this.stripe.isConfigured) {
      this.logger.error(
        `Add-on "${code}" tenant ${tenantId}: Stripe item ${itemId} cannot be removed — Stripe is not configured; keeping the handle`,
      );
      throw new ServiceUnavailableException(ADDON_DISABLE_BILLING_FAILED);
    }
    try {
      await this.stripe.client.subscriptionItems.del(itemId, {
        proration_behavior: "create_prorations",
      });
    } catch (err) {
      if (!isStripeResourceMissing(err)) {
        this.logger.error(
          `Add-on "${code}" tenant ${tenantId}: Stripe item ${itemId} removal failed: ${(err as Error).message}`,
        );
        throw new ServiceUnavailableException(ADDON_DISABLE_BILLING_FAILED);
      }
      this.logger.warn(
        `Add-on "${code}" tenant ${tenantId}: Stripe item ${itemId} was already removed; clearing the pointer`,
      );
    }
  }

  /** Disable an add-on. Keeps the row (history read-only); nav/flag simply drops. */
  async disableAddon(tenantId: string, sku: string, actorId?: string) {
    // The SAME `addon:<tenant>:<sku>` advisory lock enableAddon (and the admin path) holds, so a
    // disable can never interleave with an enable of the same add-on (two items / a stale pointer).
    const lockKey = `addon:${tenantId}:${addonCodeOf(sku)}`;
    try {
      const result = await withAdvisoryLock(
        { family: "billing", key: lockKey, mode: "wait", waitMs: 10_000 },
        () => this.disableAddonLocked(tenantId, sku, actorId),
      );
      if (!result.acquired) {
        throw new ServiceUnavailableException(
          `Could not disable add-on "${sku}" for tenant ${tenantId} — lock unavailable`,
        );
      }
      return result.value;
    } catch (e) {
      if (e instanceof LockTimeoutError || e instanceof LockUnavailableError) {
        this.logger.error(
          `Add-on "${sku}" lock unavailable for tenant ${tenantId}: ${(e as Error).message}`,
        );
        throw new ServiceUnavailableException(
          `Could not serialise disabling add-on "${sku}" for tenant ${tenantId} — retry shortly`,
        );
      }
      throw e;
    }
  }

  private async disableAddonLocked(tenantId: string, sku: string, actorId?: string) {
    // #2188 / SA-385: the shared lookup (legacy addonKey or SKU) — its deterministic pick
    // (active first, then oldest) — refused unless that row is active.
    const addon = await findAddonRow(this.prisma, tenantId, sku);
    if (!addon?.active) throw new NotFoundException(`Active add-on "${sku}" not found.`);
    // Resolve the CANONICAL code (bridges legacy addonKey like tobacco_dealer → REGULATED_ITEMS).
    const code = addonSkuCode(addon) ?? sku;
    // Symmetric with enableAddon: an admin-granted ("ships dark") add-on is revocable only by
    // platform-admin — self-disabling one is a dead end, since re-enabling it is a 403.
    if (!isSelfServiceAddon(code)) throw new ForbiddenException(ADMIN_ONLY_ADDON_MESSAGE);

    // A billed add-on carries a Stripe subscription item: it must actually be removed (or already
    // gone) BEFORE the entitlement is turned off. Any other Stripe failure refuses the call.
    await this.removeStripeAddonItem(tenantId, code, addon.stripeItemId);

    // MANUAL tenant (owner invoices by hand): tell the platform to stop invoicing it. Only a row that
    // was actually priced (> 0) was ever invoiced.
    const { mode } = await this.addonBillingContext(tenantId);
    const manualStopName =
      mode === "MANUAL" && !addon.stripeItemId && Number(addon.priceSnapshot ?? 0) > 0
        ? await this.tenantLabelOf(tenantId)
        : null;
    const stopSkuName = manualStopName
      ? ((await this.catalog.getPublishedCatalog()).addonSkus.find((x) => x.sku === code)?.name ??
        code)
      : code;

    await this.prisma.$transaction(async (tx) => {
      // FIX-864 r2 finding #0: `addon` above was read outside the transaction and before any
      // lock — two concurrent self-serve disables could both observe active=true and both emit
      // a −snapshot×qty ledger delta. Mirror addon.service.ts's admin-path fix (FIX-865B): lock
      // the row FIRST, re-read it INSIDE the transaction, and gate the update + emit on THAT
      // read, so a losing concurrent call sees active=false already and no-ops.
      // B865 / SA-277 FIX-2 (house lock order): tenant row lock FIRST, before the TenantAddon
      // row lock.
      await lockTenantForLedger(tx, tenantId);
      await tx.$queryRaw`SELECT id FROM "TenantAddon" WHERE id = ${addon.id} FOR UPDATE`;
      const current = await tx.tenantAddon.findUnique({ where: { id: addon.id } });
      if (!current?.active) return; // already disabled by a concurrent call that won the race
      await tx.tenantAddon.update({
        where: { id: addon.id },
        data: { active: false, stripeItemId: null },
      });
      await emitAddonDelta(tx, this.events, {
        tenantId,
        sku: code,
        before: { priceSnapshot: current.priceSnapshot, quantity: current.quantity },
        after: { priceSnapshot: 0, quantity: 0 },
        actorId,
      });
      if (code === "SEAT_EXTRA") {
        await this.events.emit(
          tenantId,
          BILLING_EVENTS.SEAT_FREED,
          { quantity: current.quantity },
          { actorId, tx },
        );
      }
      if (manualStopName) {
        await this.writeManualInvoiceNotice(tx, {
          tenantId,
          actorId,
          action: AdminAuditAction.ADDON_MANUAL_INVOICE_STOP,
          sku: code,
          quantity: current.quantity,
          monthlyPrice: Number(current.priceSnapshot ?? 0),
          kind: "stop",
          addonName: stopSkuName,
          fromQty: current.quantity,
          toQty: 0,
          message: `Add-on ${stopSkuName} turned off for ${manualStopName}: stop invoicing it`,
        });
      }
    });

    this.entitlements.invalidate(tenantId);
    return this.subscription.getSubscription(tenantId);
  }
}
