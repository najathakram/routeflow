import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { manipulateAsync, SaveFormat } from "expo-image-manipulator";
import { ios } from "@routeflow/ui/tokens";
import { NavBackButton, NavBar, SearchBar } from "@routeflow/ui/mobile/ios";
import { FormField, FormSection, FormSheet, FormTextInput } from "../../../components/FormSheet";
import { MoneyTextInput } from "../../../components/MoneyTextInput";
import { PhotoCapture } from "../../../components/PhotoCapture";
import { useAdminCustomers, useAdminInvoices } from "../../../lib/api/admin";
import {
  useRecordPaymentStandalone,
  useUploadPaymentImage,
  type StandalonePaymentAllocation,
} from "../../../lib/api/payments";
import type { EditablePaymentMethod } from "../../../lib/api/payments";
import {
  allocationTotals,
  oldestInvoicesFirst,
  waterfallAllocations,
} from "../../../lib/payments-logic";
import { roundMoney } from "../../../lib/pricing";
import { productImageFile } from "../../../lib/product-image";
import { showToast } from "../../../lib/toast";

/**
 * Standalone payment with multi-invoice allocation — one check at the door
 * covering several invoices (`POST /invoices/payments/record`). Mirrors web's
 * RecordPaymentModal flow: pick customer → amount → greedy oldest-first
 * waterfall over open invoices → hand-tune → save. All money safety lives
 * client-side (see lib/payments-logic.ts): the server applies allocations
 * verbatim, so rows are capped at balanceDue and submit blocks on
 * over-allocation. Unallocated excess becomes an ADVANCE for the customer.
 */

const METHODS: { id: EditablePaymentMethod; label: string }[] = [
  { id: "CASH", label: "Cash" },
  { id: "CHECK", label: "Check" },
  { id: "ACH", label: "ACH" },
  { id: "CREDIT_CARD", label: "Credit card" },
  { id: "OTHER", label: "Other" },
];

const BANK_DATE_LABEL = "Money received in bank";
const BANK_DATE_HELP =
  "When the funds actually landed — e.g. a post-dated check's clearing date. Leave blank if unknown.";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Statuses a payment can land on (matches web's candidate query). */
const OPEN_STATUSES = "SENT,VIEWED,PARTIAL,OVERDUE";

export default function RecordStandalonePaymentScreen() {
  const router = useRouter();
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [customerName, setCustomerName] = useState<string | null>(null);

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace("/(operator)/payments" as any);
  };

  if (!customerId) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <CustomerPick
          onBack={goBack}
          onPick={(id, name) => {
            setCustomerId(id);
            setCustomerName(name);
          }}
        />
      </SafeAreaView>
    );
  }

  return (
    <PaymentForm
      customerId={customerId}
      customerName={customerName ?? "Customer"}
      onDone={goBack}
      onChangeCustomer={() => {
        setCustomerId(null);
        setCustomerName(null);
      }}
    />
  );
}

function CustomerPick({
  onBack,
  onPick,
}: {
  onBack: () => void;
  onPick: (id: string, name: string) => void;
}) {
  const [search, setSearch] = useState("");
  const { data } = useAdminCustomers({ search: search.trim() || undefined, limit: 100 });
  const customers = data?.data ?? [];
  return (
    <>
      <NavBar
        inlineTitle="Record payment"
        leading={<NavBackButton label="Back" onPress={onBack} />}
      />
      <SearchBar placeholder="Search customers…" value={search} onChangeText={setSearch} />
      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={styles.pickList}>
          {customers.map((c, i) => (
            <Pressable
              key={c.id}
              style={[
                styles.pickRow,
                i > 0 && {
                  borderTopWidth: StyleSheet.hairlineWidth,
                  borderTopColor: ios.separator,
                },
              ]}
              onPress={() => onPick(c.id, c.businessName)}
            >
              <Text style={styles.pickName} numberOfLines={1}>
                {c.businessName}
              </Text>
              <Ionicons name="chevron-forward" size={16} color={ios.gray[3]} />
            </Pressable>
          ))}
        </View>
      </ScrollView>
    </>
  );
}

