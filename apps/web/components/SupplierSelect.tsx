"use client";

import * as React from "react";
import { Plus } from "lucide-react";
import { cn } from "@routeflow/ui/web";
import { InlineCreateSupplierModal } from "./InlineCreateSupplierModal";
import type { Supplier } from "@/lib/api/suppliers";

/**
 * Supplier dropdown + inline-create button.
 *
 * Drop-in replacement for the bare `<select>` + `useSuppliers()` pattern
 * that's repeated across Scan Invoice, Quick Restock, manual vendor bill,
 * expense create, and bill-detail edit. Clicking the "+ New" button opens
 * `InlineCreateSupplierModal`; on save, the new supplier is auto-selected
 * via `onChange(newSupplier.id)`.
 */
interface SupplierSelectProps {
  value: string;
  onChange: (supplierId: string) => void;
  suppliers: Pick<Supplier, "id" | "name">[];
  /** Custom placeholder text inside the select (default: "— Select supplier —") */
  placeholder?: string;
  /** Extra classes for the <select> */
  className?: string;
  /** Disable the whole control */
  disabled?: boolean;
  /** Hide the "+ New" button (rare — use when the user shouldn't create suppliers) */
  hideCreate?: boolean;
  /** id/aria-label hooks for screen readers */
  id?: string;
  ariaLabel?: string;
}

export function SupplierSelect({
  value,
  onChange,
  suppliers,
  placeholder = "— Select supplier —",
  className,
  disabled,
  hideCreate,
  id,
  ariaLabel,
}: SupplierSelectProps) {
  const [createOpen, setCreateOpen] = React.useState(false);

  return (
    <>
      <div className="flex items-stretch gap-2">
        <select
          id={id}
          aria-label={ariaLabel}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className={cn(
            "flex-1 rounded-lg border border-surface-border bg-white px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:cursor-not-allowed disabled:bg-surface-raised",
            className,
          )}
        >
          <option value="">{placeholder}</option>
          {suppliers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        {!hideCreate && (
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            disabled={disabled}
            className="inline-flex items-center gap-1 rounded-lg border border-surface-border bg-white px-2.5 text-xs font-medium text-brand-600 transition-colors hover:border-brand-300 hover:bg-brand-50 disabled:cursor-not-allowed disabled:text-navy/30 disabled:hover:bg-white"
            title="Create a new supplier"
          >
            <Plus className="h-3.5 w-3.5" />
            New
          </button>
        )}
      </div>

      <InlineCreateSupplierModal
        isOpen={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(supplier) => {
          // Auto-select the new supplier in the parent form
          onChange(supplier.id);
        }}
      />
    </>
  );
}
