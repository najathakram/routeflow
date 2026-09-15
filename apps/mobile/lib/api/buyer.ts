import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { buyerApiClient, type BuyerSeller } from "../buyer-auth";
import { trackingRefetchInterval } from "../order-tracking-logic";
import type {
  ChangeRequestResolution,
  ChangeRequestStatus,
  ChangeRequestType,
} from "./change-requests";
import type {
  BuyerAnalytics,
  BuyerAuthorizationRow,
  BuyerCreateChangeRequestInput,
  BuyerPayment,
  BuyerPromotion,
  BuyerRemittance,
  BuyerStatement,
  BuyerStockAlerts,
  ExpiringAuthorization,
  LockedCategory,
  ReplenishmentEstimate,
  ShelfResponse,
  SubmitBuyerAuthorizationInput,
} from "@routeflow/types";
export type {
  BuyerAnalytics,
  BuyerAuthorizationRow,
  BuyerCreateChangeRequestInput,
  BuyerPayment,
  BuyerPromotion,
  BuyerRemittance,
  BuyerStatement,
  BuyerStatementTransaction,
  BuyerStockAlerts,
  ExpiringAuthorization,
  LockedCategory,
  ReplenishmentEstimate,
  ShelfActiveOrder,
  ShelfEstimate,
  ShelfResponse,
  SubmitBuyerAuthorizationInput,
} from "@routeflow/types";
export type { ChangeRequestStatus, ChangeRequestType } from "./change-requests";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BuyerProduct {
  id: string;
  name: string;
  description?: string;
  category?: string;
  unit?: string;
  /** Legacy field — may be absent. Prefer buyerPrice then basePrice. */
  price?: number;
  buyerPrice?: number;
  basePrice?: number;
  imageUrl?: string;
  isFavorite?: boolean;
  /** Box packaging: when > 1 the buyerPrice/basePrice is the BOX price. */
  unitsPerBox?: number | null;
  // Catalogue v2 merch/stock fields (P5-02 DTO; optional so older cached shapes
  // still type-check). Mirrors buyer-catalog.service.ts BuyerProduct.
  sku?: string | null;
  barcode?: string | null;
  thumbnailUrl?: string | null;
  imageUrls?: string[];
  isFeatured?: boolean;
  isNew?: boolean;
  isDeal?: boolean;
  inStock?: boolean;
  stockStatus?: "IN_STOCK" | "LOW" | "OUT_OF_STOCK";
  stockLeft?: number | null;
}

// ─── Change requests (P5-09/10 twin — P5-16b) ─────────────────────────────────
// Type/Status/Resolution are identical to `./change-requests`'s (which now
// sources Type/Status from `@routeflow/types`) — imported, not redeclared
// (wave E / imp-10b R2 intra-app dedup). `ChangeRequest` itself is NOT
// deduped: this buyer-facing shape carries resolver-name/reason fields
// `./change-requests`'s driver-flow shape lacks — a real divergence the sweep
// undercounted, kept local on both sides.

