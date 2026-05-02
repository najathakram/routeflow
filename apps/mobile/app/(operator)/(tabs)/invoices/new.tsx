import { useState } from "react";
import { useRouter } from "expo-router";
import {
  FormField,
  FormSection,
  FormSheet,
  FormTextInput,
} from "../../../../components/FormSheet";
import { useCreateInvoice } from "../../../../lib/api/invoices";
import { showToast } from "../../../../lib/toast";

/**
 * RF-203: New invoice form for the mobile operator UI.
 *
 * This screen intentionally keeps the form simple — customer ID and optional
 * notes — because the full multi-line invoice editor lives in the web app.
 * The important thing is that this screen renders immediately (no data fetches
 * that block rendering) so users are never stuck on an infinite spinner.
 */
export default function NewInvoiceScreen() {
  const router = useRouter();
  const mut = useCreateInvoice();
  const [customerId, setCustomerId] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const trimmed = customerId.trim();
    if (!trimmed) {
      setError("Customer ID is required.");
      return;
    }
    setError(null);
    mut.mutate(
      { customerId: trimmed, notes: notes.trim() || undefined },
      {
        onSuccess: (res: any) => {
          showToast("Invoice created");
          router.replace(`/(operator)/invoices/${res.id}`);
        },
        onError: (e: any) =>
          showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
      },
    );
  };

  return (
    <FormSheet
      title="New invoice"
      submitLabel={mut.isPending ? "Saving…" : "Create"}
      submitting={mut.isPending}
      onSubmit={submit}
    >
      <FormSection title="Details">
        <FormField label="Customer ID" error={error ?? undefined}>
          <FormTextInput
            value={customerId}
            onChangeText={setCustomerId}
            placeholder="Paste customer UUID"
            autoCapitalize="none"
            autoCorrect={false}
          />
        </FormField>
        <FormField label="Notes">
          <FormTextInput
            value={notes}
            onChangeText={setNotes}
            placeholder="Optional"
            multiline
            numberOfLines={3}
            textAlignVertical="top"
            style={{ minHeight: 80 }}
          />
        </FormField>
      </FormSection>
    </FormSheet>
  );
}
