"use client";

import { useGenerateTemplateOrder } from "@/lib/api/order-templates";
import { useRestrictionWarningRetry } from "@/lib/use-restriction-warning-retry";

/**
 * The customer page's manual "Generate order now" on a standing-order template. Row 510, ruling Q2: a manual run is
 * judged for the person who clicks it, so a restricted line opens the warning dialog (a reason per line, by that user)
 * and the same template is generated again with the ack. A scheduled run is unattended and never reaches a dialog.
 * Render `dialog` once; any other failure keeps the global mutation toast.
 */
export function useGenerateTemplateOrderAction() {
  const generateOrder = useGenerateTemplateOrder();
  const rw = useRestrictionWarningRetry();

  const generate = (templateId: string, templateName: string) =>
    generateOrder.mutate(rw.attach(templateId), {
      onSuccess: () => window.alert(`Order generated for "${templateName}"!`),
      onError: (err) => void rw.handle(err, () => generate(templateId, templateName)),
    });

  return { generate, isPending: generateOrder.isPending, dialog: rw.dialog };
}
