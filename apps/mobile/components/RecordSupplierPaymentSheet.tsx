import * as React from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { ios } from "@routeflow/ui/tokens";
import { FormField, FormSection, FormTextInput } from "./FormSheet";
import { MoneyTextInput } from "./MoneyTextInput";
import { useVendorBills, type VendorBill } from "../lib/api/vendor-bills";
import { useRecordSupplierPayment, type SupplierAllocationRow } from "../lib/api/supplier-payments";
import {
  billAllocationTotals,
  billBalance,
  eligibleBills,
  oldestBillsFirst,
  waterfallBillAllocations,
} from "../lib/supplier-payment-logic";
import { roundMoney } from "@routeflow/pricing";
import { showToast } from "../lib/toast";
import { fmtCalendarDate } from "../lib/format-date";
import { SELECTABLE_METHOD_OPTIONS, type SelectablePaymentMethod } from "../lib/payment-methods";

const METHODS = SELECTABLE_METHOD_OPTIONS;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * FormSheet-pattern modal (mirrors `LineEditSheet`/`VariantSplitSheet`) for a
 * supplier-level payment split across several bills — the AP mirror of the
 * AR standalone payment screen (`app/(operator)/payments/record.tsx`,
 * `POST /vendor-bills/payments/record`). All the allocation math (waterfall
 * pre-fill, per-row clamp, over-allocation guard) is pure and unit-tested in
 * `lib/supplier-payment-logic.ts`, mirroring `lib/payments-logic.ts` so AP
 * and AR behave identically. Eligibility is arithmetic
 * (`totalOwed − totalPaid > 0.001`), never `VendorBillStatus` — a
 * short-received PARTIAL bill with `totalPaid = 0` is fully payable.
 */
