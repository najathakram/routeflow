"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  MoreHorizontal,
  ArrowUp,
  ArrowDown,
  Plus,
  Eye,
  Calendar,
  X,
  Loader2,
  ChevronDown,
  ChevronUp,
  ChevronsUpDown,
  Trash2,
  Download,
  Printer,
} from "lucide-react";
import { Button, cn, useToast, EmptyState, Select } from "@routeflow/ui/web";
import { OPEN_INVOICE_STATUS_LIST } from "@/lib/open-invoice-status";
import { ToCollectChip } from "@/components/ToCollectChip";
import { RecordCard, RecordCardList } from "@/components/RecordCard";
import { FiltersDisclosure, activeFilterCount } from "@/components/FiltersDisclosure";
import { usePageTitle } from "@/lib/page-title-context";
import { useUrlFilters } from "@/lib/hooks/useUrlFilters";
import { useUrlSearch } from "@/lib/hooks/useUrlSearch";
import { useUrlPage, useClampPage } from "@/lib/hooks/useUrlPage";
import { downloadCsv, csvDate } from "@/lib/export";
import {
  useInvoices,
  useInvoiceKpiSummary,
  useDeleteInvoice,
  type Invoice,
  type InvoiceStatus,
} from "@/lib/api/invoices";
import { resolveInvoiceListBalance, resolveInvoiceListBalanceTone } from "./invoice-list-balance";
import { usePrintInvoice } from "@/lib/use-print-invoice";
import { apiClient } from "@/lib/api-client";
import { invoiceListStatusParams } from "@/lib/invoice-list-filter";
import { useBookkeepingSummary } from "@/lib/api/bookkeeping";
import { fmt, fmtCalendarDate, calendarDaysUntil } from "@/lib/formatting";
import { useAuth } from "@/lib/auth-context";
import { ReadOnlyHint, WriteButton } from "@/lib/read-only-gate";

/** Add calendar days to a YYYY-MM-DD date, in UTC end to end — mirrors
 *  invoices/new/page.tsx's addDaysIso (local-getter math loses a day across a
 *  DST boundary). */
function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The VIEWER'S current calendar day as YYYY-MM-DD. Deliberately NOT
 * `todayIso()` (which is `toISOString()`, i.e. the UTC day): the operator's
 * "today" is their local day, and both the due-soon chips and the Due Today
 * KPI tile must anchor on the same one — a UTC anchor rolls over hours early
 * for every negative-UTC-offset viewer, so the tile and the chip it triggers
 * would target different dates for part of every day. Mirrors
 * dispatch/page.tsx's todayLocalISO.
 */