export interface ChangeRequest {
  id: string;
  orderId: string;
  orderItemId: string | null;
  productId: string | null;
  type: ChangeRequestType;
  status: ChangeRequestStatus;
  payload: {
    productId?: string;
    qty?: number;
    boxes?: number | null;
    pieces?: number | null;
    productName?: string;
    orderItemId?: string;
    newQty?: number;
    text?: string;
  };
  note: string | null;
  requestedByName: string | null;
  requestedByRole: string | null;
  resolvedByName: string | null;
  resolvedByRole: string | null;
  resolution: ChangeRequestResolution | null;
  resolutionReason: string | null;
  nextOrderId: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

export interface BuyerOrder {
  id: string;
  orderNumber?: string;
  status: string;
  createdAt: string;
  requestedDeliveryDate?: string;
  notes?: string;
  urgent?: boolean;
  subtotal?: number;
  tax?: number;
  total?: number;
  lineItems: Array<{
    id: string;
    productId: string;
    qty: number;
    unitPrice: number;
    subtotal?: number;
    boxes?: number | null;
    pieces?: number | null;
    status?: string;
    deliveredQty?: number;
    categoryTaxAmount?: number; // RF-4: regulated category tax folded into order.total
    /** BUY_N_GET_M: whole free SELLING units on this line — names the reduced
     *  `subtotal` so it doesn't read as a pricing error. */
    promoFreeUnits?: number | null;
    /** Per-line note, buyer-visible. */
    notes?: string | null;
    product?: { id: string; name: string; unit?: string };
  }>;
  /** P5-09: post-dispatch change requests, newest first. */
  changeRequests?: ChangeRequest[];
  /** P5-08: server edit window — closes when the order's run dispatches. */
  editWindow?: {
    editable: boolean;
    editableUntil: string | null;
    closedReason: "DISPATCHED" | "STATUS" | null;
  };
  routeRun?: { status: string; startedAt?: string | null } | null;
}

export interface BuyerInvoiceItem {
  id: string;
  description: string;
  qty: number;
  unitPrice: number;
  discount?: number;
  subtotal: number;
  /** BUY_N_GET_M: whole free SELLING units on this line — names the reduced
   *  `subtotal` so it doesn't read as a pricing error. */
  promoFreeUnits?: number | null;
  /** Per-line note, buyer-visible. */
  notes?: string | null;
  product?: { id: string; name: string; unit?: string };
}

/** Check lifecycle states (P5-12). Only ever set when method = CHECK. */
export type BuyerCheckStatus = "RECORDED" | "DEPOSITED" | "CLEARED" | "BOUNCED";

/** Raw InvoicePayment row from GET /buyer/invoices/:id (no DTO mapping). Field
 *  is `method`; `paymentMethod` kept only for older cached shapes. Decimal
 *  fields may arrive as strings — render via Number(), never do arithmetic. */
export interface BuyerInvoicePayment {
  id: string;
  amount: number;
  createdAt: string;
  method?: string;
  /** @deprecated the API returns `method` — kept for older cached shapes. */
  paymentMethod?: string;
  reference?: string;
  notes?: string;
  status?: "DRAFT" | "PAID" | "VOID" | string;
  checkStatus?: BuyerCheckStatus | null;
  nsfFeeAmount?: number | string | null;
  paidAt?: string;
}

export interface BuyerInvoice {
  id: string;
  invoiceNumber: string;
  status: string;
  issueDate?: string;
  dueDate?: string;
  subtotal?: number;
  tax?: number;
  total: number;
  amountPaid?: number;
  paidAmount?: number;
  amountDue?: number;
  balanceDue?: number;
  isOverdue?: boolean;
  customer?: { id: string; businessName: string };
  items?: BuyerInvoiceItem[];
  payments?: BuyerInvoicePayment[];
}

export interface BuyerProfile {
  id: string;
  businessName: string;
  email?: string;
  phone?: string;
  address?: { line1?: string; city?: string; postcode?: string };
}

/** Minimal order shape returned by /buyer/dashboard (no lineItems — use itemCount). */
export interface DashboardOrder {
  id: string;
  orderNumber?: string;
  status: string;
  total?: number;
  createdAt: string;
  requestedDeliveryDate?: string;
  /** Pre-computed item count returned by the dashboard endpoint. */
  itemCount?: number;
  /** lineItems is NOT present in dashboard responses — guard every access. */
  lineItems?: Array<{
    id: string;
    productId: string;
    qty: number;
    unitPrice: number;
    product?: { id: string; name: string; unit?: string };
  }>;
}

export interface BuyerDashboard {
  recentOrders: DashboardOrder[];
  frequentItems: Array<{ productId: string; name: string; totalQty: number }>;
  frequentlyOrdered?: Array<{ productId: string; name: string; totalQty: number }>;
  stats: {
    // Fields returned by /buyer/dashboard
    spendAllTime: number;
    spend30d: number;
    spend90d: number;
    activeOrders: number;
    pendingDeliveries: number;
    templateCount: number;
    /** Open invoices (SENT/VIEWED/PARTIAL/OVERDUE) — matches /buyer/analytics summary. */
    unpaidInvoiceCount: number;
    unpaidInvoiceTotal: number;
    // Legacy aliases — may be absent depending on API version
    totalOrders?: number;
    totalSpend?: number;
    /** @deprecated the API never returned this — use unpaidInvoiceCount. */
    unpaidInvoices?: number;
  };
}

// ─── Catalog ──────────────────────────────────────────────────────────────────

export function useBuyerProducts(params?: {
  search?: string;
  category?: string;
  page?: number;
  limit?: number;
}) {
  return useQuery<{
    data: BuyerProduct[];
    meta: { total: number };
    hiddenCategories?: LockedCategory[];
  }>({
    queryKey: ["buyer-products", params],
    queryFn: () =>
      buyerApiClient
        .get("/buyer/products", { params: { limit: 50, ...params } })
        .then((r) => r.data),
    staleTime: 60_000,
  });
}

/**
 * Paged catalog for the browse screen. Pages through the seller's WHOLE
 * catalog (the old single-shot `limit:100` call cut off everything past row
 * 100). Key stays under "buyer-products" so socket invalidation covers it.
 * Buyer meta only carries `total`, so the next page is derived from the
 * accumulated row count.
 */
export function useBuyerProductsInfinite(params?: {
  search?: string;
  category?: string;
  limit?: number;
}) {
  const limit = params?.limit ?? 50;
  return useInfiniteQuery({
    queryKey: ["buyer-products", "infinite", params],
    queryFn: ({ pageParam }) =>
      buyerApiClient.get("/buyer/products", { params: { ...params, limit, page: pageParam } }).then(
        (r) =>
          r.data as {
            data: BuyerProduct[];
            meta: { total: number };
            hiddenCategories?: LockedCategory[];
          },
      ),
    initialPageParam: 1,
    getNextPageParam: (last, all) => {
      const loaded = all.reduce((sum, p) => sum + p.data.length, 0);
      return loaded < (last.meta?.total ?? 0) && last.data.length > 0 ? all.length + 1 : undefined;
    },
    staleTime: 15_000,
  });
}

/**
 * F30 / R12 (B200): resolve a scanned code against THIS buyer's catalog.
 *
 * The operator ladder in `lib/barcode-resolve.ts` is unusable from the buyer
 * realm — both its rungs (`/products/barcode/:code` and `/products?scanCode=`)
 * are `@Roles(OPERATOR, DRIVER)`, so a customer 403s on both. This is the
 * buyer realm's own rung (`BuyerController.scanProduct`), which runs the same
 * `normalizeScanCode` candidate match the operator rung does — so an iOS
 * 13-digit decode of a 12-digit label still resolves — behind the isActive +
 * regulated-visibility gate every other buyer-catalog surface uses.
 *
 * A 404 is the MISS outcome, not a failure: it covers both "no candidate
 * matched" and "matched a product this buyer may not see", and the two must
 * be indistinguishable to the buyer. Anything else (network / 5xx) propagates
 * so the caller can say "try again" instead of lying with "not found"
 * (`resolveProductByCode`'s convention).
 */
export async function resolveBuyerProductByCode(
  code: string,
  signal?: AbortSignal,
): Promise<{ product: BuyerProduct; notFound?: false } | { notFound: true; product?: undefined }> {
  const trimmed = code.trim();
  if (!trimmed) return { notFound: true };
  try {
    const res = await buyerApiClient.get<BuyerProduct>(
      `/buyer/products/scan/${encodeURIComponent(trimmed)}`,
      { signal },
    );
    if (res.data?.id) return { product: res.data };
  } catch (err: any) {
    if (err?.response?.status !== 404) throw err;
  }
  return { notFound: true };
}

// ─── Promotions (P5-04, buyer cart) ────────────────────────────────────────────
// `BuyerPromotion` now imported from @routeflow/types (wave E / imp-10b, L-072):
// this local copy's `type` field omitted "BUY_N_GET_M", which the schema, web,
// and this app's own lib/pricing.ts PromotionType already carried — see
// matchingBogoPromo in buyer-cart-logic.ts, whose compensating `as PromotionType`
// cast is now removed.

/**
 * Active promotions for the current seller — feeds the mobile cart's per-line
 * best-promo evaluation (`applyBestPromotion`) so buyers see the same net price
 * the server bills. Display-only; the order create path sends no unitPrice.
 */
export function useBuyerPromotions() {
  return useQuery<BuyerPromotion[]>({
    queryKey: ["buyer-promotions"],
    queryFn: () => buyerApiClient.get("/buyer/promotions").then((r) => r.data),
    staleTime: 5 * 60_000,
  });
}

/** Buyer: the caller's own expiring/expired licenses at this seller (W7b bell). */
export function useBuyerExpiringAuthorizations() {
  return useQuery<ExpiringAuthorization[]>({
    queryKey: ["buyer-authorizations-expiring"],
    queryFn: () => buyerApiClient.get("/buyer/authorizations/expiring").then((r) => r.data),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });
}

// ─── License self-serve (submit / renew) ───────────────────────────────────────

/** Per-category license status for the buyer's self-serve screen (GET /buyer/authorizations). */
export function useBuyerAuthorizations() {
  return useQuery<BuyerAuthorizationRow[]>({
    queryKey: ["buyer-authorizations"],
    queryFn: () => buyerApiClient.get("/buyer/authorizations").then((r) => r.data),
    staleTime: 60_000,
  });
}

/** Submit/renew a license for a category (POST /buyer/authorizations). */
export function useSubmitBuyerAuthorization() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, SubmitBuyerAuthorizationInput>({
    mutationFn: (dto) => buyerApiClient.post("/buyer/authorizations", dto).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["buyer-authorizations"] });
      qc.invalidateQueries({ queryKey: ["buyer-authorizations-expiring"] });
      qc.invalidateQueries({ queryKey: ["buyer-products"] });
    },
  });
}

