import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { manipulateAsync, SaveFormat } from "expo-image-manipulator";
import { ios } from "@routeflow/ui/tokens";
import {
  FormField,
  FormSection,
  FormSheet,
  FormTextInput,
} from "../../../../../components/FormSheet";
import { PhotoCapture } from "../../../../../components/PhotoCapture";
import { useAdminInvoice } from "../../../../../lib/api/admin";
import { useRecordInvoicePayment, type PaymentMethod } from "../../../../../lib/api/invoices";
import { useUploadPaymentImage } from "../../../../../lib/api/payments";
import { productImageFile } from "../../../../../lib/product-image";
import { showToast } from "../../../../../lib/toast";

// Advance / Credit-Note are intentionally excluded: the server rejects them here
// ("use the dedicated Apply Credit Note / Apply Advance actions") so offering
// them as chips only ever produced an error toast.
const METHODS: { id: PaymentMethod; label: string }[] = [
  { id: "CASH", label: "Cash" },
  { id: "CHECK", label: "Check" },
  { id: "ACH", label: "ACH" },
  { id: "CREDIT_CARD", label: "Credit card" },
  { id: "OTHER", label: "Other" },
];

export default function RecordPaymentScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: invoice } = useAdminInvoice(id ?? "");
  const mut = useRecordInvoicePayment();
  const uploadImageMut = useUploadPaymentImage();

  const balance = invoice?.balanceDue ?? invoice?.total ?? 0;
  const [method, setMethod] = useState<PaymentMethod>("CASH");
  const [amount, setAmount] = useState<string>(balance ? String(Number(balance).toFixed(2)) : "");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [bankCharges, setBankCharges] = useState("");
  const [paidAt, setPaidAt] = useState("");
  const [photos, setPhotos] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Best-effort: the payment is already recorded by the time this runs, so a
  // failure here must never surface as a payment failure — just note the photo
  // didn't attach. Re-encode to JPEG first (iOS HEIC picks aren't decodable
  // once uploaded as-is; see products/[id].tsx for the same trap).
  const uploadReceiptPhoto = async (uri: string, paymentId: string) => {
    try {
      const jpeg = await manipulateAsync(uri, [], { compress: 0.8, format: SaveFormat.JPEG });
      const file = productImageFile({ uri: jpeg.uri, mimeType: "image/jpeg" });
      await uploadImageMut.mutateAsync({ paymentId, file });
    } catch {
      showToast("Payment recorded, but the photo failed to upload.");
    }
  };

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
      onSuccess: (result) => {
        showToast("Payment recorded");
        if (photos[0] && result.createdPaymentId) {
          uploadReceiptPhoto(photos[0], result.createdPaymentId);
        }
        router.back();
      },
      onError: (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
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
        {/* Quick amount presets */}
        {balance ? (
          <View style={styles.presets}>
            {[25, 50, 75, 100].map((pct) => (
              <Pressable
                key={pct}
                style={styles.preset}
                onPress={() => setAmount(((Number(balance) * pct) / 100).toFixed(2))}
              >
                <Text style={styles.presetText}>{pct}%</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
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
            placeholder={(() => {
              // BUG-W-8 / BUG-OPS1-4: local-timezone today, not UTC.
              const d = new Date();
              return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
            })()}
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

      <FormSection title="Receipt photo">
        <PhotoCapture
          photos={photos}
          onAdd={(uri) => setPhotos([uri])}
          onRemove={(uri) => setPhotos((p) => p.filter((u) => u !== uri))}
          maxPhotos={1}
          label="Receipt photo"
        />
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
  presets: { flexDirection: "row", gap: 8, marginTop: 8 },
  preset: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: ios.brandWash,
    alignItems: "center",
  },
  presetText: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: ios.brand },
});
