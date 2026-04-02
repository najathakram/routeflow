"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import { Eye, Pencil, Trash2, CheckSquare, X } from "lucide-react";
import { PageHeader, Table, Badge, Button, Select, cn } from "@routeflow/ui/web";
import { useToast } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { AddDriverModal } from "./_components/AddDriverModal";
import { EditDriverModal } from "./_components/EditDriverModal";
import { useDrivers, useCreateDriver, useUpdateDriver, useDeleteDriver, type Driver } from "@/lib/api/drivers";

// ─── Status badge ─────────────────────────────────────────────────────────────

function DriverStatusBadge({ driver }: { driver: Driver }) {
  if (driver.status === "ACTIVE") return <Badge status="ACTIVE" />;
  return <Badge status="INACTIVE" />;
}

// ─── Vehicle display helper ───────────────────────────────────────────────────

function vehicleLabel(driver: Driver): string {
  const parts = [driver.vehicleMake, driver.vehicleModel, driver.vehicleColour, driver.vehiclePlate].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "—";
}

// ─── Status filter options ────────────────────────────────────────────────────

const STATUS_OPTIONS = [
  { value: "", label: "All Statuses" },
  { value: "ACTIVE", label: "Active" },
  { value: "INACTIVE", label: "Inactive" },
];

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function DriversPage() {
  const router = useRouter();
  const { setTitle } = usePageTitle();
  const { toast } = useToast();
  const [isAddOpen, setIsAddOpen] = React.useState(false);
  const [editTarget, setEditTarget] = React.useState<Driver | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<Driver | null>(null);
  const [search, setSearch] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState("");
  const [selectMode, setSelectMode] = React.useState(false);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [isBulkDeleting, setIsBulkDeleting] = React.useState(false);

  React.useEffect(() => { setTitle("Drivers"); }, [setTitle]);

  const { data, isLoading, isError } = useDrivers();
  const createDriver = useCreateDriver();
  const updateDriver = useUpdateDriver();
  const deleteDriver = useDeleteDriver();

  const drivers = data?.data ?? [];

  // Client-side filtering
  const filtered = React.useMemo(() => {
    const q = search.toLowerCase();
    return drivers.filter((d) => {
      if (statusFilter && d.status !== statusFilter) return false;
      if (q) {
        const haystack = [d.contactName, d.phone, d.vehicleMake, d.vehicleModel, d.vehiclePlate, d.user?.username]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [drivers, search, statusFilter]);

  const toggleSelect = (id: string) =>
    setSelected((prev) => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });

  const exitSelectMode = () => { setSelectMode(false); setSelected(new Set()); };

  const handleBulkDelete = async () => {
    if (isBulkDeleting) return;
    setIsBulkDeleting(true);
    try {
      await Promise.all(Array.from(selected).map((id) => deleteDriver.mutateAsync(id)));
      toast({ title: `${selected.size} driver${selected.size !== 1 ? "s" : ""} deleted`, variant: "success" });
      exitSelectMode();
    } catch {
      toast({ title: "Failed to delete some drivers", variant: "error" });
    } finally {
      setIsBulkDeleting(false);
    }
  };

  const handleCreateDriver = async (formData: {
    contactName: string;
    email: string;
    username: string;
    phone?: string;
    vehicleMake?: string;
    vehicleModel?: string;
    vehicleColour?: string;
    vehiclePlate?: string;
  }) => {
    const result = await createDriver.mutateAsync(formData);
    return result.tempPassword;
  };

  const handleSaveDriver = async (id: string, data: Partial<Driver>) => {
    await updateDriver.mutateAsync({ id, data });
    toast({ title: "Driver updated", variant: "success" });
  };

  const handleDeleteDriver = async (driver: Driver) => {
    try {
      await deleteDriver.mutateAsync(driver.id);
      setDeleteTarget(null);
      toast({ title: `${driver.contactName} deleted`, variant: "success" });
      // If currently on their detail page, go back to list (handled by list-page context only)
    } catch (err: unknown) {
      const apiMsg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message;
      toast({ title: apiMsg || "Failed to delete driver", variant: "error" });
      setDeleteTarget(null);
    }
  };

  const allFilteredIds = filtered.map((d) => d.id);
  const allChecked = allFilteredIds.length > 0 && allFilteredIds.every((id) => selected.has(id));
  const someChecked = allFilteredIds.some((id) => selected.has(id));

  const columns = React.useMemo<ColumnDef<Driver, unknown>[]>(
    () => [
      ...(selectMode ? [{
        id: "select",
        header: () => (
          <input
            type="checkbox"
            checked={allChecked}
            ref={(el) => { if (el) el.indeterminate = someChecked && !allChecked; }}
            onChange={() => { if (allChecked) setSelected(new Set()); else setSelected(new Set(allFilteredIds)); }}
            className="h-4 w-4 cursor-pointer rounded border-navy/30 accent-brand-500"
          />
        ),
        cell: ({ row }: { row: { original: Driver } }) => (
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
      } as ColumnDef<Driver, unknown>] : []),
      {
        accessorKey: "contactName",
        header: "Name",
        cell: ({ row }) => (
          <div>
            <p className="font-medium text-navy">{row.original.contactName ?? row.original.user?.username ?? "—"}</p>
            <p className="text-xs text-navy/80">{row.original.user?.username}</p>
          </div>
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
        id: "vehicle",
        header: "Vehicle",
        enableSorting: false,

        cell: ({ row }) => (
          <span className="text-sm text-navy/70">{vehicleLabel(row.original)}</span>
        ),
      },
      {
        id: "status",
        header: "Status",
        accessorFn: (row: Driver) => row.status,
        cell: ({ row }) => <DriverStatusBadge driver={row.original} />,
      },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        cell: ({ row }) => (
          <div className="flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
            <button
              title="View driver"
              onClick={() => router.push(`/drivers/${row.original.id}`)}
              className="rounded p-1.5 text-navy/40 hover:bg-surface-raised hover:text-navy transition-colors"
            >
              <Eye className="h-4 w-4" />
            </button>
            <button
              title="Edit driver"
              onClick={() => setEditTarget(row.original)}
              className="rounded p-1.5 text-navy/40 hover:bg-surface-raised hover:text-navy transition-colors"
            >
              <Pencil className="h-4 w-4" />
            </button>
            <button
              title="Delete driver"
              onClick={() => setDeleteTarget(row.original)}
              className="rounded p-1.5 text-navy/40 hover:bg-red-50 hover:text-danger transition-colors"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [router, selectMode, selected, allChecked, someChecked, allFilteredIds.join(",")],
  );

  const activeCount = drivers.filter((d) => d.status === "ACTIVE").length;
  const inactiveCount = drivers.filter((d) => d.status === "INACTIVE").length;

  return (
    <div className="space-y-5 p-6">
      <PageHeader
        title="Drivers"
        action={
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              leftIcon={selectMode ? <X className="h-4 w-4" /> : <CheckSquare className="h-4 w-4" />}
              onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
            >
              {selectMode ? "Cancel" : "Select"}
            </Button>
            <Button onClick={() => setIsAddOpen(true)}>Add Driver</Button>
          </div>
        }
      />

      {/* Summary chips */}
      <div className="flex items-center gap-2 text-sm">
        <span
          onClick={() => setStatusFilter("")}
          className={cn(
            "cursor-pointer rounded-full px-3 py-1 font-medium transition-colors",
            !statusFilter
              ? "bg-brand-100 text-brand-700"
              : "bg-surface-raised text-navy/60 hover:text-navy",
          )}
        >
          All ({drivers.length})
        </span>
        <span
          onClick={() => setStatusFilter(statusFilter === "ACTIVE" ? "" : "ACTIVE")}
          className={cn(
            "cursor-pointer rounded-full px-3 py-1 font-medium transition-colors",
            statusFilter === "ACTIVE"
              ? "bg-success-bg text-success"
              : "bg-surface-raised text-navy/60 hover:text-navy",
          )}
        >
          Active ({activeCount})
        </span>
        <span
          onClick={() => setStatusFilter(statusFilter === "INACTIVE" ? "" : "INACTIVE")}
          className={cn(
            "cursor-pointer rounded-full px-3 py-1 font-medium transition-colors",
            statusFilter === "INACTIVE"
              ? "bg-surface-border text-navy/60"
              : "bg-surface-raised text-navy/60 hover:text-navy",
          )}
        >
          Inactive ({inactiveCount})
        </span>
      </div>

      {/* Selection action bar */}
      {selectMode && selected.size > 0 && (
        <div className="flex items-center justify-between rounded-lg border border-danger/30 bg-danger-bg px-4 py-3">
          <span className="text-sm font-medium text-navy">
            {selected.size} driver{selected.size !== 1 ? "s" : ""} selected
          </span>
          <div className="flex items-center gap-2">
            <button onClick={() => setSelected(new Set())} className="text-sm text-navy/50 hover:text-navy transition-colors">
              Deselect all
            </button>
            <Button variant="danger" leftIcon={<Trash2 className="h-4 w-4" />} loading={isBulkDeleting} onClick={handleBulkDelete}>
              Delete {selected.size}
            </Button>
          </div>
        </div>
      )}

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          placeholder="Search by name, phone, plate…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-10 w-64 rounded border border-surface-border bg-white px-3 text-sm text-navy placeholder:text-navy/40 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
        <div className="w-40">
          <Select
            options={STATUS_OPTIONS}
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          />
        </div>
        {(search || statusFilter) && (
          <button
            onClick={() => { setSearch(""); setStatusFilter(""); }}
            className="text-sm text-brand-500 hover:underline"
          >
            Clear filters
          </button>
        )}
      </div>

      {isError ? (
        <div className="flex items-center gap-2 rounded-lg border border-danger/30 bg-danger-bg px-4 py-3">
          <span className="text-sm text-danger">Failed to load data. Please try refreshing.</span>
        </div>
      ) : (
        <Table
          data={filtered}
          columns={columns}
          onRowClick={(row) => {
            if (selectMode) toggleSelect(row.original.id);
            else router.push(`/drivers/${row.original.id}`);
          }}
          emptyState={
            isLoading ? "Loading drivers…" :
            (search || statusFilter) ? (
              <div className="flex flex-col items-center gap-2">
                <p className="text-sm text-navy/40">No drivers match your search.</p>
                <button
                  className="text-sm text-brand-500 hover:underline"
                  onClick={() => { setSearch(""); setStatusFilter(""); }}
                >
                  Clear filters
                </button>
              </div>
            ) :
            <div className="flex flex-col items-center gap-2">
              <p className="text-sm text-navy/40">No drivers yet. Add your first driver to get started.</p>
              <button
                className="text-sm text-brand-500 hover:underline"
                onClick={() => setIsAddOpen(true)}
              >
                Add a driver
              </button>
            </div>
          }
        />
      )}

      {/* Add modal */}
      <AddDriverModal
        isOpen={isAddOpen}
        onClose={() => setIsAddOpen(false)}
        onCreateDriver={handleCreateDriver}
      />

      {/* Edit modal */}
      {editTarget && (
        <EditDriverModal
          driver={editTarget}
          isOpen={!!editTarget}
          onClose={() => setEditTarget(null)}
          onSave={(data) => handleSaveDriver(editTarget.id, data)}
        />
      )}

      {/* Delete confirmation */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl">
            <h2 className="text-base font-semibold text-navy">Delete Driver</h2>
            <p className="mt-2 text-sm text-navy/70">
              Are you sure you want to delete{" "}
              <span className="font-medium text-navy">{deleteTarget.contactName}</span>? This will
              permanently remove their account. Drivers with active route runs cannot be deleted.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setDeleteTarget(null)}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant="danger"
                loading={deleteDriver.isPending}
                onClick={() => handleDeleteDriver(deleteTarget)}
              >
                Delete
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
