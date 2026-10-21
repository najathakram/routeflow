import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  API_ERROR_CODES,
  type AddonBillingMode,
  type EnableAddonResult,
  type BillingPortalResult,
  type MeterKey,
  type SubscriptionView,
} from "@routeflow/types";
import { apiClient } from "../api-client";
import { guardCounterLeave } from "../counter-cart-signal";

export type { SubscriptionView };

// ─── Types (mirror apps/api/src/billing return shapes) ──────────────────────────

export type Cycle = "MONTHLY" | "ANNUAL";

export interface PlanDef {
  planKey: string;
  name: string;
  monthlyPrice: number | null;
  annualPrice: number | null;
  isCustom: boolean;
  seatsIncluded: number | null;
  routesConcurrent: number | null;
  scansIncluded: number | null;
  msgsIncluded: number;
  featureFlags: string[];
  sortOrder: number;
}

export interface AddonSkuDef {
  sku: string;
  name: string;
  monthlyPrice: number;
  unit: string;
  includedAtPlan: string | null;
  meteredKey: string | null;
  capacityPerUnit: number | null;
  stackable: boolean;
  grantsFlags: string[];
  sortOrder: number;
}

export interface PublicCatalog {
  version: number;
  effectiveAt: string | null;
  plans: PlanDef[];
  addons: AddonSkuDef[];
}

export type { MeterKey };

export interface MeterReading {
  meter: MeterKey;
  used: number;
  included: number | null;
  remaining: number | null;
  resetsAt: string | null;
}

export interface QuoteLine {
  type: "plan" | "addon";
  key: string;
  name: string;
  quantity: number;
  monthly: number;
  cyclePrice: number;
  included: boolean;
}

export type PlanChangeAction =
  "SUBSCRIBE" | "UPGRADE" | "DOWNGRADE" | "KEEP_CURRENT" | "CONTACT_SALES" | "NOOP";

/** Mirrors apps/api/src/billing/subscription-mutation.service.ts's PlanChangePreview
 * (dates serialize to ISO strings over the wire). `null` on the quote when the caller
 * carries no tenant context (e.g. SUPER_ADMIN). */
export interface PlanChange {
  action: PlanChangeAction;
  proratedNow: number | null;
  effectiveAt: string | null;
  keepsRenewalAt: string | null;
  warning?: string;
  /** TRUE only when the DOWNGRADE seat-cap check found users over the target plan's cap,
   *  i.e. the one case where committing really does deactivate staff accounts. Never infer
   *  that consequence from `warning` being non-empty — `warning` also carries unrelated
   *  copy (a revoked cancellation, "not prorated", sales hand-off), and keying the
   *  acknowledgement on it demands consent to a consequence that will not happen. */
  seatAckRequired: boolean;
  /** The tenant's CURRENT plan key, normalized past legacy aliases, so the chooser can
   *  mark the plan they are on without re-deriving it from a stored (possibly aliased)
   *  key. Absent when the caller carries no tenant context. */
  fromPlanKey?: string | null;
  /** UPGRADE only (SA-786): the add-ons the new plan newly includes - free from commit, still on. */
  includedAddons?: { sku: string; name: string }[];
  /** DOWNGRADE only (SA-786): the add-ons the new plan stops including - billed at the catalog price. */
  repricedAddons?: { sku: string; name: string; monthlyPrice: number }[];
}

export interface QuoteResult {
  planKey: string;
  planName: string;
  cycle: Cycle;
  isCustom: boolean;
  lines: QuoteLine[];
  subtotalMonthly: number;
  dueToday: number;
  annualSaving: number;
  renewalAt: string;
  change: PlanChange | null;
}

export interface PlanFit {
  planKey: string;
  name: string;
  monthly: number | null;
  isCustom: boolean;
  fits: boolean;
  over: { seats: number; routes: number; scans: number; msgs: number };
}

export interface Recommendation {
  currentPlanKey: string;
  usage: { seats: number; routes: number; scans: number; msgs: number };
  perPlan: PlanFit[];
  recommendedPlanKey: string;
  preCheckedAddons: string[];
}

export interface ProrationPreview {
  sku: string;
  name: string;
  monthly: number;
  /** An estimate (Stripe's own figure comes back from the enable call). Null when nothing would
   *  be charged: an unbilled tenant (`billed` false) or a refused enable (`refusal` set). */
  proratedToday: number | null;
  daysRemaining: number;
  daysInCycle: number;
  effectiveAt: string;
  nextChargeAt: string;
  /** How the add-on is billed; "REFUSED" when the enable call would 409 (see `refusal`). */
  billing?: AddonBillingMode | "REFUSED";
  billed?: boolean;
  /** The SAME `{ code, message }` the enable call throws (ADDON_ANNUAL_NOT_SUPPORTED /
   *  ADDON_INCLUDED_IN_PLAN); null when the enable is allowed. */
  refusal?: { code: string; message: string } | null;
  /** SA-690: true while the tenant is still on its TRIAL — the add-on is on at no charge now and is
   *  billed when the card is added (the confirm sheet's copy), not charged today. */
  trial?: boolean;
}

