"use client";

import * as React from "react";
import { Modal, Button, useToast } from "@routeflow/ui/web";
import { useCustomers, type Customer } from "@/lib/api/customers";
import { todayIso } from "@/lib/formatting";
import { useAddAssignment, useBulkAssign, type RecomputeResult } from "@/lib/api/sales-agents";

export interface AssignCustomersModalProps {
  agentId: string;
  isOpen: boolean;
  onClose: () => void;
}

// POST /sales-agents/:id/assignments/bulk caps customerIds at 500 (ArrayMaxSize).
const MAX_CUSTOMERS = 500;

/**
 * Multi-select customer picker for the agent detail page's "Assign
 * customers" action. A single pick goes through `POST .../assignments`
 * (useAddAssignment) so the single-row 400 (interval inversion) reads
 * naturally; several go through the one-tx bulk route (useBulkAssign) with
 * the same effective-from applied to every selected customer. Both mutations
 * may backdate and trigger a commission resync — the recompute count from
 * the response is folded into the success toast, never predicted client-side.
 */
export function AssignCustomersModal({ agentId, isOpen, onClose }: AssignCustomersModalProps) {
  const { toast } = useToast();
  const [search, setSearch] = React.useState("");
  const [debouncedSearch, setDebouncedSearch] = React.useState("");
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [effectiveFrom, setEffectiveFrom] = React.useState(todayIso());

  const addAssignment = useAddAssignment(agentId);
  const bulkAssign = useBulkAssign(agentId);
  const isPending = addAssignment.isPending || bulkAssign.isPending;

  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Fresh picker every time the modal opens.
  React.useEffect(() => {
    if (!isOpen) return;
    setSearch("");
    setDebouncedSearch("");
    setSelected(new Set());
    setEffectiveFrom(todayIso());
  }, [isOpen]);

  const { data } = useCustomers({ search: debouncedSearch || undefined, limit: 50 });
  const customers: Customer[] = data?.data ?? [];

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < MAX_CUSTOMERS) next.add(id);
      return next;
    });
  };

  const handleSubmit = () => {
    if (selected.size === 0) return;
    const ids = Array.from(selected);
    const onSuccess = (result: RecomputeResult) => {
      toast({
        title: ids.length === 1 ? "Customer assigned" : `${ids.length} customers assigned`,
        description: result.recompute
          ? `Recomputed ${result.recompute.invoicesSynced} invoice(s)`
          : undefined,
        variant: "success",
      });
      onClose();
    };
    if (ids.length === 1) {
      addAssignment.mutate({ customerId: ids[0], effectiveFrom }, { onSuccess });
    } else {
      bulkAssign.mutate({ customerIds: ids, effectiveFrom }, { onSuccess });
    }
  };

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title="Assign Customers"
      description="Backdating recomputes commission from that date."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} loading={isPending} disabled={selected.size === 0}>
            Assign{selected.size > 0 ? ` (${selected.size})` : ""}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <input
          type="search"
          placeholder="Search customers…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-9 w-full rounded border border-surface-border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
        <div>
          <label className="mb-1 block text-sm font-medium text-navy">Effective from</label>
          <input
            type="date"
            value={effectiveFrom}
            onChange={(e) => setEffectiveFrom(e.target.value)}
            className="h-9 w-full rounded border border-surface-border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>
        {customers.length === 0 ? (
          <p className="rounded-lg border border-dashed border-surface-border bg-surface-raised px-3 py-4 text-center text-xs text-navy/70">
            No customers found.
          </p>
        ) : (
          <ul className="max-h-64 divide-y divide-surface-border overflow-auto rounded-lg border border-surface-border">
            {customers.map((c) => (
              <li key={c.id}>
                <label className="flex cursor-pointer items-center gap-2.5 px-3 py-2 text-sm hover:bg-surface-raised">
                  <input
                    type="checkbox"
                    checked={selected.has(c.id)}
                    onChange={() => toggle(c.id)}
                    className="h-4 w-4 shrink-0 accent-brand-500"
                  />
                  <span className="min-w-0 flex-1 truncate text-navy">{c.businessName}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
        {selected.size >= MAX_CUSTOMERS && (
          <p className="text-xs text-warning-700">Maximum {MAX_CUSTOMERS} customers per batch.</p>
        )}
      </div>
    </Modal>
  );
}