function PaymentForm({
  customerId,
  customerName,
  onDone,
  onChangeCustomer,
}: {
  customerId: string;
  customerName: string;
  onDone: () => void;
  onChangeCustomer: () => void;
}) {
  const mut = useRecordPaymentStandalone();
  const uploadImageMut = useUploadPaymentImage();
  const { data: invoicesData } = useAdminInvoices({
    customerId,
    status: OPEN_STATUSES,
    limit: 50,
  });

  // Open invoices, oldest first — the array order IS the allocation order.
  const openInvoices = useMemo(
    () =>
      oldestInvoicesFirst(
        (invoicesData?.data ?? []).filter((inv) => Number(inv.balanceDue ?? 0) > 0.001),
      ),
    [invoicesData],
  );

  const [method, setMethod] = useState<EditablePaymentMethod>("CASH");
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [bankCharges, setBankCharges] = useState("");
  const [paidAt, setPaidAt] = useState("");
  const [settledAt, setSettledAt] = useState("");
  const [asDraft, setAsDraft] = useState(false);
  const [photos, setPhotos] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [allocs, setAllocs] = useState<Record<string, number | null>>({});

  const amountNum = roundMoney(Number(amount) || 0);

  // Waterfall pre-fill — recomputed whenever the received amount or the invoice
  // set changes, clobbering hand edits (web's modal behaves identically; the
  // amount is entered first in practice).
  const invoiceKey = openInvoices.map((i) => i.id).join(",");
  useEffect(() => {
    const { allocations } = waterfallAllocations(
      amountNum,
      openInvoices.map((i) => ({ id: i.id, balanceDue: Number(i.balanceDue ?? 0) })),
    );
    const next: Record<string, number | null> = {};
    for (const inv of openInvoices) next[inv.id] = null;
    for (const a of allocations) next[a.invoiceId] = a.amount;
    setAllocs(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amountNum, invoiceKey]);

  const totals = allocationTotals(
    amountNum,
    openInvoices.map((inv) => ({ amount: allocs[inv.id] ?? null })),
  );

  const setRowAmount = (inv: { id: string; balanceDue?: number }, value: number | null) => {
    // Cap at the invoice's balance — the server would happily over-pay it.
    const cap = roundMoney(Number(inv.balanceDue ?? 0));
    const v = value == null ? null : roundMoney(Math.min(Math.max(0, value), cap));
    setAllocs((m) => ({ ...m, [inv.id]: v === 0 ? null : v }));
  };

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
    if (amountNum <= 0) {
      setError("Enter a positive amount received.");
      return;
    }
    if (totals.overAllocated) {
      setError(
        `Allocated $${totals.allocated.toFixed(2)} exceeds the $${amountNum.toFixed(2)} received.`,
      );
      return;
    }
    if (paidAt.trim() && !ISO_DATE.test(paidAt.trim())) {
      setError("Payment date must be YYYY-MM-DD (or blank for today).");
      return;
    }
    if (settledAt.trim() && !ISO_DATE.test(settledAt.trim())) {
      setError("Bank date must be YYYY-MM-DD (or blank).");
      return;
    }
    setError(null);
    const allocations: StandalonePaymentAllocation[] = openInvoices
      .map((inv) => ({ invoiceId: inv.id, amount: allocs[inv.id] ?? 0 }))
      .filter((a) => a.amount > 0)
      .map((a) => ({ ...a, amount: roundMoney(a.amount) }));
    mut.mutate(
      {
        customerId,
        totalAmount: amountNum,
        method,
        allocations,
        ...(paidAt.trim() ? { paidAt: paidAt.trim() } : {}),
        ...(settledAt.trim() ? { settledAt: settledAt.trim() } : {}),
        ...(bankCharges.trim() && Number(bankCharges) > 0
          ? { bankCharges: roundMoney(Number(bankCharges)) }
          : {}),
        ...(reference.trim() ? { reference: reference.trim() } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        status: asDraft ? "DRAFT" : "PAID",
      },
      {
        onSuccess: (res) => {
          showToast(
            res.excess > 0.001
              ? `Payment recorded — $${res.excess.toFixed(2)} saved as advance`
              : "Payment recorded",
          );
          if (photos[0] && res.payments[0]?.id) {
            uploadReceiptPhoto(photos[0], res.payments[0].id);
          }
          onDone();
        },
        onError: (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
      },
    );
  };

  return (
    <FormSheet
      title="Record payment"
      subtitle={customerName}
      submitLabel={mut.isPending ? "Saving…" : asDraft ? "Save as draft" : "Save as paid"}
      submitting={mut.isPending}
      warnIfDirty
      onSubmit={submit}
    >
      <Pressable style={styles.changeCustomer} onPress={onChangeCustomer} hitSlop={6}>
        <Ionicons name="person-outline" size={14} color={ios.brand} />
        <Text style={styles.changeCustomerText}>{customerName}</Text>
        <Text style={styles.changeCustomerAction}>Change</Text>
      </Pressable>

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

      <FormSection title="Amount received">
        <FormField label="Amount" error={error ?? undefined}>
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

      <FormSection title="Apply to invoices">
        {openInvoices.length === 0 ? (
          <Text style={styles.emptyText}>
            No open invoices — the full amount will be saved as an advance.
          </Text>
        ) : (
          openInvoices.map((inv, i) => (
            <View
              key={inv.id}
              style={[
                styles.allocRow,
                i > 0 && {
                  borderTopWidth: StyleSheet.hairlineWidth,
                  borderTopColor: ios.separator,
                },
              ]}
            >
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.allocNumber} numberOfLines={1}>
                  {inv.invoiceNumber}
                </Text>
                <Text style={styles.allocMeta}>
                  Due ${Number(inv.balanceDue ?? 0).toFixed(2)}
                  {inv.dueDate ? ` · by ${new Date(inv.dueDate).toLocaleDateString()}` : ""}
                </Text>
              </View>
              <View style={styles.allocInputWrap}>
                <Text style={styles.allocCurrency}>$</Text>
                <MoneyTextInput
                  style={[styles.allocInput, (allocs[inv.id] ?? 0) > 0 && styles.allocInputActive]}
                  value={allocs[inv.id] ?? null}
                  onChangeValue={(v) => setRowAmount(inv as any, v)}
                  placeholder="0.00"
                  returnKeyType="done"
                />
              </View>
            </View>
          ))
        )}

        {/* Live footer — mirrors web's Allocated / Received / Unallocated strip. */}
        <View style={styles.totalsStrip}>
          <Text style={styles.totalsLine}>
            Allocated ${totals.allocated.toFixed(2)} of ${amountNum.toFixed(2)} received
          </Text>
          {totals.overAllocated ? (
            <Text style={styles.totalsOver}>Allocated more than received — reduce a line.</Text>
          ) : totals.excess > 0.001 ? (
            <Text style={styles.totalsExcess}>
              ${totals.excess.toFixed(2)} unallocated → saved as customer advance
            </Text>
          ) : null}
        </View>
      </FormSection>

      <FormSection title="Details">
        <FormField label="Payment date" hint="Format: YYYY-MM-DD (leave blank for today)">
          <FormTextInput
            value={paidAt}
            onChangeText={setPaidAt}
            placeholder={(() => {
              // Local-timezone today, not UTC (BUG-W-8 / BUG-OPS1-4).
              const d = new Date();
              return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
            })()}
            keyboardType="numbers-and-punctuation"
          />
        </FormField>
        <FormField label={BANK_DATE_LABEL} hint={BANK_DATE_HELP}>
          <FormTextInput
            value={settledAt}
            onChangeText={setSettledAt}
            placeholder="YYYY-MM-DD"
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
        <Pressable style={styles.draftRow} onPress={() => setAsDraft((d) => !d)} hitSlop={4}>
          <View style={[styles.checkbox, asDraft && styles.checkboxOn]}>
            {asDraft ? <Text style={styles.checkboxTick}>✓</Text> : null}
          </View>
          <Text style={styles.draftLabel}>
            Save as draft (records the rows without touching invoice statuses)
          </Text>
        </Pressable>
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
  safe: { flex: 1, backgroundColor: ios.bg },
  pickList: {
    marginHorizontal: 16,
    backgroundColor: ios.bgElev,
    borderRadius: 12,
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: ios.separator,
  },
  pickRow: {
    paddingHorizontal: 14,
    paddingVertical: 13,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  pickName: { flex: 1, fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },

  changeCustomer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: ios.brandWash,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
    alignSelf: "flex-start",
  },
  changeCustomerText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: ios.brand,
    flexShrink: 1,
  },
  changeCustomerAction: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    color: ios.brand,
    opacity: 0.65,
    marginLeft: 6,
  },

  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999 },
  chipActive: { backgroundColor: ios.brand },
  chipInactive: { backgroundColor: ios.fill3 },
  chipText: { fontSize: 13, fontFamily: "Inter_500Medium" },
  chipTextActive: { color: "#fff" },
  chipTextInactive: { color: ios.label },

  emptyText: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2 },
  allocRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 10,
  },
  allocNumber: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: ios.label },
  allocMeta: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    marginTop: 2,
    fontVariant: ["tabular-nums"],
  },
  allocInputWrap: { flexDirection: "row", alignItems: "center", gap: 6 },
  allocCurrency: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label2 },
  allocInput: {
    minWidth: 70,
    maxWidth: 96,
    flexShrink: 0,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: ios.separator,
    borderRadius: 8,
    textAlign: "right",
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  allocInputActive: { borderColor: ios.brand, color: ios.brand },
  totalsStrip: { gap: 3, paddingTop: 6 },
  totalsLine: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  totalsExcess: { fontSize: 12, fontFamily: "Inter_500Medium", color: ios.system.orangeInk },
  totalsOver: { fontSize: 12, fontFamily: "Inter_600SemiBold", color: ios.system.redInk },

  draftRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: ios.separator,
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxOn: { backgroundColor: ios.brand, borderColor: ios.brand },
  checkboxTick: { color: "#fff", fontFamily: "Inter_700Bold" },
  draftLabel: {
    flex: 1,
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: ios.label,
  },
});
