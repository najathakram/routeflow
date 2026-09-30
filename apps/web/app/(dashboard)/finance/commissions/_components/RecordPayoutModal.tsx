"use client";

import * as React from "react";
import { Modal, Button, Select, Input, Textarea, useToast } from "@routeflow/ui/web";
import { MoneyInput } from "@/components/MoneyInput";
import { SELECTABLE_PAYMENT_METHODS, paymentMethodLabel } from "@/lib/payment-methods";
import { useRecordCommissionPayout, type CommissionStatementDetail } from "@/lib/api/sales-agents";
import { fmt, todayIso } from "@/lib/formatting";

/**
 * PR-D WP6 — record a payout against an APPROVED statement. Amount defaults to
 * the remaining balance (STORED totalAmount − paidAmount); an over-cap 400
 * carries the exact remaining in its message and surfaces via the global
 * mutation-error toast (providers.tsx), so nothing is re-derived here.
 */
export function RecordPayoutModal({
  open,
  onClose,
  statement,
}: {
  open: boolean;
  onClose: () => void;
  statement: CommissionStatementDetail;
}) {
  const { toast } = useToast();
  const recordPayout = useRecordCommissionPayout();
  const remaining = Number(statement.totalAmount) - Number(statement.paidAmount);

  const [amount, setAmount] = React.useState<number | null>(remaining);
  const [method, setMethod] = React.useState<string>(SELECTABLE_PAYMENT_METHODS[0]);
  const [reference, setReference] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [paidAt, setPaidAt] = React.useState(todayIso());

  React.useEffect(() => {
    if (open) {
      setAmount(remaining);
      setMethod(SELECTABLE_PAYMENT_METHODS[0]);
      setReference("");
      setNotes("");
      setPaidAt(todayIso());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleClose = () => {
    if (recordPayout.isPending) return;
    onClose();
  };

  const handleSubmit = () => {
    if (amount == null || amount <= 0) return;
    recordPayout.mutate(
      {
        id: statement.id,
        amount,
        method,
        reference: reference || undefined,
        notes: notes || undefined,
        paidAt: paidAt || undefined,
      },
      {
        onSuccess: () => {
          toast({ title: "Payout recorded", variant: "success" });
          onClose();
        },
        // Over-cap 400 carries the exact remaining in its message — the global
        // toast suffices; the statement flips to PAID at the cap server-side
        // and the hook's invalidation refreshes the page with that state.
      },
    );
  };

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Record payout"
      description={`Remaining balance: ${fmt(remaining)}`}
      footer={
        <>
          <Button variant="secondary" onClick={handleClose} disabled={recordPayout.isPending}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            loading={recordPayout.isPending}
            disabled={amount == null || amount <= 0}
          >
            Record payout
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-col gap-1">
          <label className="text-sm font-medium text-navy" htmlFor="payout-amount">
            Amount
          </label>
          <MoneyInput id="payout-amount" value={amount} onChange={setAmount} />
        </div>
        <Select
          label="Method"
          value={method}
          onChange={(e) => setMethod(e.target.value)}
          options={SELECTABLE_PAYMENT_METHODS.map((m) => ({
            value: m,
            label: paymentMethodLabel(m),
          }))}
        />
        <Input
          label="Reference (optional)"
          value={reference}
          onChange={(e) => setReference(e.target.value)}
          placeholder="Check #, transfer id, …"
        />
        <Textarea
          label="Notes (optional)"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
        />
        <div className="flex flex-col gap-1">
          <label className="text-sm font-medium text-navy" htmlFor="payout-paid-at">
            Paid on
          </label>
          <input
            id="payout-paid-at"
            type="date"
            value={paidAt}
            onChange={(e) => setPaidAt(e.target.value)}
            className="h-10 w-full rounded border border-surface-border bg-white px-3 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>
      </div>
    </Modal>
  );
}