export function useBuyerCategories() {
  return useQuery<string[]>({
    queryKey: ["buyer-categories"],
    queryFn: () => buyerApiClient.get("/buyer/products/categories").then((r) => r.data),
    staleTime: 5 * 60_000,
  });
}

export function useBuyerFavorites() {
  return useQuery<BuyerProduct[]>({
    queryKey: ["buyer-favorites"],
    queryFn: () => buyerApiClient.get("/buyer/favorites").then((r) => r.data),
    staleTime: 60_000,
  });
}

export function useToggleFavorite() {
  const qc = useQueryClient();
  return useMutation<void, Error, { productId: string; isFavorite: boolean }>({
    mutationFn: ({ productId, isFavorite }) =>
      isFavorite
        ? buyerApiClient.delete(`/buyer/favorites/${productId}`).then(() => undefined)
        : buyerApiClient.post(`/buyer/favorites/${productId}`).then(() => undefined),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["buyer-favorites"] });
      qc.invalidateQueries({ queryKey: ["buyer-products"] });
    },
  });
}

// ─── Stock alerts / Notify-me (P5-03 twin — P5-16a) ───────────────────────────

export function useBuyerStockAlerts() {
  return useQuery<BuyerStockAlerts>({
    queryKey: ["buyer-stock-alerts"],
    queryFn: () => buyerApiClient.get("/buyer/stock-alerts").then((r) => r.data),
    staleTime: 60_000,
  });
}

