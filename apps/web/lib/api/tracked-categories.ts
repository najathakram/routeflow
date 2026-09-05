import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";
import type {
  RegulatedLedgerResponse,
  RegulatedReportPreview,
  ReportTemplateDef,
} from "@routeflow/types";
export type {
  RegulatedLedgerResponse,
  RegulatedLedgerRow,
  RegulatedReportColumn,
  RegulatedReportPreview,
  RegulatedReportWarning,
  RegulatedReportWarningCode,
  ReportTemplateDef,
  TemplateColumn,
  TemplateItemType,
  TemplateUomOption,
} from "@routeflow/types";

// ─── Types ────────────────────────────────────────────────────────────────────

export type TrackedCategoryTaxType =
  "EXCISE_PER_UNIT" | "PERCENT_OF_SALE" | "PER_VOLUME" | "DEPOSIT_PER_CONTAINER" | "NONE";
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
  /** TX Comptroller (TX_COMPTROLLER template) config — null unless configured. */
  wholesalerLicenseNo: string | null;
  /** @deprecated superseded by Product.regItemType. Kept as a shadow; no reader. */
  txItemType: number | null;
  /** @deprecated superseded by Product.regUomUnit. Kept as a shadow; no reader. */
  txUom: string | null;
  /** Saved custom report column layout, keyed by template code. */
  reportColumnPrefs?: Record<string, string[]> | null;
  /** Computed server-side: name is "Tobacco" (ci) — the compliance-pack anchor. */
  isTobaccoCategory?: boolean;
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
  /** TX config: send `null` to clear a column — `undefined` is dropped by axios and no-ops. */
  wholesalerLicenseNo?: string | null;
  /** @deprecated superseded by Product.regItemType. Kept as a shadow; no reader. */
  txItemType?: number | null;
  /** @deprecated superseded by Product.regUomUnit. Kept as a shadow; no reader. */
  txUom?: string | null;
  /** Saved custom report column layout, keyed by template code. */
  reportColumnPrefs?: Record<string, string[]> | null;
}

const KEY = ["tracked-categories"] as const;

// ─── Queries ──────────────────────────────────────────────────────────────────

export function useTrackedCategories(
  params?: { search?: string; active?: boolean },
  options?: { enabled?: boolean },
) {
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
    enabled: options?.enabled ?? true,
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

/**
 * `assigned` counts MOVERS only — rows already in the target type are excluded
 * from it although they were processed. `processed` is every requested row the
 * tenant can see; use it (not `assigned`) to decide what was skipped. Optional
 * because a browser tab open across a deploy can still hit the older API.
 */
export function useAssignProductsToCategory() {
  const qc = useQueryClient();
  return useMutation<
    { assigned: number; processed?: number },
    Error,
    { id: string; productIds: string[] }
  >({
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

// ─── Subcategories (Phase A) ────────────────────────────────────────────────────

/**
 * A classification child of a section. Carries NO compliance semantics (no tax /
 * license / invoice logic) — every regulated guard keys off the parent section's
 * `trackedCategoryId`. This is purely a reporting/grouping tag on a product.
 */
export interface TrackedSubcategory {
  id: string;
  trackedCategoryId: string; // parent section
  name: string;
  active: boolean;
  productCount: number;
  createdAt: string;
  updatedAt: string;
}

const SUBCAT_KEY = ["tracked-subcategories"] as const;

/** Subcategories of one section (includes inactive ones so a manager can toggle them). */
export function useTrackedSubcategories(categoryId: string | undefined) {
  return useQuery<TrackedSubcategory[]>({
    queryKey: [...SUBCAT_KEY, categoryId ?? null],
    queryFn: () =>
      apiClient.get(`/tracked-categories/${categoryId}/subcategories`).then((r) => r.data),
    enabled: !!categoryId,
  });
}

export function useCreateSubcategory() {
  const qc = useQueryClient();
  return useMutation<
    TrackedSubcategory,
    Error,
    { categoryId: string; name: string; active?: boolean }
  >({
    mutationFn: ({ categoryId, ...body }) =>
      apiClient.post(`/tracked-categories/${categoryId}/subcategories`, body).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: SUBCAT_KEY }),
  });
}

export function useUpdateSubcategory() {
  const qc = useQueryClient();
  return useMutation<
    TrackedSubcategory,
    Error,
    { categoryId: string; subId: string; data: { name?: string; active?: boolean } }
  >({
    mutationFn: ({ categoryId, subId, data }) =>
      apiClient
        .patch(`/tracked-categories/${categoryId}/subcategories/${subId}`, data)
        .then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: SUBCAT_KEY }),
  });
}

