"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Plus,
  Search,
  Building2,
  Phone,
  Mail,
  Clock,
  Pencil,
  X,
  CheckSquare,
  Trash2,
  MapPin,
  Globe,
  LayoutGrid,
  LayoutList,
  DollarSign,
} from "lucide-react";
import { PageHeader, Badge, Button, cn } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { useToast } from "@routeflow/ui/web";
import { useUrlSearch } from "@/lib/hooks/useUrlSearch";
import { AddressAutocomplete } from "@/components/AddressAutocomplete";
import {
  useSuppliers,
  useCreateSupplier,
  useUpdateSupplier,
  useDeleteSupplier,
  useDeactivateSupplier,
  type Supplier,
} from "@/lib/api/suppliers";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n?: number) {
  if (n == null || n === 0) return null;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Same VALID_TERMS list as the API DTO (create-supplier.dto.ts) and the
// invoice pages' TERMS_OPTIONS — "" seeds/clears "no default" (falls back to
// whatever the operator picks on the bill).
const TERMS_OPTIONS = [
  { value: "", label: "No default" },
  { value: "Due on Receipt", label: "Due on Receipt" },
  { value: "Net 15", label: "Net 15" },
  { value: "Net 30", label: "Net 30" },
  { value: "Net 45", label: "Net 45" },
  { value: "Net 60", label: "Net 60" },
];

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
    mobile: initial?.mobile ?? "",
    email: initial?.email ?? "",
    website: initial?.website ?? "",
    notes: initial?.notes ?? "",
    leadTimeDays: initial?.leadTimeDays != null ? String(initial.leadTimeDays) : "",
    defaultTerms: initial?.defaultTerms ?? "",
    addressLine1: initial?.addressLine1 ?? "",
    addressLine2: initial?.addressLine2 ?? "",
    city: initial?.city ?? "",
    state: initial?.state ?? "",
    zip: initial?.zip ?? "",
    country: initial?.country ?? "",
  });

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const isEdit = !!initial;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await onSave({
      name: form.name,
      contactName: form.contactName || undefined,
      phone: form.phone || undefined,
      mobile: form.mobile || undefined,
      email: form.email || undefined,
      website: form.website || undefined,
      notes: form.notes || undefined,
      leadTimeDays: form.leadTimeDays ? Number(form.leadTimeDays) : undefined,
      // Always send — unlike the free-text fields above, "" here is a deliberate
      // choice (the "No default" option), not "leave unset", and the API reads
      // "" as "clear a previously-set default" (create-supplier.dto.ts).
      defaultTerms: form.defaultTerms,
      addressLine1: form.addressLine1 || undefined,
      addressLine2: form.addressLine2 || undefined,
      city: form.city || undefined,
      state: form.state || undefined,
      zip: form.zip || undefined,
      country: form.country || undefined,
    });
  };

  const inputCls =
    "w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-xl border border-surface-border bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-surface-border px-6 py-4">
          <h2 className="text-base font-semibold text-navy">
            {isEdit ? "Edit Supplier" : "New Supplier"}
          </h2>
          <button onClick={onClose} className="text-navy/70 hover:text-navy transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="max-h-[80vh] overflow-y-auto p-6">
          <div className="space-y-4">
            {/* Company info */}
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <label className="mb-1 block text-xs font-medium text-navy/70 uppercase tracking-wide">
                  Company name *
                </label>
                <input
                  required
                  value={form.name}
                  onChange={(e) => set("name", e.target.value)}
                  className={inputCls}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-navy/70 uppercase tracking-wide">
                  Contact person
                </label>
                <input
                  value={form.contactName}
                  onChange={(e) => set("contactName", e.target.value)}
                  className={inputCls}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-navy/70 uppercase tracking-wide">
                  Lead time (days)
                </label>
                <input
                  type="number"
                  min="0"
                  value={form.leadTimeDays}
                  onChange={(e) => set("leadTimeDays", e.target.value)}
                  placeholder="e.g. 3"
                  className={inputCls}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-navy/70 uppercase tracking-wide">
                  Phone
                </label>
                <input
                  type="tel"
                  value={form.phone}
                  onChange={(e) => set("phone", e.target.value)}
                  className={inputCls}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-navy/70 uppercase tracking-wide">
                  Mobile
                </label>
                <input
                  type="tel"
                  value={form.mobile}
                  onChange={(e) => set("mobile", e.target.value)}
                  className={inputCls}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-navy/70 uppercase tracking-wide">
                  Default payment terms
                </label>
                <select
                  value={form.defaultTerms}
                  onChange={(e) => set("defaultTerms", e.target.value)}
                  className={inputCls}
                >
                  {TERMS_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="col-span-2">
                <label className="mb-1 block text-xs font-medium text-navy/70 uppercase tracking-wide">
                  Email
                </label>
                <input
                  type="email"
                  value={form.email}
                  onChange={(e) => set("email", e.target.value)}
                  className={inputCls}
                />
              </div>
              <div className="col-span-2">
                <label className="mb-1 block text-xs font-medium text-navy/70 uppercase tracking-wide">
                  Website
                </label>
                <input
                  type="url"
                  value={form.website}
                  onChange={(e) => set("website", e.target.value)}
                  placeholder="https://"
                  className={inputCls}
                />
              </div>
            </div>

            {/* Address */}
            <div>
              <p className="mb-2 text-xs font-medium text-navy/70 uppercase tracking-wide">
                Address
              </p>
              <div className="space-y-2">
                <AddressAutocomplete
                  placeholder="Street address — start typing for suggestions"
                  value={form.addressLine1}
                  onChange={(v) => set("addressLine1", v)}
                  onAddressSelect={({ street, city, state, zip }) => {
                    set("addressLine1", street);
                    set("city", city);
                    set("state", state);
                    set("zip", zip);
                  }}
                />
                <input
                  placeholder="Address line 2"
                  value={form.addressLine2}
                  onChange={(e) => set("addressLine2", e.target.value)}
                  className={inputCls}
                />
                <div className="grid grid-cols-3 gap-2">
                  <input
                    placeholder="City"
                    value={form.city}
                    onChange={(e) => set("city", e.target.value)}
                    className={inputCls}
                  />
                  <input
                    placeholder="State"
                    value={form.state}
                    onChange={(e) => set("state", e.target.value)}
                    className={inputCls}
                  />
                  <input
                    placeholder="ZIP"
                    value={form.zip}
                    onChange={(e) => set("zip", e.target.value)}
                    className={inputCls}
                  />
                </div>
                <input
                  placeholder="Country"
                  value={form.country}
                  onChange={(e) => set("country", e.target.value)}
                  className={inputCls}
                />
              </div>
            </div>

            {/* Notes */}
            <div>
              <label className="mb-1 block text-xs font-medium text-navy/70 uppercase tracking-wide">
                Notes
              </label>
              <textarea
                rows={3}
                value={form.notes}
                onChange={(e) => set("notes", e.target.value)}
                className={inputCls}
                placeholder="Internal notes about this supplier…"
              />
            </div>
          </div>

          <div className="mt-6 flex justify-end gap-2 border-t border-surface-border pt-4">
            <Button type="button" variant="secondary" onClick={onClose} disabled={isSaving}>
              Cancel
            </Button>
            <Button type="submit" loading={isSaving}>
              {isEdit ? "Save changes" : "Add Supplier"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Supplier card (grid view) ─────────────────────────────────────────────────

function SupplierCard({
  supplier,
  onEdit,
  onView,
  onDeactivate,
  onReactivate,
  onDelete,
  isUpdating,
  selectMode,
  selected,
  onSelect,
}: {
  supplier: Supplier;
  onEdit: () => void;
  onView: () => void;
  onDeactivate: () => void;
  onReactivate: () => void;
  onDelete: () => void;
  isUpdating: boolean;
  selectMode?: boolean;
  selected?: boolean;
  onSelect?: () => void;
}) {
  const [confirmDeactivate, setConfirmDeactivate] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const outstanding = supplier.outstandingBalance ?? 0;

  return (
    <div
      className={cn(
        "relative flex flex-col gap-3 rounded-xl border bg-white p-4 shadow-card transition-shadow hover:shadow-dropdown",
        !supplier.isActive && "opacity-60",
        "cursor-pointer",
        selected && "ring-2 ring-brand-500 border-brand-500",
      )}
      onClick={selectMode ? onSelect : onView}
    >
      {/* Checkbox — only in selection mode */}
      {selectMode && (
        <div
          className="absolute left-3 top-3 z-10"
          onClick={(e) => {
            e.stopPropagation();
            onSelect?.();
          }}
        >
          <input
            type="checkbox"
            checked={selected ?? false}
            onChange={() => {}}
            className="h-4 w-4 cursor-pointer rounded border-navy/30 accent-brand-500"
          />
        </div>
      )}

      {/* Header row */}
      <div className={cn("flex items-start justify-between gap-2", selectMode && "pl-6")}>
        <div className="flex items-start gap-2 min-w-0">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-50">
            <Building2 className="h-4 w-4 text-brand-500" />
          </div>
          <div className="min-w-0">
            <p className="font-semibold text-navy leading-snug">{supplier.name}</p>
            {supplier.contactName && <p className="text-xs text-navy/70">{supplier.contactName}</p>}
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

      {/* Outstanding balance */}
      {outstanding > 0 && (
        <div className="flex items-center gap-1.5 rounded-lg bg-warning/10 px-3 py-2">
          <DollarSign className="h-3.5 w-3.5 shrink-0 text-warning" />
          <div className="min-w-0">
            <span className="text-xs font-semibold text-warning">
              {fmt(outstanding)} outstanding
            </span>
            {(supplier.billCount ?? 0) > 0 && (
              <span className="ml-1 text-xs text-navy/70">
                across {supplier.billCount} bill{supplier.billCount !== 1 ? "s" : ""}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Contact details */}
      <div className="space-y-1">
        {(supplier.phone || supplier.mobile) && (
          <div className="flex items-center gap-1.5 text-xs text-navy">
            <Phone className="h-3.5 w-3.5 shrink-0 text-navy/30" />
            {supplier.phone || supplier.mobile}
          </div>
        )}
        {supplier.email && (
          <div className="flex items-center gap-1.5 text-xs text-navy">
            <Mail className="h-3.5 w-3.5 shrink-0 text-navy/30" />
            {supplier.email}
          </div>
        )}
        {supplier.website && (
          <div className="flex items-center gap-1.5 text-xs text-navy">
            <Globe className="h-3.5 w-3.5 shrink-0 text-navy/30" />
            <span className="truncate">{supplier.website.replace(/^https?:\/\//, "")}</span>
          </div>
        )}
        {supplier.addressLine1 && (
          <div className="flex items-start gap-1.5 text-xs text-navy/70">
            <MapPin className="h-3.5 w-3.5 shrink-0 text-navy/30 mt-0.5" />
            <span className="line-clamp-2">
              {[supplier.addressLine1, supplier.city, supplier.state, supplier.zip]
                .filter(Boolean)
                .join(", ")}
            </span>
          </div>
        )}
        {supplier.leadTimeDays != null && (
          <div className="flex items-center gap-1.5 text-xs text-navy">
            <Clock className="h-3.5 w-3.5 shrink-0 text-navy/30" />
            {supplier.leadTimeDays} day lead time
          </div>
        )}
        {supplier.notes && (
          <p className="mt-1 text-xs text-navy/70 line-clamp-2">{supplier.notes}</p>
        )}
      </div>

      {/* Footer */}
      <div className="border-t border-surface-border pt-2 mt-auto">
        {confirmDelete ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-danger">Permanently delete?</span>
            <button
              onClick={() => {
                setConfirmDelete(false);
                onDelete();
              }}
              disabled={isUpdating}
              className="text-xs font-medium text-danger hover:underline disabled:opacity-40"
            >
              Delete
            </button>
            <button
              onClick={() => setConfirmDelete(false)}
              className="text-xs text-navy/70 hover:text-navy transition-colors"
            >
              Cancel
            </button>
          </div>
        ) : confirmDeactivate ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-warning">Deactivate supplier?</span>
            <button
              onClick={() => {
                setConfirmDeactivate(false);
                onDeactivate();
              }}
              disabled={isUpdating}
              className="text-xs font-medium text-warning hover:underline disabled:opacity-40"
            >
              Yes
            </button>
            <button
              onClick={() => setConfirmDeactivate(false)}
              className="text-xs text-navy/70 hover:text-navy transition-colors"
            >
              Cancel
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-between">
            {supplier.isActive ? (
              <button
                onClick={() => setConfirmDeactivate(true)}
                disabled={isUpdating}
                className="text-xs text-navy/70 hover:text-warning transition-colors disabled:opacity-40"
              >
                Deactivate
              </button>
            ) : (
              <button
                onClick={onReactivate}
                disabled={isUpdating}
                className="text-xs font-medium text-brand-500 hover:text-brand-600 transition-colors disabled:opacity-40"
              >
                Reactivate
              </button>
            )}
            <button
              onClick={() => setConfirmDelete(true)}
              disabled={isUpdating}
              className="text-xs text-danger/50 hover:text-danger transition-colors disabled:opacity-40"
            >
              Delete
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Supplier row (list view) ──────────────────────────────────────────────────

function SupplierRow({
  supplier,
  onEdit,
  onView,
  onDeactivate,
  onReactivate,
  onDelete,
  isUpdating,
  selectMode,
  selected,
  onSelect,
}: {
  supplier: Supplier;
  onEdit: () => void;
  onView: () => void;
  onDeactivate: () => void;
  onReactivate: () => void;
  onDelete: () => void;
  isUpdating: boolean;
  selectMode?: boolean;
  selected?: boolean;
  onSelect?: () => void;
}) {
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const outstanding = supplier.outstandingBalance ?? 0;

  return (
    <tr
      className={cn(
        "group border-b border-surface-border transition-colors hover:bg-surface-raised/50 cursor-pointer",
        !supplier.isActive && "opacity-60",
        selected && "bg-brand-50/40",
      )}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button,input,a")) return;
        if (selectMode) {
          onSelect?.();
          return;
        }
        onView();
      }}
    >
      {/* Checkbox */}
      {selectMode && (
        <td className="w-10 px-4 py-3">
          <input
            type="checkbox"
            checked={selected ?? false}
            onChange={() => onSelect?.()}
            onClick={(e) => e.stopPropagation()}
            className="h-4 w-4 cursor-pointer rounded border-navy/30 accent-brand-500"
          />
        </td>
      )}

      {/* Name + contact */}
      <td className="px-4 py-3">
        <div className="flex items-center gap-2.5">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-brand-50">
            <Building2 className="h-3.5 w-3.5 text-brand-500" />
          </div>
          <div>
            <p className="font-medium text-navy text-sm">{supplier.name}</p>
            {supplier.contactName && <p className="text-xs text-navy/70">{supplier.contactName}</p>}
          </div>
        </div>
      </td>

      {/* Phone / email */}
      <td className="px-4 py-3">
        <div className="space-y-0.5">
          {(supplier.phone || supplier.mobile) && (
            <div className="flex items-center gap-1 text-xs text-navy/70">
              <Phone className="h-3 w-3 shrink-0 text-navy/30" />
              {supplier.phone || supplier.mobile}
            </div>
          )}
          {supplier.email && (
            <div className="flex items-center gap-1 text-xs text-navy/70">
              <Mail className="h-3 w-3 shrink-0 text-navy/30" />
              {supplier.email}
            </div>
          )}
          {!supplier.phone && !supplier.mobile && !supplier.email && (
            <span className="text-xs text-navy/30">—</span>
          )}
        </div>
      </td>

      {/* City / state */}
      <td className="px-4 py-3 text-xs text-navy/70">
        {supplier.city || supplier.state ? (
          [supplier.city, supplier.state].filter(Boolean).join(", ")
        ) : (
          <span className="text-navy/30">—</span>
        )}
      </td>

      {/* Lead time */}
      <td className="px-4 py-3 text-center text-xs text-navy/70">
        {supplier.leadTimeDays != null ? (
          `${supplier.leadTimeDays}d`
        ) : (
          <span className="text-navy/30">—</span>
        )}
      </td>

      {/* Outstanding balance */}
      <td className="px-4 py-3 text-right">
        {outstanding > 0 ? (
          <div>
            <span className="text-sm font-semibold text-warning">{fmt(outstanding)}</span>
            {(supplier.billCount ?? 0) > 0 && (
              <p className="text-[10px] text-navy/70 leading-tight">
                {supplier.billCount} bill{supplier.billCount !== 1 ? "s" : ""}
              </p>
            )}
          </div>
        ) : (
          <span className="text-xs text-navy/30">—</span>
        )}
      </td>

      {/* Status */}
      <td className="px-4 py-3">
        <Badge
          variant={supplier.isActive ? "success" : "neutral"}
          label={supplier.isActive ? "Active" : "Inactive"}
        />
      </td>

      {/* Actions */}
      <td className="px-4 py-3">
        <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={onEdit}
            className="rounded p-1 text-navy/70 hover:bg-surface-raised hover:text-navy transition-colors"
            title="Edit"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          {confirmDelete ? (
            <div className="flex items-center gap-1">
              <button
                onClick={() => {
                  setConfirmDelete(false);
                  onDelete();
                }}
                className="text-xs text-danger hover:underline"
              >
                Delete
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                className="text-xs text-navy/70 hover:text-navy"
              >
                ✕
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              className="rounded p-1 text-navy/30 hover:bg-danger/10 hover:text-danger transition-colors"
              title="Delete"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

// ─── Page ──────────────────────────────────────────────────────────────────────

export default function SuppliersPage() {
  const router = useRouter();
  const { setTitle } = usePageTitle();
  const { toast } = useToast();
  React.useEffect(() => {
    setTitle("Suppliers");
  }, [setTitle]);

  const [search, setSearch, debouncedSearch] = useUrlSearch();
  const [activeFilter, setActiveFilter] = React.useState<"all" | "active" | "inactive">("all");
  const [viewMode, setViewMode] = React.useState<"grid" | "list">("list");
  const [showModal, setShowModal] = React.useState(false);
  const [editTarget, setEditTarget] = React.useState<Supplier | undefined>(undefined);
  const [selectMode, setSelectMode] = React.useState(false);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [isDeleting, setIsDeleting] = React.useState(false);

  const createSupplier = useCreateSupplier();
  const updateSupplier = useUpdateSupplier();
  const deactivateSupplier = useDeactivateSupplier();
  const deleteSupplier = useDeleteSupplier();

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
    if (isDeleting) return;
    setIsDeleting(true);
    try {
      await Promise.all(Array.from(selected).map((id) => deleteSupplier.mutateAsync(id)));
      toast({
        title: `${selected.size} supplier${selected.size !== 1 ? "s" : ""} deleted`,
        variant: "success",
      });
      exitSelectMode();
    } catch {
      toast({ title: "Failed to delete some suppliers", variant: "error" });
    } finally {
      setIsDeleting(false);
    }
  };

  const {
    data: result,
    isLoading,
    isError,
  } = useSuppliers({
    search: debouncedSearch || undefined,
    isActive: activeFilter === "all" ? undefined : activeFilter === "active",
    limit: 0,
  });

  const suppliers: Supplier[] = result?.data ?? [];
  const total = result?.meta?.total ?? 0;
  const totalOutstanding = suppliers.reduce((sum, s) => sum + (s.outstandingBalance ?? 0), 0);

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

  const handleDeactivate = async (supplier: Supplier) => {
    try {
      await deactivateSupplier.mutateAsync(supplier.id);
      toast({ title: "Supplier deactivated", variant: "success" });
    } catch {
      toast({ title: "Update failed", variant: "error" });
    }
  };

  const handleReactivate = async (supplier: Supplier) => {
    try {
      await updateSupplier.mutateAsync({ id: supplier.id, isActive: true });
      toast({ title: "Supplier reactivated", variant: "success" });
    } catch {
      toast({ title: "Update failed", variant: "error" });
    }
  };

  const handleDelete = async (supplier: Supplier) => {
    try {
      await deleteSupplier.mutateAsync(supplier.id);
      toast({ title: "Supplier deleted", variant: "success" });
    } catch (err: any) {
      const msg = err?.response?.data?.message ?? "Failed to delete supplier";
      toast({ title: "Cannot delete supplier", description: msg, variant: "error" });
    }
  };

  const sharedRowProps = (s: Supplier) => ({
    supplier: s,
    onEdit: () => {
      if (!selectMode) {
        setEditTarget(s);
        setShowModal(true);
      }
    },
    onView: () => {
      if (!selectMode) router.push(`/suppliers/${s.id}`);
    },
    onDeactivate: () => {
      if (!selectMode) handleDeactivate(s);
    },
    onReactivate: () => {
      if (!selectMode) handleReactivate(s);
    },
    onDelete: () => {
      if (!selectMode) handleDelete(s);
    },
    isUpdating:
      updateSupplier.isPending || deactivateSupplier.isPending || deleteSupplier.isPending,
    selectMode,
    selected: selected.has(s.id),
    onSelect: () => toggleSelect(s.id),
  });

  const allSelected = suppliers.length > 0 && suppliers.every((s) => selected.has(s.id));
  const someSelected = !allSelected && suppliers.some((s) => selected.has(s.id));

  return (
    <div className="space-y-5 p-6">
      <PageHeader
        title="Suppliers"
        subtitle={`${total} supplier${total !== 1 ? "s" : ""}${totalOutstanding > 0 ? ` · ${fmt(totalOutstanding)} outstanding` : ""}`}
        action={
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              leftIcon={
                selectMode ? <X className="h-4 w-4" /> : <CheckSquare className="h-4 w-4" />
              }
              onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
            >
              {selectMode ? "Cancel" : "Select"}
            </Button>
            <Button
              leftIcon={<Plus className="h-4 w-4" />}
              onClick={() => {
                setEditTarget(undefined);
                setShowModal(true);
              }}
            >
              New Supplier
            </Button>
          </div>
        }
      />

      {showModal && (
        <SupplierModal
          initial={editTarget}
          onClose={() => {
            setShowModal(false);
            setEditTarget(undefined);
          }}
          onSave={handleSave}
          isSaving={createSupplier.isPending || updateSupplier.isPending}
        />
      )}

      {/* Selection action bar */}
      {selectMode && selected.size > 0 && (
        <div className="flex items-center justify-between rounded-lg border border-danger/30 bg-danger-bg px-4 py-3">
          <span className="text-sm font-medium text-navy">
            {selected.size} supplier{selected.size !== 1 ? "s" : ""} selected
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setSelected(new Set())}
              className="text-sm text-navy/70 hover:text-navy transition-colors"
            >
              Deselect all
            </button>
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

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        {/* Select-all checkbox (list view) */}
        {selectMode && viewMode === "list" && suppliers.length > 0 && (
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={allSelected}
              ref={(el) => {
                if (el) el.indeterminate = someSelected;
              }}
              onChange={() => {
                if (allSelected) setSelected(new Set());
                else setSelected(new Set(suppliers.map((s) => s.id)));
              }}
              className="h-4 w-4 cursor-pointer rounded border-navy/30 accent-brand-500"
            />
            <span className="text-sm text-navy/70">Select all</span>
          </label>
        )}

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-navy/30" />
          <input
            type="search"
            placeholder="Search suppliers…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-10 w-64 rounded border border-surface-border bg-white pl-9 pr-3 text-sm text-navy placeholder:text-navy/70 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>

        {/* Status filter */}
        <div className="flex rounded-lg border border-surface-border bg-white p-1">
          {(["all", "active", "inactive"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setActiveFilter(f)}
              className={cn(
                "rounded px-3 py-1.5 text-xs font-medium capitalize transition-colors",
                activeFilter === f ? "bg-navy text-white" : "text-navy/70 hover:text-navy",
              )}
            >
              {f}
            </button>
          ))}
        </div>

        {/* View toggle */}
        <div className="ml-auto flex rounded-lg border border-surface-border bg-white p-1">
          <button
            onClick={() => setViewMode("list")}
            className={cn(
              "rounded p-1.5 transition-colors",
              viewMode === "list" ? "bg-navy text-white" : "text-navy/70 hover:text-navy",
            )}
            title="List view"
          >
            <LayoutList className="h-4 w-4" />
          </button>
          <button
            onClick={() => setViewMode("grid")}
            className={cn(
              "rounded p-1.5 transition-colors",
              viewMode === "grid" ? "bg-navy text-white" : "text-navy/70 hover:text-navy",
            )}
            title="Grid view"
          >
            <LayoutGrid className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Loading skeleton */}
      {isLoading ? (
        viewMode === "list" ? (
          <div className="overflow-hidden rounded-xl border border-surface-border bg-white">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="flex items-center gap-4 border-b border-surface-border px-4 py-3"
              >
                <div className="h-7 w-7 animate-pulse rounded-md bg-surface-raised" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-3.5 w-40 animate-pulse rounded bg-surface-raised" />
                  <div className="h-3 w-24 animate-pulse rounded bg-surface-raised" />
                </div>
                <div className="h-3 w-28 animate-pulse rounded bg-surface-raised" />
                <div className="h-5 w-20 animate-pulse rounded-full bg-surface-raised" />
              </div>
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <div
                key={i}
                className="h-48 animate-pulse rounded-xl border border-surface-border bg-surface-raised"
              />
            ))}
          </div>
        )
      ) : isError ? (
        <div className="flex items-center gap-2 rounded-lg border border-danger/30 bg-danger-bg px-4 py-3">
          <span className="text-sm text-danger">Failed to load data. Please try refreshing.</span>
        </div>
      ) : suppliers.length === 0 ? (
        <div className="rounded-xl border border-surface-border bg-white py-16 text-center">
          <Building2 className="mx-auto mb-3 h-10 w-10 text-navy/15" />
          <p className="text-sm font-medium text-navy/70">
            {search || activeFilter !== "all"
              ? "No suppliers match your filters."
              : "No suppliers yet. Add your first supplier to get started."}
          </p>
          {search || activeFilter !== "all" ? (
            <button
              onClick={() => {
                setSearch("");
                setActiveFilter("all");
              }}
              className="mt-2 text-sm text-brand-500 hover:underline"
            >
              Clear filters
            </button>
          ) : (
            <button
              onClick={() => setShowModal(true)}
              className="mt-2 text-sm text-brand-500 hover:underline"
            >
              Add your first supplier →
            </button>
          )}
        </div>
      ) : viewMode === "list" ? (
        /* ── List view ── */
        <div className="overflow-hidden rounded-xl border border-surface-border bg-white">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-surface-border bg-surface-raised/60">
                  {selectMode && <th className="w-10 px-4 py-2.5" />}
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-navy/70 uppercase tracking-wide">
                    Supplier
                  </th>
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-navy/70 uppercase tracking-wide">
                    Contact
                  </th>
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-navy/70 uppercase tracking-wide">
                    Location
                  </th>
                  <th className="px-4 py-2.5 text-center text-xs font-semibold text-navy/70 uppercase tracking-wide">
                    Lead
                  </th>
                  <th className="px-4 py-2.5 text-right text-xs font-semibold text-navy/70 uppercase tracking-wide">
                    Outstanding
                  </th>
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-navy/70 uppercase tracking-wide">
                    Status
                  </th>
                  <th className="w-20 px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {suppliers.map((s) => (
                  <SupplierRow key={s.id} {...sharedRowProps(s)} />
                ))}
              </tbody>
            </table>
          </div>

          {/* Total outstanding footer */}
          {totalOutstanding > 0 && (
            <div className="flex items-center justify-between border-t border-surface-border bg-surface-raised/40 px-4 py-2.5">
              <span className="text-xs text-navy/70">Total outstanding across all suppliers</span>
              <span className="text-sm font-semibold text-warning">{fmt(totalOutstanding)}</span>
            </div>
          )}
        </div>
      ) : (
        /* ── Grid view ── */
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {suppliers.map((s) => (
            <SupplierCard key={s.id} {...sharedRowProps(s)} />
          ))}
        </div>
      )}
    </div>
  );
}
