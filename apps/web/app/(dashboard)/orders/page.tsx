"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  Eye,
  Loader2,
  Calendar,
  X,
  CheckSquare,
  Trash2,
  ChevronUp,
  ChevronDown,
  ChevronsUpDown,
  ChevronLeft,
  ChevronRight,
  Download,
  History,
  Package,
  Route as RouteIcon,
} from "lucide-react";
import { PageHeader, Badge, Select, Button, cn, useToast, EmptyState } from "@routeflow/ui/web";
import { useAuth } from "@/lib/auth-context";
import { staffMay } from "@routeflow/types";
import { OrdersMoreMenu } from "./_components/OrdersMoreMenu";
import { usePageTitle } from "@/lib/page-title-context";
import { humanizeEnum } from "@/lib/format";
import { useOrders, useUpdateOrderStatus, useBulkDeleteOrders, type Order } from "@/lib/api/orders";
import { useProduct } from "@/lib/api/products";
import { useShippedWeek } from "@/lib/tenant-timezone";
import { SearchableProductPicker } from "@/components/SearchableProductPicker";
import { useUrlFilters } from "@/lib/hooks/useUrlFilters";
import { useUrlSearch } from "@/lib/hooks/useUrlSearch";
import { useUrlPage, useResetPageOnChange, useClampPage } from "@/lib/hooks/useUrlPage";
import { downloadCsv, csvDate } from "@/lib/export";
import { apiClient } from "@/lib/api-client";
import { useDeliveryAccess, useFleetAccess } from "@/lib/api/addons";
import { useOrderStatusLabel, useStaffFulfilment } from "@/lib/fulfilment-caps";
import { useDrafts } from "@/lib/api/drafts";
import { saveTripDraft } from "@/lib/trip-draft";
import { bulkCancelFailureTitle } from "@/lib/bulk-cancel-summary";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { CreateOrderModal } from "./_components/CreateOrderModal";
import { BatchShipActions } from "./_components/BatchShipActions";
import { useCounterSaleGate } from "@/lib/api/counter-sale";
import { genericToastCopy } from "@/lib/generic-toast-copy";

// ─── Saved view definitions ───────────────────────────────────────────────────

const SAVED_VIEWS = [
  { id: "all", label: "All", filters: {} as Record<string, string | boolean> },
  { id: "pending", label: "Pending", filters: { status: "PENDING" } },
  { id: "confirmed", label: "Confirmed", filters: { status: "CONFIRMED" } },
  { id: "delivery", label: "Out for Delivery", filters: { status: "OUT_FOR_DELIVERY" } },
  { id: "urgent", label: "Urgent", filters: { urgent: true } },
  { id: "delivered", label: "Delivered", filters: { status: "DELIVERED" } },
  { id: "cancelled", label: "Cancelled", filters: { status: "CANCELLED" } },
];

// ─── Status filter options ────────────────────────────────────────────────────

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "All Statuses" },
  { value: "DRAFT", label: "Draft" },
  { value: "PENDING", label: "Pending" },
  { value: "CONFIRMED", label: "Confirmed" },
  { value: "OUT_FOR_DELIVERY", label: "Out for Delivery" },
  { value: "PARTIALLY_DELIVERED", label: "Partially Delivered" },
  { value: "DELIVERED", label: "Delivered" },
  { value: "CANCELLED", label: "Cancelled" },
];

// Row status badge label — reuse the filter-pill copy above so the two stay in
// sync; fall back to humanizeEnum for any status this list doesn't know about
// yet (never render the raw enum with underscores).
function orderStatusLabel(status: string): string {
  return STATUS_OPTIONS.find((o) => o.value === status)?.label ?? humanizeEnum(status);
}

// ─── Fulfillment filter options ───────────────────────────────────────────────

const FULFILLMENT_LABEL = { ROUTE: "Delivery route", SHIP: "Ship via carrier" } as const;

// ─── Date column ──────────────────────────────────────────────────────────────

const DATE_FORMAT: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" };

/**
 * Render a date-only field (stored midnight UTC) as its calendar day. Parsing the
 * parts by hand avoids the day-behind shift `new Date(iso)` causes west of UTC.
 */
function formatDateOnly(iso: string): string {
  const [y, m, d] = iso.split("T")[0].split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", DATE_FORMAT);
}

/** The business day the order happened, falling back to when it was entered. */
function OrderDateCell({ order }: { order: Order }) {
  const backdated =
    !!order.orderDate && order.orderDate.slice(0, 10) !== order.createdAt.slice(0, 10);
  return (
    <span className="inline-flex items-center gap-1">
      {order.orderDate
        ? formatDateOnly(order.orderDate)
        : new Date(order.createdAt).toLocaleDateString("en-US", DATE_FORMAT)}
      {backdated && (
        <span
          className="cursor-help"
          title={`Backdated — entered ${new Date(order.createdAt).toLocaleDateString(
            "en-US",
            DATE_FORMAT,
          )}`}
        >
          <History className="h-3 w-3 text-navy/40" aria-hidden />
          <span className="sr-only">Backdated order</span>
        </span>
      )}
    </span>
  );
}

// ─── Pager (shared by the desktop table-card footer and the mobile-only card) ─────

interface PagerMeta {
  total: number;
  totalPages?: number;
}

/** "Showing X to Y of N" / an empty-result message. */
function PagerInfo({
  meta,
  page,
  limit,
  customerSearch,
}: {
  meta: PagerMeta;
  page: number;
  limit: number;
  customerSearch: string;
}) {
  return (
    <span>
      {meta.total > 0 ? (
        <>
          Showing{" "}
          <span className="font-mono tabular-nums text-navy">
            {(page - 1) * limit + 1} to {Math.min(page * limit, meta.total)}
          </span>{" "}
          of <span className="font-mono tabular-nums text-navy">{meta.total}</span>
          {customerSearch ? " (filtered)" : ""}
        </>
      ) : customerSearch ? (
        "No orders match your search"
      ) : (
        "No orders found"
      )}
    </span>
  );
}

