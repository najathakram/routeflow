import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import {
  FormField,
  FormSection,
  FormSheet,
  FormTextInput,
} from "../../../../../../../components/FormSheet";
import { useAdminInvoice } from "../../../../../../../lib/api/admin";
import {
  usePayment,
  useUpdatePayment,
  type EditablePaymentMethod,
} from "../../../../../../../lib/api/payments";
import { isPaymentEditable } from "../../../../../../../lib/invoices-logic";
import { showToast } from "../../../../../../../lib/toast";

// Advance/Credit-Note are not editable (server rejects them); the invoice list
// gates the pencil affordance via isPaymentEditable so only these reach here.
const METHODS: { id: EditablePaymentMethod; label: string }[] = [
  { id: "CASH", label: "Cash" },
  { id: "CHECK", label: "Check" },
  { id: "ACH", label: "ACH" },
  { id: "CREDIT_CARD", label: "Credit card" },
  { id: "OTHER", label: "Other" },
];

export default function EditPaymentScreen() {
  const router = useRouter();
  const { id, paymentId } = useLocalSearchParams<{ id: string; paymentId: string }>();
  const { data: invoice } = useAdminInvoice(id ?? "");
  const { data: payment, isLoading } = usePayment(paymentId ?? "");
  const mut = useUpdatePayment();

  // Amount cap = invoice total − the OTHER (non-void, non-this) payments, mirroring web.
  const others = (invoice?.payments ?? [])
    .filter((p: any) => p.id !== paymentId && p.status !== "VOID")
    .reduce((s: number, p: any) => s + Number(p.amount ?? 0), 0);
  const maxAmount = Math.max(0, Number(invoice?.total ?? 0) - others);

  const [method, setMethod] = useState<EditablePaymentMethod | null>(null);
  const [amount, setAmount] = useState<string | null>(null);
  const [reference, setReference] = useState<string | null>(null);
  const [notes, setNotes] = useState<string | null>(null);
  const [bankCharges, setBankCharges] = useState<string | null>(null);
  const [paidAt, setPaidAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Seed the form once from the loaded payment (keyed on its id so a background
  // refetch doesn't clobber in-progress edits).
  useEffect(() => {
    if (!payment) return;
    const m = payment.method;
    setMethod(
      (["CASH", "CHECK", "ACH", "CREDIT_CARD", "OTHER"] as const).includes(m as any)
        ? (m as EditablePaymentMethod)
        : "OTHER",
    );
    setAmount(String(Number(payment.amount ?? 0).toFixed(2)));
    setReference(payment.reference ?? "");
    setNotes(payment.notes ?? "");
    setBankCharges(payment.bankCharges != null ? String(payment.bankCharges) : "");
    setPaidAt(payment.paidAt ? payment.paidAt.slice(0, 10) : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payment?.id]);

  // Guard against a non-editable payment reached by deep-link (the list-screen
  // pencil is a render condition, not a route guard). Advance/Credit-Note draws
  // and terminal states must never be hand-edited (would corrupt reconciliation).
  const notEditable =
    !!payment && !isPaymentEditable(payment.method, payment.status, invoice?.status);

  const submit = () => {
    if (!id || !paymentId || !method) return;
    if (notEditable) {
      setError("This payment can't be edited.");
      return;
    }
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) {
      setError("Enter a positive amount.");
      return;
    }
    // Cap once the invoice is loaded (maxAmount is floored at 0). Mirrors web's
    // unconditional check — a 0 remaining balance rejects any positive amount.
    if (invoice && n > maxAmount + 0.0001) {
      setError(`Amount can't exceed $${maxAmount.toFixed(2)} (invoice balance).`);
      return;
    }
    setError(null);
    mut.mutate(
      {
        invoiceId: id,
        paymentId,
        method,
        amount: n,
        reference: (reference ?? "").trim() || undefined,
        notes: (notes ?? "").trim() || undefined,
        bankCharges: (bankCharges ?? "").trim() ? Number(bankCharges) || undefined : undefined,
        paidAt: (paidAt ?? "").trim() || undefined,
      },
      {
        onSuccess: () => {
          showToast("Payment updated");
          router.back();
        },
        onError: (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
      },
    );
  };

  return (
    <FormSheet
      title="Edit payment"
      subtitle={payment?.paymentNumber ?? invoice?.invoiceNumber}
      submitLabel={mut.isPending ? "Saving…" : "Save changes"}
      submitting={mut.isPending || isLoading}
      submitDisabled={notEditable}
      onSubmit={submit}
    >
      {notEditable ? (
        <FormSection title="Not editable">
          <Text style={styles.notEditable}>
            This payment can’t be edited — advance / credit-note draws and settled invoices are
            locked. Void it instead if it’s wrong.
          </Text>
        </FormSection>
      ) : null}
      <FormSection title="Method">
        <View style={styles.chips}>
          {METHODS.map((m) => {
            const active = method === m.id;
            return (
              <Pressable
                key={m.id}
                style={[styles.chip, active ? styles.chipActive : styles.chipInactive]}
                onPress={() => setMethod(m.id)}
              >
                <Text
                  style={[
                    styles.chipText,
                    active ? styles.chipTextActive : styles.chipTextInactive,
                  ]}
                >
                  {m.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </FormSection>

      <FormSection title="Amount">
        <FormField
          label="Amount"
          hint={maxAmount > 0 ? `Max: $${maxAmount.toFixed(2)}` : undefined}
          error={error ?? undefined}
        >
          <FormTextInput
            value={amount ?? ""}
            onChangeText={setAmount}
            placeholder="0.00"
            keyboardType="decimal-pad"
          />
        </FormField>
        {method === "ACH" || method === "CHECK" ? (
          <FormField label="Bank charges (optional)">
            <FormTextInput
              value={bankCharges ?? ""}
              onChangeText={setBankCharges}
              placeholder="0.00"
              keyboardType="decimal-pad"
            />
          </FormField>
        ) : null}
        <FormField label="Reference (optional)">
          <FormTextInput
            value={reference ?? ""}
            onChangeText={setReference}
            placeholder="Check #, txn ID…"
          />
        </FormField>
      </FormSection>

      <FormSection title="Details">
        <FormField label="Payment date" hint="Format: YYYY-MM-DD">
          <FormTextInput
            value={paidAt ?? ""}
            onChangeText={setPaidAt}
            placeholder="YYYY-MM-DD"
            keyboardType="numbers-and-punctuation"
          />
        </FormField>
        <FormField label="Notes (optional)">
          <FormTextInput
            value={notes ?? ""}
            onChangeText={setNotes}
            placeholder="Any notes about this payment…"
            multiline
            numberOfLines={3}
            style={{ minHeight: 72, textAlignVertical: "top" }}
          />
        </FormField>
      </FormSection>
    </FormSheet>
  );
}

const styles = StyleSheet.create({
  notEditable: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.system.red },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999 },
  chipActive: { backgroundColor: ios.brand },
  chipInactive: { backgroundColor: ios.fill3 },
  chipText: { fontSize: 13, fontFamily: "Inter_500Medium" },
  chipTextActive: { color: "#fff" },
  chipTextInactive: { color: ios.label },
});
