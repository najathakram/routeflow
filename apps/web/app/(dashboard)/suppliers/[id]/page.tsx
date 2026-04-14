"use client";

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeft, Building2, Phone, Mail, Globe, MapPin, Clock,
  Pencil, DollarSign, Receipt, X, CheckCircle2, AlertCircle,
  FileText, Truck,
} from "lucide-react";
import { Badge, Button, cn } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { useToast } from "@routeflow/ui/web";
import { useSupplier, useUpdateSupplier, type Supplier } from "@/lib/api/suppliers";
import { useVendorBills, type VendorBill, type VendorBillStatus } from "@/lib/api/vendor-bills";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n?: number | null) {
  if (n == null) return "—";
  return `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDate(s?: string | null) {
  if (!s) return "—";
  return new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

const STATUS_LABELS: Record<VendorBillStatus, string> = {
  DRAFT: "Draft",
  RECEIVED: "Received",
  PARTIAL: "Partial",
  PAID: "Paid",
  VOID: "Void",
};

const STATUS_VARIANTS: Record<VendorBillStatus, "neutral" | "warning" | "success" | "danger"> = {
  DRAFT: "neutral",
  RECEIVED: "warning",
  PARTIAL: "warning",
  PAID: "success",
  VOID: "danger",
};

// ─── Edit modal (reuses the form from the list page inline) ───────────────────

function EditModal({
  supplier, onClose, onSave, isSaving,
}: {
  supplier: Supplier;
  onClose: () => void;
  onSave: (data: Partial<Supplier>) => Promise<void>;
  isSaving: boolean;
}) {
  const [form, setForm] = React.useState({
    name: supplier.name ?? "",
    contactName: supplier.contactName ?? "",
    phone: supplier.phone ?? "",
    mobile: supplier.mobile ?? "",
    email: supplier.email ?? "",
    website: supplier.website ?? "",
    notes: supplier.notes ?? "",
    leadTimeDays: supplier.leadTimeDays != null ? String(supplier.leadTimeDays) : "",
    addressLine1: supplier.addressLine1 ?? "",
    addressLine2: supplier.addressLine2 ?? "",
    city: supplier.city ?? "",
    state: supplier.state ?? "",
    zip: supplier.zip ?? "",
    country: supplier.country ?? "",
  });
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const inputCls = "w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-xl border border-surface-border bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-surface-border px-6 py-4">
          <h2 className="text-base font-semibold text-navy">Edit Supplier</h2>
          <button onClick={onClose} className="text-navy/40 hover:text-navy transition-colors"><X className="h-4 w-4" /></button>
        </div>
        <form
          onSubmit={async (e) => {
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
              addressLine1: form.addressLine1 || undefined,
              addressLine2: form.addressLine2 || undefined,
              city: form.city || undefined,
              state: form.state || undefined,
              zip: form.zip || undefined,
              country: form.country || undefined,
            });
          }}
          className="max-h-[80vh] overflow-y-auto p-6 space-y-4"
        >
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="mb-1 block text-xs font-medium text-navy/60 uppercase tracking-wide">Company name *</label>
              <input required value={form.name} onChange={(e) => set("name", e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-navy/60 uppercase tracking-wide">Contact person</label>
              <input value={form.contactName} onChange={(e) => set("contactName", e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-navy/60 uppercase tracking-wide">Lead time (days)</label>
              <input type="number" min="0" value={form.leadTimeDays} onChange={(e) => set("leadTimeDays", e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-navy/60 uppercase tracking-wide">Phone</label>
              <input type="tel" value={form.phone} onChange={(e) => set("phone", e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-navy/60 uppercase tracking-wide">Mobile</label>
              <input type="tel" value={form.mobile} onChange={(e) => set("mobile", e.target.value)} className={inputCls} />
            </div>
            <div className="col-span-2">
              <label className="mb-1 block text-xs font-medium text-navy/60 uppercase tracking-wide">Email</label>
              <input type="email" value={form.email} onChange={(e) => set("email", e.target.value)} className={inputCls} />
            </div>
            <div className="col-span-2">
              <label className="mb-1 block text-xs font-medium text-navy/60 uppercase tracking-wide">Website</label>
              <input value={form.website} onChange={(e) => set("website", e.target.value)} placeholder="https://" className={inputCls} />
            </div>
          </div>
          <div>
            <p className="mb-2 text-xs font-medium text-navy/60 uppercase tracking-wide">Address</p>
            <div className="space-y-2">
              <input placeholder="Street address" value={form.addressLine1} onChange={(e) => set("addressLine1", e.target.value)} className={inputCls} />
              <div className="grid grid-cols-3 gap-2">
                <input placeholder="City" value={form.city} onChange={(e) => set("city", e.target.value)} className={inputCls} />
                <input placeholder="State" value={form.state} onChange={(e) => set("state", e.target.value)} className={inputCls} />
                <input placeholder="ZIP" value={form.zip} onChange={(e) => set("zip", e.target.value)} className={inputCls} />
              </div>
              <input placeholder="Country" value={form.country} onChange={(e) => set("country", e.target.value)} className={inputCls} />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-navy/60 uppercase tracking-wide">Notes</label>
            <textarea rows={3} value={form.notes} onChange={(e) => set("notes", e.target.value)} className={inputCls} />
          </div>
          <div className="flex justify-end gap-2 border-t border-surface-border pt-4">
            <Button type="button" variant="secondary" onClick={onClose} disabled={isSaving}>Cancel</Button>
            <Button type="submit" loading={isSaving}>Save changes</Button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Bill row ──────────────────────────────────────────────────────────────────

function BillRow({ bill }: { bill: VendorBill }) {
  const outstanding = Math.max(0, Number(bill.totalOwed) - Number(bill.totalPaid));
  return (
    <tr className="border-b border-surface-border last:border-0 hover:bg-surface-raised/40 transition-colors">
      <td className="px-5 py-3">
        <span className="font-mono text-sm text-navy">{bill.billNumber}</span>
      </td>
      <td className="px-5 py-3 text-sm text-navy/70">{fmtDate(bill.billDate)}</td>
      <td className="px-5 py-3">
        <Badge variant={STATUS_VARIANTS[bill.status]} label={STATUS_LABELS[bill.status]} />
      </td>
      <td className="px-5 py-3 text-right text-sm text-navy">{fmt(bill.totalOwed)}</td>
      <td className="px-5 py-3 text-right text-sm text-navy/60">{fmt(bill.totalPaid)}</td>
      <td className={cn("px-5 py-3 text-right text-sm font-medium", outstanding > 0 ? "text-warning" : "text-navy/40")}>
        {outstanding > 0 ? fmt(outstanding) : "—"}
      </td>
      <td className="px-5 py-3 text-xs text-navy/50 max-w-xs truncate">{bill.notes ?? "—"}</td>
    </tr>
  );
}

// ─── Page ──────────────────────────────────────────────────────────────────────

export default function SupplierDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { setTitle } = usePageTitle();
  const { toast } = useToast();
  const [showEdit, setShowEdit] = React.useState(false);

  const { data: supplier, isLoading, isError } = useSupplier(params.id);
  const { data: billsResult } = useVendorBills({ supplierId: params.id, limit: 50 });
  const updateSupplier = useUpdateSupplier();

  React.useEffect(() => {
    if (supplier?.name) setTitle(supplier.name);
    else setTitle("Supplier");
  }, [supplier?.name, setTitle]);

  if (isLoading) {
    return (
      <div className="space-y-5 p-6">
        <div className="h-6 w-48 animate-pulse rounded bg-surface-raised" />
        <div className="grid grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-28 animate-pulse rounded-xl bg-surface-raised" />
          ))}
        </div>
      </div>
    );
  }

  if (isError || !supplier) {
    return (
      <div className="p-6">
        <div className="rounded-lg border border-danger/30 bg-danger-bg px-4 py-3 text-sm text-danger">
          Supplier not found.
        </div>
      </div>
    );
  }

  const bills: VendorBill[] = billsResult?.data ?? [];
  const totalOwed = bills.filter((b) => b.status !== "VOID").reduce((s, b) => s + Number(b.totalOwed), 0);
  const totalPaid = bills.filter((b) => b.status !== "VOID").reduce((s, b) => s + Number(b.totalPaid), 0);
  const outstanding = Math.max(0, totalOwed - totalPaid);
  const openBills = bills.filter((b) => b.status !== "PAID" && b.status !== "VOID");

  const handleSave = async (data: Partial<Supplier>) => {
    try {
      await updateSupplier.mutateAsync({ id: supplier.id, ...data });
      toast({ title: "Supplier updated", variant: "success" });
      setShowEdit(false);
    } catch (err: any) {
      toast({ title: "Failed to save", description: err?.message, variant: "error" });
      throw err;
    }
  };

  return (
    <div className="space-y-5 p-6">
      {showEdit && (
        <EditModal
          supplier={supplier}
          onClose={() => setShowEdit(false)}
          onSave={handleSave}
          isSaving={updateSupplier.isPending}
        />
      )}

      {/* Header */}
      <div className="flex items-start gap-4">
        <button
          onClick={() => router.back()}
          className="mt-0.5 rounded-lg border border-surface-border bg-white p-2 text-navy/40 hover:text-navy transition-colors shadow-card"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className="flex flex-1 items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-brand-50 border border-brand-100">
              <Building2 className="h-6 w-6 text-brand-500" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-navy">{supplier.name}</h1>
              <div className="flex items-center gap-2 mt-0.5">
                {supplier.contactName && (
                  <span className="text-sm text-navy/50">{supplier.contactName}</span>
                )}
                <Badge
                  variant={supplier.isActive ? "success" : "neutral"}
                  label={supplier.isActive ? "Active" : "Inactive"}
                />
              </div>
            </div>
          </div>
          <Button variant="secondary" leftIcon={<Pencil className="h-4 w-4" />} onClick={() => setShowEdit(true)}>
            Edit
          </Button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {/* Outstanding */}
        <div className={cn(
          "rounded-xl border bg-white p-5 shadow-card",
          outstanding > 0 ? "border-warning/40" : "border-surface-border",
        )}>
          <div className="flex items-center gap-2 mb-2">
            <DollarSign className={cn("h-4 w-4", outstanding > 0 ? "text-warning" : "text-navy/30")} />
            <span className="text-xs font-medium text-navy/50 uppercase tracking-wide">Outstanding</span>
          </div>
          <p className={cn("text-2xl font-bold", outstanding > 0 ? "text-warning" : "text-navy/30")}>
            {outstanding > 0 ? fmt(outstanding) : "—"}
          </p>
          {outstanding > 0 && (
            <p className="mt-1 text-xs text-navy/50">
              {openBills.length} open bill{openBills.length !== 1 ? "s" : ""}
            </p>
          )}
        </div>

        {/* Total billed */}
        <div className="rounded-xl border border-surface-border bg-white p-5 shadow-card">
          <div className="flex items-center gap-2 mb-2">
            <Receipt className="h-4 w-4 text-navy/30" />
            <span className="text-xs font-medium text-navy/50 uppercase tracking-wide">Total Billed</span>
          </div>
          <p className="text-2xl font-bold text-navy">{totalOwed > 0 ? fmt(totalOwed) : "—"}</p>
          <p className="mt-1 text-xs text-navy/50">{bills.filter((b) => b.status !== "VOID").length} bills</p>
        </div>

        {/* Total paid */}
        <div className="rounded-xl border border-surface-border bg-white p-5 shadow-card">
          <div className="flex items-center gap-2 mb-2">
            <CheckCircle2 className="h-4 w-4 text-navy/30" />
            <span className="text-xs font-medium text-navy/50 uppercase tracking-wide">Total Paid</span>
          </div>
          <p className="text-2xl font-bold text-navy">{totalPaid > 0 ? fmt(totalPaid) : "—"}</p>
          <p className="mt-1 text-xs text-navy/50">
            {bills.filter((b) => b.status === "PAID").length} paid bills
          </p>
        </div>
      </div>

      {/* Details + Bills */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        {/* Contact details */}
        <div className="lg:col-span-1 space-y-4">
          <div className="rounded-xl border border-surface-border bg-white p-5 shadow-card">
            <h2 className="mb-4 text-sm font-semibold text-navy">Contact Details</h2>
            <div className="space-y-3">
              {(supplier.phone || supplier.mobile) && (
                <div className="flex items-center gap-2.5">
                  <Phone className="h-4 w-4 shrink-0 text-navy/30" />
                  <div>
                    {supplier.phone && <p className="text-sm text-navy">{supplier.phone}</p>}
                    {supplier.mobile && supplier.mobile !== supplier.phone && (
                      <p className="text-sm text-navy/70">{supplier.mobile}</p>
                    )}
                  </div>
                </div>
              )}
              {supplier.email && (
                <div className="flex items-center gap-2.5">
                  <Mail className="h-4 w-4 shrink-0 text-navy/30" />
                  <a href={`mailto:${supplier.email}`} className="text-sm text-brand-600 hover:underline break-all">
                    {supplier.email}
                  </a>
                </div>
              )}
              {supplier.website && (
                <div className="flex items-center gap-2.5">
                  <Globe className="h-4 w-4 shrink-0 text-navy/30" />
                  <a
                    href={supplier.website.startsWith("http") ? supplier.website : `https://${supplier.website}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-brand-600 hover:underline break-all"
                  >
                    {supplier.website.replace(/^https?:\/\//, "")}
                  </a>
                </div>
              )}
              {supplier.addressLine1 && (
                <div className="flex items-start gap-2.5">
                  <MapPin className="h-4 w-4 shrink-0 text-navy/30 mt-0.5" />
                  <div className="text-sm text-navy/70">
                    <p>{supplier.addressLine1}</p>
                    {supplier.addressLine2 && <p>{supplier.addressLine2}</p>}
                    <p>{[supplier.city, supplier.state, supplier.zip].filter(Boolean).join(", ")}</p>
                    {supplier.country && <p>{supplier.country}</p>}
                  </div>
                </div>
              )}
              {supplier.leadTimeDays != null && (
                <div className="flex items-center gap-2.5">
                  <Truck className="h-4 w-4 shrink-0 text-navy/30" />
                  <p className="text-sm text-navy">{supplier.leadTimeDays} day lead time</p>
                </div>
              )}
              {supplier.notes && (
                <div className="mt-3 rounded-lg bg-surface-raised p-3">
                  <p className="text-xs font-medium text-navy/50 mb-1">Notes</p>
                  <p className="text-sm text-navy/70 whitespace-pre-line">{supplier.notes}</p>
                </div>
              )}
              {!supplier.phone && !supplier.mobile && !supplier.email && !supplier.website && !supplier.addressLine1 && !supplier.leadTimeDays && !supplier.notes && (
                <p className="text-sm text-navy/40 text-center py-4">No contact details recorded.</p>
              )}
            </div>
          </div>
        </div>

        {/* Vendor bills */}
        <div className="lg:col-span-2">
          <div className="rounded-xl border border-surface-border bg-white shadow-card overflow-hidden">
            <div className="flex items-center justify-between border-b border-surface-border px-5 py-4">
              <div className="flex items-center gap-2">
                <FileText className="h-4 w-4 text-navy/40" />
                <h2 className="text-sm font-semibold text-navy">Purchase Bills</h2>
                {bills.length > 0 && (
                  <span className="rounded-full bg-surface-raised px-2 py-0.5 text-xs font-medium text-navy/60">
                    {bills.length}
                  </span>
                )}
              </div>
            </div>

            {bills.length === 0 ? (
              <div className="py-12 text-center">
                <Receipt className="mx-auto mb-3 h-8 w-8 text-navy/15" />
                <p className="text-sm text-navy/40">No bills recorded for this supplier.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-surface-border bg-surface-raised/60">
                      <th className="px-5 py-2.5 text-left text-xs font-semibold text-navy/50 uppercase tracking-wide">Bill #</th>
                      <th className="px-5 py-2.5 text-left text-xs font-semibold text-navy/50 uppercase tracking-wide">Date</th>
                      <th className="px-5 py-2.5 text-left text-xs font-semibold text-navy/50 uppercase tracking-wide">Status</th>
                      <th className="px-5 py-2.5 text-right text-xs font-semibold text-navy/50 uppercase tracking-wide">Billed</th>
                      <th className="px-5 py-2.5 text-right text-xs font-semibold text-navy/50 uppercase tracking-wide">Paid</th>
                      <th className="px-5 py-2.5 text-right text-xs font-semibold text-navy/50 uppercase tracking-wide">Due</th>
                      <th className="px-5 py-2.5 text-left text-xs font-semibold text-navy/50 uppercase tracking-wide">Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bills.map((b) => <BillRow key={b.id} bill={b} />)}
                  </tbody>
                  {outstanding > 0 && (
                    <tfoot>
                      <tr className="border-t-2 border-surface-border bg-surface-raised/40">
                        <td colSpan={5} className="px-5 py-3 text-sm font-semibold text-navy text-right">
                          Total outstanding
                        </td>
                        <td className="px-5 py-3 text-right text-sm font-bold text-warning">
                          {fmt(outstanding)}
                        </td>
                        <td />
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