export function useSubscribeStockAlert() {
  const qc = useQueryClient();
  return useMutation<{ subscribed: true }, Error, string>({
    mutationFn: (productId) =>
      buyerApiClient.post(`/buyer/products/${productId}/stock-alert`).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["buyer-stock-alerts"] });
      qc.invalidateQueries({ queryKey: ["buyer-products"] });
    },
  });
}

export function useUnsubscribeStockAlert() {
  const qc = useQueryClient();
  return useMutation<{ subscribed: false }, Error, string>({
    mutationFn: (productId) =>
      buyerApiClient.delete(`/buyer/products/${productId}/stock-alert`).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["buyer-stock-alerts"] });
      qc.invalidateQueries({ queryKey: ["buyer-products"] });
    },
  });
}

// ─── Replenishment (P5-05 twin — behavioral tile chips) ───────────────────────

export function useBuyerReplenishment() {
  return useQuery<ReplenishmentEstimate[]>({
    queryKey: ["buyer-replenishment"],
    queryFn: () => buyerApiClient.get("/buyer/replenishment").then((r) => r.data),
    staleTime: 5 * 60_000,
  });
}

// ─── Your Shelf (P5-06/07 twin — P5-16b) ──────────────────────────────────────
export function useBuyerShelf() {
  return useQuery<ShelfResponse>({
    queryKey: ["buyer-shelf"],
    queryFn: () => buyerApiClient.get("/buyer/shelf").then((r) => r.data),
    staleTime: 60_000,
  });
}

