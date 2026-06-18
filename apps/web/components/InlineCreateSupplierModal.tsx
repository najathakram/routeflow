"use client";

import * as React from "react";
import { X } from "lucide-react";
import { Button, useToast } from "@routeflow/ui/web";
import { useCreateSupplier, type Supplier } from "@/lib/api/suppliers";

/**
 * Mirrors `InlineCreateProductModal` — opens above any other modal
 * (z-[200] so it stacks above the Scan Invoice / Quick Restock dialogs)
 * and returns the new supplier to the caller via `onCreated` so the
 * parent dropdown can auto-select it.
 */
interface InlineCreateSupplierModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Called with the newly created supplier so the caller can auto-select it */
  onCreated: (supplier: Supplier) => void;
  /** Pre-fill name from a search term the operator typed */
  initialName?: string;
}

export function InlineCreateSupplierModal({
  isOpen,
  onClose,
  onCreated,
  initialName = "",
}: InlineCreateSupplierModalProps) {
  const { toast } = useToast();
  const createSupplier = useCreateSupplier();

  const [form, setForm] = React.useState({
    name: initialName,
    contactName: "",
    phone: "",
    email: "",
    website: "",
    addressLine1: "",
    city: "",
    state: "",
    zip: "",
  });

  // Sync initialName when modal opens
  React.useEffect(() => {
    if (isOpen) {
      setForm((f) => ({ ...f, name: initialName }));
    }
  }, [isOpen, initialName]);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const name = form.name.trim();
    if (!name) {
      toast({ title: "Supplier name is required", variant: "error" });
      return;
    }

    // Strip empty strings so we don't pollute the row with "" for every blank field
    const payload: Partial<Supplier> = {
      name,
      ...(form.contactName.trim() && { contactName: form.contactName.trim() }),
      ...(form.phone.trim() && { phone: form.phone.trim() }),
      ...(form.email.trim() && { email: form.email.trim() }),
      ...(form.website.trim() && { website: form.website.trim() }),
      ...(form.addressLine1.trim() && { addressLine1: form.addressLine1.trim() }),
      ...(form.city.trim() && { city: form.city.trim() }),
      ...(form.state.trim() && { state: form.state.trim() }),
      ...(form.zip.trim() && { zip: form.zip.trim() }),
    };

    createSupplier.mutate(payload, {
      onSuccess: (supplier: Supplier) => {
        toast({
          title: "Supplier created",
          description: `${supplier.name} has been added.`,
          variant: "success",
        });
        onCreated(supplier);
        onClose();
        setForm({
          name: "",
          contactName: "",
          phone: "",
          email: "",
          website: "",
          addressLine1: "",
          city: "",
          state: "",
          zip: "",
        });
      },
      onError: (err: any) => {
        toast({
          title: "Failed to create supplier",
          description: err?.response?.data?.message ?? "Check the details and try again.",
          variant: "error",
        });
      },
    });
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-xl bg-white shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-surface-border px-6 py-4">
          <h2 className="text-base font-semibold text-navy">New Supplier</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-navy/70 hover:bg-surface-raised hover:text-navy"
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 px-6 py-4">
          {/* ── Name (required) ── */}
          <div>
            <label className="mb-1 block text-xs font-medium text-navy">
              Name <span className="text-danger">*</span>
            </label>
            <input
              required
              autoFocus
              type="text"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
              placeholder="e.g. Sysco Foods"
            />
          </div>

          {/* ── Contact name + phone ── */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-navy">Contact name</label>
              <input
                type="text"
                value={form.contactName}
                onChange={(e) => setForm((f) => ({ ...f, contactName: e.target.value }))}
                className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                placeholder="e.g. Jane Doe"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-navy">Phone</label>
              <input
                type="tel"
                value={form.phone}
                onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                placeholder="(555) 123-4567"
              />
            </div>
          </div>

          {/* ── Email + website ── */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-navy">Email</label>
              <input
                type="email"
                value={form.email}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                placeholder="orders@supplier.com"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-navy">Website</label>
              <input
                type="url"
                value={form.website}
                onChange={(e) => setForm((f) => ({ ...f, website: e.target.value }))}
                className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                placeholder="https://…"
              />
            </div>
          </div>

          {/* ── Address ── */}
          <div>
            <label className="mb-1 block text-xs font-medium text-navy">Address</label>
            <input
              type="text"
              value={form.addressLine1}
              onChange={(e) => setForm((f) => ({ ...f, addressLine1: e.target.value }))}
              className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
              placeholder="Street address"
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-navy">City</label>
              <input
                type="text"
                value={form.city}
                onChange={(e) => setForm((f) => ({ ...f, city: e.target.value }))}
                className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-navy">State</label>
              <input
                type="text"
                value={form.state}
                onChange={(e) => setForm((f) => ({ ...f, state: e.target.value }))}
                className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-navy">ZIP</label>
              <input
                type="text"
                value={form.zip}
                onChange={(e) => setForm((f) => ({ ...f, zip: e.target.value }))}
                className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={createSupplier.isPending}>
              Create Supplier
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