/** Flip active on/off. Deactivation keeps historic tagging intact (soft delete). */
export function useToggleSubcategory() {
  const qc = useQueryClient();
  return useMutation<TrackedSubcategory, Error, { categoryId: string; subId: string }>({
    mutationFn: ({ categoryId, subId }) =>
      apiClient
        .patch(`/tracked-categories/${categoryId}/subcategories/${subId}/toggle`)
        .then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: SUBCAT_KEY }),
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

export function useRegulatedFilings(categoryId?: string, options?: { enabled?: boolean }) {
  return useQuery<RegulatedFiling[]>({
    queryKey: [...FILINGS_KEY, categoryId ?? null],
    queryFn: () =>
      apiClient
        .get("/regulated/filings", { params: categoryId ? { category: categoryId } : {} })
        .then((r) => r.data),
    enabled: options?.enabled ?? true,
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

// ─── Ledger (per-section sales/tax by period) ─────────────────────────────────────

const LEDGER_KEY = ["regulated", "ledger"] as const;

/**
 * Net-sales / tax grouped by (section, month). `to` is INCLUSIVE on this endpoint.
 * Amounts come back as numbers (the ledger endpoint Number()-casts, unlike filings).
 */
export function useRegulatedLedger(
  params?: { category?: string; from?: string; to?: string },
  options?: { enabled?: boolean },
) {
  return useQuery<RegulatedLedgerResponse>({
    queryKey: [...LEDGER_KEY, params ?? {}],
    queryFn: () =>
      apiClient
        .get("/regulated/ledger", {
          params: {
            ...(params?.category ? { category: params.category } : {}),
            ...(params?.from ? { from: params.from } : {}),
            ...(params?.to ? { to: params.to } : {}),
          },
        })
        .then((r) => r.data),
    enabled: options?.enabled ?? true,
  });
}

// ─── Reports (arbitrary-range preview + CSV, WP11) ─────────────────────────────

export interface RegulatedReportParams {
  category: string;
  /** Inclusive YYYY-MM-DD. */
  from: string;
  /** Inclusive YYYY-MM-DD. */
  to: string;
  /** Defaults to the category's configured reportTemplate server-side. */
  template?: string;
  /**
   * Comma-separated column keys; order defines output order. Forwarded only when
   * non-empty so default requests keep today's query shape and cache keys.
   */
  columns?: string;
}

/**
 * Drop `columns` when empty so a request with no custom layout keeps today's exact
 * query shape (and therefore today's cache key / server behavior).
 */
function withColumns(params: RegulatedReportParams): Record<string, unknown> {
  const { columns, ...rest } = params;
  return columns ? { ...rest, columns } : rest;
}

/**
 * Stateless report preview — computed on demand, nothing persisted. `enabled: !!params`
 * so nothing fires until the operator has picked a range and clicked Preview.
 */
export function useRegulatedReportPreview(params: RegulatedReportParams | null) {
  const queryParams = params ? withColumns(params) : null;
  return useQuery<RegulatedReportPreview>({
    queryKey: ["regulated", "report", queryParams],
    queryFn: () =>
      apiClient.get("/regulated/reports/preview", { params: queryParams! }).then((r) => r.data),
    enabled: !!queryParams,
  });
}

/**
 * Fetch the report CSV as a Blob through the authenticated client. Never `window.open`
 * this endpoint directly — it requires the auth header, which a bare navigation can't send.
 */
export async function fetchRegulatedReportCsv(params: RegulatedReportParams): Promise<Blob> {
  const r = await apiClient.get("/regulated/reports/csv", {
    params: withColumns(params),
    responseType: "blob",
  });
  return r.data;
}

// ─── Report templates (registry-driven vocabulary + columns) ──────────────────

/** Report-template metadata; static per deploy, so cache it for the session. */
export function useRegulatedTemplates() {
  return useQuery<ReportTemplateDef[]>({
    queryKey: ["regulated", "templates"],
    queryFn: () => apiClient.get("/regulated/templates").then((r) => r.data),
    staleTime: Infinity,
  });
}
