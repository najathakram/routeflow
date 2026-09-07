import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";

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

export type MeterKey = "SEATS" | "ROUTES" | "SCANS" | "MSGS";

export interface MeterReading {
  meter: MeterKey;
  used: number;
  included: number | null;
  remaining: number | null;
  resetsAt: string | null;
}

export interface SubscriptionView {
  planKey: string;
  planName: string;
  status: string;
  cycle: Cycle;
  monthlyPrice: number | null;
  annualPrice: number | null;
  isCustom: boolean;
  renewalAt: string | null;
  cancelAtPeriodEnd: boolean;
  downgradeToPlanKey: string | null;
  downgradeEffectiveAt: string | null;
  trialEndsAt: string | null;
  addons: Array<{ sku: string | null; name: string; quantity: number; monthly: number | null }>;
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
  proratedToday: number;
  daysRemaining: number;
  daysInCycle: number;
  effectiveAt: string;
  nextChargeAt: string;
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

export function useSubscription() {
  return useQuery<SubscriptionView>({
    queryKey: [...KEY, "subscription"],
    queryFn: () => apiClient.get("/billing/subscription").then((r) => r.data),
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

export function useProrationPreview(sku: string | null) {
  return useQuery<ProrationPreview>({
    queryKey: [...KEY, "proration-preview", sku],
    enabled: !!sku,
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

function useBillingMutation<TBody>(fn: (b: TBody) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation<unknown, Error, TBody>({
    mutationFn: fn,
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

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

export function useCancelSubscription() {
  return useBillingMutation<void>(() =>
    apiClient.post("/billing/subscription/cancel").then((r) => r.data),
  );
}

export function useResumeSubscription() {
  return useBillingMutation<void>(() =>
    apiClient.post("/billing/subscription/resume").then((r) => r.data),
  );
}

export function useEnableAddon() {
  return useBillingMutation<{ sku: string; quantity?: number }>(({ sku, quantity }) =>
    apiClient.post(`/billing/addons/${sku}/enable`, { quantity }).then((r) => r.data),
  );
}

export function useDisableAddon() {
  return useBillingMutation<{ sku: string }>(({ sku }) =>
    apiClient.post(`/billing/addons/${sku}/disable`).then((r) => r.data),
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
