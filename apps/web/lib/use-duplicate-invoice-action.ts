"use client";

import { useRouter } from "next/navigation";
import { useToast } from "@routeflow/ui/web";
import { useDuplicateInvoice } from "@/lib/api/invoices";

/**
 * The invoice page's "Duplicate" action (B644). It asks the SERVER to duplicate — the web never rebuilds
 * a line — then opens the new DRAFT.
 *
 * No error handler here on purpose: the server refuses an order-linked invoice (400) and a unit line
 * (409 UNIT_AWARE_LINE), and the global MutationCache handler (app/providers.tsx) already shows the
 * server's own message once for any code it does not handle. A toast here would show it twice (B594).
 * A second click while one duplicate is in flight is ignored, so a double-click cannot make two copies.
 */
export function useDuplicateInvoiceAction() {
  const router = useRouter();
  const { toast } = useToast();
  const duplicate = useDuplicateInvoice();

  return {
    duplicate: (invoiceId: string) => {
      if (duplicate.isPending) return;
      duplicate.mutate(invoiceId, {
        onSuccess: (copy) => {
          toast({
            title: "Invoice duplicated",
            description: `New invoice ${copy.invoiceNumber} created as a draft.`,
            variant: "success",
          });
          router.push(`/invoices/${copy.id}`);
        },
      });
    },
    isPending: duplicate.isPending,
  };
}
