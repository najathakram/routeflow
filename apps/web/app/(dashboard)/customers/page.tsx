"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import { Pencil, ToggleLeft, ToggleRight, Eye } from "lucide-react";
import { PageHeader, Table, Badge, Button, Select, cn } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { CustomerFormModal } from "./_components/CustomerFormModal";
import { useCustomers, useUpdateCustomerStatus } from "@/lib/api/customers";

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
  const { setTitle } = usePageTitle();

  React.useEffect(() => { setTitle("Customers"); }, [setTitle]);

  // ── Local state ──────────────────────────────────────────────────────────
  const [search, setSearch] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState<string>("");
  const [isAddOpen, setIsAddOpen] = React.useState(false);
  const [editingCustomer, setEditingCustomer] = React.useState<any>(null);

  // ── API data ─────────────────────────────────────────────────────────────
  const { data: result, isLoading } = useCustomers({
    search: search || undefined,
    status: statusFilter || undefined,
  });
  const customers: Customer[] = result?.data ?? [];

  const updateStatus = useUpdateCustomerStatus();

  // ── Status toggle ────────────────────────────────────────────────────────
  const toggleStatus = React.useCallback((id: string, currentStatus: string) => {
    updateStatus.mutate({
      id,
      status: currentStatus === "ACTIVE" ? "INACTIVE" : "ACTIVE",
    });
  }, [updateStatus]);

  // ── Column definitions ───────────────────────────────────────────────────
  const columns = React.useMemo<ColumnDef<Customer, unknown>[]>(
    () => [
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
        cell: () => (
          <span className="text-xs text-navy/30">—</span>
        ),
      },
      {
        id: "status",
        header: "Status",
        cell: ({ row }) => (
          <Badge status={row.original.user?.status ?? "ACTIVE"} />
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
    [router, toggleStatus],
  );

  return (
    <div className="space-y-5 p-6">
      <PageHeader
        title="Customers"
        action={
          <Button onClick={() => setIsAddOpen(true)}>Add Customer</Button>
        }
      />

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
      </div>

      {/* Loading skeleton */}
      {isLoading ? (
        <div className="animate-pulse space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-12 rounded bg-surface-raised" />
          ))}
        </div>
      ) : (
        /* Table */
        <Table
          data={customers}
          columns={columns}
          onRowClick={(row) => router.push(`/customers/${row.original.id}`)}
          emptyState={
            <span className="text-sm">
              No customers match your search.{" "}
              <button
                className="text-brand-500 hover:underline"
                onClick={() => { setSearch(""); setStatusFilter(""); }}
              >
                Clear filters
              </button>
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
