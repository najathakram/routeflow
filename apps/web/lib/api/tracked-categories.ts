import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";

// ─── Types ────────────────────────────────────────────────────────────────────

export type TrackedCategoryTaxType =
  | "EXCISE_PER_UNIT"
  | "PERCENT_OF_SALE"
  | "PER_VOLUME"
  | "DEPOSIT_PER_CONTAINER"
  | "NONE";
export type InvoiceTreatment = "SEPARATE_INVOICE" | "SEPARATE_SECTION" | "LINE_TAX";
export type ReportCadence = "MONTHLY" | "QUARTERLY" | "ANNUAL";

export interface TrackedCategory {
  id: string;
  name: string;
  taxType: TrackedCategoryTaxType;
  rate: string; // Prisma Decimal serialized as a string
  unitBasis: string | null;
  priceIncludesTax: boolean;
  invoiceTreatment: InvoiceTreatment;
  appliesScope: Record<string, unknown> | null;
  requiresLicense: boolean;
  reportTemplate: string;
  reportCadence: ReportCadence;
  active: boolean;
  productCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface TrackedCategoryInput {
  name: string;
  taxType?: TrackedCategoryTaxType;
  rate?: number;
  unitBasis?: string;
  priceIncludesTax?: boolean;
  invoiceTreatment?: InvoiceTreatment;
  appliesScope?: Record<string, unknown>;
  requiresLicense?: boolean;
  reportTemplate?: string;
  reportCadence?: ReportCadence;
  active?: boolean;
}

const KEY = ["tracked-categories"] as const;

// ─── Queries ──────────────────────────────────────────────────────────────────

export function useTrackedCategories(params?: { search?: string; active?: boolean }) {
  return useQuery<TrackedCategory[]>({
    queryKey: [...KEY, params ?? {}],
    queryFn: () =>
      apiClient
        .get("/tracked-categories", {
          params: {
            ...(params?.search ? { search: params.search } : {}),
            ...(params?.active !== undefined ? { active: params.active } : {}),
          },
        })
        .then((r) => r.data),
  });
}

export function useTrackedCategory(id: string | undefined) {
  return useQuery<TrackedCategory>({
    queryKey: [...KEY, "detail", id],
    queryFn: () => apiClient.get(`/tracked-categories/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}

// ─── Mutations ────────────────────────────────────────────────────────────────

export function useCreateTrackedCategory() {
  const qc = useQueryClient();
  return useMutation<TrackedCategory, Error, TrackedCategoryInput>({
    mutationFn: (dto) => apiClient.post("/tracked-categories", dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useUpdateTrackedCategory() {
  const qc = useQueryClient();
  return useMutation<TrackedCategory, Error, { id: string; data: Partial<TrackedCategoryInput> }>({
    mutationFn: ({ id, data }) =>
      apiClient.patch(`/tracked-categories/${id}`, data).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

/** Flip active on/off. Deactivation keeps historic sales/ledger data intact. */
export function useToggleTrackedCategory() {
  const qc = useQueryClient();
  return useMutation<TrackedCategory, Error, string>({
    mutationFn: (id) => apiClient.patch(`/tracked-categories/${id}/toggle`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useAssignProductsToCategory() {
  const qc = useQueryClient();
  return useMutation<{ assigned: number }, Error, { id: string; productIds: string[] }>({
    mutationFn: ({ id, productIds }) =>
      apiClient
        .post(`/tracked-categories/${id}/products/assign`, { productIds })
        .then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: ["products"] });
    },
  });
}

export function useUnassignProductsFromCategory() {
  const qc = useQueryClient();
  return useMutation<{ unassigned: number }, Error, { id: string; productIds: string[] }>({
    mutationFn: ({ id, productIds }) =>
      apiClient
        .post(`/tracked-categories/${id}/products/unassign`, { productIds })
        .then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: ["products"] });
    },
  });
}

// ─── Filings (W5b) ──────────────────────────────────────────────────────────────

export type RegulatedFilingStatus = "GENERATED" | "FAILED";

export interface RegulatedFiling {
  id: string;
  trackedCategoryId: string;
  reportTemplate: string;
  cadence: ReportCadence;
  periodKey: string;
  periodStart: string;
  periodEnd: string;
  status: RegulatedFilingStatus;
  totalQty: string; // Prisma Decimal serialized as a string
  totalUnitBasisQty: string;
  totalNetSales: string;
  totalCategoryTax: string;
  csvKey: string | null;
  generationCount: number;
  generatedAt: string;
}

export interface PrepareFilingInput {
  trackedCategoryId: string;
  cadence?: ReportCadence;
  year: number;
  index?: number; // month 1-12 (MONTHLY) or quarter 1-4 (QUARTERLY); ignored ANNUAL
}

const FILINGS_KEY = ["regulated", "filings"] as const;

export function useRegulatedFilings(categoryId?: string) {
  return useQuery<RegulatedFiling[]>({
    queryKey: [...FILINGS_KEY, categoryId ?? null],
    queryFn: () =>
      apiClient
        .get("/regulated/filings", { params: categoryId ? { category: categoryId } : {} })
        .then((r) => r.data),
  });
}

export function usePrepareFiling() {
  const qc = useQueryClient();
  return useMutation<RegulatedFiling, Error, PrepareFilingInput>({
    mutationFn: (dto) => apiClient.post("/regulated/filings/prepare", dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: FILINGS_KEY }),
  });
}

/** Fetch a short-lived presigned URL for a filing's stored artifact. */
export async function fetchRegulatedFilingUrl(id: string, format: "csv" | "pdf" = "csv") {
  return apiClient.get(`/regulated/filings/${id}/${format}`).then((r) => r.data.url as string);
}