export function useSnoozeReplenishment() {
  const qc = useQueryClient();
  return useMutation<{ snoozedUntil: string }, Error, string>({
    mutationFn: (productId) =>
      buyerApiClient.post(`/buyer/replenishment/${productId}/snooze`).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["buyer-shelf"] });
      qc.invalidateQueries({ queryKey: ["buyer-replenishment"] });
    },
  });
}

export function useUnsnoozeReplenishment() {
  const qc = useQueryClient();
  return useMutation<{ ok: boolean }, Error, string>({
    mutationFn: (productId) =>
      buyerApiClient.delete(`/buyer/replenishment/${productId}/snooze`).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["buyer-shelf"] });
      qc.invalidateQueries({ queryKey: ["buyer-replenishment"] });
    },
  });
}

/** Box splits computed SERVER-side (shelf.service lowItems) — no client money math. */
export function useAddAllLow() {
  const qc = useQueryClient();
  return useMutation<BuyerOrder | null, Error, void>({
    mutationFn: () => buyerApiClient.post("/buyer/shelf/add-all-low").then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["buyer-shelf"] });
      qc.invalidateQueries({ queryKey: ["buyer-replenishment"] });
      qc.invalidateQueries({ queryKey: ["buyer-orders"] });
      qc.invalidateQueries({ queryKey: ["buyer-dashboard"] });
    },
  });
}

// ─── Orders ───────────────────────────────────────────────────────────────────

export function useBuyerOrders(params?: { status?: string; page?: number; limit?: number }) {
  return useQuery<{ data: BuyerOrder[]; meta: any }>({
    queryKey: ["buyer-orders", params],
    queryFn: () =>
      buyerApiClient.get("/buyer/orders", { params: { limit: 30, ...params } }).then((r) => r.data),
    staleTime: 30_000,
  });
}

