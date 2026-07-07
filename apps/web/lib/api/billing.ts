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
