import { useEffect, useState } from "react";
import { Linking, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { manipulateAsync, SaveFormat } from "expo-image-manipulator";
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
  useUploadPaymentImage,
  useDeletePaymentImage,
  useGetPaymentImageUrl,
  type EditablePaymentMethod,
} from "../../../../../../../lib/api/payments";
import { productImageFile } from "../../../../../../../lib/product-image";
import { isPaymentEditable } from "../../../../../../../lib/invoices-logic";
import { showToast } from "../../../../../../../lib/toast";
import { confirm, chooseAction } from "../../../../../../../lib/confirm";

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
  const uploadImageMut = useUploadPaymentImage();
  const deleteImageMut = useDeletePaymentImage();
  const getImageUrlMut = useGetPaymentImageUrl();

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

  // Photo section acts immediately — the payment already exists here (unlike
  // record-payment.tsx), so Add/Replace/Remove hit the API right away rather
  // than staging behind the Save button.
  const pickAndUploadPhoto = async (useCamera: boolean) => {
    if (!paymentId) return;
    const res =
      useCamera && Platform.OS !== "web"
        ? await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 1 })
        : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 1 });
    if (res.canceled || !res.assets?.[0]) return;
    try {
      // Re-encode to JPEG: an iOS library HEIC pick returns raw HEIC bytes the
      // server would otherwise store verbatim (see products/[id].tsx).
      const jpeg = await manipulateAsync(res.assets[0].uri, [], {
        compress: 0.8,
        format: SaveFormat.JPEG,
      });
      const file = productImageFile({ uri: jpeg.uri, mimeType: "image/jpeg" });
      uploadImageMut.mutate(
        { paymentId, file },
        {
          onSuccess: () => showToast(payment?.imageKey ? "Photo replaced" : "Photo added"),
          onError: (e: any) =>
            showToast(e?.response?.data?.message ?? e?.message ?? "Couldn't upload the photo."),
        },
      );
    } catch {
      showToast("Couldn't process the photo.");
    }
  };

  const onAddOrReplacePhoto = () => {
    const actions =
      Platform.OS === "web"
        ? [
            { label: "Choose photo", onPress: () => pickAndUploadPhoto(false) },
            { label: "Cancel", style: "cancel" as const },
          ]
        : [
            { label: "Take photo", onPress: () => pickAndUploadPhoto(true) },
            { label: "Choose from library", onPress: () => pickAndUploadPhoto(false) },
            { label: "Cancel", style: "cancel" as const },
          ];
    chooseAction(
      payment?.imageKey ? "Replace receipt photo" : "Add receipt photo",
      "Attach a photo of the receipt, slip, or check for this payment.",
      actions,
    );
  };

  const onViewPhoto = () => {
    if (!paymentId) return;
    getImageUrlMut.mutate(paymentId, {
      onSuccess: (data) =>
        Linking.openURL(data.url).catch(() => showToast("Couldn't open the receipt.")),
      onError: (e: any) =>
        showToast(e?.response?.data?.message ?? e?.message ?? "Couldn't load the receipt."),
    });
  };

  const onRemovePhoto = () => {
    if (!paymentId) return;
    confirm(
      "Remove photo?",
      "This photo will be removed from the payment.",
      () =>
        deleteImageMut.mutate(paymentId, {
          onSuccess: () => showToast("Photo removed"),
          onError: (e: any) =>
            showToast(e?.response?.data?.message ?? e?.message ?? "Couldn't remove the photo."),
        }),
      { confirmText: "Remove", destructive: true },
    );
  };

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

      <FormSection title="Receipt photo">
        {payment?.imageKey ? (
          <View style={styles.photoRow}>
            <Pressable
              style={styles.photoBtn}
              onPress={onViewPhoto}
              disabled={getImageUrlMut.isPending}
            >
              <Ionicons name="image-outline" size={16} color={ios.brand} />
              <Text style={styles.photoBtnText}>
                {getImageUrlMut.isPending ? "Loading…" : "View"}
              </Text>
            </Pressable>
            <Pressable
              style={styles.photoBtn}
              onPress={onAddOrReplacePhoto}
              disabled={uploadImageMut.isPending}
            >
              <Ionicons name="camera-outline" size={16} color={ios.brand} />
              <Text style={styles.photoBtnText}>
                {uploadImageMut.isPending ? "Uploading…" : "Replace"}
              </Text>
            </Pressable>
            <Pressable
              style={[styles.photoBtn, styles.photoBtnDanger]}
              onPress={onRemovePhoto}
              disabled={deleteImageMut.isPending}
            >
              <Ionicons name="trash-outline" size={16} color={ios.system.red} />
              <Text style={[styles.photoBtnText, { color: ios.system.red }]}>
                {deleteImageMut.isPending ? "Removing…" : "Remove"}
              </Text>
            </Pressable>
          </View>
        ) : (
          <Pressable
            style={styles.addPhotoBtn}
            onPress={onAddOrReplacePhoto}
            disabled={uploadImageMut.isPending}
          >
            <Ionicons name="camera-outline" size={18} color={ios.brand} />
            <Text style={styles.addPhotoBtnText}>
              {uploadImageMut.isPending ? "Uploading…" : "Add receipt photo"}
            </Text>
          </Pressable>
        )}
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
  photoRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  photoBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 10,
    backgroundColor: ios.fill3,
  },
  photoBtnDanger: { backgroundColor: ios.system.redWash },
  photoBtnText: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: ios.brand },
  addPhotoBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1.5,
    borderStyle: "dashed",
    borderColor: ios.brand,
    backgroundColor: ios.brandWash,
  },
  addPhotoBtnText: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: ios.brand },
});