export function useBuyerOrder(id: string) {
  return useQuery<BuyerOrder>({
    queryKey: ["buyer-orders", id],
    queryFn: () => buyerApiClient.get(`/buyer/orders/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}

export interface BuyerOrderTracking {
  status: string;
  tracking: {
    runId: string;
    routeName: string | null;
    driverName: string | null;
    runStatus: string;
    stopNumber: number;
    stopStatus: string;
    stopsAhead: number;
    estimatedArrivalWindow: { start: string | null; end: string | null };
  } | null;
}

/** Live-ish: polls while the order can still move. There is no per-stop push
 *  to the buyer socket namespace today — only order.statusChanged is wired
 *  (useBuyerSocket.ts), which covers status transitions but not driver
 *  progress WITHIN a status (stopsAhead ticking down). Paused once
 *  DELIVERED/CANCELLED or before dispatch. ALSO polls while the run is
 *  IN_PROGRESS so a CONFIRMED order can observe its own skip (F11). TanStack
 *  v5 function form. */
export function useBuyerOrderTracking(id: string) {
  return useQuery<BuyerOrderTracking>({
    queryKey: ["buyer-order-tracking", id],
    queryFn: () => buyerApiClient.get(`/buyer/orders/${id}/tracking`).then((r) => r.data),
    enabled: !!id,
    refetchInterval: (query) => trackingRefetchInterval(query.state.data),
  });
}

export function useBuyerCreateOrder() {
  const qc = useQueryClient();
  return useMutation<
    BuyerOrder,
    Error,
    {
      items: Array<{ productId: string; qty: number; boxes?: number; pieces?: number }>;
      notes?: string;
      urgent?: boolean;
      requestedDeliveryDate?: string;
    }
  >({
    mutationFn: (dto) => buyerApiClient.post("/buyer/orders", dto).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["buyer-orders"] });
      qc.invalidateQueries({ queryKey: ["buyer-shelf"] });
    },
  });
}

export function useBuyerCancelOrder() {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (id) => buyerApiClient.post(`/buyer/orders/${id}/cancel`).then(() => undefined),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["buyer-orders"] }),
  });
}

// ─── Invoices ─────────────────────────────────────────────────────────────────

export function useBuyerInvoices(params?: {
  status?: string;
  statuses?: string[];
  page?: number;
  limit?: number;
}) {
  return useQuery<{ data: BuyerInvoice[]; meta: any }>({
    queryKey: ["buyer-invoices", params],
    queryFn: () =>
      buyerApiClient
        .get("/buyer/invoices", { params: { limit: 30, ...params } })
        .then((r) => r.data),
    staleTime: 30_000,
  });
}

export function useBuyerInvoice(id: string) {
  return useQuery<BuyerInvoice>({
    queryKey: ["buyer-invoices", id],
    queryFn: () => buyerApiClient.get(`/buyer/invoices/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}

// ─── Profile & Dashboard ──────────────────────────────────────────────────────

export function useBuyerProfile() {
  return useQuery<BuyerProfile>({
    queryKey: ["buyer-profile"],
    queryFn: () => buyerApiClient.get("/buyer/profile").then((r) => r.data),
    staleTime: 5 * 60_000,
  });
}

export function useBuyerDashboard() {
  return useQuery<BuyerDashboard>({
    queryKey: ["buyer-dashboard"],
    queryFn: () => buyerApiClient.get("/buyer/dashboard").then((r) => r.data),
    staleTime: 60_000,
  });
}

// ─── Finances / analytics (mirrors web useBuyerAnalytics) ─────────────────────

export function useBuyerAnalytics() {
  return useQuery<BuyerAnalytics>({
    queryKey: ["buyer", "analytics"],
    queryFn: () => buyerApiClient.get("/buyer/analytics").then((r) => r.data),
    staleTime: 60_000,
  });
}

// ─── Payments / credits / statement (P5-12/13/14/15 twins — P5-16c) ──────────
// Mobile mirrors of the SHIPPED web hooks. Same endpoints/shapes; dash-style
// keys so useBuyerSocket prefix-invalidation covers them. ALL money figures are
// server values — render verbatim, NEVER recompute.

export function useBuyerStatement() {
  return useQuery<BuyerStatement>({
    queryKey: ["buyer-statement"],
    queryFn: () => buyerApiClient.get("/buyer/statement").then((r) => r.data),
    staleTime: 30_000,
  });
}

export interface BuyerPaymentsMeta {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export function useBuyerPayments(params?: { page?: number; limit?: number }) {
  return useQuery<{ data: BuyerPayment[]; meta: BuyerPaymentsMeta }>({
    queryKey: ["buyer-payments", params],
    queryFn: () => buyerApiClient.get("/buyer/payments", { params }).then((r) => r.data),
    staleTime: 30_000,
    // Retain the prior page's rows while a Prev/Next fetch is in flight so the
    // Payments screen doesn't blank to a full-page spinner / reset scroll on
    // every pagination tap (mirrors web scoping the load gate to the history).
    placeholderData: keepPreviousData,
  });
}

export function useBuyerRemittance() {
  return useQuery<BuyerRemittance>({
    queryKey: ["buyer-remittance"],
    queryFn: () => buyerApiClient.get("/buyer/remittance").then((r) => r.data),
    staleTime: 5 * 60_000,
  });
}

export function useBuyerStatementMonths() {
  return useQuery<{ months: string[] }>({
    queryKey: ["buyer-statement-months"],
    queryFn: () => buyerApiClient.get("/buyer/statements").then((r) => r.data),
    staleTime: 5 * 60_000,
  });
}

/** Imperative (PDF gen is slow): returns the PRESIGNED URL (no JWT) → hand to
 *  sharePdf(). No 401: only this call is authenticated, the download is not. */
export async function fetchStatementPdfUrl(month: string): Promise<string> {
  const r = await buyerApiClient.get<{ url: string }>(`/buyer/statements/${month}`);
  return r.data.url;
}

// ─── Standing orders ──────────────────────────────────────────────────────────

export function useBuyerTemplates() {
  return useQuery<any[]>({
    queryKey: ["buyer-templates"],
    queryFn: () =>
      buyerApiClient.get("/buyer/templates").then((r) => {
        const body = r.data;
        return Array.isArray(body) ? body : (body?.data ?? []);
      }),
    staleTime: 60_000,
  });
}

export function useBuyerReorder() {
  const qc = useQueryClient();
  return useMutation<BuyerOrder, Error, string>({
    mutationFn: (templateId) =>
      buyerApiClient.post(`/buyer/templates/${templateId}/reorder`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["buyer-orders"] }),
  });
}

export function useBuyerUpdateTemplate() {
  const qc = useQueryClient();
  return useMutation<any, Error, { id: string; isActive: boolean }>({
    mutationFn: ({ id, isActive }) =>
      buyerApiClient.patch(`/buyer/templates/${id}`, { isActive }).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["buyer-templates"] }),
  });
}

export function useBuyerUpdateOrderItems() {
  const qc = useQueryClient();
  return useMutation<
    BuyerOrder,
    Error,
    { orderId: string; items: Array<{ productId: string; qty: number }> }
  >({
    mutationFn: ({ orderId, items }) =>
      buyerApiClient.patch(`/buyer/orders/${orderId}/items`, { items }).then((r) => r.data),
    onSuccess: (_, { orderId }) => {
      qc.invalidateQueries({ queryKey: ["buyer-orders"] });
      qc.invalidateQueries({ queryKey: ["buyer-order", orderId] });
    },
  });
}

// ─── Post-dispatch change requests (P5-10 twin — P5-16b) ──────────────────────
export function useBuyerCreateChangeRequest() {
  const qc = useQueryClient();
  return useMutation<ChangeRequest, Error, BuyerCreateChangeRequestInput>({
    mutationFn: ({ orderId, ...dto }) =>
      buyerApiClient.post(`/buyer/orders/${orderId}/change-requests`, dto).then((r) => r.data),
    onSuccess: () => {
      // ["buyer-orders"] prefix covers both list (["buyer-orders", params]) and
      // detail (["buyer-orders", id]) keys.
      qc.invalidateQueries({ queryKey: ["buyer-orders"] });
    },
  });
}

// ─── Sellers directory (P10-BUY-1) ────────────────────────────────────────────
// Distinct from getBuyerSellers()/setActiveSeller() in ../buyer-auth (the one-off
// calls used at login, before any React Query cache exists) — these are the
// query-cached, in-app-switch equivalents. Same GET /buyer/sellers endpoint;
// zero backend changes anywhere in this section.

export function useBuyerSellers() {
  return useQuery<BuyerSeller[]>({
    queryKey: ["buyer-sellers"],
    queryFn: () => buyerApiClient.get("/buyer/sellers").then((r) => r.data),
  });
}

export function useRequestSeller() {
  const qc = useQueryClient();
  return useMutation<{ message?: string }, Error, { sellerSlug: string; emailAtSeller: string }>({
    mutationFn: (dto) => buyerApiClient.post("/buyer/sellers/request", dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["buyer-sellers"] }),
  });
}

/** Also doubles as "cancel request" for a not-yet-approved link — same
 *  endpoint buyer.service.disconnectSelf() handles for any link status, not
 *  just ACTIVE. */
export function useDisconnectSeller() {
  const qc = useQueryClient();
  return useMutation<{ message?: string }, Error, string>({
    mutationFn: (sellerSlug) =>
      buyerApiClient.delete(`/buyer/sellers/${sellerSlug}`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["buyer-sellers"] }),
  });
}