function todayLocalIso(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** The invoice's issue date, falling back to when it was created. */
function invoiceDate(inv: Invoice): string {
  return (inv as any).issueDate ?? inv.createdAt;
}

/** The phone "More" menu of the header (same look as the Orders list's): every target is 44 px tall. */
function InvoicesMoreMenu({
  items,
}: {
  items: { label: string; onSelect: () => void; disabled?: boolean }[];
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label="More actions"
          className="inline-flex h-11 w-11 items-center justify-center rounded-ctl border border-line-strong bg-paper text-navy shadow-card transition-colors hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy focus-visible:ring-offset-2 md:hidden"
        >
          <MoreHorizontal className="h-4 w-4" aria-hidden />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="z-50 min-w-[10rem] rounded-lg border border-surface-border bg-white p-1 shadow-dropdown"
        >
          {items.map((item) => (
            <DropdownMenu.Item
              key={item.label}
              disabled={item.disabled}
              onSelect={item.onSelect}
              className="flex min-h-11 cursor-pointer items-center rounded-md px-3 text-sm text-navy outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-surface-raised"
            >
              {item.label}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/**
 * The same "unpaid" status set the API's `isOverdue` filter composes
 * server-side (invoices.service.ts findAll: SENT/VIEWED/PARTIAL/OVERDUE,
 * i.e. everything except DRAFT/PAID/VOID/WRITTEN_OFF). The due-soon chips
 * send this via the API's pre-existing `statuses` (plural) param so a
 * due-window query doesn't surface invoices that are already settled or not
 * yet issued — reusing the existing mechanism rather than inventing a new one.
 */
const UNPAID_STATUSES: string[] = [...OPEN_INVOICE_STATUS_LIST];

type DueChipKey = "today" | "tomorrow" | "7d";

const DUE_CHIPS: { key: DueChipKey; label: string }[] = [
  { key: "today", label: "Due today" },
  { key: "tomorrow", label: "Due tomorrow" },
  { key: "7d", label: "Next 7 days" },
];

// ─── Contextual status display (Zoho-style) ───────────────────────────────────

function renderStatus(status: InvoiceStatus, dueDate?: string | null): React.ReactNode {
  if (status === "PAID") {
    return <span className="text-xs font-semibold text-success">Paid</span>;
  }
  if (status === "VOID") {
    return <span className="text-xs font-semibold text-navy/40">Void</span>;
  }
  if (status === "WRITTEN_OFF") {
    return <span className="text-xs font-semibold text-navy/50">Written off</span>;
  }
  if (status === "DRAFT") {
    return <span className="text-xs font-semibold text-navy/50">Draft</span>;
  }
  if (status === "SENT") {
    return <span className="text-xs font-semibold text-brand-600">Sent</span>;
  }
  if (status === "VIEWED") {
    return <span className="text-xs font-semibold text-brand-700">Viewed</span>;
  }

  // For PARTIAL / OVERDUE — compute days to add context
  const diffDays = calendarDaysUntil(dueDate);
  if (diffDays !== null) {
    if (status === "OVERDUE" || diffDays < 0) {
      const overdueDays = Math.abs(diffDays);
      if (status === "PARTIAL") {
        return (
          <span className="text-xs font-semibold text-danger">
            Partial · Overdue
            {overdueDays > 0 ? ` by ${overdueDays} day${overdueDays !== 1 ? "s" : ""}` : ""}
          </span>
        );
      }
      return (
        <span className="text-xs font-semibold text-danger">
          Overdue{overdueDays > 0 ? ` by ${overdueDays} day${overdueDays !== 1 ? "s" : ""}` : ""}
        </span>
      );
    }

    if (diffDays === 0) {
      if (status === "PARTIAL") {
        return <span className="text-xs font-semibold text-warning">Partial · Due today</span>;
      }
      return <span className="text-xs font-semibold text-warning">Due today</span>;
    }

    if (status === "PARTIAL") {
      return (
        <span className="text-xs font-semibold text-warning">
          Partial · Due in {diffDays} day{diffDays !== 1 ? "s" : ""}
        </span>
      );
    }

    return (
      <span className="text-xs font-semibold text-brand-600">
        Due in {diffDays} day{diffDays !== 1 ? "s" : ""}
      </span>
    );
  }

  // No dueDate fallback
  const labels: Record<string, string> = {
    SENT: "Sent",
    VIEWED: "Viewed",
    PARTIAL: "Partial",
    OVERDUE: "Overdue",
  };
  const colors: Record<string, string> = {
    SENT: "text-brand-600",
    VIEWED: "text-brand-700",
    PARTIAL: "text-warning",
    OVERDUE: "text-danger",
  };
  return (
    <span className={cn("text-xs font-semibold", colors[status] ?? "text-navy/50")}>
      {labels[status] ?? status}
    </span>
  );
}

// ─── Stat tile (Ledger idiom: overline · value · hint) ─────────────────────────

function StatTile({
  label,
  value,
  hint,
  money,
  valueClass,
  active,
  onClick,
  ariaLabel,
}: {
  label: string;
  value: string;
  hint?: string;
  money?: boolean;
  valueClass?: string;
  active?: boolean;
  onClick?: () => void;
  ariaLabel?: string;
}) {
  const content = (
    <>
      <span className="eyebrow-label block">{label}</span>
      <span
        className={cn(
          "mt-0.5 block text-xl text-navy md:mt-1.5 md:text-2xl",
          money ? "money" : "font-semibold tracking-[-0.02em]",
          valueClass,
        )}
      >
        {value}
      </span>
      {hint && <span className="mt-1 block text-xs text-navy/70">{hint}</span>}
    </>
  );

  const base = "rounded-lg border bg-white p-3 text-left shadow-card md:p-4";

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-label={ariaLabel}
        className={cn(
          base,
          "cursor-pointer transition-all hover:bg-surface-raised",
          active ? "border-brand-200 ring-1 ring-inset ring-brand-200" : "border-surface-border",
        )}
      >
        {content}
      </button>
    );
  }

  return <div className={cn(base, "border-surface-border")}>{content}</div>;
}

// ─── Payment Summary (KPI stat tiles) ─────────────────────────────────────────

function PaymentSummaryBar({
  activeFilter,
  onFilter,
  dueTodayActive,
  onDueTodayClick,
}: {
  activeFilter: string;
  onFilter: (status: string) => void;
  dueTodayActive: boolean;
  onDueTodayClick: () => void;
}) {
  // Calendar-date basis: the VIEWER's local calendar day, the same anchor the
  // due-soon chips send to the server (L-047 — never derived from the
  // server's own clock). B12: the six tiles are now computed server-side over
  // the tenant's whole OPEN set — `useInvoices({ limit: 999 })` silently
  // dropped whichever invoices page 1000+ would have held.
  const today = todayLocalIso();
  const { data: summary } = useInvoiceKpiSummary(today);
  const kpis = summary ?? {
    totalOutstanding: 0,
    dueToday: 0,
    dueIn30: 0,
    overdue: 0,
    avgDays: 0,
    awaitingConfirmationCount: 0,
  };

  const items = [
    {
      label: "Total outstanding",
      value: fmt(kpis.totalOutstanding),
      hint: undefined as string | undefined,
      money: true,
      valueClass: undefined as string | undefined,
      active: activeFilter === "SENT",
      onClick: () => onFilter(activeFilter === "SENT" ? "" : "SENT"),
      ariaLabel: undefined as string | undefined,
    },
    {
      label: "Due today",
      value: fmt(kpis.dueToday),
      hint: undefined as string | undefined,
      money: true,
      valueClass: kpis.dueToday > 0 ? "text-orange-500" : undefined,
      active: dueTodayActive,
      onClick: onDueTodayClick,
      ariaLabel: "Filter invoices due today",
    },
    {
      label: "Due within 30 days",
      value: fmt(kpis.dueIn30),
      hint: undefined as string | undefined,
      money: true,
      valueClass: undefined as string | undefined,
      active: false,
      onClick: undefined as (() => void) | undefined,
      ariaLabel: undefined as string | undefined,
    },
    {
      label: "Overdue",
      value: fmt(kpis.overdue),
      hint: undefined as string | undefined,
      money: true,
      valueClass: kpis.overdue > 0 ? "text-red-600" : undefined,
      active: activeFilter === "OVERDUE",
      onClick: () => onFilter(activeFilter === "OVERDUE" ? "" : "OVERDUE"),
      ariaLabel: undefined as string | undefined,
    },
    {
      label: "Avg. days to get paid",
      value: kpis.avgDays > 0 ? `${Math.round(kpis.avgDays)} days` : "—",
      hint: undefined as string | undefined,
      money: false,
      valueClass: undefined as string | undefined,
      active: activeFilter === "PAID",
      onClick: () => onFilter(activeFilter === "PAID" ? "" : "PAID"),
      ariaLabel: undefined as string | undefined,
    },
    {
      // F03/R2 (REG-B11) — count of DRAFT (unconfirmed) payments across all
      // invoices; not an invoice-status filter (DRAFT is a payment-level
      // status here), so this tile is a read-only counter, not a toggle.
      label: "Awaiting confirmation",
      value: String(kpis.awaitingConfirmationCount),
      hint: "Draft payments not yet counted as paid",
      money: false,
      valueClass: kpis.awaitingConfirmationCount > 0 ? "text-warning" : undefined,
      active: false,
      onClick: undefined as (() => void) | undefined,
      ariaLabel: undefined as string | undefined,
    },
  ];

  return (
    <div
      data-kpi-row
      className="flex snap-x gap-3 overflow-x-auto py-1 scrollbar-hide md:grid md:grid-cols-2 md:gap-4 md:overflow-visible lg:grid-cols-6"
    >
      {items.map((item) => (
        <div
          key={item.label}
          data-kpi-cell
          className="flex w-[46%] shrink-0 snap-start flex-col md:w-auto md:shrink [&>*]:flex-1"
        >
          <StatTile
            label={item.label}
            value={item.value}
            hint={item.hint}
            money={item.money}
            valueClass={item.valueClass}
            active={item.active}
            onClick={item.onClick}
            ariaLabel={item.ariaLabel}
          />
        </div>
      ))}
    </div>
  );
}

// ─── Status filter tabs ────────────────────────────────────────────────────────

const STATUS_TABS = [
  { value: "", label: "All" },
  { value: "DRAFT", label: "Draft" },
  { value: "SENT", label: "Sent" },
  { value: "VIEWED", label: "Viewed" },
  { value: "PARTIAL", label: "Partial" },
  { value: "OVERDUE", label: "Overdue" },
  { value: "PAID", label: "Paid" },
  { value: "VOID", label: "Void" },
  { value: "WRITTEN_OFF", label: "Written off" },
];

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function InvoicesPage() {
  const router = useRouter();

  const { setTitle } = usePageTitle();
  const { user } = useAuth();
  const isCustomer = user?.role === "CUSTOMER";
  React.useEffect(() => {
    setTitle("Invoices");
  }, [setTitle]);

  const { toast } = useToast();
  const deleteInvoice = useDeleteInvoice();
  const [confirmDeleteId, setConfirmDeleteId] = React.useState<string | null>(null);
  const printInvoice = usePrintInvoice();
  const [printingIds, setPrintingIds] = React.useState<ReadonlySet<string>>(() => new Set());

  /** The row actions (view, print, delete with its confirm), shared by the table row and the phone card. */
  const renderRowActions = (inv: Invoice, size: "table" | "card" = "table") => {
    // On the phone card every action is a 44px target with 8px between; the table keeps its small buttons.
    const card = size === "card";
    const tap = card ? "grid min-h-[44px] min-w-[44px] place-items-center " : "";
    return (
      <>
        {!isCustomer && confirmDeleteId === inv.id ? (
          <div className={card ? "flex items-center gap-2" : "flex items-center gap-1"}>
            <button
              title="Confirm delete"
              disabled={deleteInvoice.isPending}
              onClick={async () => {
                try {
                  await deleteInvoice.mutateAsync(inv.id);
                  setConfirmDeleteId(null);
                  toast({ title: "Invoice deleted", variant: "success" });
                } catch (err: any) {
                  setConfirmDeleteId(null);
                  toast({
                    title: "Delete failed",
                    description: err?.response?.data?.message ?? err?.message ?? "Unknown error",
                    variant: "error",
                  });
                }
              }}
              className={`${tap}rounded px-2 py-1 text-xs font-semibold text-white bg-danger hover:bg-danger/80 disabled:opacity-50 transition-colors`}
            >
              {deleteInvoice.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Delete"}
            </button>
            <button
              title="Cancel"
              onClick={() => setConfirmDeleteId(null)}
              className={`${tap}rounded p-1 text-navy/70 hover:text-navy transition-colors`}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <div className={card ? "flex items-center gap-2" : "flex items-center gap-0.5"}>
            {/* The phone card is itself the link, so it has no View button. */}
            {!card && (
              <button
                title="View invoice"
                aria-label={`View invoice ${inv.invoiceNumber}`}
                onClick={() => router.push(`/invoices/${inv.id}`)}
                className="rounded p-1.5 text-navy/70 hover:bg-white hover:text-navy transition-colors"
              >
                <Eye className="h-4 w-4" />
              </button>
            )}
            {!isCustomer && (
              <button
                title="Print invoice"
                aria-label={`Print invoice ${inv.invoiceNumber}`}
                disabled={printingIds.has(inv.id)}
                onClick={async () => {
                  if (printingIds.has(inv.id)) return;
                  setPrintingIds((prev) => new Set(prev).add(inv.id));
                  try {
                    // The one shared print path; it never throws and tells the user when it could not. Each row
                    // keeps its own spinner, and concurrent rows print independently (review finding F1).
                    await printInvoice.print(inv.id);
                  } finally {
                    setPrintingIds((prev) => {
                      const next = new Set(prev);
                      next.delete(inv.id);
                      return next;
                    });
                  }
                }}
                className={`${tap}rounded p-1.5 text-navy/70 hover:bg-white hover:text-navy transition-colors disabled:opacity-50`}
              >
                {printingIds.has(inv.id) ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Printer className="h-4 w-4" />
                )}
              </button>
            )}
            {!isCustomer && inv.status === "DRAFT" && (
              <button
                title="Delete invoice"
                aria-label={`Delete invoice ${inv.invoiceNumber}`}
                onClick={() => setConfirmDeleteId(inv.id)}
                className={`${tap}rounded p-1.5 text-navy/70 hover:bg-white hover:text-danger transition-colors`}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            )}
          </div>
        )}
      </>
    );
  };

  const [urlFilters, setFilter, , setFilters] = useUrlFilters({
    status: "",
    dateFrom: "",
    dateTo: "",
    dueFrom: "",
    dueTo: "",
    toCollect: "", // SA-1026: "true" = only invoices that read To collect (staff)
    customerId: "", // the customer chip's link: one customer's list
  });
  const toCollectOn = urlFilters.toCollect === "true";
  const customerFilter = (urlFilters.customerId as string) ?? "";
  const statusFilter = (urlFilters.status as string) ?? "";
  const dateFrom = (urlFilters.dateFrom as string) ?? "";
  const dateTo = (urlFilters.dateTo as string) ?? "";
  const dueFrom = (urlFilters.dueFrom as string) ?? "";
  const dueTo = (urlFilters.dueTo as string) ?? "";

  // Due-soon chip windows, computed fresh each render off the viewer's LOCAL
  // calendar day — the same anchor the Due Today KPI tile uses, so the tile and
  // the chip it applies always target the same date. The server compares these
  // against dueDate, which is stored at UTC midnight, so a bare YYYY-MM-DD
  // (parsed as UTC midnight) lines up with the stored calendar date exactly.
  const todayStr = todayLocalIso();
  const tomorrowStr = addDaysIso(todayStr, 1);
  const in7Str = addDaysIso(todayStr, 7);

  const activeDueChip: DueChipKey | "" =
    !dueFrom && !dueTo
      ? ""
      : dueFrom === todayStr && dueTo === todayStr
        ? "today"
        : dueFrom === tomorrowStr && dueTo === tomorrowStr
          ? "tomorrow"
          : dueFrom === todayStr && dueTo === in7Str
            ? "7d"
            : "";

  function handleDueChipClick(key: DueChipKey) {
    if (activeDueChip === key) {
      setFilters({ dueFrom: "", dueTo: "" });
      return;
    }
    const window =
      key === "today"
        ? { dueFrom: todayStr, dueTo: todayStr }
        : key === "tomorrow"
          ? { dueFrom: tomorrowStr, dueTo: tomorrowStr }
          : { dueFrom: todayStr, dueTo: in7Str };
    setFilters(window);
  }

  // Due-soon chips imply "not yet settled" — when no explicit status tab is
  // picked, compose the SAME unpaid status set the API's isOverdue filter
  // already uses (server-side, invoices.service.ts findAll) via the
  // pre-existing `statuses` (plural) param, so a due window never surfaces
  // DRAFT/PAID/VOID/WRITTEN_OFF invoices. An explicit status tab still wins.
  const dueWindowActive = Boolean(dueFrom || dueTo);
  const composedStatuses = dueWindowActive && !statusFilter ? UNPAID_STATUSES : undefined;
  const [search, setSearch, debouncedSearch] = useUrlSearch();
  const [page, setPage] = useUrlPage();
  const [limit, setLimit] = React.useState(20);
  const [sortBy, setSortBy] = React.useState("issueDate");
  const [sortOrder, setSortOrder] = React.useState<"asc" | "desc">("desc");

  const toggleSort = (col: string) => {
    if (sortBy === col) setSortOrder((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortBy(col);
      setSortOrder("asc");
    }
    setPage(1);
  };

  const SortIcon = ({ col }: { col: string }) => {
    if (sortBy !== col) return <ChevronsUpDown className="h-3 w-3 ml-0.5 text-current/40 inline" />;
    return sortOrder === "asc" ? (
      <ChevronUp className="h-3 w-3 ml-0.5 inline" />
    ) : (
      <ChevronDown className="h-3 w-3 ml-0.5 inline" />
    );
  };

  const { data, isLoading, isError } = useInvoices({
    ...invoiceListStatusParams(statusFilter),
    statuses: composedStatuses,
    search: debouncedSearch || undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
    dueFrom: dueFrom || undefined,
    dueTo: dueTo || undefined,
    toCollect: toCollectOn || undefined,
    customerId: customerFilter || undefined,
    sortBy,
    sortOrder,
    page,
    limit,
  });

  const invoices = data?.data ?? [];
  const meta = data?.meta;
  const totalPages = meta?.totalPages ?? 1;
  useClampPage(setPage, page, meta?.totalPages);

  const [isExporting, setIsExporting] = React.useState(false);

  const handleExport = async () => {
    if (isExporting) return;
    setIsExporting(true);
    try {
      const EXPORT_LIMIT = 1000;
      const res = await apiClient.get("/invoices", {
        params: {
          ...invoiceListStatusParams(statusFilter),
          statuses: composedStatuses,
          search: debouncedSearch || undefined,
          dateFrom: dateFrom || undefined,
          dateTo: dateTo || undefined,
          dueFrom: dueFrom || undefined,
          dueTo: dueTo || undefined,
          toCollect: toCollectOn || undefined,
          customerId: customerFilter || undefined,
          sortBy,
          sortOrder,
          page: 1,
          limit: EXPORT_LIMIT,
        },
      });
      const payload = res.data as { data: Invoice[]; meta?: { total?: number } };
      const rows = payload.data ?? [];
      downloadCsv(
        `invoices-${new Date().toISOString().split("T")[0]}.csv`,
        ["Invoice #", "Customer", "Issue Date", "Due Date", "Total", "Balance Due", "Status"],
        rows.map((inv) => [
          inv.invoiceNumber,
          inv.customer?.businessName ?? "",
          csvDate(inv.issueDate),
          csvDate(inv.dueDate),
          Number(inv.total ?? 0).toFixed(2),
          Number(inv.balanceDue ?? 0).toFixed(2),
          inv.status,
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
      toast({ title: "Export failed", description: (err as Error).message, variant: "error" });
    } finally {
      setIsExporting(false);
    }
  };

  // No setPage(1) here (nor beside any other setFilter/setSearch call on this
  // page): both useUrlFilters.setFilter and useUrlSearch already delete the
  // `page` param on every write. A second write from setPage would rebuild the
  // query from window.location.search BEFORE the router applied the filter
  // write, replacing the URL with the pre-filter one — silently reverting the
  // status/date the operator just picked.
  function handleFilterChange(status: string) {
    setFilter("status", status);
  }

  return (
    <div className="space-y-5 p-6">
      {/* Header: below md the title and New invoice share one row, the description is hidden and
          Export / Payments Received / Recurring live in a More menu; from md up it is the full
          header with plain buttons. Same layout as PageHeader. */}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="shrink">
          <h2 className="whitespace-nowrap text-2xl font-bold text-navy">Invoices</h2>
          <p className="mt-1 hidden text-sm text-navy/70 md:block">
            Track receivables — what&apos;s outstanding, due soon, and overdue across your
            customers.
          </p>
        </div>
        {!isCustomer && (
          <div className="max-w-full shrink-0">
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
                title="Export filtered invoices as CSV"
                className="hidden md:inline-flex"
              >
                {isExporting ? "Exporting…" : "Export"}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => router.push("/invoices/payments")}
                className="hidden md:inline-flex"
              >
                Payments Received
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => router.push("/invoices/recurring")}
                className="hidden md:inline-flex"
              >
                Recurring
              </Button>
              <InvoicesMoreMenu
                items={[
                  {
                    label: isExporting ? "Exporting…" : "Export",
                    onSelect: handleExport,
                    disabled: isExporting,
                  },
                  { label: "Payments Received", onSelect: () => router.push("/invoices/payments") },
                  { label: "Recurring", onSelect: () => router.push("/invoices/recurring") },
                ]}
              />
              <WriteButton
                size="sm"
                className="min-h-[44px] md:min-h-0"
                leftIcon={<Plus className="h-4 w-4" />}
                onClick={() => router.push("/invoices/new")}
              >
                New invoice
              </WriteButton>
              <ReadOnlyHint className="basis-full text-right text-xs text-slate-600" />
            </div>
          </div>
        )}
      </div>

      {/* Payment Summary — KPI stat tiles */}
      <PaymentSummaryBar
        activeFilter={statusFilter}
        onFilter={handleFilterChange}
        dueTodayActive={activeDueChip === "today"}
        onDueTodayClick={() => handleDueChipClick("today")}
      />

      {/* Status filter tabs */}
      <div className="flex snap-x items-center gap-1 overflow-x-auto border-b border-surface-border scrollbar-hide">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.value}
            onClick={() => handleFilterChange(tab.value)}
            className={cn(
              "-mb-px inline-flex min-h-[44px] shrink-0 snap-start items-center whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors",
              statusFilter === tab.value
                ? "border-brand-500 text-brand-500"
                : "border-transparent text-navy/70 hover:text-navy",
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Due-soon chips */}
      <div className="flex snap-x items-center gap-2 overflow-x-auto py-1 scrollbar-hide">
        {!isCustomer && (
          <button
            type="button"
            aria-pressed={toCollectOn}
            onClick={() => setFilter("toCollect", toCollectOn ? "" : "true")}
            className={cn(
              "min-h-[44px] shrink-0 snap-start rounded-full border px-3 py-1.5 text-sm font-medium transition-colors",
              toCollectOn
                ? "border-brand-500 bg-brand-500 text-white"
                : "border-surface-border bg-white text-navy hover:bg-surface-raised",
            )}
          >
            To collect
          </button>
        )}
        <span className="shrink-0 text-xs font-medium uppercase tracking-wider text-navy/70">
          Due:
        </span>
        {DUE_CHIPS.map((chip) => (
          <button
            key={chip.key}
            type="button"
            onClick={() => handleDueChipClick(chip.key)}
            className={cn(
              "min-h-[44px] shrink-0 snap-start whitespace-nowrap rounded-full border px-3 py-1.5 text-sm font-medium transition-colors md:min-h-0",
              activeDueChip === chip.key
                ? "border-brand-500 bg-brand-500 text-white"
                : "border-surface-border bg-white text-navy hover:bg-surface-raised",
            )}
          >
            {chip.label}
          </button>
        ))}
      </div>

      {/* Search is always visible. Below md the date fields open from a "Filters (n)" button that
          shares a row with the sort control; from md up everything is inline as before. */}
      <div className="flex flex-col gap-2 md:flex-row md:flex-wrap md:items-start">
        <input
          type="search"
          placeholder="Search by invoice # or customer…"
          aria-label="Search invoices"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-11 w-full rounded border border-surface-border bg-white px-3 text-sm text-navy placeholder:text-navy/70 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500 md:h-9 md:w-56"
        />
        <FiltersDisclosure
          count={activeFilterCount({ dateFrom, dateTo })}
          toolbar={
            !isLoading && !isError && invoices.length > 0 ? (
              <div className="flex min-w-0 flex-1 items-center gap-1.5 md:hidden">
                <div className="min-w-0 flex-1">
                  <Select
                    aria-label="Sort invoices by"
                    options={[
                      { value: "issueDate", label: "Date" },
                      { value: "invoiceNumber", label: "Invoice #" },
                      { value: "status", label: "Status" },
                      { value: "dueDate", label: "Due Date" },
                      { value: "total", label: "Total" },
                    ]}
                    value={sortBy}
                    onChange={(e) => {
                      if (e.target.value !== sortBy) toggleSort(e.target.value);
                    }}
                    className="h-11"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => toggleSort(sortBy)}
                  aria-label={sortOrder === "asc" ? "Sort descending" : "Sort ascending"}
                  className="grid h-11 w-11 shrink-0 place-items-center rounded-ctl border border-surface-border bg-white text-navy hover:bg-surface-raised"
                >
                  {sortOrder === "asc" ? (
                    <ArrowUp className="h-4 w-4" />
                  ) : (
                    <ArrowDown className="h-4 w-4" />
                  )}
                </button>
              </div>
            ) : undefined
          }
        >
          <div className="flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center">
            <div className="flex flex-col gap-2 md:flex-row md:items-center md:gap-1.5">
              <Calendar className="hidden h-4 w-4 text-navy/70 md:block" />
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setFilter("dateFrom", e.target.value)}
                max={dateTo || undefined}
                className="h-11 w-full rounded border border-surface-border bg-white px-2 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500 md:h-9 md:w-32"
                title="Issue date from"
              />
              <span className="hidden text-navy/70 md:inline">–</span>
              <input
                type="date"
                value={dateTo}
                min={dateFrom || undefined}
                onChange={(e) => setFilter("dateTo", e.target.value)}
                className="h-11 w-full rounded border border-surface-border bg-white px-2 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500 md:h-9 md:w-32"
                title="Issue date to"
              />
              {(dateFrom || dateTo) && (
                <button
                  onClick={() => setFilters({ dateFrom: "", dateTo: "" })}
                  className="grid min-h-[44px] place-items-center rounded p-1 text-navy/70 transition-colors hover:text-danger md:min-h-0"
                  title="Clear dates"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>
        </FiltersDisclosure>
      </div>

      {/* Phone cards — below md; the table below takes over from md up. Same balance helper and
          the same row actions as the table. While loading, on error or when empty, the table's own
          state rows show at every width. */}
      {!isLoading && !isError && invoices.length > 0 && (
        <RecordCardList>
          {invoices.map((inv: Invoice) => (
            <RecordCard
              key={inv.id}
              href={`/invoices/${inv.id}`}
              title={inv.invoiceNumber}
              amountLabel="Balance Due"
              amount={fmt(resolveInvoiceListBalance(inv))}
              amountTone={resolveInvoiceListBalanceTone(inv)}
              subtitle={inv.customer?.businessName ?? "—"}
              badges={
                <>
                  {renderStatus(inv.status, inv.dueDate)}
                  {!isCustomer && <ToCollectChip state={inv.toCollect} />}
                </>
              }
              meta={
                <span className="flex flex-wrap gap-x-2 gap-y-0.5">
                  <span>{fmtCalendarDate(invoiceDate(inv))}</span>
                  <span>Due {fmtCalendarDate(inv.dueDate)}</span>
                  <span>Total {fmt(Number(inv.total))}</span>
                </span>
              }
              actions={renderRowActions(inv, "card")}
            />
          ))}
        </RecordCardList>
      )}

      {/* Table — B750: the bare table clipped (overflow-hidden) instead of scrolling at 390px;
          an inner overflow-x-auto lets it scroll horizontally while the outer div keeps the
          rounded-corner clip, same pattern as the orders list table. */}
      <div
        className={cn(
          "overflow-hidden rounded-lg border border-surface-border bg-white",
          !isLoading && !isError && invoices.length > 0 && "hidden md:block",
        )}
      >
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-surface-border bg-gray-50">
              <tr>
                <th
                  className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-navy/70 cursor-pointer select-none hover:text-navy transition-colors"
                  onClick={() => toggleSort("issueDate")}
                >
                  Date <SortIcon col="issueDate" />
                </th>
                <th
                  className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-navy/70 cursor-pointer select-none hover:text-navy transition-colors"
                  onClick={() => toggleSort("invoiceNumber")}
                >
                  Invoice # <SortIcon col="invoiceNumber" />
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-navy/70">
                  Customer
                </th>
                <th
                  className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-navy/70 cursor-pointer select-none hover:text-navy transition-colors"
                  onClick={() => toggleSort("status")}
                >
                  Status <SortIcon col="status" />
                </th>
                <th
                  className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-navy/70 cursor-pointer select-none hover:text-navy transition-colors"
                  onClick={() => toggleSort("dueDate")}
                >
                  Due Date <SortIcon col="dueDate" />
                </th>
                <th
                  className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-navy/70 cursor-pointer select-none hover:text-navy transition-colors"
                  onClick={() => toggleSort("total")}
                >
                  Amount <SortIcon col="total" />
                </th>
                <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-navy/70">
                  Balance Due
                </th>
                <th className="w-20 px-3 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-border bg-white">
              {isLoading ? (
                <tr>
                  <td colSpan={8} className="px-4 py-12 text-center">
                    <Loader2 className="mx-auto h-6 w-6 animate-spin text-navy/70" />
                  </td>
                </tr>
              ) : isError ? (
                <tr>
                  <td colSpan={8} className="px-4 py-12 text-center text-sm text-danger">
                    Failed to load invoices. Please try again.
                  </td>
                </tr>
              ) : invoices.length === 0 ? (
                <tr>
                  <td colSpan={8} className="p-0">
                    {search ||
                    statusFilter ||
                    dateFrom ||
                    dateTo ||
                    dueFrom ||
                    dueTo ||
                    toCollectOn ||
                    customerFilter ? (
                      <EmptyState
                        variant="invoices"
                        title="No matching invoices"
                        description="No invoices match your current search and filters."
                        action={
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => {
                              setSearch("");
                              setFilters({
                                status: "",
                                dateFrom: "",
                                dateTo: "",
                                dueFrom: "",
                                dueTo: "",
                                toCollect: "",
                                customerId: "",
                              });
                            }}
                          >
                            Clear filters
                          </Button>
                        }
                      />
                    ) : (
                      <EmptyState
                        variant="invoices"
                        title="No invoices yet"
                        description="Create an invoice to bill a customer and start tracking receivables."
                        action={
                          !isCustomer ? (
                            <WriteButton size="sm" onClick={() => router.push("/invoices/new")}>
                              New invoice
                            </WriteButton>
                          ) : undefined
                        }
                      />
                    )}
                  </td>
                </tr>
              ) : (
                invoices.map((inv: Invoice) => {
                  const balance = resolveInvoiceListBalance(inv);
                  return (
                    <tr
                      key={inv.id}
                      onClick={() => router.push(`/invoices/${inv.id}`)}
                      className="group cursor-pointer transition-colors hover:bg-blue-50/40"
                    >
                      <td className="px-4 py-3 text-sm text-navy">
                        {fmtCalendarDate(invoiceDate(inv))}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-col gap-0.5">
                          <span className="font-mono text-xs font-semibold text-brand-500">
                            {inv.invoiceNumber}
                          </span>
                          <span
                            className={cn(
                              "inline-flex w-fit items-center rounded-full px-1.5 py-px text-[10px] font-medium leading-tight",
                              (inv as any).orderId
                                ? "bg-brand-50 text-brand-600"
                                : "bg-surface-raised text-navy/70",
                            )}
                          >
                            {(inv as any).orderId ? "From Order" : "Manual"}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3 font-medium text-navy">
                        {inv.customer?.businessName ?? "—"}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-col items-start gap-1">
                          {renderStatus(inv.status, inv.dueDate)}
                          {!isCustomer && <ToCollectChip state={inv.toCollect} />}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-sm text-navy">
                        {fmtCalendarDate(inv.dueDate)}
                      </td>
                      <td className="px-4 py-3 text-right text-sm font-medium text-navy">
                        {fmt(Number(inv.total))}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span
                          className={cn(
                            "text-sm font-semibold",
                            resolveInvoiceListBalanceTone(inv) === "danger"
                              ? "text-danger"
                              : "text-navy",
                          )}
                        >
                          {fmt(balance)}
                        </span>
                      </td>
                      <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
                        {renderRowActions(inv)}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pagination */}
      {meta && (
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <p className="text-sm text-navy/70">
              {meta.total > 0
                ? `Showing ${(page - 1) * limit + 1}–${Math.min(page * limit, meta.total)} of ${meta.total} invoices`
                : "No invoices found"}
            </p>
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-navy/70">Per page:</span>
              <select
                value={limit}
                onChange={(e) => {
                  setLimit(Number(e.target.value));
                  setPage(1);
                }}
                className="h-8 rounded border border-surface-border bg-white px-2 text-xs text-navy focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              >
                {[10, 20, 50, 100].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {meta.totalPages > 1 && (
            <div className="flex items-center gap-1">
              <button
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
                className="rounded border border-surface-border bg-white px-3 py-1.5 text-sm font-medium text-navy hover:bg-surface-raised disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Previous
              </button>
              {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
                const p = totalPages <= 7 ? i + 1 : page <= 4 ? i + 1 : page + i - 3;
                if (p < 1 || p > totalPages) return null;
                return (
                  <button
                    key={p}
                    onClick={() => setPage(p)}
                    className={cn(
                      "rounded border px-3 py-1.5 text-sm font-medium transition-colors",
                      p === page
                        ? "border-brand-500 bg-brand-500 text-white"
                        : "border-surface-border bg-white text-navy hover:bg-surface-raised",
                    )}
                  >
                    {p}
                  </button>
                );
              })}
              <button
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
                className="rounded border border-surface-border bg-white px-3 py-1.5 text-sm font-medium text-navy hover:bg-surface-raised disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Next
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
