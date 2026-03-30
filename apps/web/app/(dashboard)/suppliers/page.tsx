"use client";

import * as React from "react";
import { Plus, Search, Building2, Phone, Mail, Clock, Pencil, X, Check } from "lucide-react";
import { PageHeader, Badge, Button, cn } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { useToast } from "@routeflow/ui/web";
import { useSuppliers, useCreateSupplier, useUpdateSupplier, useDeleteSupplier, type Supplier } from "@/lib/api/suppliers";

// ─── Supplier form modal ───────────────────────────────────────────────────────

function SupplierModal({
  initial,
  onClose,
  onSave,
  isSaving,
}: {
  initial?: Supplier;
  onClose: () => void;
  onSave: (data: Partial<Supplier>) => Promise<void>;
  isSaving: boolean;
}) {
  const [form, setForm] = React.useState({
    name: initial?.name ?? "",
    contactName: initial?.contactName ?? "",
    phone: initial?.phone ?? "",
    email: initial?.email ?? "",
    notes: initial?.notes ?? "",
    leadTimeDays: initial?.leadTimeDays != null ? String(initial.leadTimeDays) : "",
  });

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const isEdit = !!initial;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await onSave({
      name: form.name,
      contactName: form.contactName || undefined,
      phone: form.phone || undefined,
      email: form.email || undefined,
      notes: form.notes || undefined,
      leadTimeDays: form.leadTimeDays ? Number(form.leadTimeDays) : undefined,
    });
  };

  const inputCls = "w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-xl border border-surface-border bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-surface-border px-6 py-4">
          <h2 className="text-base font-semibold text-navy">
            {isEdit ? "Edit Supplier" : "New Supplier"}
          </h2>
          <button onClick={onClose} className="text-navy/40 hover:text-navy transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4 p-6">
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <label className="mb-1 block text-sm font-medium text-navy">Company name *</label>
              <input required value={form.name} onChange={(e) => set("name", e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-navy">Contact name</label>
              <input value={form.contactName} onChange={(e) => set("contactName", e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-navy">Phone</label>
              <input type="tel" value={form.phone} onChange={(e) => set("phone", e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-navy">Email</label>
              <input type="email" value={form.email} onChange={(e) => set("email", e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-navy">Lead time (days)</label>
              <input
                type="number"
                min="0"
                value={form.leadTimeDays}
                onChange={(e) => set("leadTimeDays", e.target.value)}
                placeholder="e.g. 3"
                className={inputCls}
              />
            </div>
            <div className="col-span-2">
              <label className="mb-1 block text-sm font-medium text-navy">Notes</label>
              <textarea
                rows={2}
                value={form.notes}
                onChange={(e) => set("notes", e.target.value)}
                className={`${inputCls} resize-y`}
              />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
            <Button type="submit" loading={isSaving}>
              {isEdit ? "Save changes" : "Add Supplier"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Supplier card ─────────────────────────────────────────────────────────────

function SupplierCard({
  supplier,
  onEdit,
  onToggleActive,
  isUpdating,
}: {
  supplier: Supplier;
  onEdit: () => void;
  onToggleActive: () => void;
  isUpdating: boolean;
}) {
  return (
    <div className={cn(
      "flex flex-col gap-3 rounded-xl border bg-white p-4 shadow-card transition-shadow hover:shadow-dropdown",
      !supplier.isActive && "opacity-60",
    )}>
      {/* Header row */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2 min-w-0">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-50">
            <Building2 className="h-4 w-4 text-brand-500" />
          </div>
          <div className="min-w-0">
            <p className="font-semibold text-navy leading-snug">{supplier.name}</p>
            {supplier.contactName && (
              <p className="text-xs text-navy/50">{supplier.contactName}</p>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Badge
            variant={supplier.isActive ? "success" : "neutral"}
            label={supplier.isActive ? "Active" : "Inactive"}
          />
          <button
            onClick={onEdit}
            className="rounded p-1 text-navy/30 hover:bg-surface-raised hover:text-navy transition-colors"
            title="Edit supplier"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Contact details */}
      <div className="space-y-1">
        {supplier.phone && (
          <div className="flex items-center gap-1.5 text-xs text-navy/60">
            <Phone className="h-3.5 w-3.5 shrink-0 text-navy/30" />
            {supplier.phone}
          </div>
        )}
        {supplier.email && (
          <div className="flex items-center gap-1.5 text-xs text-navy/60">
            <Mail className="h-3.5 w-3.5 shrink-0 text-navy/30" />
            {supplier.email}
          </div>
        )}
        {supplier.leadTimeDays != null && (
          <div className="flex items-center gap-1.5 text-xs text-navy/60">
            <Clock className="h-3.5 w-3.5 shrink-0 text-navy/30" />
            {supplier.leadTimeDays} day lead time
          </div>
        )}
        {supplier.notes && (
          <p className="mt-1 text-xs text-navy/50 line-clamp-2">{supplier.notes}</p>
        )}
      </div>

      {/* Footer */}
      <div className="border-t border-surface-border pt-2">
        <button
          onClick={onToggleActive}
          disabled={isUpdating}
          className="text-xs text-navy/40 hover:text-navy transition-colors disabled:opacity-40"
        >
          {supplier.isActive ? "Deactivate" : "Reactivate"}
        </button>
      </div>
    </div>
  );
}

// ─── Page ──────────────────────────────────────────────────────────────────────

export default function SuppliersPage() {
  const { setTitle } = usePageTitle();
  const { toast } = useToast();
  React.useEffect(() => { setTitle("Suppliers"); }, [setTitle]);

  const [search, setSearch] = React.useState("");
  const [activeFilter, setActiveFilter] = React.useState<"all" | "active" | "inactive">("active");
  const [showModal, setShowModal] = React.useState(false);
  const [editTarget, setEditTarget] = React.useState<Supplier | undefined>(undefined);

  const createSupplier = useCreateSupplier();
  const updateSupplier = useUpdateSupplier();
  const deleteSupplier = useDeleteSupplier();

  const { data: result, isLoading } = useSuppliers({
    search: search || undefined,
    isActive: activeFilter === "all" ? undefined : activeFilter === "active",
    limit: 0,
  });

  const suppliers: Supplier[] = result?.data ?? [];
  const total = result?.meta?.total ?? 0;

  const handleSave = async (data: Partial<Supplier>) => {
    try {
      if (editTarget) {
        await updateSupplier.mutateAsync({ id: editTarget.id, ...data });
        toast({ title: "Supplier updated", variant: "success" });
      } else {
        await createSupplier.mutateAsync(data);
        toast({ title: "Supplier added", variant: "success" });
      }
      setShowModal(false);
      setEditTarget(undefined);
    } catch (err: any) {
      toast({ title: "Failed to save", description: err?.message, variant: "error" });
      throw err;
    }
  };

  const handleToggleActive = async (supplier: Supplier) => {
    try {
      await updateSupplier.mutateAsync({ id: supplier.id, isActive: !supplier.isActive });
      toast({
        title: supplier.isActive ? "Supplier deactivated" : "Supplier reactivated",
        variant: "success",
      });
    } catch {
      toast({ title: "Update failed", variant: "error" });
    }
  };

  return (
    <div className="space-y-5 p-6">
      <PageHeader
        title="Suppliers"
        subtitle={`${total} supplier${total !== 1 ? "s" : ""}`}
        action={
          <Button
            leftIcon={<Plus className="h-4 w-4" />}
            onClick={() => { setEditTarget(undefined); setShowModal(true); }}
          >
            Add Supplier
          </Button>
        }
      />

      {showModal && (
        <SupplierModal
          initial={editTarget}
          onClose={() => { setShowModal(false); setEditTarget(undefined); }}
          onSave={handleSave}
          isSaving={createSupplier.isPending || updateSupplier.isPending}
        />
      )}

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-navy/30" />
          <input
            type="search"
            placeholder="Search suppliers…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-10 w-64 rounded border border-surface-border bg-white pl-9 pr-3 text-sm text-navy placeholder:text-navy/40 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>
        <div className="flex rounded-lg border border-surface-border bg-white p-1">
          {(["all", "active", "inactive"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setActiveFilter(f)}
              className={cn(
                "rounded px-3 py-1.5 text-xs font-medium capitalize transition-colors",
                activeFilter === f ? "bg-navy text-white" : "text-navy/50 hover:text-navy",
              )}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {/* Grid */}
      {isLoading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-40 animate-pulse rounded-xl border border-surface-border bg-surface-raised" />
          ))}
        </div>
      ) : suppliers.length === 0 ? (
        <div className="rounded-xl border border-surface-border bg-white py-16 text-center">
          <Building2 className="mx-auto mb-3 h-10 w-10 text-navy/15" />
          <p className="text-sm font-medium text-navy/50">
            {search ? "No suppliers match your search." : "No suppliers yet."}
          </p>
          {!search && (
            <button
              onClick={() => setShowModal(true)}
              className="mt-2 text-sm text-brand-500 hover:underline"
            >
              Add your first supplier →
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {suppliers.map((s) => (
            <SupplierCard
              key={s.id}
              supplier={s}
              onEdit={() => { setEditTarget(s); setShowModal(true); }}
              onToggleActive={() => handleToggleActive(s)}
              isUpdating={updateSupplier.isPending}
            />
          ))}
        </div>
      )}
    </div>
  );
}