export function RecordSupplierPaymentSheet({
  visible,
  supplierId,
  supplierName,
  onClose,
}: {
  visible: boolean;
  supplierId: string;
  supplierName: string;
  onClose: () => void;
}) {
  const { data: billsData } = useVendorBills({ supplierId, limit: 200 });
  const mut = useRecordSupplierPayment();

  const openBills = React.useMemo(
    () => oldestBillsFirst(eligibleBills(billsData?.data ?? [])),
    [billsData],
  );

  const [method, setMethod] = React.useState<SelectablePaymentMethod>("CASH");
  const [amount, setAmount] = React.useState("");
  const [reference, setReference] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [paidAt, setPaidAt] = React.useState("");
  const [allocs, setAllocs] = React.useState<Record<string, number | null>>({});
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<{ excess: number } | null>(null);

  // Re-seed once per opening — never on every bills refetch mid-edit.
  React.useEffect(() => {
    if (!visible) return;
    setMethod("CASH");
    setAmount("");
    setReference("");
    setNotes("");
    setPaidAt("");
    setAllocs({});
    setError(null);
    setResult(null);
    mut.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const amountNum = roundMoney(Number(amount) || 0);
  const billKey = openBills.map((b) => b.id).join(",");

  // Waterfall pre-fill — recomputed whenever the paid amount or the bill set
  // changes, clobbering hand edits (mirrors payments/record.tsx's PaymentForm).
  React.useEffect(() => {
    if (!visible) return;
    const { allocations } = waterfallBillAllocations(
      amountNum,
      openBills.map((b) => ({ id: b.id, balance: billBalance(b) })),
    );
    const next: Record<string, number | null> = {};
    for (const b of openBills) next[b.id] = null;
    for (const a of allocations) next[a.vendorBillId] = a.amount;
    setAllocs(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, amountNum, billKey]);

  const totals = billAllocationTotals(
    amountNum,
    openBills.map((b) => ({ amount: allocs[b.id] ?? null })),
  );

  const setRowAmount = (bill: VendorBill, value: number | null) => {
    // Cap at the bill's remaining balance — the server would happily over-pay it.
    const cap = billBalance(bill);
    const v = value == null ? null : roundMoney(Math.min(Math.max(0, value), cap));
    setAllocs((m) => ({ ...m, [bill.id]: v === 0 ? null : v }));
  };

  const handleClose = () => {
    mut.reset();
    onClose();
  };

  const submit = () => {
    if (amountNum <= 0) {
      setError("Enter a positive amount paid.");
      return;
    }
    if (totals.overAllocated) {
      setError(
        `Allocated $${totals.allocated.toFixed(2)} exceeds the $${amountNum.toFixed(2)} paid.`,
      );
      return;
    }
    if (paidAt.trim() && !ISO_DATE.test(paidAt.trim())) {
      setError("Payment date must be YYYY-MM-DD (or blank for today).");
      return;
    }
    setError(null);
    const allocations: SupplierAllocationRow[] = openBills
      .map((b) => ({ vendorBillId: b.id, amount: allocs[b.id] ?? 0 }))
      .filter((a) => a.amount > 0)
      .map((a) => ({ ...a, amount: roundMoney(a.amount) }));
    mut.mutate(
      {
        supplierId,
        totalAmount: amountNum,
        method,
        allocations,
        ...(paidAt.trim() ? { paidAt: paidAt.trim() } : {}),
        ...(reference.trim() ? { reference: reference.trim() } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      },
      {
        onSuccess: (res) => {
          showToast(
            res.excess > 0.001
              ? `Payment recorded — $${res.excess.toFixed(2)} saved as account credit`
              : "Payment recorded",
          );
          setResult({ excess: res.excess });
        },
        onError: (e: any) => setError(e?.response?.data?.message ?? e?.message ?? "Try again."),
      },
    );
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={handleClose}>
      <Pressable style={styles.backdrop} onPress={handleClose} />
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.sheetWrap}
      >
        <View style={styles.sheet}>
          <View style={styles.header}>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>Record payment</Text>
              <Text style={styles.subtitle} numberOfLines={1}>
                {supplierName}
              </Text>
            </View>
            <Pressable onPress={handleClose} hitSlop={10} accessibilityLabel="Close">
              <Ionicons name="close" size={20} color={ios.label2} />
            </Pressable>
          </View>

          {result ? (
            <View style={styles.successWrap}>
              <Ionicons name="checkmark-circle" size={40} color={ios.system.greenInk} />
              <Text style={styles.successTitle}>Payment recorded</Text>
              {result.excess > 0.001 ? (
                <Text style={styles.successBody}>
                  ${result.excess.toFixed(2)} unallocated → saved as account credit
                </Text>
              ) : null}
              <Pressable style={styles.submitBtn} onPress={handleClose}>
                <Text style={styles.submitText}>Done</Text>
              </Pressable>
            </View>
          ) : (
            <>
              <ScrollView
                showsVerticalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={{ paddingBottom: 8 }}
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

                <FormSection title="Amount paid">
                  <FormField label="Amount" error={error ?? undefined}>
                    <FormTextInput
                      value={amount}
                      onChangeText={setAmount}
                      placeholder="0.00"
                      keyboardType="decimal-pad"
                    />
                  </FormField>
                  <FormField label="Reference (optional)">
                    <FormTextInput
                      value={reference}
                      onChangeText={setReference}
                      placeholder="Check #, txn ID…"
                    />
                  </FormField>
                </FormSection>

                <FormSection title="Apply to bills">
                  {openBills.length === 0 ? (
                    <Text style={styles.emptyText}>
                      No open bills — the full amount will be saved as account credit.
                    </Text>
                  ) : (
                    openBills.map((bill, i) => {
                      const balance = billBalance(bill);
                      return (
                        <View
                          key={bill.id}
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
                              {bill.billNumber ?? "Bill"}
                            </Text>
                            <Text style={styles.allocMeta}>
                              Owed ${balance.toFixed(2)}
                              {bill.billDate ? ` · ${fmtCalendarDate(bill.billDate)}` : ""}
                            </Text>
                          </View>
                          <View style={styles.allocInputWrap}>
                            <Text style={styles.allocCurrency}>$</Text>
                            <MoneyTextInput
                              style={[
                                styles.allocInput,
                                (allocs[bill.id] ?? 0) > 0 && styles.allocInputActive,
                              ]}
                              value={allocs[bill.id] ?? null}
                              onChangeValue={(v) => setRowAmount(bill, v)}
                              placeholder="0.00"
                              returnKeyType="done"
                            />
                          </View>
                        </View>
                      );
                    })
                  )}

                  {/* Live footer — mirrors web's Allocated / Received / Unallocated strip. */}
                  <View style={styles.totalsStrip}>
                    <Text style={styles.totalsLine}>
                      Allocated ${totals.allocated.toFixed(2)} of ${amountNum.toFixed(2)} paid
                    </Text>
                    {totals.overAllocated ? (
                      <Text style={styles.totalsOver}>
                        Allocated more than paid — reduce a line.
                      </Text>
                    ) : totals.excess > 0.001 ? (
                      <Text style={styles.totalsExcess}>
                        ${totals.excess.toFixed(2)} unallocated → stays on account
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
                        // Local-timezone today, not UTC.
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
              </ScrollView>

              <Pressable
                style={[
                  styles.submitBtn,
                  (mut.isPending || amountNum <= 0 || totals.overAllocated) &&
                    styles.submitBtnDisabled,
                ]}
                onPress={submit}
                disabled={mut.isPending || amountNum <= 0 || totals.overAllocated}
              >
                {mut.isPending ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.submitText}>Save payment</Text>
                )}
              </Pressable>
            </>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)" },
  sheetWrap: { position: "absolute", left: 0, right: 0, bottom: 0 },
  sheet: {
    maxHeight: "90%",
    backgroundColor: ios.bg,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 16,
    paddingTop: 6,
    paddingBottom: 16,
  },
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 10,
    paddingVertical: 10,
  },
  title: { fontSize: 16, fontFamily: "Inter_700Bold", color: ios.label },
  subtitle: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },

  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999 },
  chipActive: { backgroundColor: ios.brand },
  chipInactive: { backgroundColor: ios.fill3 },
  chipText: { fontSize: 13, fontFamily: "Inter_500Medium" },
  chipTextActive: { color: "#fff" },
  chipTextInactive: { color: ios.label },

  emptyText: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2 },
  allocRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10 },
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

  submitBtn: {
    marginTop: 10,
    backgroundColor: ios.brand,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  submitBtnDisabled: { opacity: 0.4 },
  submitText: { fontSize: 16, fontFamily: "Inter_600SemiBold", color: "#fff" },

  successWrap: { alignItems: "center", gap: 8, paddingVertical: 32, paddingHorizontal: 16 },
  successTitle: { fontSize: 17, fontFamily: "Inter_700Bold", color: ios.label },
  successBody: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    textAlign: "center",
  },
});
