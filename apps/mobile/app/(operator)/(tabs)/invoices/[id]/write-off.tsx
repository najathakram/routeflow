import { useState } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import {
  FormField,
  FormSection,
  FormSheet,
  FormTextInput,
} from "../../../../../components/FormSheet";
import { useAdminInvoice } from "../../../../../lib/api/admin";
import { useWriteOffInvoice } from "../../../../../lib/api/invoices";
import { showToast } from "../../../../../lib/toast";

/**
 * Write an unpaid invoice off as bad debt. Requires a reason; not reversible.
 * Server allows only SENT | VIEWED | PARTIAL | OVERDUE (guarded on the list
 * screen via canWriteOff before this route is reachable).
 */
export default function WriteOffInvoiceScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: invoice } = useAdminInvoice(id ?? "");
  const mut = useWriteOffInvoice();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    if (!id) return;
    if (reason.trim() === "") {
      setError("Enter a reason for the write-off.");
      return;
    }
    setError(null);
    mut.mutate(
      { id, reason: reason.trim() },
      {
        onSuccess: () => {
          showToast("Invoice written off");
          router.back();
        },
        onError: (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
      },
    );
  };

  return (
    <FormSheet
      title="Write off invoice"
      subtitle={invoice?.invoiceNumber}
      submitLabel={mut.isPending ? "Writing off…" : "Write off"}
      submitting={mut.isPending}
      destructive
      onSubmit={submit}
    >
      <FormSection title="Reason">
        <FormField
          label="Why is this being written off?"
          hint="Recorded on the invoice. This cannot be undone."
          error={error ?? undefined}
        >
          <FormTextInput
            value={reason}
            onChangeText={setReason}
            placeholder="e.g. customer insolvent, uncollectable balance…"
            multiline
            numberOfLines={4}
            style={{ minHeight: 96, textAlignVertical: "top" }}
          />
        </FormField>
      </FormSection>
    </FormSheet>
  );
}
