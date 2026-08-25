import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";
import { useTenantStore } from "../tenant-store";

// ─── Tenant addons (feature flags) — mirrors web lib/api/tobacco.ts ───────────

export function useTenantAddons() {
  // Tenant-scoped key: the QueryClient outlives a logout (module-scoped in
  // app/_layout.tsx, never cleared), so a bare ["tenant","addons"] key would
  // serve the previous tenant's flags to the next session on a shared device.
  const tenantSlug = useTenantStore((s) => s.slug);
  return useQuery<{ addons: string[] }>({
    queryKey: ["tenant", tenantSlug, "addons"],
    queryFn: () => apiClient.get("/tenants/me/addons").then((r) => r.data),
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useHasAddon(key: string): boolean {
  const { data } = useTenantAddons();
  return data?.addons?.includes(key) ?? false;
}

export const TOBACCO_ADDON = "tobacco_dealer";

// Mirrors web lib/api/addons.ts SALES_AGENTS_ADDON.
export const SALES_AGENTS_ADDON = "sales_agents";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TobaccoOverview {
  period: { from: string; to: string };
  flaggedProductCount: number;
  inventory: { totalQty: number; totalValue: number };
  purchases: { count: number; totalQty: number; totalValue: number };
  sales: { count: number; totalQty: number; totalValue: number; totalTax: number };
}

export interface TobaccoReport {
  id: string;
  periodYear: number;
  periodMonth: number;
  status: "GENERATED" | "FAILED";
  totalPurchaseValue: number;
  totalSalesValue: number;
  totalTaxCollected: number;
  endingStockValue: number;
  generatedAt: string;
  generationCount: number;
  errorMessage: string | null;
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export function useTobaccoOverview(month?: string, options?: { enabled?: boolean }) {
  return useQuery<TobaccoOverview>({
    queryKey: ["tobacco", "overview", month],
    queryFn: () =>
      apiClient.get("/tobacco/overview", { params: month ? { month } : {} }).then((r) => r.data),
    // The endpoint is addon-guarded (403 without tobacco_dealer); callers that
    // aren't already behind an addon gate should pass enabled to avoid a 403.
    enabled: options?.enabled ?? true,
    retry: false,
  });
}

export function useTobaccoInventory() {
  return useQuery<
    {
      id: string;
      name: string;
      sku: string | null;
      unit: string;
      currentStock: number;
      averageCost: number | null;
      totalValue: number | null;
    }[]
  >({
    queryKey: ["tobacco", "inventory"],
    queryFn: () => apiClient.get("/tobacco/inventory").then((r) => r.data),
  });
}

export function useTobaccoReports() {
  return useQuery<TobaccoReport[]>({
    queryKey: ["tobacco", "reports"],
    queryFn: () => apiClient.get("/tobacco/reports").then((r) => r.data),
  });
}

export function useGenerateTobaccoReport() {
  const qc = useQueryClient();
  return useMutation<TobaccoReport, Error, { year: number; month: number }>({
    mutationFn: (dto) => apiClient.post("/tobacco/reports/generate", dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tobacco", "reports"] }),
  });
}

export async function fetchTobaccoReportUrl(id: string, format: "csv" | "pdf"): Promise<string> {
  const { data } = await apiClient.get(`/tobacco/reports/${id}/${format}`);
  return data.url as string;
}