export interface QuoteInput {
  planKey: string;
  cycle: Cycle;
  addons?: Array<{ sku: string; quantity?: number }>;
}

const KEY = ["billing"] as const;

// ─── Queries ────────────────────────────────────────────────────────────────

export function usePlans() {
  return useQuery<PublicCatalog>({
    queryKey: [...KEY, "plans"],
    queryFn: () => apiClient.get("/billing/plans").then((r) => r.data),
  });
}

/** `staleTime` defaults to the QueryClient-wide 30s; callers that only need the read-only
 *  banner on every dashboard page (not the billing page's live detail) should pass a longer
 *  one so it doesn't refetch on every navigation. `enabled` lets a caller that renders for
 *  every role (e.g. the dashboard shell) skip the request for roles the endpoint 403s
 *  (CUSTOMER/DRIVER — `GET /billing/subscription` is `@Roles(OPERATOR)`-gated). */
export function useSubscription(options?: {
  staleTime?: number;
  enabled?: boolean;
  /** SA-733r6: poll while a billing state is showing so a payment clears the strip <= 60 s (no websocket). */
  refetchInterval?:
    number | false | ((query: { state: { data?: SubscriptionView } }) => number | false);
}) {
  return useQuery<SubscriptionView>({
    queryKey: [...KEY, "subscription"],
    queryFn: () => apiClient.get("/billing/subscription").then((r) => r.data),
    ...options,
  });
}

export function useUsage() {
  return useQuery<MeterReading[]>({
    queryKey: [...KEY, "usage"],
    queryFn: () => apiClient.get("/billing/usage").then((r) => r.data),
  });
}

export function useRecommendation() {
  return useQuery<Recommendation>({
    queryKey: [...KEY, "recommendation"],
    queryFn: () => apiClient.get("/billing/recommendation").then((r) => r.data),
  });
}

/** A MONEY quote the add-on confirm sheet shows before the tenant commits: never served from
 *  the cache as current. `staleTime: 0` + `refetchOnMount: "always"` override the app-wide 30s
 *  staleTime, so every open re-checks; callers gate Confirm on `isFetching`, not `isLoading`. */
export function useProrationPreview(sku: string | null) {
  return useQuery<ProrationPreview>({
    queryKey: [...KEY, "proration-preview", sku],
    enabled: !!sku,
    staleTime: 0,
    refetchOnMount: "always",
    queryFn: () =>
      apiClient.get(`/billing/proration-preview`, { params: { sku } }).then((r) => r.data),
  });
}

// ─── Mutations ────────────────────────────────────────────────────────────────

/** Recompute a quote as the chooser toggles cycle / selects add-ons. */
export function useQuote() {
  return useMutation<QuoteResult, Error, QuoteInput>({
    mutationFn: (body) => apiClient.post("/billing/quote", body).then((r) => r.data),
  });
}

/** `localErrorToast`: the settings page renders its own error UI for this mutation, so the app-wide
 *  generic error toast (mutation-error-toast.ts) must not stack on top of it. `true` = the page owns
 *  every error; a predicate = it owns only the errors it matches (the rest keep the global toast). */
type LocalErrorToast = boolean | ((error: unknown) => boolean);

function useBillingMutation<TBody, TResult = unknown>(
  fn: (b: TBody) => Promise<TResult>,
  localErrorToast?: LocalErrorToast,
  /** Seeds the cache from the response BEFORE the invalidation refetch (so a page never shows a stale value). */
  seed?: (qc: ReturnType<typeof useQueryClient>, result: TResult) => void,
) {
  const qc = useQueryClient();
  return useMutation<TResult, Error, TBody>({
    mutationFn: fn,
    onSuccess: (result) => {
      seed?.(qc, result);
      return qc.invalidateQueries({ queryKey: KEY });
    },
    meta: localErrorToast ? { localErrorToast } : undefined,
  });
}

/** The `code` of an API error body (`response.data.code`), never the status. */
export function apiErrorCodeOf(error: unknown): string | undefined {
  const code = (error as { response?: { data?: { code?: unknown } } } | undefined)?.response?.data
    ?.code;
  return typeof code === "string" ? code : undefined;
}

/**
 * A refused Complete payment checkout the billing page words itself: ADDON_BILLING_PENDING_CHECKOUT, and
 * CHECKOUT_ANCHOR_WINDOW (the window before the 1st: fixed copy + the local time of `retryAt`).
 */
