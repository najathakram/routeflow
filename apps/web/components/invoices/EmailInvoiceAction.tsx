"use client";

import * as React from "react";
import { Send } from "lucide-react";
import { Button } from "@routeflow/ui/web";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
  invoiceResendCopy,
  type InvoiceSendLock,
  type InvoiceSendState,
} from "@/lib/invoice-send-state";

/**
 * #2088: the invoice's Send / "Email again" action. The server decides the state (`sendState`, an exact content
 * fingerprint compare) and the lock (`sendLocked`, the pre-delivery mirror); this only words them. A first send goes
 * straight out; an invoice emailed before asks first, saying whether it changed since. A locked invoice shows WHY
 * (a disabled action with the reason), not a missing button.
 */
export function EmailInvoiceAction({
  sendState,
  sendLocked,
  lockedLabel,
  loading,
  onSend,
}: {
  sendState?: InvoiceSendState | null;
  sendLocked?: InvoiceSendLock | null;
  /** The locked reason in the business's own words ("Sends after pickup" for a store-only business). */
  lockedLabel: string;
  loading?: boolean;
  onSend: () => void;
}) {
  const [asking, setAsking] = React.useState(false);
  const copy = invoiceResendCopy(sendState);

  if (sendLocked) {
    return (
      <span className="inline-flex items-center gap-2">
        <Button
          size="sm"
          variant="primary"
          leftIcon={<Send className="h-3.5 w-3.5" />}
          disabled
          aria-describedby="send-locked-reason"
          title={`${lockedLabel}. Edit the order instead; the invoice updates automatically.`}
        >
          {copy.action}
        </Button>
        <span id="send-locked-reason" className="text-xs font-medium text-navy/60">
          {lockedLabel}
        </span>
      </span>
    );
  }

  return (
    <>
      <Button
        size="sm"
        variant={copy.confirm ? "secondary" : "primary"}
        leftIcon={<Send className="h-3.5 w-3.5" />}
        onClick={() => (copy.confirm ? setAsking(true) : onSend())}
        loading={loading}
      >
        {copy.action}
      </Button>
      {copy.confirm && (
        <ConfirmDialog
          open={asking}
          onClose={() => setAsking(false)}
          onConfirm={() => {
            setAsking(false);
            onSend();
          }}
          title={copy.action}
          description={copy.confirm}
          confirmLabel={copy.confirmButton}
          variant="secondary"
          loading={loading}
        />
      )}
    </>
  );
}
