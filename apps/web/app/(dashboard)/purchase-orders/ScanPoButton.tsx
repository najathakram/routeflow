"use client";

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Lock, Sparkles } from "lucide-react";
import { Button, Modal, useToast } from "@routeflow/ui/web";
import { ScanInvoiceModal } from "@/components/ScanInvoiceModal";
import { usePlanFlag } from "@/lib/api/plan-flags";
import { SCAN_LOCK_BODY, SCAN_LOCK_TITLE, scanPoAccess } from "@/lib/scan-po-lock";

/** "Scan supplier invoice": opens the scanner in purchase-order mode, or a friendly lock notice
 *  when the plan doesn't include scanning. Manual POs never depend on this. */
export function ScanPoButton({ onDrafted }: { onDrafted: (poId: string) => void }) {
  const flag = usePlanFlag("flag.ap_bills");
  const access = scanPoAccess(flag);
  const [scanOpen, setScanOpen] = React.useState(false);
  const [lockOpen, setLockOpen] = React.useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const onClick = () => (access === "locked" ? setLockOpen(true) : setScanOpen(true));

  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        disabled={access === "pending"}
        onClick={onClick}
        leftIcon={
          access === "locked" ? <Lock className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />
        }
      >
        Scan supplier invoice
      </Button>

      {scanOpen && (
        <ScanInvoiceModal
          open
          intent="purchase-order"
          onClose={() => setScanOpen(false)}
          onPurchaseOrderCreated={(po) => {
            void queryClient.invalidateQueries({ queryKey: ["inventory", "purchase-orders"] });
            toast({
              title: po.poNumber
                ? `PO ${po.poNumber} drafted — open it below`
                : "Purchase order drafted — open it below",
              variant: "success",
            });
            onDrafted(po.id);
          }}
        />
      )}

      <Modal
        open={lockOpen}
        onClose={() => setLockOpen(false)}
        title={SCAN_LOCK_TITLE}
        description={SCAN_LOCK_BODY}
        footer={<Button onClick={() => setLockOpen(false)}>Got it</Button>}
      >
        <p className="text-sm text-navy/70">Use “New purchase order” to add one by hand.</p>
      </Modal>
    </>
  );
}
