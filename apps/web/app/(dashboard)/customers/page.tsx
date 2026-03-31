"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import { Pencil, ToggleLeft, ToggleRight, Eye, CheckSquare, X, Trash2 } from "lucide-react";
import { PageHeader, Table, Badge, Button, Select, cn, type BadgeStatus } from "@routeflow/ui/web";
import { useToast } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { CustomerFormModal } from "./_components/CustomerFormModal";
import { useCustomers, useUpdateCustomerStatus, useDeleteCustomer } from "@/lib/api/customers";
import { useCustomerRouteAssignments } from "@/lib/api/routes";
import { useDebounce } from "@/lib/hooks/useDebounce";

// ─── Local type ───────────────────────────────────────────────────────────────

interface Customer {
  id: string;
  businessName: string;
  contactName: string;
  phone?: string;
  user: { id: string; email: string; username: string; status: string };
  addresses: any[];
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function CustomersPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { setTitle } = usePageTitle();

  React.useEffect(() => { setTitle("Customers"); }, [setTitle]);

  // ── Local state ──────────────────────────────────────────────────────────
  const [search, setSearch] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState<string>(
    searchParams.get("status") ?? "",
  );
  const [unassignedOnly, setUnassignedOnly] = React.useState(false);
  const [isAddOpen, setIsAddOpen] = React.useState(false);
  const [editingCustomer, setEditingCustomer] = React.useState<any>(null);
  const [selectMode, setSelectMode] = React.useState(false);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [isDeleting, setIsDeleting] = React.useState(false);
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

  // ── API data ─────────────────────────────────────────────────────────────
  const { data: result, isLoading, isError } = useCustomers({
    search: debouncedSearch || undefined,
    status: statusFilter || undefined,
  });
  const customers: Customer[] = result?.data ?? [];

  const { data: assignments } = useCustomerRouteAssignments();

  const updateStatus = useUpdateCustomerStatus();
  const deleteCustomer = useDeleteCustomer();

  // ── Filter: unassigned only ───────────────────────────────────────────────
  const visibleCustomers = React.useMemo(() => {
    if (!unassignedOnly) return customers;
    return customers.filter((c) => !assignments?.[c.id]?.length);
  }, [customers, assignments, unassignedOnly]);

