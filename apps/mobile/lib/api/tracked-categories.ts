import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";

// ─── Types (mirror apps/web/lib/api/tracked-categories.ts) ──────────────────────

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
  requiresLicense: boolean;
  reportTemplate: string;
  reportCadence: ReportCadence;
  active: boolean;
  // TX Comptroller (TX_COMPTROLLER template) config. Null on every other template, and
  // ABSENT entirely when talking to an API deployed before these columns shipped — hence
  // optional, not just nullable. Read sites must tolerate undefined.
  /** THIS tenant's own TX license/permit number (8 digits). */
  wholesalerLicenseNo?: string | null;
  /** 1 = Cigarettes, 2 = Cigars, 3 = Tobacco. */
  txItemType?: number | null;
  /** CP|CS|CC (cigarettes) SB|SC|SD|SF (cigars) WO|WN (tobacco). */
  txUom?: string | null;
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
  requiresLicense?: boolean;
  reportTemplate?: string;
  reportCadence?: ReportCadence;
  active?: boolean;
  /** TX config: send `null` to clear a column — `undefined` is dropped from the body and no-ops. */
  wholesalerLicenseNo?: string | null;
  txItemType?: number | null;
  txUom?: string | null;
}

/**
 * A classification child of a section. Carries NO compliance semantics — every
 * regulated guard keys off the parent section's trackedCategoryId. Purely a
 * reporting/grouping tag on a product. Mirrors apps/web/lib/api/tracked-categories.ts.
 */
export interface TrackedSubcategory {
  id: string;
  trackedCategoryId: string;
  name: string;
  active: boolean;
  productCount: number;
  createdAt: string;
  updatedAt: string;
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export function useTrackedCategories(
  params?: { search?: string; active?: boolean },
  options?: { enabled?: boolean },
) {
  return useQuery<TrackedCategory[]>({
    queryKey: ["tracked-categories", params ?? {}],
    queryFn: () => apiClient.get("/tracked-categories", { params }).then((r) => r.data),
    enabled: options?.enabled ?? true,
  });
}

export function useTrackedCategory(id: string | undefined) {
  return useQuery<TrackedCategory>({
    queryKey: ["tracked-category", id],
    queryFn: () => apiClient.get(`/tracked-categories/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}

/** Subcategories of one section (includes inactive ones so a manager can toggle them). */
export function useTrackedSubcategories(categoryId: string | undefined) {
  return useQuery<TrackedSubcategory[]>({
    queryKey: ["tracked-subcategories", categoryId ?? null],
    queryFn: () =>
      apiClient.get(`/tracked-categories/${categoryId}/subcategories`).then((r) => r.data),
    enabled: !!categoryId,
  });
}

// ─── Mutations — sections ────────────────────────────────────────────────────

function invalidateTrackedCategories(qc: ReturnType<typeof useQueryClient>, id?: string) {
  qc.invalidateQueries({ queryKey: ["tracked-categories"] });
  if (id) qc.invalidateQueries({ queryKey: ["tracked-category", id] });
}

export function useCreateTrackedCategory() {
  const qc = useQueryClient();
  return useMutation<TrackedCategory, Error, TrackedCategoryInput>({
    mutationFn: (dto) => apiClient.post("/tracked-categories", dto).then((r) => r.data),
    onSuccess: () => invalidateTrackedCategories(qc),
  });
}

export function useUpdateTrackedCategory() {
  const qc = useQueryClient();
  return useMutation<TrackedCategory, Error, { id: string; data: Partial<TrackedCategoryInput> }>({
    mutationFn: ({ id, data }) =>
      apiClient.patch(`/tracked-categories/${id}`, data).then((r) => r.data),
    onSuccess: (_, { id }) => invalidateTrackedCategories(qc, id),
  });
}

/** Flip active on/off. Deactivation keeps historic sales/ledger data intact. */
export function useToggleTrackedCategory() {
  const qc = useQueryClient();
  return useMutation<TrackedCategory, Error, string>({
    mutationFn: (id) => apiClient.patch(`/tracked-categories/${id}/toggle`).then((r) => r.data),
    onSuccess: (_, id) => invalidateTrackedCategories(qc, id),
  });
}

// ─── Mutations — product membership ──────────────────────────────────────────

function invalidateProducts(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["products"] });
  qc.invalidateQueries({ queryKey: ["admin", "products"] }); // prefix-matches the infinite key too
}

export function useAssignProductsToCategory() {
  const qc = useQueryClient();
  return useMutation<{ assigned: number }, Error, { id: string; productIds: string[] }>({
    mutationFn: ({ id, productIds }) =>
      apiClient
        .post(`/tracked-categories/${id}/products/assign`, { productIds })
        .then((r) => r.data),
    onSuccess: (_, { id }) => {
      invalidateTrackedCategories(qc, id);
      invalidateProducts(qc);
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
    onSuccess: (_, { id }) => {
      invalidateTrackedCategories(qc, id);
      invalidateProducts(qc);
    },
  });
}

// ─── Mutations — subcategories ───────────────────────────────────────────────

function invalidateSubcategories(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["tracked-subcategories"] });
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
    onSuccess: () => invalidateSubcategories(qc),
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
    onSuccess: () => invalidateSubcategories(qc),
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
    onSuccess: () => invalidateSubcategories(qc),
  });
}
