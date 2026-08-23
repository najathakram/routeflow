import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";

// ─── Tenant addons (feature flags) ────────────────────────────────────────────

export function useTenantAddons() {
  return useQuery<{ addons: string[] }>({
    queryKey: ["tenant", "addons"],
    queryFn: () => apiClient.get("/tenants/me/addons").then((r) => r.data),
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** Convenience flag read — false while loading or when the endpoint is unavailable. */
export function useHasAddon(key: string): boolean {
  const { data } = useTenantAddons();
  return data?.addons?.includes(key) ?? false;
}

export const TOBACCO_ADDON = "tobacco_dealer";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TobaccoOverview {
  period: { from: string; to: string };
  flaggedProductCount: number;
  inventory: { totalQty: number; totalValue: number };
  purchases: { count: number; totalQty: number; totalValue: number };
  sales: { count: number; totalQty: number; totalValue: number; totalTax: number };
}

export interface TobaccoInventoryItem {
  id: string;
  name: string;
  sku: string | null;
  unit: string;
  isActive: boolean;
  /** PIECES (system-wide stock unit) — label it with `unitsLabel`, never with `unit`. */
  currentStock: number;
  unitsPerBox?: number | null;
  averageCost: number | null;
  totalValue: number | null;
}

export interface TobaccoPurchase {
  id: string;
  date: string;
  product: { id: string; name: string; sku?: string | null; unit?: string };
  supplier: { id: string; name: string; tobaccoLicenseNo: string | null } | null;
  reference: string | null;
  quantity: number;
  unitCost: number | null;
  value: number;
}

export interface TobaccoSale {
  id: string;
  date: string;
  invoiceId: string;
  invoiceNumber: string;
  customer: {
    id: string;
    businessName: string;
    tobaccoLicenseNo: string | null;
    tobaccoLicenseExpiry: string | null;
  };
  product: { id: string; name: string; sku?: string | null; unit?: string };
  qty: number;
  unitPrice: number;
  subtotal: number;
  tax: number;
}

export interface TobaccoMonthlyBucket {
  month: string;
  purchaseValue: number;
  salesValue: number;
  taxCollected: number;
}

export interface TobaccoReport {
  id: string;
  periodYear: number;
  periodMonth: number;
  status: "GENERATED" | "FAILED";
  totalQtyPurchased: number;
  totalPurchaseValue: number;
  totalQtySold: number;
  totalSalesValue: number;
  totalTaxCollected: number;
  endingStockQty: number;
  endingStockValue: number;
  generatedAt: string;
  generatedById: string | null;
  generationCount: number;
  errorMessage: string | null;
  csvKey: string | null;
  pdfKey: string | null;
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
  return useQuery<TobaccoInventoryItem[]>({
    queryKey: ["tobacco", "inventory"],
    queryFn: () => apiClient.get("/tobacco/inventory").then((r) => r.data),
  });
}

export function useTobaccoPurchases(params?: { from?: string; to?: string }) {
  return useQuery<TobaccoPurchase[]>({
    queryKey: ["tobacco", "purchases", params],
    queryFn: () => apiClient.get("/tobacco/purchases", { params }).then((r) => r.data),
  });
}

export function useTobaccoSales(params?: { from?: string; to?: string }) {
  return useQuery<TobaccoSale[]>({
    queryKey: ["tobacco", "sales", params],
    queryFn: () => apiClient.get("/tobacco/sales", { params }).then((r) => r.data),
  });
}

export function useTobaccoMonthly(year?: number) {
  return useQuery<TobaccoMonthlyBucket[]>({
    queryKey: ["tobacco", "monthly", year],
    queryFn: () =>
      apiClient.get("/tobacco/monthly", { params: year ? { year } : {} }).then((r) => r.data),
  });
}

export function useTobaccoReports() {
  return useQuery<TobaccoReport[]>({
    queryKey: ["tobacco", "reports"],
    queryFn: () => apiClient.get("/tobacco/reports").then((r) => r.data),
  });
}

export function useTobaccoSettings() {
  return useQuery<{ excludeFromMainAnalytics: boolean }>({
    queryKey: ["tobacco", "settings"],
    queryFn: () => apiClient.get("/tobacco/settings").then((r) => r.data),
  });
}

// ─── Mutations ────────────────────────────────────────────────────────────────

export function useGenerateTobaccoReport() {
  const qc = useQueryClient();
  return useMutation<TobaccoReport, Error, { year: number; month: number }>({
    mutationFn: (dto) => apiClient.post("/tobacco/reports/generate", dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tobacco", "reports"] }),
  });
}

export function useUpdateTobaccoSettings() {
  const qc = useQueryClient();
  return useMutation<{ excludeFromMainAnalytics: boolean }, Error, boolean>({
    mutationFn: (excludeFromMainAnalytics) =>
      apiClient.patch("/tobacco/settings", { excludeFromMainAnalytics }).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tobacco", "settings"] });
      // Exclusion changes every main analytics surface
      qc.invalidateQueries({ queryKey: ["analytics"] });
    },
  });
}

export async function fetchTobaccoReportUrl(id: string, format: "csv" | "pdf"): Promise<string> {
  const { data } = await apiClient.get(`/tobacco/reports/${id}/${format}`);
  return data.url;
}
