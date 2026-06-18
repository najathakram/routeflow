"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import {
  Pencil,
  ToggleLeft,
  ToggleRight,
  Eye,
  CheckSquare,
  X,
  Trash2,
  Download,
  Upload,
  ArrowUpDown,
  Merge,
  AlertCircle,
  UserCheck,
  ChevronDown,
  ChevronUp,
  ExternalLink,
} from "lucide-react";
import {
  PageHeader,
  Table,
  Badge,
  Button,
  Select,
  Modal,
  cn,
  EmptyState,
  type BadgeStatus,
} from "@routeflow/ui/web";
import { useToast } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { CustomerFormModal } from "./_components/CustomerFormModal";
import {
  useCustomers,
  useUpdateCustomerStatus,
  useDeleteCustomer,
  useBatchDeleteCustomers,
  useCustomerTags,
  useExportCustomers,
  useMergeCustomers,
  usePendingPortalApprovals,
  useApprovePortalFromList,
} from "@/lib/api/customers";
import { apiClient } from "@/lib/api-client";
import { useCustomerRouteAssignments } from "@/lib/api/routes";
import { useDebounce } from "@/lib/hooks/useDebounce";
import { fmt } from "@/lib/formatting";

// ─── Local type ───────────────────────────────────────────────────────────────

interface Customer {
  id: string;
  businessName: string;
  contactName: string;
  phone?: string;
  email?: string;
  customerType?: string;
  receivables?: number;
  unusedCredits?: number;
  tagAssignments?: Array<{ tag: { id: string; name: string; color: string } }>;
  user: { id: string; email: string; username: string; status: string };
  addresses: any[];
}

// ─── Import Modal ─────────────────────────────────────────────────────────────

function ImportCustomersModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { toast } = useToast();
  const [file, setFile] = React.useState<File | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [result, setResult] = React.useState<{
    created: number;
    updated: number;
    skipped: number;
    errors: string[];
  } | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (f && f.name.endsWith(".csv")) {
      setFile(f);
      setResult(null);
    }
  };

  const handleImport = async () => {
    if (!file) return;
    setLoading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await apiClient.post("/import/contacts", formData, {
        headers: { "Content-Type": "multipart/form-data" },
        timeout: 300_000,
      });
      setResult(res.data);
      toast({
        title: "Customers imported",
        description: `${res.data.created} created, ${res.data.updated} updated, ${res.data.skipped} skipped`,
        variant: "success",
      });
      onDone();
    } catch (err: any) {
      toast({
        title: "Import failed",
        description: err?.response?.data?.message ?? "Please check your file format and try again",
        variant: "error",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-xl bg-white shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-surface-border px-6 py-4">
          <h2 className="text-base font-semibold text-navy">Import Customers</h2>
          <button
            onClick={onClose}
            className="rounded p-1 text-navy/70 hover:text-navy transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 px-6 py-5">
          {/* How-to hint */}
          <div className="flex items-start gap-2 rounded-lg bg-surface-raised px-3 py-2.5 text-xs text-navy/70">
            <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0 text-navy/70" />
            <span>
              <strong className="text-navy/70">How to export from Zoho:</strong> Zoho Invoices →
              Contacts → ⋮ → Export Contacts (CSV)
            </span>
          </div>

          {/* Drop zone */}
          <div
            onDrop={handleDrop}
            onDragOver={(e) => e.preventDefault()}
            onClick={() => inputRef.current?.click()}
            className={cn(
              "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-8 transition-colors",
              file
                ? "border-brand-300 bg-brand-50"
                : "border-surface-border hover:border-brand-300 hover:bg-brand-50/30",
            )}
          >
            <input
              ref={inputRef}
              type="file"
              accept=".csv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) {
                  setFile(f);
                  setResult(null);
                }
              }}
            />
            <Upload className={cn("h-6 w-6", file ? "text-brand-500" : "text-navy/30")} />
            {file ? (
              <div className="text-center">
                <p className="text-sm font-medium text-brand-600">{file.name}</p>
                <p className="text-xs text-navy/70">
                  {(file.size / 1024).toFixed(1)} KB · Click to change
                </p>
              </div>
            ) : (
              <div className="text-center">
                <p className="text-sm text-navy/70">
                  Drop CSV file here or <span className="text-brand-500">browse</span>
                </p>
                <p className="text-xs text-navy/70 mt-0.5">Zoho Contacts CSV format</p>
              </div>
            )}
          </div>

          {/* Result */}
          {result && (
            <div className="rounded-lg border border-success/30 bg-success-bg/50 px-3 py-2.5 text-sm">
              <p className="font-medium text-success">Import complete</p>
              <p className="text-xs text-navy/70 mt-0.5">
                {result.created} created · {result.updated} updated · {result.skipped} skipped
                {result.errors.length > 0 &&
                  ` · ${result.errors.length} error${result.errors.length !== 1 ? "s" : ""}`}
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 border-t border-surface-border px-6 py-4">
          <button
            onClick={onClose}
            className="rounded-lg border border-surface-border px-4 py-2 text-sm text-navy hover:bg-surface-raised transition-colors"
          >
            {result ? "Close" : "Cancel"}
          </button>
          <button
            onClick={handleImport}
            disabled={!file || loading}
            className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-40 transition-colors"
          >
            {loading ? (
              <span className="flex items-center gap-2">
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white border-t-transparent" />
                Importing…
              </span>
            ) : (
              "Import Customers"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function CustomersPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { setTitle } = usePageTitle();

  React.useEffect(() => {
    setTitle("Customers");
  }, [setTitle]);

  // ── Local state ──────────────────────────────────────────────────────────
  const [search, setSearch] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState<string>(searchParams.get("status") ?? "");
  const [typeFilter, setTypeFilter] = React.useState("");
  const [tagFilter, setTagFilter] = React.useState("");
  const [unassignedOnly, setUnassignedOnly] = React.useState(false);
  const [isAddOpen, setIsAddOpen] = React.useState(false);
  const [isImportOpen, setIsImportOpen] = React.useState(false);
  const [editingCustomer, setEditingCustomer] = React.useState<any>(null);
  const [selectMode, setSelectMode] = React.useState(false);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [isDeleting, setIsDeleting] = React.useState(false);
  const [deactivatingCustomer, setDeactivatingCustomer] = React.useState<{
    id: string;
    name: string;
  } | null>(null);
  const [page, setPage] = React.useState(1);
  const [limit, setLimit] = React.useState(20);
  const [sortBy, setSortBy] = React.useState("");
  const [sortDir, setSortDir] = React.useState<"asc" | "desc">("asc");
  const { toast } = useToast();

  // Sync status filter to URL
  React.useEffect(() => {
    const url = statusFilter
      ? `/customers?status=${encodeURIComponent(statusFilter)}`
      : "/customers";
    router.replace(url, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter]);

  // Debounce search to avoid firing API on every keystroke
  const debouncedSearch = useDebounce(search, 300);

  // Reset page when filters change
  React.useEffect(() => {
    setPage(1);
  }, [debouncedSearch, statusFilter, typeFilter, tagFilter]);

  // ── API data ─────────────────────────────────────────────────────────────
  const {
    data: result,
    isLoading,
    isError,
    refetch,
  } = useCustomers({
    search: debouncedSearch || undefined,
    status: statusFilter || undefined,
    page,
    limit,
    tag: tagFilter || undefined,
    customerType: typeFilter || undefined,
    sortBy: sortBy || undefined,
    sortDir: sortBy ? sortDir : undefined,
  });
  const customers: Customer[] = result?.data ?? [];
  const meta = result?.meta;

  const { data: assignments } = useCustomerRouteAssignments();
  const { data: tags } = useCustomerTags();
  const exportCustomers = useExportCustomers();
  const mergeCustomers = useMergeCustomers();

  const updateStatus = useUpdateCustomerStatus();
  const deleteCustomer = useDeleteCustomer();
  const batchDelete = useBatchDeleteCustomers();

  // ── Pending portal approvals ──────────────────────────────────────────────
  const { data: pendingApprovals = [] } = usePendingPortalApprovals();
  const approveFromList = useApprovePortalFromList();
  const [approvalsExpanded, setApprovalsExpanded] = React.useState(true);

  // ── Filter: unassigned only ───────────────────────────────────────────────
  const visibleCustomers = React.useMemo(() => {
    if (!unassignedOnly) return customers;
    return customers.filter((c) => !assignments?.[c.id]?.length);
  }, [customers, assignments, unassignedOnly]);

  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const exitSelectMode = () => {
    setSelectMode(false);
    setSelected(new Set());
  };

  const handleBulkDelete = async () => {
    if (isDeleting || selected.size === 0) return;
    setIsDeleting(true);
    try {
      const res = await batchDelete.mutateAsync(Array.from(selected));
      if (res.failed.length === 0) {
        toast({
          title: `${res.deleted} customer${res.deleted !== 1 ? "s" : ""} deleted`,
          variant: "success",
        });
      } else {
        toast({
          title: `Deleted ${res.deleted}, failed ${res.failed.length}`,
          variant: res.deleted > 0 ? "success" : "error",
        });
      }
      exitSelectMode();
    } catch {
      toast({ title: "Failed to delete customers", variant: "error" });
    } finally {
      setIsDeleting(false);
    }
  };

  const handleMerge = async () => {
    if (selected.size !== 2) return;
    const [primaryId, secondaryId] = Array.from(selected);
    try {
      await mergeCustomers.mutateAsync({ primaryId, secondaryId });
      toast({ title: "Customers merged successfully", variant: "success" });
      exitSelectMode();
    } catch {
      toast({ title: "Failed to merge customers", variant: "error" });
    }
  };

  // ── Sorting ──────────────────────────────────────────────────────────────
  const handleSort = (col: string) => {
    if (sortBy === col) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(col);
      setSortDir("asc");
    }
  };

  const SortHeader = ({ col, children }: { col: string; children: React.ReactNode }) => (
    <button onClick={() => handleSort(col)} className="flex items-center gap-1 group">
      {children}
      <ArrowUpDown
        className={cn(
          "h-3 w-3 transition-colors",
          sortBy === col ? "text-white" : "text-white/40 group-hover:text-white/70",
        )}
      />
    </button>
  );

  // ── Status toggle ────────────────────────────────────────────────────────
  const toggleStatus = React.useCallback(
    (id: string, currentStatus: string, businessName: string) => {
      if (currentStatus === "ACTIVE") {
        // Deactivating requires confirmation
        setDeactivatingCustomer({ id, name: businessName });
      } else {
        // Reactivating is safe — no confirmation needed
        updateStatus.mutate({ id, status: "ACTIVE" });
      }
    },
    [updateStatus],
  );

  // ── Column definitions ───────────────────────────────────────────────────
  const allVisible = visibleCustomers;
  const allVisibleIds = allVisible.map((c) => c.id);
  const allChecked = allVisibleIds.length > 0 && allVisibleIds.every((id) => selected.has(id));
  const someChecked = allVisibleIds.some((id) => selected.has(id));

  const columns = React.useMemo<ColumnDef<Customer, unknown>[]>(
    () => [
      ...(selectMode
        ? [
            {
              id: "select",
              header: () => (
                <input
                  type="checkbox"
                  checked={allChecked}
                  ref={(el) => {
                    if (el) el.indeterminate = someChecked && !allChecked;
                  }}
                  onChange={() => {
                    if (allChecked) setSelected(new Set());
                    else setSelected(new Set(allVisibleIds));
                  }}
                  className="h-4 w-4 cursor-pointer rounded border-navy/30 accent-brand-500"
                />
              ),
              cell: ({ row }: { row: { original: Customer } }) => (
                <input
                  type="checkbox"
                  checked={selected.has(row.original.id)}
                  onChange={() => toggleSelect(row.original.id)}
                  onClick={(e) => e.stopPropagation()}
                  className="h-4 w-4 cursor-pointer rounded border-navy/30 accent-brand-500"
                />
              ),
              enableSorting: false,
              size: 40,
            } as ColumnDef<Customer, unknown>,
          ]
        : []),
      {
        accessorKey: "contactName",
        header: () => <SortHeader col="contactName">Name</SortHeader>,
        cell: ({ row }) => (
          <span className="font-medium text-navy">{row.original.contactName}</span>
        ),
      },
      {
        accessorKey: "businessName",
        header: () => <SortHeader col="businessName">Business Name</SortHeader>,
        cell: ({ row }) => <span className="text-navy/80">{row.original.businessName}</span>,
      },
      {
        accessorKey: "email",
        header: "Email",
        enableSorting: false,
        cell: ({ row }) => (
          <span className="text-navy/70 text-xs">
            {row.original.email ??
              (row.original.user?.email && !row.original.user.email.endsWith("@imported.local")
                ? row.original.user.email
                : "—")}
          </span>
        ),
      },
      {
        accessorKey: "phone",
        header: "Phone",
        enableSorting: false,
        cell: ({ row }) => <span className="text-navy/70">{row.original.phone ?? "—"}</span>,
      },
      {
        id: "receivables",
        header: () => <SortHeader col="receivables">Receivables</SortHeader>,
        cell: ({ row }) => {
          const val = row.original.receivables ?? 0;
          return (
            <span
              className={cn("text-right font-medium", val > 0 ? "text-danger" : "text-navy/70")}
            >
              {val > 0 ? fmt(val) : "—"}
            </span>
          );
        },
      },
      {
        id: "credits",
        header: "Credits",
        enableSorting: false,
        cell: ({ row }) => {
          const val = row.original.unusedCredits ?? 0;
          return (
            <span
              className={cn("text-right font-medium", val > 0 ? "text-success" : "text-navy/70")}
            >
              {val > 0 ? fmt(val) : "—"}
            </span>
          );
        },
      },
      {
        id: "tags",
        header: "Tags",
        enableSorting: false,
        cell: ({ row }) => {
          const tagList = row.original.tagAssignments ?? [];
          if (!tagList.length) return <span className="text-navy/30 text-xs">—</span>;
          return (
            <div className="flex flex-wrap gap-1">
              {tagList.slice(0, 2).map((ta) => (
                <span
                  key={ta.tag.id}
                  className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium text-white"
                  style={{ backgroundColor: ta.tag.color }}
                >
                  {ta.tag.name}
                </span>
              ))}
              {tagList.length > 2 && (
                <span className="text-xs text-navy/70">+{tagList.length - 2}</span>
              )}
            </div>
          );
        },
      },
      {
        id: "status",
        header: "Status",
        accessorFn: (row) => row.user?.status ?? "ACTIVE",
        cell: ({ row }) => (
          <Badge status={(row.original.user?.status ?? "ACTIVE") as BadgeStatus} />
        ),
      },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        cell: ({ row }) => {
          const status = row.original.user?.status ?? "ACTIVE";
          return (
            <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
              <button
                title="Edit customer"
                aria-label="Edit customer"
                onClick={() => setEditingCustomer(row.original)}
                className="rounded p-1.5 text-navy/70 hover:bg-surface-raised hover:text-navy transition-colors"
              >
                <Pencil className="h-4 w-4" />
              </button>
              <button
                title={status === "ACTIVE" ? "Deactivate" : "Activate"}
                aria-label={status === "ACTIVE" ? "Deactivate customer" : "Activate customer"}
                onClick={() => toggleStatus(row.original.id, status, row.original.businessName)}
                className={cn(
                  "rounded p-1.5 transition-colors",
                  status === "ACTIVE"
                    ? "text-success hover:bg-success-bg"
                    : "text-navy/30 hover:bg-surface-raised hover:text-navy",
                )}
              >
                {status === "ACTIVE" ? (
                  <ToggleRight className="h-4 w-4" />
                ) : (
                  <ToggleLeft className="h-4 w-4" />
                )}
              </button>
              <button
                title="View customer"
                aria-label="View customer"
                onClick={() => router.push(`/customers/${row.original.id}`)}
                className="rounded p-1.5 text-navy/70 hover:bg-surface-raised hover:text-navy transition-colors"
              >
                <Eye className="h-4 w-4" />
              </button>
            </div>
          );
        },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      router,
      toggleStatus,
      assignments,
      selectMode,
      selected,
      allChecked,
      someChecked,
      sortBy,
      sortDir,
    ],
  );

  return (
    <div className="space-y-5 p-6">
      <PageHeader
        title="Customers"
        action={
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              leftIcon={<Upload className="h-4 w-4" />}
              onClick={() => setIsImportOpen(true)}
            >
              Import
            </Button>
            <Button
              variant="secondary"
              leftIcon={<Download className="h-4 w-4" />}
              onClick={() => exportCustomers.mutate({})}
              loading={exportCustomers.isPending}
            >
              Export
            </Button>
            <Button
              variant="secondary"
              leftIcon={
                selectMode ? <X className="h-4 w-4" /> : <CheckSquare className="h-4 w-4" />
              }
              onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
            >
              {selectMode ? "Cancel" : "Select"}
            </Button>
            <Button onClick={() => setIsAddOpen(true)}>Add Customer</Button>
          </div>
        }
      />

      {/* Selection action bar */}
      {selectMode && selected.size > 0 && (
        <div className="flex items-center justify-between rounded-lg border border-danger/30 bg-danger-bg px-4 py-3">
          <span className="text-sm font-medium text-navy">
            {selected.size} customer{selected.size !== 1 ? "s" : ""} selected
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setSelected(new Set())}
              className="text-sm text-navy/70 hover:text-navy transition-colors"
            >
              Deselect all
            </button>
            {selected.size === 2 && (
              <Button
                variant="secondary"
                leftIcon={<Merge className="h-4 w-4" />}
                onClick={handleMerge}
                loading={mergeCustomers.isPending}
              >
                Merge
              </Button>
            )}
            <Button
              variant="danger"
              leftIcon={<Trash2 className="h-4 w-4" />}
              loading={isDeleting}
              onClick={handleBulkDelete}
            >
              Delete {selected.size}
            </Button>
          </div>
        </div>
      )}

      {/* Pending portal connection approvals */}
      {pendingApprovals.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 overflow-hidden">
          {/* Header */}
          <button
            onClick={() => setApprovalsExpanded((v) => !v)}
            className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-amber-100/60 transition-colors"
          >
            <div className="flex items-center gap-2.5">
              <div className="flex h-6 w-6 items-center justify-center rounded-full bg-amber-500 text-white text-xs font-bold shrink-0">
                {pendingApprovals.length}
              </div>
              <span className="text-sm font-semibold text-amber-900">
                Pending Buyer Portal {pendingApprovals.length === 1 ? "Connection" : "Connections"}
              </span>
              <span className="text-xs text-amber-700">
                — review and approve buyers requesting access to their accounts
              </span>
            </div>
            {approvalsExpanded ? (
              <ChevronUp className="h-4 w-4 text-amber-600 shrink-0" />
            ) : (
              <ChevronDown className="h-4 w-4 text-amber-600 shrink-0" />
            )}
          </button>

          {/* Rows */}
          {approvalsExpanded && (
            <div className="border-t border-amber-200 divide-y divide-amber-100">
              {pendingApprovals.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center justify-between gap-4 px-4 py-3 bg-white/60"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <UserCheck className="h-4 w-4 text-amber-500 shrink-0" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-navy truncate">
                        {item.customer.contactName || item.customer.businessName}
                        {item.customer.contactName && item.customer.businessName && (
                          <span className="ml-1.5 text-navy/70 font-normal text-xs">
                            · {item.customer.businessName}
                          </span>
                        )}
                      </p>
                      <p className="text-xs text-navy/70 truncate">
                        Buyer account:{" "}
                        <span className="font-medium text-navy/80">
                          {item.buyerAccount?.email ?? item.customer.email ?? "—"}
                        </span>
                        {item.buyerAccount?.name && (
                          <span className="ml-1 text-navy/70">({item.buyerAccount.name})</span>
                        )}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => router.push(`/customers/${item.customer.id}`)}
                      title="View customer"
                      className="rounded p-1.5 text-navy/70 hover:bg-surface-raised hover:text-navy transition-colors"
                    >
                      <ExternalLink className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => approveFromList.mutate(item.customer.id)}
                      disabled={approveFromList.isPending}
                      className="flex items-center gap-1.5 rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-600 disabled:opacity-50 transition-colors"
                    >
                      <UserCheck className="h-3.5 w-3.5" />
                      Approve
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          placeholder="Search by name, business, or phone…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-10 w-72 rounded border border-surface-border bg-white px-3 text-sm text-navy placeholder:text-navy/70 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
        <div className="w-36">
          <Select
            options={[
              { value: "", label: "All Statuses" },
              { value: "ACTIVE", label: "Active" },
              { value: "INACTIVE", label: "Inactive" },
              { value: "SUSPENDED", label: "Suspended" },
            ]}
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          />
        </div>
        <div className="w-36">
          <Select
            options={[
              { value: "", label: "All Types" },
              { value: "BUSINESS", label: "Business" },
              { value: "INDIVIDUAL", label: "Individual" },
            ]}
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
          />
        </div>
        {tags && tags.length > 0 && (
          <div className="w-36">
            <Select
              options={[
                { value: "", label: "All Tags" },
                ...tags.map((t) => ({ value: t.id, label: t.name })),
              ]}
              value={tagFilter}
              onChange={(e) => setTagFilter(e.target.value)}
            />
          </div>
        )}

        {/* Unassigned only toggle chip */}
        <button
          onClick={() => setUnassignedOnly((v) => !v)}
          className={cn(
            "flex h-10 items-center gap-1.5 rounded border px-3 text-sm font-medium transition-colors",
            unassignedOnly
              ? "border-brand-500 bg-brand-50 text-brand-600"
              : "border-surface-border bg-white text-navy/70 hover:border-brand-300 hover:text-navy",
          )}
        >
          <span
            className={cn(
              "inline-flex h-4 w-4 items-center justify-center rounded-full border text-xs",
              unassignedOnly ? "border-brand-500 bg-brand-500 text-white" : "border-navy/30",
            )}
          >
            {unassignedOnly && "✓"}
          </span>
          Unassigned only
        </button>
      </div>

      {/* Loading / Error / Table */}
      {isLoading ? (
        <div className="animate-pulse space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-12 rounded bg-surface-raised" />
          ))}
        </div>
      ) : isError ? (
        <div className="flex items-center gap-2 rounded-lg border border-danger/30 bg-danger-bg px-4 py-3">
          <span className="text-sm text-danger">
            Failed to load customers. Please try refreshing the page.
          </span>
        </div>
      ) : (
        /* Table */
        <>
          <Table
            data={visibleCustomers}
            columns={columns}
            onRowClick={(row) => {
              if (selectMode) toggleSelect(row.original.id);
              else router.push(`/customers/${row.original.id}`);
            }}
            emptyState={
              unassignedOnly ? (
                <EmptyState
                  variant="customers"
                  title="No unassigned customers"
                  description="Every customer is already assigned to a route."
                  action={
                    <Button variant="secondary" size="sm" onClick={() => setUnassignedOnly(false)}>
                      Show all customers
                    </Button>
                  }
                />
              ) : search || statusFilter || typeFilter || tagFilter ? (
                <EmptyState
                  variant="customers"
                  title="No matching customers"
                  description="No customers match your current search and filters."
                  action={
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setSearch("");
                        setStatusFilter("");
                        setTypeFilter("");
                        setTagFilter("");
                      }}
                    >
                      Clear filters
                    </Button>
                  }
                />
              ) : (
                <EmptyState
                  variant="customers"
                  title="No customers yet"
                  description="Add your first customer to start taking orders and sending invoices."
                  action={
                    <Button size="sm" onClick={() => setIsAddOpen(true)}>
                      Add customer
                    </Button>
                  }
                />
              )
            }
          />
          {/* Pagination */}
          {meta && (
            <div className="flex items-center justify-between gap-4 flex-wrap mt-4">
              <div className="flex items-center gap-3">
                <p className="text-sm text-navy/70">
                  {meta.total > 0
                    ? `Showing ${(page - 1) * limit + 1}–${Math.min(page * limit, meta.total)} of ${meta.total} customers`
                    : "No customers found"}
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
              {(meta.totalPages ?? 1) > 1 && (
                <div className="flex items-center gap-1">
                  <button
                    disabled={page <= 1}
                    onClick={() => setPage((p) => p - 1)}
                    className="rounded border border-surface-border bg-white px-3 py-1.5 text-sm font-medium text-navy hover:bg-surface-raised disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    Previous
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
                    disabled={page >= (meta.totalPages ?? 1)}
                    onClick={() => setPage((p) => p + 1)}
                    className="rounded border border-surface-border bg-white px-3 py-1.5 text-sm font-medium text-navy hover:bg-surface-raised disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    Next
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* Deactivate confirmation modal */}
      <Modal
        open={deactivatingCustomer !== null}
        onClose={() => setDeactivatingCustomer(null)}
        title="Deactivate Customer?"
        description={`Deactivate ${deactivatingCustomer?.name ?? "this customer"}?`}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setDeactivatingCustomer(null)}
              disabled={updateStatus.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={updateStatus.isPending}
              onClick={() => {
                if (!deactivatingCustomer) return;
                updateStatus.mutate(
                  { id: deactivatingCustomer.id, status: "INACTIVE" },
                  { onSettled: () => setDeactivatingCustomer(null) },
                );
              }}
            >
              Deactivate
            </Button>
          </>
        }
      >
        <p className="text-sm text-navy/70">
          Deactivating <strong>{deactivatingCustomer?.name}</strong> will hide them from route
          assignment and they will no longer be able to log in.
        </p>
      </Modal>

      {/* Import modal */}
      {isImportOpen && (
        <ImportCustomersModal
          onClose={() => setIsImportOpen(false)}
          onDone={() => {
            setIsImportOpen(false);
            refetch?.();
          }}
        />
      )}

      {/* Add modal */}
      <CustomerFormModal isOpen={isAddOpen} onClose={() => setIsAddOpen(false)} mode="add" />

      {/* Edit modal */}
      <CustomerFormModal
        isOpen={editingCustomer !== null}
        onClose={() => setEditingCustomer(null)}
        mode="edit"
        initialData={editingCustomer ?? undefined}
      />
    </div>
  );
}