/** Per-page select + prev/page-number/next controls. */
function PagerControls({
  meta,
  page,
  limit,
  setLimit,
  setPage,
}: {
  meta: PagerMeta;
  page: number;
  limit: number;
  setLimit: (n: number) => void;
  setPage: (next: number | ((prev: number) => number)) => void;
}) {
  return (
    <>
      <div className="flex items-center gap-1.5">
        <span>Per page</span>
        <select
          value={limit}
          onChange={(e) => {
            setLimit(Number(e.target.value));
            setPage(1);
          }}
          className="h-7 rounded-ctl border border-surface-border bg-white px-2 font-mono text-xs text-navy focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
        >
          {[10, 20, 50, 100].map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </div>
      {(meta.totalPages ?? 1) > 1 && (
        <div className="ml-auto flex items-center gap-0.5">
          <button
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
            aria-label="Previous page"
            className="grid h-7 w-7 place-items-center rounded-ctl text-navy/70 hover:bg-surface-raised disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          {Array.from({ length: Math.min(meta.totalPages ?? 1, 7) }, (_, i) => {
            const totalPages = meta.totalPages ?? 1;
            const p = totalPages <= 7 ? i + 1 : page <= 4 ? i + 1 : page + i - 3;
            if (p < 1 || p > totalPages) return null;
            return (
              <button
                key={p}
                onClick={() => setPage(p)}
                className={cn(
                  "grid h-7 min-w-7 place-items-center rounded-ctl px-2 font-mono text-xs tabular-nums transition-colors",
                  p === page ? "bg-navy text-white" : "text-navy/70 hover:bg-surface-raised",
                )}
              >
                {p}
              </button>
            );
          })}
          <button
            disabled={page >= (meta.totalPages ?? 1)}
            onClick={() => setPage((p) => p + 1)}
            aria-label="Next page"
            className="grid h-7 w-7 place-items-center rounded-ctl text-navy/70 hover:bg-surface-raised disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function OrdersPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user } = useAuth();
  // Same staff test as the shell's gate callers (layout.tsx, CommandPalette): everyone but CUSTOMER / DRIVER.
  const counterGate = useCounterSaleGate({
    enabled: user?.role !== "CUSTOMER" && user?.role !== "DRIVER",
  });
  const { setTitle } = usePageTitle();
  React.useEffect(() => {
    setTitle("Orders");
  }, [setTitle]);

  // URL-backed filter state
  const [urlFilters, setFilter, clearFilters] = useUrlFilters({
    status: "",
    urgent: false,
    dateFrom: "",
    dateTo: "",
    // PR-B: "which orders had this item?" — round-trips through the URL like
    // every other chip here so a deep link / Back nav preserves it.
    productId: "",
    // Ad-hoc trips: ROUTE (dispatched) vs SHIP (supplier/carrier-shipped,
    // excluded from trip/route dispatch) — same URL-chip treatment as status.
    fulfillPath: "",
    // Dashboard shipping cards: "no-tracking" (shipped, no tracking number) | "week" (shipped since Sunday 00:00 in the business's timezone).
    shipView: "",
  });
  const statusFilter = (urlFilters.status as string) ?? "";
  const urgentOnly = (urlFilters.urgent as boolean) ?? false;
  const dateFrom = (urlFilters.dateFrom as string) ?? "";
  const dateTo = (urlFilters.dateTo as string) ?? "";
  const productIdFilter = (urlFilters.productId as string) ?? "";
  const fulfillPathFilter = (urlFilters.fulfillPath as string) ?? "";
  const shipView = (urlFilters.shipView as string) ?? "";
  // Sunday 00:00 in the business's timezone — the dashboard card uses the same helper.
  const week = useShippedWeek(shipView === "week");
  const weekStart = week.from;
  const shipParams = {
    hasTracking: shipView === "no-tracking" ? (false as const) : undefined,
    shippedFrom: shipView === "week" ? weekStart : undefined,
  };
  // Only fetched to render the chip's label — the filter itself is the id.
  const { data: filterProduct } = useProduct(productIdFilter);
  // Hide-only gate for the ad-hoc delivery builder entry point — bulkbar action
  // stays hidden on `enabled` (never `resolved`; this is a nav affordance, not a
  // data guard). The `order_delivery` addon alone, via the shared composition
  // helper (owner decision 2026-08-28: `devMode` no longer unlocks it).
  const { enabled: deliveryAccessEnabled } = useDeliveryAccess();

  // Customer search is URL-backed like the chips above, so drilling into an order
  // and pressing Back returns to the search that found it.
  const [customerSearch, setCustomerSearch, debouncedCustomerSearch] = useUrlSearch();
  const [isCreateOpen, setIsCreateOpen] = React.useState(false);
  // Draft resume state (pos-cost-roles-spec §2): which parked draft to hydrate and
  // an optional barcode to add on open.
  const [resumeDraftId, setResumeDraftId] = React.useState<string | null>(null);
  const [initialScanCode, setInitialScanCode] = React.useState<string | null>(null);
  // B1210: ?preselect=SHIP (the counter sale's "Ship this order instead") opens a FRESH builder on "Ship via carrier".
  const [initialFulfillPath, setInitialFulfillPath] = React.useState<"SHIP" | null>(null);

  // Open the builder from URL intents: ?action=new (fresh), ?resumeDraft=<id>
  // (resume a parked draft), optional &scan=<code> (add on open). Runs on mount and
  // whenever the params change — so Resume from the draft dock works even when
  // already on this page — then strips the params so a refresh won't reopen it.
  React.useEffect(() => {
    const action = searchParams.get("action");
    const resume = searchParams.get("resumeDraft");
    const scan = searchParams.get("scan");
    if (!resume && action !== "new") return;
    // A business whose staff default is the counter: "New order" OPENS AS the counter sale, unless the operator chose
    // "Ship this order instead" (?ship=1), which falls through to the normal builder.
    if (
      !resume &&
      action === "new" &&
      counterGate.opensAsCounter &&
      searchParams.get("ship") !== "1" &&
      // ?builder=1 (the /orders/new target and the "Invoice order" link) asks for the builder itself.
      searchParams.get("builder") !== "1"
    ) {
      router.replace("/orders/counter-sale");
      return;
    }
    if (resume) {
      setResumeDraftId(resume);
    } else {
      setResumeDraftId(null);
    }
    setInitialScanCode(scan);
    setInitialFulfillPath(!resume && searchParams.get("preselect") === "SHIP" ? "SHIP" : null);
    setIsCreateOpen(true);
    // Strip ONLY the intent params. This used to replace with a bare "/orders",
    // which also discarded the status/date chips and the search — so opening the
    // builder from the draft dock silently cleared the operator's filters.
    const params = new URLSearchParams(window.location.search);
    params.delete("action");
    params.delete("resumeDraft");
    params.delete("scan");
    params.delete("ship");
    params.delete("builder");
    params.delete("preselect");
    const qs = params.toString();
    router.replace(qs ? `/orders?${qs}` : "/orders", { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, counterGate.opensAsCounter]);
  const [selectMode, setSelectMode] = React.useState(false);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [isCancelling, setIsCancelling] = React.useState(false);
  const [isDeleting, setIsDeleting] = React.useState(false);
  const [deleteConfirm, setDeleteConfirm] = React.useState(false);
  // REG-B2: cancelling voids the orders' linked invoices, so the bulk bar asks first.
  const [cancelConfirm, setCancelConfirm] = React.useState(false);
  const [page, setPage] = useUrlPage();
  const [limit, setLimit] = React.useState(20);
  const [sortCol, setSortCol] = React.useState<string>("createdAt");
  const [sortDir, setSortDir] = React.useState<"asc" | "desc">("desc");

  const toggleSort = (col: string) => {
    if (sortCol === col) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortCol(col);
      setSortDir("asc");
    }
  };

  const SortIcon = ({ col }: { col: string }) => {
    if (sortCol !== col) return <ChevronsUpDown className="h-3 w-3 ml-1 text-navy/30 inline" />;
    return sortDir === "asc" ? (
      <ChevronUp className="h-3 w-3 ml-1 inline text-brand-700" />
    ) : (
      <ChevronDown className="h-3 w-3 ml-1 inline text-brand-700" />
    );
  };
  const { toast } = useToast();
  // Status words come from the shared fulfilment table (display only): per ORDER by its fulfillPath,
  // and the account's default method for the filters below.
  const statusLabel = useOrderStatusLabel();
  // The fulfilment filter lists only the paths the account offers (plus an active URL filter).
  const fulfilMethods = useStaffFulfilment().formMethods;
  // A carrier-only (fleet-off) account has no delivery runs: the requested-delivery-date filter, sort and
  // column are noise there. An active date filter in the URL keeps them, so it can still be cleared.
  const { fleet } = useFleetAccess();
  const showDelivery = fleet || !!dateFrom || !!dateTo;
  // A sort left on the hidden Delivery Date column would order rows by a key the user can no longer see.
  React.useEffect(() => {
    if (!showDelivery && sortCol === "deliveryDate") {
      setSortCol("createdAt");
      setSortDir("desc");
    }
  }, [showDelivery, sortCol]);
  const savedViews = SAVED_VIEWS.map((v) => ({
    ...v,
    label: statusLabel(String(v.filters.status ?? ""), v.label),
  }));
  const statusOptions = STATUS_OPTIONS.map((o) => ({
    ...o,
    label: statusLabel(o.value, o.label),
  }));
  // The bulk cancel shows its own single summary toast — no per-order global error toasts.
  const updateStatus = useUpdateOrderStatus({ localErrorToast: true });
  const bulkDelete = useBulkDeleteOrders();
  // B823: DraftDock (layout.tsx) floats over the bottom-left of every dashboard screen;
  // below md there isn't enough vertical room for the toolbar above it AND the dock's own
  // footprint, so the dock can land on top of the first visible rows. Reserve clearance
  // (the spacer below) only when a draft is actually parked — same react-query cache key
  // as the dock's own fetch, so this costs no extra request.
  const { data: drafts } = useDrafts();
  const hasDrafts = (drafts?.length ?? 0) > 0;

  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const exitSelectMode = () => {
    setSelectMode(false);
    setSelected(new Set());
    setDeleteConfirm(false);
    setCancelConfirm(false);
  };

  const handleBulkCancel = async () => {
    if (isCancelling) return;
    setIsCancelling(true);
    try {
      const results = await Promise.allSettled(
        Array.from(selected).map((id) => updateStatus.mutateAsync({ id, status: "CANCELLED" })),
      );
      const failures = results.flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
      if (failures.length > 0) {
        // Orders with the carrier are refused (ORDER_WITH_CARRIER_NO_CANCEL): name them, with the count.
        toast({ title: bulkCancelFailureTitle(failures), variant: "error" });
      } else {
        toast({
          title: `${selected.size} order${selected.size !== 1 ? "s" : ""} cancelled`,
          variant: "success",
        });
        exitSelectMode();
      }
    } finally {
      setIsCancelling(false);
      setCancelConfirm(false);
    }
  };

  const handleBulkDelete = async () => {
    if (isDeleting) return;
    setIsDeleting(true);
    try {
      const result = await bulkDelete.mutateAsync(Array.from(selected));
      if (result.errors.length > 0) {
        toast({
          title: `${result.deleted} deleted, ${result.errors.length} failed (orders whose invoice has recorded payments must be voided first)`,
          variant: "error",
        });
      } else {
        toast({
          title: `${result.deleted} order${result.deleted !== 1 ? "s" : ""} deleted`,
          variant: "success",
        });
      }
      exitSelectMode();
    } catch {
      toast({ title: "Failed to delete orders", variant: "error" });
    } finally {
      setIsDeleting(false);
      setDeleteConfirm(false);
    }
  };

  // Reset page when filters change — but not on mount: page now lives in the
  // URL (useUrlPage), so a mount-time reset would clobber the ?page= just
  // restored when the operator presses Back from an order.
  useResetPageOnChange(setPage, [
    statusFilter,
    urgentOnly,
    dateFrom,
    dateTo,
    productIdFilter,
    fulfillPathFilter,
    shipView,
    debouncedCustomerSearch,
  ]);

  // REG-B154 class fix: selection used to accumulate across page/search/filter
  // changes with no reset (toggleSelect only ever adds/removes one id — see
  // below), so a bulk action could silently include ids from a page/filter the
  // operator is no longer looking at. Reset whenever the visible set changes.
  React.useEffect(() => {
    setSelected(new Set());
    setDeleteConfirm(false);
    setCancelConfirm(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    page,
    limit,
    statusFilter,
    urgentOnly,
    dateFrom,
    dateTo,
    productIdFilter,
    fulfillPathFilter,
    customerSearch,
  ]);

  // Active saved view detection
  const activeSavedView = React.useMemo(() => {
    return (
      SAVED_VIEWS.find((v) => {
        const keys = Object.keys(v.filters);
        if (keys.length === 0) {
          return (
            !statusFilter &&
            !urgentOnly &&
            !dateFrom &&
            !dateTo &&
            !productIdFilter &&
            !fulfillPathFilter &&
            !shipView
          );
        }
        return keys.every(
          (k) =>
            String((urlFilters as Record<string, unknown>)[k]) ===
            String((v.filters as Record<string, unknown>)[k]),
        );
      })?.id ?? null
    );
  }, [urlFilters, statusFilter, urgentOnly, dateFrom, dateTo, productIdFilter, fulfillPathFilter]);

  const applyView = (view: (typeof SAVED_VIEWS)[0]) => {
    clearFilters();
    for (const [k, val] of Object.entries(view.filters)) {
      setFilter(k as never, val as string | boolean);
    }
  };

  // The week view waits for the business timezone: never fetch (or show) an unfiltered list for it.
  const weekPending = shipView === "week" && !weekStart;
  const {
    data,
    isLoading: ordersLoading,
    isError,
  } = useOrders(
    {
      status: statusFilter || undefined,
      urgent: urgentOnly || undefined,
      deliveryDateFrom: dateFrom || undefined,
      deliveryDateTo: dateTo || undefined,
      productId: productIdFilter || undefined,
      fulfillPath: (fulfillPathFilter as "ROUTE" | "SHIP" | "") || undefined,
      ...shipParams,
      search: debouncedCustomerSearch || undefined,
      page,
      limit,
    },
    { enabled: !weekPending },
  );
  const isLoading = ordersLoading || weekPending;

  const orders = data?.data ?? [];
  const meta = data?.meta;
  useClampPage(setPage, page, meta?.totalPages);

  // B144: `search` is now sent to the server and composes with the other
  // filters there (role scope, `customerId`) — this page no longer re-filters
  // the current PAGE's rows client-side (that silently hid matches on every
  // page but the one the operator happened to be viewing). Only the in-page
  // sort stays local.
  const filtered = React.useMemo(() => {
    return [...orders].sort((a, b) => {
      // Urgent always floats to top regardless of sort column
      if (a.urgent && !b.urgent) return -1;
      if (!a.urgent && b.urgent) return 1;
      const dir = sortDir === "asc" ? 1 : -1;
      if (sortCol === "orderNumber")
        return dir * (a.orderNumber ?? "").localeCompare(b.orderNumber ?? "");
      if (sortCol === "customer")
        return dir * (a.customer?.businessName ?? "").localeCompare(b.customer?.businessName ?? "");
      if (sortCol === "total") return dir * (Number(a.total) - Number(b.total));
      if (sortCol === "status") return dir * (a.status ?? "").localeCompare(b.status ?? "");
      if (sortCol === "deliveryDate")
        return dir * (a.requestedDeliveryDate ?? "").localeCompare(b.requestedDeliveryDate ?? "");
      // default: createdAt
      return dir * (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    });
  }, [orders, sortCol, sortDir]);

  const urgentCount = orders.filter((o) => o.urgent).length;

  const [isExporting, setIsExporting] = React.useState(false);

  const handleExport = async () => {
    if (isExporting || weekPending) return;
    setIsExporting(true);
    try {
      const EXPORT_LIMIT = 1000;
      const res = await apiClient.get("/orders", {
        params: {
          status: statusFilter || undefined,
          urgent: urgentOnly || undefined,
          deliveryDateFrom: dateFrom || undefined,
          deliveryDateTo: dateTo || undefined,
          productId: productIdFilter || undefined,
          fulfillPath: fulfillPathFilter || undefined,
          ...shipParams,
          search: debouncedCustomerSearch || undefined,
          page: 1,
          limit: EXPORT_LIMIT,
        },
      });
      const payload = res.data as { data: Order[]; meta?: { total?: number } };
      const rows = payload.data ?? [];
      downloadCsv(
        `orders-${new Date().toISOString().split("T")[0]}.csv`,
        [
          "Order #",
          "Customer",
          "Items",
          "Total",
          "Status",
          "Fulfillment",
          "Delivery Date",
          "Created",
        ],
        rows.map((o) => [
          o.orderNumber ?? o.id.slice(0, 8).toUpperCase(),
          o.customer?.businessName ?? "",
          o.lineItems?.length ?? 0,
          Number(o.total ?? 0).toFixed(2),
          o.status,
          o.fulfillPath ?? "ROUTE",
          csvDate(o.requestedDeliveryDate),
          csvDate(o.createdAt),
        ]),
      );
      const total = payload.meta?.total ?? rows.length;
      if (total > EXPORT_LIMIT) {
        toast({
          title: `Exported first ${EXPORT_LIMIT} rows`,
          description: `Narrow filters to export the remaining ${total - EXPORT_LIMIT}.`,
          variant: "warning",
        });
      }
    } catch (err) {
      toast({
        title: "Export failed",
        description: genericToastCopy(
          err,
          "The orders export couldn't be created. Check the filters, then try again.",
        ),
        variant: "error",
      });
    } finally {
      setIsExporting(false);
    }
  };

  // A store-only tenant (capabilities.fulfilment: PICKUP only): "New Order" went to the same place as "Counter sale",
  // so the header has Counter sale (primary) and Invoice a customer (secondary) and nothing else duplicated.
  const storeOnlyHeader = counterGate.offerInvoiceOrder === true;

  const headerSubtitle = meta
    ? `${meta.total.toLocaleString("en-US")} order${meta.total !== 1 ? "s" : ""}${
        urgentCount > 0 ? ` · ${urgentCount} urgent` : ""
      }`
    : undefined;

  return (
    <div className="space-y-5 p-6">
      <PageHeader
        title="Orders"
        subtitle={headerSubtitle}
        action={
          // PageHeader (packages/ui): shrink-0 now pairs with max-w-full, so this row
          // actually gets a narrow-enough box to wrap into at 390px.
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              variant="secondary"
              size="sm"
              leftIcon={
                isExporting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Download className="h-3.5 w-3.5" />
                )
              }
              onClick={handleExport}
              disabled={isExporting}
              title="Export filtered orders as CSV"
              className={cn(storeOnlyHeader && "max-sm:hidden")}
            >
              {isExporting ? "Exporting…" : "Export"}
            </Button>
            <Button
              variant="secondary"
              className={cn(
                selectMode && "border-brand-600 bg-brand-50 text-brand-700",
                storeOnlyHeader && "max-sm:hidden",
              )}
              leftIcon={
                selectMode ? <X className="h-4 w-4" /> : <CheckSquare className="h-4 w-4" />
              }
              onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
            >
              {selectMode ? "Cancel" : "Select"}
            </Button>
            {storeOnlyHeader ? (
              <OrdersMoreMenu
                className="sm:hidden"
                items={[
                  {
                    label: isExporting ? "Exporting…" : "Export",
                    onSelect: handleExport,
                    disabled: isExporting,
                  },
                  {
                    label: selectMode ? "Cancel selection" : "Select",
                    onSelect: () => (selectMode ? exitSelectMode() : setSelectMode(true)),
                  },
                ]}
              />
            ) : null}
            {counterGate.showButton ? (
              <Button
                // A store-only tenant has one place to ring a sale: the counter is the filled primary (UX G7).
                variant={storeOnlyHeader ? undefined : "secondary"}
                className={cn(storeOnlyHeader && "max-sm:h-11")}
                onClick={() => router.push("/orders/counter-sale")}
              >
                Counter sale
              </Button>
            ) : null}
            {storeOnlyHeader && staffMay(user?.role, "USE_POS_MODE") ? (
              <Button
                variant="secondary"
                className="max-sm:h-11"
                onClick={() => setIsCreateOpen(true)}
              >
                Invoice a customer
              </Button>
            ) : null}
            {storeOnlyHeader ? null : (
              <Button
                onClick={() =>
                  counterGate.opensAsCounter
                    ? router.push("/orders/counter-sale")
                    : setIsCreateOpen(true)
                }
              >
                New Order
              </Button>
            )}
          </div>
        }
      />

      {/* Selection action bar — dark "bulkbar" (Ledger) */}
      {selectMode && selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-3.5 rounded-lg bg-navy px-4 py-2.5 text-white shadow-dropdown">
          <b className="text-[13px] font-semibold">{selected.size} selected</b>
          <button
            onClick={() => setSelected(new Set())}
            className="text-[12.5px] font-semibold text-white/75 hover:text-white transition-colors"
          >
            Deselect all
          </button>
          <span className="h-[18px] w-px bg-white/20" />
          <button
            onClick={() => setCancelConfirm(true)}
            disabled={isCancelling}
            className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-white/75 hover:text-white transition-colors disabled:opacity-60"
          >
            {isCancelling && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Cancel {selected.size}
          </button>
          <BatchShipActions
            orders={filtered
              .filter((o) => selected.has(o.id))
              .map((o) => ({
                id: o.id,
                orderNumber: o.orderNumber,
                customerName: o.customer?.businessName,
              }))}
            onDone={exitSelectMode}
          />
          {deliveryAccessEnabled && (
            <>
              <span className="h-[18px] w-px bg-white/20" />
              <button
                onClick={() => {
                  saveTripDraft(Array.from(selected));
                  router.push(`/deliveries/new?n=${selected.size}`);
                }}
                className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-white/75 hover:text-white transition-colors"
              >
                <RouteIcon className="h-3.5 w-3.5" />
                Plan delivery trip
              </button>
            </>
          )}
          {deleteConfirm ? (
            <div className="flex items-center gap-2.5">
              <span className="text-[12.5px] font-semibold text-[#FCA5A5]">
                Delete {selected.size} order{selected.size !== 1 ? "s" : ""}?
              </span>
              <button
                onClick={handleBulkDelete}
                disabled={isDeleting}
                className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-[#FCA5A5] hover:text-white transition-colors disabled:opacity-60"
              >
                {isDeleting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Confirm delete
              </button>
              <button
                onClick={() => setDeleteConfirm(false)}
                className="text-[12.5px] font-semibold text-white/75 hover:text-white transition-colors"
              >
                No
              </button>
            </div>
          ) : (
            <button
              onClick={() => setDeleteConfirm(true)}
              className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-[#FCA5A5] hover:text-white transition-colors"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete {selected.size}
            </button>
          )}
          <span className="ml-auto text-[11.5px] text-white/45">
            Orders with recorded payments can&apos;t be deleted
          </span>
        </div>
      )}

      {/* Saved view chips */}
      <div className="flex items-center gap-2 overflow-x-auto pb-1">
        {savedViews.map((view) => {
          const isActive = activeSavedView === view.id;
          // Only the counts we actually have from the loaded data are shown
          // (total for "All", urgent count for the urgent view); others omit
          // gracefully rather than fabricating per-status tallies.
          const count =
            view.id === "all" ? meta?.total : view.id === "urgent" ? urgentCount : undefined;
          // Urgent is a rare-but-important state — don't clutter the row with an
          // empty pill when there's nothing urgent to see. Keep it while it's the
          // ACTIVE view though: `urgentCount` counts the loaded page, so an urgent
          // filter that returns nothing would otherwise hide the very chip that
          // explains why the list is empty.
          if (view.id === "urgent" && urgentCount === 0 && !isActive) return null;
          return (
            <button
              key={view.id}
              onClick={() => applyView(view)}
              className={cn(
                "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-xs font-medium whitespace-nowrap transition-colors",
                isActive
                  ? "border-navy bg-navy text-white"
                  : "border-surface-border bg-white text-navy hover:bg-surface-raised",
              )}
            >
              {view.label}
              {count != null && (
                <span
                  className={cn(
                    "font-mono text-[11px] tabular-nums",
                    isActive ? "text-white/60" : "text-navy/40",
                  )}
                >
                  {count.toLocaleString("en-US")}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3">
        {selectMode && filtered.length > 0 && (
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={filtered.every((o) => selected.has(o.id))}
              ref={(el) => {
                if (el)
                  el.indeterminate =
                    filtered.some((o) => selected.has(o.id)) &&
                    !filtered.every((o) => selected.has(o.id));
              }}
              onChange={() => {
                if (filtered.every((o) => selected.has(o.id))) setSelected(new Set());
                else setSelected(new Set(filtered.map((o) => o.id)));
              }}
              className="h-4 w-4 cursor-pointer rounded border-navy/30 accent-brand-500"
            />
            <span className="text-sm text-navy/70">Select all</span>
          </label>
        )}
        <input
          type="search"
          placeholder="Search customer or order #…"
          value={customerSearch}
          onChange={(e) => setCustomerSearch(e.target.value)}
          className="h-10 w-64 rounded-ctl border border-surface-border bg-white px-3 text-sm text-navy placeholder:text-navy/40 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
        {/* B823 review (Opus): mobile has no way to sort at all — the desktop table's
            sort is column-header clicks, invisible below md. Same sortCol/sortDir/
            toggleSort state; a direction button next to it matches SortIcon's own glyph. */}
        <div className="flex items-center gap-1.5 md:hidden">
          <div className="w-36">
            <Select
              aria-label="Sort orders by"
              options={[
                { value: "createdAt", label: "Created" },
                ...(showDelivery ? [{ value: "deliveryDate", label: "Delivery Date" }] : []),
                { value: "orderNumber", label: "Order #" },
                { value: "customer", label: "Customer" },
                { value: "total", label: "Total" },
                { value: "status", label: "Status" },
              ]}
              value={sortCol}
              onChange={(e) => {
                const col = e.target.value;
                if (col === sortCol) return;
                setSortCol(col);
                setSortDir(col === "createdAt" || col === "deliveryDate" ? "desc" : "asc");
              }}
              className="h-10"
            />
          </div>
          <button
            type="button"
            onClick={() => toggleSort(sortCol)}
            aria-label={sortDir === "asc" ? "Sort ascending" : "Sort descending"}
            className="grid h-10 w-10 shrink-0 place-items-center rounded-ctl border border-surface-border bg-white text-navy/70 hover:bg-surface-raised"
          >
            <SortIcon col={sortCol} />
          </button>
        </div>
        <div className="w-48">
          <Select
            options={statusOptions}
            value={statusFilter}
            onChange={(e) => setFilter("status", e.target.value)}
          />
        </div>
        <div className="w-44">
          <Select
            options={[
              { value: "", label: "All Fulfillment" },
              ...Array.from(new Set([...fulfilMethods, fulfillPathFilter].filter(Boolean))).map(
                (m) => ({
                  value: m,
                  label: FULFILLMENT_LABEL[m as "ROUTE" | "SHIP"] ?? m,
                }),
              ),
            ]}
            value={fulfillPathFilter}
            onChange={(e) => setFilter("fulfillPath", e.target.value)}
          />
        </div>
        {/* Urgent toggle */}
        <button
          onClick={() => setFilter("urgent", !urgentOnly)}
          className={cn(
            "flex h-10 items-center gap-2 rounded-ctl border px-3 text-sm font-medium transition-colors",
            urgentOnly
              ? "border-danger/40 bg-danger-bg text-danger"
              : "border-line-strong bg-white text-navy/70 hover:text-navy",
          )}
        >
          <AlertTriangle className="h-4 w-4" />
          Urgent only
          {urgentOnly && urgentCount > 0 && (
            <span className="flex h-[17px] min-w-[17px] items-center justify-center rounded-full bg-danger-bg px-1.5 font-mono text-[11px] font-semibold text-[#B91C1C]">
              {urgentCount}
            </span>
          )}
        </button>

        {/* Product filter — "which orders had this item?" (PR-B). Selecting a
            product swaps the picker for a removable chip (X clears it back
            to the picker), mirroring the urgent toggle / date-clear affordances. */}
        {productIdFilter ? (
          <button
            type="button"
            onClick={() => setFilter("productId", "")}
            className="flex h-10 items-center gap-2 rounded-ctl border border-brand-200 bg-brand-50 px-3 text-sm font-medium text-brand-700 transition-colors hover:bg-brand-100"
            title="Remove product filter"
          >
            <Package className="h-4 w-4" />
            {filterProduct?.name ?? "Loading…"}
            <X className="h-3.5 w-3.5" />
          </button>
        ) : (
          <div className="w-56">
            <SearchableProductPicker
              async
              value=""
              onChange={(id) => setFilter("productId", id)}
              placeholder="Filter by product…"
            />
          </div>
        )}

        {/* Delivery date range filter. flex-wrap here (not just on the outer
            filter bar) matters: this whole block is a single flex item in
            that row, so without its own wrap the "to [date]" half ran past
            the viewport edge at 390px instead of dropping to a second line
            the way every other filter control already does (B506). */}
        {showDelivery && (
          <div className="flex flex-wrap items-center gap-1.5">
            <Calendar className="h-4 w-4 text-navy/70" />
            <span className="text-xs text-navy/70 font-medium">Delivery:</span>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setFilter("dateFrom", e.target.value)}
              max={dateTo || undefined}
              className="h-10 w-32 rounded-ctl border border-surface-border bg-white px-2 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
              title="Delivery date from"
            />
            <span className="text-xs text-navy/40">to</span>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setFilter("dateTo", e.target.value)}
              min={dateFrom || undefined}
              className="h-10 w-32 rounded-ctl border border-surface-border bg-white px-2 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
              title="Delivery date to"
            />
            {(dateFrom || dateTo) && (
              <button
                onClick={() => {
                  setFilter("dateFrom", "");
                  setFilter("dateTo", "");
                }}
                className="rounded p-1.5 text-navy/70 hover:text-danger transition-colors"
                title="Clear dates"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        )}

        {/* Clear active filters */}
        {(statusFilter ||
          urgentOnly ||
          dateFrom ||
          dateTo ||
          productIdFilter ||
          fulfillPathFilter ||
          shipView ||
          customerSearch) && (
          <button
            onClick={() => {
              clearFilters();
              setCustomerSearch("");
            }}
            className="flex items-center gap-1 text-sm text-brand-500 hover:underline"
          >
            <X className="h-3.5 w-3.5" />
            Clear all
          </button>
        )}
      </div>

      {/* Results — loading/error/empty are shared across both layouts below; only "has
          data" branches into the mobile card list (below md) vs. the desktop table (md+). */}
      {weekPending && week.isError ? (
        <div
          role="alert"
          className="flex flex-col items-center gap-3 rounded-lg border border-surface-border bg-white py-16 text-center text-sm text-danger shadow-card"
        >
          <span>Couldn&apos;t load your time zone.</span>
          <Button variant="secondary" size="sm" onClick={week.retry}>
            Retry
          </Button>
        </div>
      ) : isLoading ? (
        <div className="flex items-center justify-center rounded-lg border border-surface-border bg-white py-16 shadow-card">
          <Loader2 className="h-6 w-6 animate-spin text-navy/70" />
        </div>
      ) : isError ? (
        <div className="rounded-lg border border-surface-border bg-white py-16 text-center text-sm text-danger shadow-card">
          Failed to load orders. Please try again.
        </div>
      ) : filtered.length === 0 ? (
        <div className="overflow-hidden rounded-lg border border-surface-border bg-white shadow-card">
          {statusFilter ||
          urgentOnly ||
          dateFrom ||
          dateTo ||
          productIdFilter ||
          fulfillPathFilter ||
          shipView ||
          customerSearch ? (
            <EmptyState
              variant="orders"
              title="No matching orders"
              description="No orders match your current search and filters."
              action={
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setCustomerSearch("");
                    clearFilters();
                  }}
                >
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              variant="orders"
              title="No orders yet"
              description="Create an order on behalf of a customer to get started."
              action={
                <Button size="sm" onClick={() => setIsCreateOpen(true)}>
                  Create order
                </Button>
              }
            />
          )}
        </div>
      ) : (
        <>
          {/* B823: clearance for the parked-draft dock (see hasDrafts above) — only
              needed below md, where the toolbar leaves no room to keep the dock clear
              of the first rows on its own. */}
          {hasDrafts && <div className="h-40 md:hidden" aria-hidden />}

          {/* Card list — below md the desktop table only scrolled sideways with TOTAL
              off-screen and no visible affordance that it could scroll at all (B823).
              One tappable card per order instead, mirroring the buyer orders list
              pattern (buyer/portal/[seller]/orders/page.tsx). */}
          <ul className="space-y-3 md:hidden">
            {filtered.map((order) => (
              <li key={order.id}>
                <div
                  role="link"
                  tabIndex={0}
                  onClick={() => {
                    if (selectMode) toggleSelect(order.id);
                    else router.push(`/orders/${order.id}`);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      if (selectMode) toggleSelect(order.id);
                      else router.push(`/orders/${order.id}`);
                    }
                  }}
                  className={cn(
                    "flex cursor-pointer flex-col gap-2 rounded-xl border border-surface-border bg-white p-4 shadow-card transition-colors hover:bg-surface-raised focus:outline-none focus:ring-2 focus:ring-inset focus:ring-brand-500",
                    order.urgent && "border-l-2 border-l-danger",
                    selected.has(order.id) && "bg-brand-50",
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      {selectMode && (
                        <input
                          type="checkbox"
                          checked={selected.has(order.id)}
                          onChange={() => toggleSelect(order.id)}
                          onClick={(e) => e.stopPropagation()}
                          className="h-4 w-4 shrink-0 cursor-pointer rounded border-navy/30 accent-brand-500"
                        />
                      )}
                      {order.urgent && <AlertTriangle className="h-4 w-4 shrink-0 text-danger" />}
                      <span className="truncate font-mono text-xs font-semibold text-ink-900">
                        {order.orderNumber}
                      </span>
                    </div>
                    <span className="shrink-0 font-mono text-sm font-semibold text-ink-900">
                      $
                      {Number(order.total).toLocaleString("en-US", {
                        minimumFractionDigits: 2,
                      })}
                    </span>
                  </div>
                  <p className="truncate text-sm font-medium text-navy">
                    {order.customer?.businessName ?? "—"}
                  </p>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge
                      status={order.status}
                      label={statusLabel(
                        order.status,
                        orderStatusLabel(order.status),
                        order.fulfillPath,
                      )}
                    />
                    {order.fulfillPath === "SHIP" && (
                      <Badge variant="neutral" title="Shipped by supplier/carrier">
                        Shipped
                      </Badge>
                    )}
                    {(order._count?.changeRequests ?? 0) > 0 && (
                      <span
                        title={`${order._count!.changeRequests} pending change request${
                          (order._count!.changeRequests ?? 0) > 1 ? "s" : ""
                        }`}
                        className="inline-flex h-[21px] items-center rounded-full bg-amber-50 px-2 text-[11px] font-semibold text-amber-700 ring-1 ring-amber-200"
                      >
                        {order._count!.changeRequests} change
                        {(order._count!.changeRequests ?? 0) > 1 ? "s" : ""}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center justify-between text-xs text-navy/60">
                    <span>
                      {order.lineItems.length} item{order.lineItems.length === 1 ? "" : "s"}
                    </span>
                    <OrderDateCell order={order} />
                  </div>
                  {/* B823 review (Opus): the desktop table's own Delivery Date column,
                      missing from the card entirely — same formatDateOnly, same em-dash
                      fallback. */}
                  {showDelivery && (
                    <div className="text-xs text-navy/60">
                      Delivery:{" "}
                      {order.requestedDeliveryDate ? (
                        formatDateOnly(order.requestedDeliveryDate)
                      ) : (
                        <span className="text-navy/30">—</span>
                      )}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>

          {/* Table — from md up. Urgent rows get red left border via wrapper trick. */}
          <div className="hidden overflow-hidden rounded-lg border border-surface-border bg-white shadow-card md:block">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-surface-border bg-surface-raised">
                  <tr>
                    {selectMode && <th className="w-10 px-3 py-3" />}
                    <th className="w-4 px-3 py-3" />
                    <th
                      className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-navy/70 cursor-pointer select-none hover:text-navy transition-colors"
                      onClick={() => toggleSort("orderNumber")}
                    >
                      Order # <SortIcon col="orderNumber" />
                    </th>
                    <th
                      className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-navy/70 cursor-pointer select-none hover:text-navy transition-colors"
                      onClick={() => toggleSort("customer")}
                    >
                      Customer <SortIcon col="customer" />
                    </th>
                    <th className="px-4 py-3 text-right text-[11px] font-semibold uppercase tracking-[0.06em] text-navy/70">
                      Items
                    </th>
                    <th
                      className="px-4 py-3 text-right text-[11px] font-semibold uppercase tracking-[0.06em] text-navy/70 cursor-pointer select-none hover:text-navy transition-colors"
                      onClick={() => toggleSort("total")}
                    >
                      Total <SortIcon col="total" />
                    </th>
                    <th
                      className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-navy/70 cursor-pointer select-none hover:text-navy transition-colors"
                      onClick={() => toggleSort("status")}
                    >
                      Status <SortIcon col="status" />
                    </th>
                    {showDelivery && (
                      <th
                        className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-navy/70 cursor-pointer select-none hover:text-navy transition-colors"
                        onClick={() => toggleSort("deliveryDate")}
                      >
                        Delivery Date <SortIcon col="deliveryDate" />
                      </th>
                    )}
                    <th
                      className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-navy/70 cursor-pointer select-none hover:text-navy transition-colors"
                      onClick={() => toggleSort("createdAt")}
                    >
                      Created <SortIcon col="createdAt" />
                    </th>
                    <th className="w-10 px-3 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface-border bg-white">
                  {filtered.map((order) => (
                    <tr
                      key={order.id}
                      role="link"
                      tabIndex={0}
                      onClick={() => {
                        if (selectMode) toggleSelect(order.id);
                        else router.push(`/orders/${order.id}`);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          if (selectMode) toggleSelect(order.id);
                          else router.push(`/orders/${order.id}`);
                        }
                      }}
                      className={cn(
                        "cursor-pointer transition-colors hover:bg-surface-raised focus:outline-none focus:ring-2 focus:ring-inset focus:ring-brand-500",
                        order.urgent && "border-l-2 border-l-danger",
                        selected.has(order.id) && "bg-brand-50",
                      )}
                    >
                      {selectMode && (
                        <td
                          className="px-3 py-3"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleSelect(order.id);
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={selected.has(order.id)}
                            onChange={() => toggleSelect(order.id)}
                            // Without this, a click ON the checkbox toggles twice:
                            // onChange here, then the bubble reaches the td's
                            // onClick — net zero, the box appears dead.
                            onClick={(e) => e.stopPropagation()}
                            className="h-4 w-4 cursor-pointer rounded border-navy/30 accent-brand-500"
                          />
                        </td>
                      )}
                      <td className="px-3 py-3">
                        {order.urgent && <AlertTriangle className="h-4 w-4 text-danger" />}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs font-semibold text-ink-900">
                        {order.orderNumber}
                      </td>
                      <td className="px-4 py-3 font-medium text-navy">
                        {order.customer?.businessName ?? "—"}
                      </td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums text-navy/70">
                        {order.lineItems.length}
                      </td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums font-medium text-ink-900">
                        $
                        {Number(order.total).toLocaleString("en-US", {
                          minimumFractionDigits: 2,
                        })}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1.5">
                          <Badge
                            status={order.status}
                            label={statusLabel(
                              order.status,
                              orderStatusLabel(order.status),
                              order.fulfillPath,
                            )}
                          />
                          {order.fulfillPath === "SHIP" && (
                            <Badge variant="neutral" title="Shipped by supplier/carrier">
                              Shipped
                            </Badge>
                          )}
                          {/* P5-11: pending post-dispatch change requests on this order
                              (filtered _count from the list endpoint; absent = no pill). */}
                          {(order._count?.changeRequests ?? 0) > 0 && (
                            <span
                              title={`${order._count!.changeRequests} pending change request${
                                (order._count!.changeRequests ?? 0) > 1 ? "s" : ""
                              }`}
                              className="inline-flex h-[21px] items-center rounded-full bg-amber-50 px-2 text-[11px] font-semibold text-amber-700 ring-1 ring-amber-200"
                            >
                              {order._count!.changeRequests} change
                              {(order._count!.changeRequests ?? 0) > 1 ? "s" : ""}
                            </span>
                          )}
                        </div>
                      </td>
                      {showDelivery && (
                        <td className="px-4 py-3 text-sm">
                          {order.requestedDeliveryDate ? (
                            <span className="text-navy/70">
                              {formatDateOnly(order.requestedDeliveryDate)}
                            </span>
                          ) : (
                            <span className="text-navy/30">—</span>
                          )}
                        </td>
                      )}
                      <td className="px-4 py-3 text-sm text-navy/70">
                        <OrderDateCell order={order} />
                      </td>
                      <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
                        <button
                          title="View order"
                          aria-label="View order details"
                          onClick={() => router.push(`/orders/${order.id}`)}
                          className="rounded p-1.5 text-navy/70 hover:bg-surface-raised hover:text-navy transition-colors"
                        >
                          <Eye className="h-4 w-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* #2057 review (Opus): the pager lives INSIDE the table's own card at md+ —
                pulling it into a separate shadow card (below) added a visible 20px gap and
                a second card border on desktop too, which the "≥768 unchanged" pass
                criterion forbids. Mobile keeps the separate always-visible card (below)
                since the table itself — and this nested footer — is hidden below md. */}
            {meta && (
              <div className="hidden flex-wrap items-center gap-x-4 gap-y-2 border-t border-surface-border px-4 py-3 text-[12.5px] text-navy/70 md:flex">
                <PagerInfo meta={meta} page={page} limit={limit} customerSearch={customerSearch} />
                <PagerControls
                  meta={meta}
                  page={page}
                  limit={limit}
                  setLimit={setLimit}
                  setPage={setPage}
                />
              </div>
            )}
          </div>
        </>
      )}

      {/* Pager — mobile-only card (see the nested md+ footer above), visible at every
          width regardless of card list vs. table state. data-testid disambiguates it
          from the md+ footer above for e2e — both render the same "Showing X to Y" text,
          one of them always `hidden` at any given viewport. */}
      {meta && (
        <div
          data-testid="pager-mobile"
          className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-surface-border bg-white px-4 py-3 text-[12.5px] text-navy/70 shadow-card md:hidden"
        >
          <PagerInfo meta={meta} page={page} limit={limit} customerSearch={customerSearch} />
          <PagerControls
            meta={meta}
            page={page}
            limit={limit}
            setLimit={setLimit}
            setPage={setPage}
          />
        </div>
      )}

      {/* B823 review (Opus): the top-of-list spacer only helps the FIRST paint — the
          DraftDock sits `absolute` outside <main>'s scroll container, so it stays pinned
          to the same screen band regardless of scroll position. Scrolled all the way
          down, the LAST card and this pager land in that exact band. Bottom clearance,
          matching the top spacer's own size, so the end of the list can clear it too. */}
      {hasDrafts && <div className="h-40 md:hidden" aria-hidden />}

      <CreateOrderModal
        isOpen={isCreateOpen}
        onClose={() => {
          setIsCreateOpen(false);
          setResumeDraftId(null);
          setInitialScanCode(null);
          setInitialFulfillPath(null);
        }}
        resumeDraftId={resumeDraftId}
        initialScanCode={initialScanCode}
        initialFulfillPath={initialFulfillPath}
        onViewOrder={(orderId) => router.push(`/orders/${orderId}`)}
      />

      {/* REG-B2: the bulk bar's Cancel used to fire the cancel for every selected order on the
          first click. Cancelling voids each order's linked invoices, so ask first — fixed copy
          (a per-order impact preview would be N requests; the server still refuses a paid or
          delivered order and that surfaces as the generic failure toast). */}
      <ConfirmDialog
        open={cancelConfirm}
        onClose={() => setCancelConfirm(false)}
        onConfirm={handleBulkCancel}
        loading={isCancelling}
        title={`Cancel ${selected.size} order${selected.size !== 1 ? "s" : ""}?`}
        description="The linked invoices will be voided. Orders that have been paid or delivered can't be cancelled."
        confirmLabel={`Cancel ${selected.size} order${selected.size !== 1 ? "s" : ""}`}
      />
    </div>
  );
}
