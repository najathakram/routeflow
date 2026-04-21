import { useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import {
  FormField,
  FormSection,
  FormSheet,
  FormTextInput,
} from "../../../../../components/FormSheet";
import { useAdminInvoice } from "../../../../../lib/api/admin";
import { useRecordInvoicePayment, type PaymentMethod } from "../../../../../lib/api/invoices";
import { showToast } from "../../../../../lib/toast";

const METHODS: { id: PaymentMethod; label: string }[] = [
  { id: "CASH", label: "Cash" },
  { id: "CHECK", label: "Check" },
  { id: "ACH", label: "ACH" },
  { id: "CREDIT_CARD", label: "Credit card" },
  { id: "ADVANCE", label: "Advance" },
  { id: "CREDIT_NOTE", label: "Credit note" },
  { id: "OTHER", label: "Other" },
];

export default function RecordPaymentScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: invoice } = useAdminInvoice(id ?? "");
  const mut = useRecordInvoicePayment();

  const balance = invoice?.balanceDue ?? invoice?.total ?? 0;
  const [method, setMethod] = useState<PaymentMethod>("CASH");
  const [amount, setAmount] = useState<string>(balance ? String(Number(balance).toFixed(2)) : "");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [bankCharges, setBankCharges] = useState("");
  const [paidAt, setPaidAt] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    if (!id) return;
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) {
      setError("Enter a positive amount.");
      return;
    }
    setError(null);
    const dto: Parameters<typeof mut.mutate>[0] = {
      invoiceId: id,
      amount: n,
      method,
      reference: reference.trim() || undefined,
      notes: notes.trim() || undefined,
      bankCharges: bankCharges.trim() ? Number(bankCharges) || undefined : undefined,
      paidAt: paidAt.trim() || undefined,
    };
    mut.mutate(dto, {
      onSuccess: () => {
        showToast("Payment recorded");
        router.back();
      },
      onError: (e: any) =>
        Alert.alert("Couldn't record", e?.response?.data?.message ?? e?.message ?? "Try again."),
    });
  };

  return (
    <FormSheet
      title="Record payment"
      subtitle={invoice?.invoiceNumber}
      submitLabel={mut.isPending ? "Saving…" : "Record"}
      submitting={mut.isPending}
      onSubmit={submit}
    >
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
          hint={balance ? `Balance due: $${Number(balance).toFixed(2)}` : undefined}
          error={error ?? undefined}
        >
          <FormTextInput
            value={amount}
            onChangeText={setAmount}
            placeholder="0.00"
            keyboardType="decimal-pad"
          />
        </FormField>
        {method === "ACH" || method === "CHECK" ? (
          <FormField label="Bank charges (optional)">
            <FormTextInput
              value={bankCharges}
              onChangeText={setBankCharges}
              placeholder="0.00"
              keyboardType="decimal-pad"
            />
          </FormField>
        ) : null}
        <FormField label="Reference (optional)">
          <FormTextInput
            value={reference}
            onChangeText={setReference}
            placeholder="Check #, txn ID…"
          />
        </FormField>
      </FormSection>

      <FormSection title="Details">
        <FormField label="Payment date" hint="Format: YYYY-MM-DD (leave blank for today)">
          <FormTextInput
            value={paidAt}
            onChangeText={setPaidAt}
            placeholder="2025-06-01"
            keyboardType="numbers-and-punctuation"
          />
        </FormField>
        <FormField label="Notes (optional)">
          <FormTextInput
            value={notes}
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
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999 },
  chipActive: { backgroundColor: ios.brand },
  chipInactive: { backgroundColor: ios.fill3 },
  chipText: { fontSize: 13, fontFamily: "Inter_500Medium" },
  chipTextActive: { color: "#fff" },
  chipTextInactive: { color: ios.label },
});