  const toggleSelect = (id: string) =>
    setSelected((prev) => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });

  const exitSelectMode = () => { setSelectMode(false); setSelected(new Set()); };

  const handleBulkDelete = async () => {
    if (isDeleting || selected.size === 0) return;
    setIsDeleting(true);
    try {
      await Promise.all(Array.from(selected).map((id) => deleteCustomer.mutateAsync(id)));
      toast({ title: `${selected.size} customer${selected.size !== 1 ? "s" : ""} deleted`, variant: "success" });
      exitSelectMode();
    } catch {
      toast({ title: "Failed to delete some customers", variant: "error" });
    } finally {
      setIsDeleting(false);
    }
  };

  // ── Status toggle ────────────────────────────────────────────────────────
  const toggleStatus = React.useCallback((id: string, currentStatus: string) => {
    updateStatus.mutate({
      id,
      status: currentStatus === "ACTIVE" ? "INACTIVE" : "ACTIVE",
    });
  }, [updateStatus]);

  // ── Column definitions ───────────────────────────────────────────────────
  const allVisible = visibleCustomers;
  const allVisibleIds = allVisible.map((c) => c.id);
  const allChecked = allVisibleIds.length > 0 && allVisibleIds.every((id) => selected.has(id));
  const someChecked = allVisibleIds.some((id) => selected.has(id));

  const columns = React.useMemo<ColumnDef<Customer, unknown>[]>(
    () => [
      ...(selectMode ? [{
        id: "select",
        header: () => (
          <input
            type="checkbox"
            checked={allChecked}
            ref={(el) => { if (el) el.indeterminate = someChecked && !allChecked; }}
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
      } as ColumnDef<Customer, unknown>] : []),
      {
        accessorKey: "contactName",
        header: "Name",
        cell: ({ row }) => (
          <span className="font-medium text-navy">{row.original.contactName}</span>
        ),
      },
      {
        accessorKey: "businessName",
        header: "Business Name",
        cell: ({ row }) => (
          <span className="text-navy/80">{row.original.businessName}</span>
        ),
      },
      {
        accessorKey: "phone",
        header: "Phone",
        enableSorting: false,
        cell: ({ row }) => (
          <span className="text-navy/70">{row.original.phone ?? "—"}</span>
        ),
      },
      {
        id: "routes",
        header: "Routes",
        enableSorting: false,
        cell: ({ row }) => {
          const customerRoutes = assignments?.[row.original.id] ?? [];
          if (!customerRoutes.length) {
            return <span className="text-xs text-navy/30 italic">Unassigned</span>;
          }
          const visible = customerRoutes.slice(0, 2);
          const overflow = customerRoutes.length - visible.length;
          return (
            <div className="flex flex-wrap items-center gap-1">
              {visible.map((r) => (
                <span
                  key={r.routeId}
                  title={r.routeName}
                  className="inline-flex max-w-[120px] items-center truncate rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-600"
                >
                  {r.routeName}
                </span>
              ))}
              {overflow > 0 && (
                <span className="text-xs text-navy/50">+{overflow} more</span>
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
            <div
              className="flex items-center gap-1"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                title="Edit customer"
                onClick={() => setEditingCustomer(row.original)}
                className="rounded p-1.5 text-navy/40 hover:bg-surface-raised hover:text-navy transition-colors"
              >
                <Pencil className="h-4 w-4" />
              </button>
              <button
                title={status === "ACTIVE" ? "Deactivate" : "Activate"}
                onClick={() => toggleStatus(row.original.id, status)}
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
                onClick={() => router.push(`/customers/${row.original.id}`)}
                className="rounded p-1.5 text-navy/40 hover:bg-surface-raised hover:text-navy transition-colors"
              >
                <Eye className="h-4 w-4" />
              </button>
            </div>
          );
        },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [router, toggleStatus, assignments, selectMode, selected, allChecked, someChecked],
  );

  return (
    <div className="space-y-5 p-6">
      <PageHeader
        title="Customers"
        action={
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              leftIcon={selectMode ? <X className="h-4 w-4" /> : <CheckSquare className="h-4 w-4" />}
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
            <button onClick={() => setSelected(new Set())} className="text-sm text-navy/50 hover:text-navy transition-colors">
              Deselect all
            </button>
            <Button variant="danger" leftIcon={<Trash2 className="h-4 w-4" />} loading={isDeleting} onClick={handleBulkDelete}>
              Delete {selected.size}
            </Button>
          </div>
        </div>
      )}

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          placeholder="Search by name, business, or phone…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-10 w-72 rounded border border-surface-border bg-white px-3 text-sm text-navy placeholder:text-navy/40 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
        <div className="w-44">
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

        {/* Unassigned only toggle chip */}
        <button
          onClick={() => setUnassignedOnly((v) => !v)}
          className={cn(
            "flex h-10 items-center gap-1.5 rounded border px-3 text-sm font-medium transition-colors",
            unassignedOnly
              ? "border-brand-500 bg-brand-50 text-brand-600"
              : "border-surface-border bg-white text-navy/60 hover:border-brand-300 hover:text-navy",
          )}
        >
          <span className={cn(
            "inline-flex h-4 w-4 items-center justify-center rounded-full border text-xs",
            unassignedOnly ? "border-brand-500 bg-brand-500 text-white" : "border-navy/30",
          )}>
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
          <span className="text-sm text-danger">Failed to load customers. Please try refreshing the page.</span>
        </div>
      ) : (
        /* Table */
        <Table
          data={visibleCustomers}
          columns={columns}
          onRowClick={(row) => {
            if (selectMode) toggleSelect(row.original.id);
            else router.push(`/customers/${row.original.id}`);
          }}
          emptyState={
            <span className="text-sm">
              {unassignedOnly ? (
                <>
                  All customers are assigned to routes.{" "}
                  <button
                    className="text-brand-500 hover:underline"
                    onClick={() => setUnassignedOnly(false)}
                  >
                    Show all
                  </button>
                </>
              ) : (
                <>
                  No customers match your search.{" "}
                  <button
                    className="text-brand-500 hover:underline"
                    onClick={() => { setSearch(""); setStatusFilter(""); }}
                  >
                    Clear filters
                  </button>
                </>
              )}
            </span>
          }
        />
      )}

      {/* Add modal */}
      <CustomerFormModal
        isOpen={isAddOpen}
        onClose={() => setIsAddOpen(false)}
        mode="add"
      />

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