export const isMappedCheckoutError = (error: unknown): boolean => {
  const code = apiErrorCodeOf(error);
  return (
    code === API_ERROR_CODES.ADDON_BILLING_PENDING_CHECKOUT ||
    code === API_ERROR_CODES.CHECKOUT_ANCHOR_WINDOW
  );
};

/** A refused add-on enable the confirm sheet words itself (annual plan, already in the plan, the quantity moved
 *  under the page, or an unbilled row that can't be raised). */
export const isMappedEnableAddonError = (error: unknown): boolean => {
  const code = apiErrorCodeOf(error);
  return (
    code === API_ERROR_CODES.ADDON_ANNUAL_NOT_SUPPORTED ||
    code === API_ERROR_CODES.ADDON_INCLUDED_IN_PLAN ||
    code === API_ERROR_CODES.ADDON_QUANTITY_CHANGED ||
    code === API_ERROR_CODES.ADDON_RAISE_UNBILLED_ROW
  );
};

export function useSubscribe() {
  return useBillingMutation<QuoteInput>((body) =>
    apiClient.post("/billing/subscribe", body).then((r) => r.data),
  );
}

export function useUpgrade() {
  return useBillingMutation<{ planKey: string }>((body) =>
    apiClient.post("/billing/subscription", body).then((r) => r.data),
  );
}

export function useDowngrade() {
  return useBillingMutation<{ targetPlanKey: string; retainedUserIds?: string[] }>((body) =>
    apiClient.post("/billing/subscription/downgrade", body).then((r) => r.data),
  );
}

/** `localErrorToast`: the caller toasts its own fixed failure copy (Cancel, End trial). */
export function useCancelSubscription(options?: { localErrorToast?: boolean }) {
  return useBillingMutation<void>(
    () => apiClient.post("/billing/subscription/cancel").then((r) => r.data),
    options?.localErrorToast,
  );
}

export function useResumeSubscription() {
  return useBillingMutation<void>(() =>
    apiClient.post("/billing/subscription/resume").then((r) => r.data),
  );
}

/** R2.5/R2.8 (lite-L2): a Stripe Checkout session for the tenant's OWN pinned plan/price —
 *  e.g. an invited LITE tenant completing its first payment (SubscriptionView.paymentRequired).
 *  Takes no body (server pins the plan); on success, navigates the browser straight to the
 *  returned Stripe-hosted URL rather than invalidating the billing query — there is nothing to
 *  refetch until the tenant returns from Stripe. */
/**
 * SA-733r6 (B4): `POST /billing/portal` (TENANT_ADMIN only - the server refuses an operator). "Update payment"
 * opens the Stripe billing portal; "Pay $X" opens the owed invoice's hosted page (portal as the fallback).
 * Leaving to Stripe goes through the counter's leave guard so an open cart is never dropped silently.
 */
export function useBillingPortal() {
  return useMutation<
    BillingPortalResult,
    Error,
    { intent: "update-payment" | "pay" },
    { win: Window | null }
  >({
    mutationFn: () => apiClient.post("/billing/portal").then((r) => r.data),
    // Stripe opens in a NEW tab, claimed synchronously on the click (before the request, so a popup blocker allows it):
    // the counter tab - and an open cart in it - is never navigated away. If the browser refuses the tab we fall back
    // to this tab through the counter's leave guard.
    onMutate: () => {
      let win: Window | null = null;
      try {
        win = window.open("", "_blank");
        if (win) win.opener = null;
      } catch {
        win = null;
      }
      return { win };
    },
    onSuccess: (r, { intent }, ctx) => {
      // Pay prefers the invoice page; Update payment prefers the portal; either falls back to the other.
      const url =
        intent === "pay"
          ? (r.hostedInvoiceUrl ?? r.portalUrl)
          : (r.portalUrl ?? r.hostedInvoiceUrl);
      if (!url) {
        ctx?.win?.close();
        return;
      }
      if (ctx?.win) {
        ctx.win.location.href = url;
        return;
      }
      if (guardCounterLeave(() => window.location.assign(url))) return;
      window.location.assign(url);
    },
    onError: (_e, _v, ctx) => {
      ctx?.win?.close();
    },
  });
}

export function useCreateCheckout() {
  return useMutation<{ checkoutUrl: string }, Error, void>({
    mutationFn: () => apiClient.post("/billing/subscription/checkout").then((r) => r.data),
    // The page words a refused checkout (ADDON_BILLING_PENDING_CHECKOUT) inline; no second toast.
    meta: { localErrorToast: isMappedCheckoutError },
    onSuccess: (r) => {
      window.location.assign(r.checkoutUrl);
    },
  });
}

