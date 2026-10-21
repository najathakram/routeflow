/**
 * DB-lane helper: a real `BillingService` + `SubscriptionMutationService` pair on a real Prisma client, driven through
 * the webhook entry point (`handleWebhookEvent("checkout.session.completed")` -> `onCheckoutCompleted`), so a spec
 * proves what a PAID checkout does to the add-on rows and the ledger without a Stripe account.
 *
 * Only what is out of scope for an add-on spec is stubbed: the plan-snapshot hook (flag off), notifications and the
 * trailing Stripe price / coupon re-sync (their own specs cover them). The Stripe stub is the caller's: it must serve
 * `getSubscription` (the checkout's subscription, items expanded) and whatever item calls the case under test makes.
 */
import { BillingService } from "../billing/billing.service";
import { BillingEventService } from "../billing/billing-event.service";
import { ProrationService } from "../billing/proration.service";
import { SubscriptionMutationService } from "../billing/subscription-mutation.service";
import { CATCHUP_META } from "../billing/catchup-claim";

export interface CheckoutHarness {
  billing: BillingService;
  mutations: SubscriptionMutationService;
  /** Delivers `checkout.session.completed` for `session` (a redelivery is just a second call). */
  complete(session: Record<string, unknown>): Promise<void>;
}

export function buildCheckoutHarness(o: {
  prisma: unknown;
  /** Serves `getPublishedCatalog` / `getVersionForTenant` (a stand-in plan graph is fine). */
  catalog: unknown;
  stripe: unknown;
  events: BillingEventService;
  /** The monthly base price `resolveCatalogPricing` answers (best-effort inside the handler). */
  monthly?: number;
}): CheckoutHarness {
  const planTransition: any = {
    isEnabled: () => Promise.resolve(false),
    prepare: () => Promise.resolve({ enabled: false, planAllows: null }),
    onPlanChange: () => Promise.resolve({ action: "none" }),
    transactionOptions: () => undefined,
    invalidateCaches: () => undefined,
  };
  const noop: any = { invalidate: jest.fn() };
  const mutations = new SubscriptionMutationService(
    o.prisma as any,
    o.catalog as any,
    new ProrationService(o.prisma as any, o.catalog as any),
    { getSubscription: jest.fn().mockResolvedValue(undefined) } as any,
    noop,
    o.events,
    noop,
    o.stripe as any,
    { notifyUpgradeConfirmed: jest.fn() } as any,
    planTransition,
  );
  const billing = new BillingService(
    o.prisma as any,
    o.stripe as any,
    { send: jest.fn().mockResolvedValue({}) } as any,
    noop,
    o.events,
    { resolveCatalogPricing: async () => ({ monthly: o.monthly ?? 249 }) } as any,
    {} as any,
    planTransition,
    mutations,
  );
  // The trailing price / coupon re-sync is its own concern (own specs): the adoption and the ledger are not.
  jest
    .spyOn(billing as any, "syncStripeSubscriptionPrice")
    .mockResolvedValue({ synced: true, unchanged: true });
  jest.spyOn(billing as any, "syncCoupon").mockResolvedValue(undefined);
  return {
    billing,
    mutations,
    complete: (session) =>
      billing.handleWebhookEvent({
        id: `evt_${String(session.id)}`,
        type: "checkout.session.completed",
        data: { object: session },
      }),
  };
}

/** The marker a catch-up card checkout carries: it turns manual invoicing off in the apply transaction. */
export const CATCHUP_PREPAID_METADATA = { [CATCHUP_META.catchup]: "prepaid" } as const;
