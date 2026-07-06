"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ClipboardEdit, PackagePlus, CreditCard, ChevronRight } from "lucide-react";
import { Modal } from "@routeflow/ui/web";

// ─── ArrivedStopSheet ──────────────────────────────────────────────────────────
// pos-cost-roles-spec.md §3 "At-the-door actions" — on an arrived stop, one sheet
// offers everything ≤2 taps deep. This sheet is purely a navigation dispatcher:
// it does not reimplement any flow, it links to the EXISTING order/payment
// screens and closes on selection. No new API calls, no new endpoints.

export interface ArrivedStopSheetOrder {
  id: string;
  orderNumber?: string | null;
}

export interface ArrivedStopSheetProps {
  open: boolean;
  onClose: () => void;
  customerName: string;
  /** The stop's existing order(s), if any — "Adjust order" only shows when present. */
  orders?: ArrivedStopSheetOrder[];
}

function ActionTile({
  icon,
  title,
  subtitle,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-lg border border-surface-border bg-white px-4 py-3.5 text-left transition-colors hover:border-brand-300 hover:bg-brand-50/50"
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-600">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-navy">{title}</span>
        <span className="block text-xs text-navy/70">{subtitle}</span>
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-navy/30" />
    </button>
  );
}

export function ArrivedStopSheet({
  open,
  onClose,
  customerName,
  orders = [],
}: ArrivedStopSheetProps) {
  const router = useRouter();
  const primaryOrder = orders[0];

  const go = (href: string) => {
    onClose();
    router.push(href);
  };

  return (
    <Modal open={open} onClose={onClose} title={customerName} className="max-w-sm">
      <p className="mb-4 text-xs text-navy/70">At-the-door actions</p>
      <div className="space-y-2.5">
        {primaryOrder && (
          <ActionTile
            icon={<ClipboardEdit className="h-5 w-5" />}
            title="Adjust order"
            subtitle={
              primaryOrder.orderNumber
                ? `Edit order #${primaryOrder.orderNumber} — qty, lines, POD`
                : "Edit this stop's order — qty, lines, POD"
            }
            onClick={() => go(`/orders/${primaryOrder.id}`)}
          />
        )}
        <ActionTile
          icon={<PackagePlus className="h-5 w-5" />}
          title="New order at door"
          subtitle="Open the order builder for this delivery"
          onClick={() => go("/orders?action=new")}
        />
        <ActionTile
          icon={<CreditCard className="h-5 w-5" />}
          title="Collect payment"
          subtitle="Record a payment against this customer's balance"
          onClick={() => go("/finance/payments")}
        />
      </div>
    </Modal>
  );
}