export function useEnableAddon() {
  // The sheet words the two refusals it maps inline; every other failure keeps the global toast.
  // `quantity` is the TARGET total; `expectedQuantity` is the owned count the page showed (0 = not on), so the
  // server refuses (409 ADDON_QUANTITY_CHANGED) instead of cutting a pack that changed under a stale page.
  return useBillingMutation<
    { sku: string; quantity?: number; expectedQuantity?: number },
    EnableAddonResult
  >(
    ({ sku, quantity, expectedQuantity }) =>
      apiClient
        .post(`/billing/addons/${sku}/enable`, { quantity, expectedQuantity })
        .then((r) => r.data),
    isMappedEnableAddonError,
    (qc, res) => {
      if (res?.subscription) qc.setQueryData([...KEY, "subscription"], res.subscription);
    },
  );
}

/** `localErrorToast`: the caller toasts its own fixed failure copy. */
export function useDisableAddon(options?: { localErrorToast?: boolean }) {
  return useBillingMutation<{ sku: string }>(
    ({ sku }) => apiClient.post(`/billing/addons/${sku}/disable`).then((r) => r.data),
    options?.localErrorToast,
  );
}

// ─── Shared plan-change dispatch (B58) ───────────────────────────────────────

export interface PlanChangeMutateOptions {
  onSuccess?: () => void;
  /** Receives the rejected request so the caller can surface the SERVER's message
   *  instead of a fixed "try again" (L-071). */
  onError?: (error?: unknown) => void;
}

/** The subset of {@link useUpgrade}/{@link useDowngrade}/{@link useSubscribe}'s
 * `mutate` functions dispatchPlanChange needs — pass the hooks' `.mutate` directly —
 * plus the caller's LIVE billing cycle. */
export interface PlanChangeMutations {
  /** The cycle the caller's toggle shows RIGHT NOW, not `preview.cycle` (the cycle the
   *  last successful quote echoed back). A commit fired after a cycle toggle but before
   *  — or after a failed — re-quote would otherwise subscribe on the cycle the tenant
   *  just moved away from, resetting the period onto the wrong term. */
  cycle: Cycle;
  upgrade: (body: { planKey: string }, options?: PlanChangeMutateOptions) => void;
  downgrade: (
    body: { targetPlanKey: string; retainedUserIds?: string[] },
    options?: PlanChangeMutateOptions,
  ) => void;
  subscribe: (body: QuoteInput, options?: PlanChangeMutateOptions) => void;
}

/** What {@link dispatchPlanChange} did, so a caller can react without re-reading
 *  `change.action`: `contact-sales` fired no request and needs the sales hand-off,
 *  `none` fired nothing because the action is not a plan change, `dispatched` posted. */
export type PlanChangeDispatch =
  | { outcome: "contact-sales" }
  | { outcome: "none"; action: "NOOP" | "KEEP_CURRENT" }
  | { outcome: "dispatched"; action: "SUBSCRIBE" | "UPGRADE" | "DOWNGRADE" };

/**
 * Single routing point for committing a quote (ruling §2/§9 B58 web): a quote's
 * `change.action` — never the raw "always subscribe" assumption — decides which
 * mutation fires. Shared by `choose-plan/page.tsx` and any other entrance (e.g.
 * PlanGates' upsell CTA) that lands on a quote and needs to commit it, so the
 * ACTIVE-tenant guard in `subscribe()` is never the first thing a plan change hits.
 * NOOP is a no-op by design — the caller is expected to disable its own commit
 * control when `change.action === "NOOP"`. KEEP_CURRENT (undoing a scheduled
 * downgrade/cancellation) is not a plan change either: it commits through the
 * resume mutation at the caller, never through subscribe() — which would reset the
 * current period — so it is a no-op here too. CONTACT_SALES (a custom plan on either
 * side) posts nothing at all: the caller sends the tenant to sales.
 *
 * The billing cycle comes from `mutations.cycle` — the caller's LIVE toggle — never
 * from `preview.cycle`, which is only the cycle the last successful quote was for.
 */
export function dispatchPlanChange(
  preview: QuoteResult,
  mutations: PlanChangeMutations,
  options?: PlanChangeMutateOptions,
): PlanChangeDispatch {
  const action = preview.change?.action ?? "SUBSCRIBE";
  if (action === "CONTACT_SALES") return { outcome: "contact-sales" };
  if (action === "NOOP" || action === "KEEP_CURRENT") return { outcome: "none", action };
  if (action === "UPGRADE") {
    mutations.upgrade({ planKey: preview.planKey }, options);
  } else if (action === "DOWNGRADE") {
    mutations.downgrade({ targetPlanKey: preview.planKey, retainedUserIds: [] }, options);
  } else {
    mutations.subscribe({ planKey: preview.planKey, cycle: mutations.cycle }, options);
  }
  return { outcome: "dispatched", action };
}
