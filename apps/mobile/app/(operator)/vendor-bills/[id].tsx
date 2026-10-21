import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ActivityIndicator } from "react-native";
import { ios } from "@routeflow/ui/tokens";
import { NavBackButton, NavBar, Pill } from "@routeflow/ui/mobile/ios";
import {
  useVendorBill,
  useReceiveVendorBill,
  useVoidVendorBill,
  useMoveVendorBillPaymentToCredit,
  getUnlinkedItemsError,
  billNeedsMapping,
} from "../../../lib/api/vendor-bills";
import { vendorBillPillFor as billPill } from "../../../lib/vendor-bill-logic";
import {
  billHasPaymentsRefusal,
  canOfferMoveAll,
  usd,
  isMovableBillPayment,
  movablePayments,
  moveToCreditFailureCopy,
  movePaymentConfirmCopy,
  movePaymentsConfirmCopy,
  movedToCreditCopy,
  voidRefusalCopy,
} from "../../../lib/vendor-bill-payments-logic";
import { paymentMethodLabel } from "../../../lib/payment-methods";
import type { VendorBillPayment } from "../../../lib/api/vendor-bills";
import { showToast } from "../../../lib/toast";
import { confirm } from "../../../lib/confirm";
import { getPackSizeUnknownError, packSizeUnknownPrompt } from "../../../lib/pack-size-unknown";
import { fmtCalendarDate } from "../../../lib/format-date";

function formatCurrency(n: number | string | undefined): string {
  const v = typeof n === "string" ? Number(n) : (n ?? 0);
  return `$${(Number.isFinite(v) ? v : 0).toFixed(2)}`;
}

/** Payment dates are real timestamps (not calendar dates): render in the viewer's local time. */
function fmtPaymentDate(pmt: VendorBillPayment): string {
  return new Date(pmt.paidAt ?? pmt.createdAt).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function VendorBillDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: bill, isLoading, refetch } = useVendorBill(id);
  const [moving, setMoving] = useState(false);
  const receiveMut = useReceiveVendorBill();
  const voidMut = useVoidVendorBill();
  const moveMut = useMoveVendorBillPaymentToCredit();

  if (isLoading || !bill) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar
          inlineTitle="Bill"
          leading={<NavBackButton label="Back" onPress={() => router.back()} />}
        />
        <View style={styles.center}>
          <ActivityIndicator color={ios.brand} />
        </View>
      </SafeAreaView>
    );
  }

  const p = billPill(bill.status);

  const onReceive = (acknowledgeUnlinked = false, acknowledgePackSizeUnknown = false) =>
    receiveMut.mutate(
      { id: bill.id, acknowledgeUnlinked, acknowledgePackSizeUnknown },
      {
        onSuccess: () => showToast("Bill marked as received"),
        onError: (e: any) => {
          // B743: a case-sold product's line with no units per case — an explicit choice, with
          // the loose-pieces consequence spelled out. Keeps this attempt's unlinked acknowledgement.
          const packUnknown = getPackSizeUnknownError(e);
          if (packUnknown) {
            const prompt = packSizeUnknownPrompt(packUnknown);
            confirm(prompt.title, prompt.message, () => onReceive(acknowledgeUnlinked, true), {
              confirmText: prompt.confirmText,
            });
            return;
          }
          // Unmapped lines: confirm they'll be skipped, then retry acknowledged
          const unlinked = getUnlinkedItemsError(e);
          if (unlinked) {
            const lines =
              unlinked.unlinkedItems.length > 0
                ? `\n\n${unlinked.unlinkedItems
                    .slice(0, 5)
                    .map((i) => `• ${i.description || "(no description)"}`)
                    .join(
                      "\n",
                    )}${unlinked.unlinkedItems.length > 5 ? `\n…and ${unlinked.unlinkedItems.length - 5} more` : ""}`
                : "";
            confirm(
              "Some lines won't update costs",
              `${unlinked.message}${lines}`,
              () => onReceive(true),
              { confirmText: "Receive anyway" },
            );
            return;
          }
          showToast(e?.response?.data?.message ?? e?.message ?? "Try again.");
        },
      },
    );

  /** Move the given cash payments to supplier credit one at a time (the endpoint is per payment). */
  const movePayments = async (payments: VendorBillPayment[]) => {
    setMoving(true);
    let moved = 0;
    let total = 0;
    try {
      for (const pmt of payments) {
        await moveMut.mutateAsync({ billId: bill.id, paymentId: pmt.id });
        moved += 1;
        total += Number(pmt.amount);
      }
      showToast(movedToCreditCopy(moved, total));
    } catch (e) {
      // Earlier payments in this run did move; the refresh in onSettled shows what is left.
      showToast(
        moved > 0
          ? `${movedToCreditCopy(moved, total)}. ${moveToCreditFailureCopy(e)}`
          : moveToCreditFailureCopy(e),
      );
    } finally {
      setMoving(false);
    }
  };

  const onMovePayment = (pmt: VendorBillPayment) => {
    const copy = movePaymentConfirmCopy(pmt, bill.status, fmtPaymentDate(pmt));
    confirm(copy.title, copy.message, () => void movePayments([pmt]), {
      confirmText: copy.confirmText,
    });
  };

  const onVoid = () =>
    confirm(
      "Void bill?",
      "This cannot be undone.",
      () =>
        voidMut.mutate(bill.id, {
          onSuccess: () => showToast("Bill voided"),
          onError: (e: any) => {
            // B288: cash payments sit on the bill. Refetch first so the prompt is built from the
            // server's current payments, and offer move-all only if it matches the refusal amount.
            const refusal = billHasPaymentsRefusal(e);
            if (refusal.kind !== "has-payments") {
              showToast(voidRefusalCopy(e));
              return;
            }
            void refetch().then((r) => {
              const cash = movablePayments(r.data?.payments);
              if (canOfferMoveAll(cash, refusal.amount)) {
                const copy = movePaymentsConfirmCopy(cash);
                confirm(
                  "Bill has payments",
                  `${voidRefusalCopy(e)}

${copy.message}`,
                  () => void movePayments(cash),
                  { confirmText: copy.confirmText },
                );
              } else {
                showToast(voidRefusalCopy(e));
              }
            });
          },
        }),
      { confirmText: "Void", destructive: true },
    );

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Vendor Bill"
        leading={<NavBackButton label="Back" onPress={() => router.back()} />}
      />
      <ScrollView showsVerticalScrollIndicator={false}>
        {/* Header card */}
        <View style={styles.headerCard}>
          <View style={styles.headerRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.supplierName}>{bill.supplier?.name ?? "Supplier"}</Text>
              {bill.billNumber ? <Text style={styles.billNumber}>{bill.billNumber}</Text> : null}
            </View>
            <Pill variant={p.variant} dot>
              {p.label}
            </Pill>
          </View>
          <View style={styles.metaRow}>
            {bill.billDate ? (
              <Text style={styles.meta}>Bill date: {fmtCalendarDate(bill.billDate, "short")}</Text>
            ) : null}
            {bill.dueDate ? (
              <Text style={styles.meta}>Due: {fmtCalendarDate(bill.dueDate, "short")}</Text>
            ) : null}
          </View>
          <Text style={styles.totalAmount}>{formatCurrency(bill.totalOwed)}</Text>
          {bill.notes ? <Text style={styles.notes}>{bill.notes}</Text> : null}
          {billNeedsMapping(bill) ? (
            <View style={styles.warnBanner}>
              <Ionicons name="alert-circle" size={14} color="#92400E" />
              <Text style={styles.warnText}>
                {(bill.items?.length ?? 0) === 0
                  ? "No line items — receiving won't update inventory or costs."
                  : "Some lines aren't linked to products and won't update costs."}
              </Text>
            </View>
          ) : null}
        </View>

        {/* Items */}
        {(bill.items?.length ?? 0) > 0 ? (
          <>
            <View style={styles.sectionRow}>
              <Text style={styles.sectionTitle}>Line items</Text>
            </View>
            <View style={styles.itemsList}>
              {bill.items!.map((item, i) => (
                <View
                  key={item.id}
                  style={[
                    styles.itemRow,
                    i > 0 && {
                      borderTopWidth: StyleSheet.hairlineWidth,
                      borderTopColor: ios.separator,
                    },
                  ]}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={styles.itemName} numberOfLines={1}>
                      {item.product?.name ?? item.description}
                    </Text>
                    <Text style={styles.itemMeta}>
                      {item.qty} × {formatCurrency(item.unitCost)}
                    </Text>
                  </View>
                  <Text style={styles.itemTotal}>
                    {formatCurrency(item.lineTotal ?? Number(item.qty) * Number(item.unitCost))}
                  </Text>
                </View>
              ))}
            </View>
          </>
        ) : null}

        {/* Payments (B288: cash can be moved to a supplier credit) */}
        {(bill.payments?.length ?? 0) > 0 ? (
          <>
            <View style={styles.sectionRow}>
              <Text style={styles.sectionTitle}>Payments</Text>
            </View>
            <View style={styles.itemsList}>
              {bill.payments!.map((pmt, i) => (
                <View
                  key={pmt.id}
                  style={[
                    styles.itemRow,
                    i > 0 && {
                      borderTopWidth: StyleSheet.hairlineWidth,
                      borderTopColor: ios.separator,
                    },
                  ]}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={styles.itemName}>{usd(Number(pmt.amount))}</Text>
                    <Text style={styles.itemMeta}>
                      {paymentMethodLabel(pmt.method)} · {fmtPaymentDate(pmt)}
                      {pmt.reference ? ` · ${pmt.reference}` : ""}
                    </Text>
                    {isMovableBillPayment(pmt) ? (
                      <Pressable
                        onPress={() => onMovePayment(pmt)}
                        disabled={moveMut.isPending || moving}
                        accessibilityRole="button"
                        hitSlop={8}
                      >
                        <Text style={styles.linkText}>Move to supplier credit</Text>
                      </Pressable>
                    ) : null}
                  </View>
                </View>
              ))}
            </View>
          </>
        ) : null}

        {/* Actions */}
        {bill.status === "DRAFT" || bill.status === "RECEIVED" || bill.status === "PARTIAL" ? (
          <View style={styles.actionsRow}>
            {bill.status === "DRAFT" || bill.status === "RECEIVED" ? (
              <Pressable
                style={styles.primaryBtn}
                onPress={() => onReceive()}
                disabled={receiveMut.isPending}
              >
                <Ionicons name="checkmark" size={16} color="#fff" />
                <Text style={styles.primaryBtnText}>Mark received</Text>
              </Pressable>
            ) : null}
            <Pressable
              style={styles.ghostBtn}
              onPress={onVoid}
              disabled={voidMut.isPending || moveMut.isPending || moving}
            >
              <Text style={styles.ghostBtnText}>Void</Text>
            </Pressable>
          </View>
        ) : null}

        <View style={{ height: 32 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  headerCard: {
    margin: 16,
    backgroundColor: ios.bgElev,
    borderRadius: 16,
    padding: 18,
    gap: 8,
  },
  headerRow: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  supplierName: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    letterSpacing: -0.3,
  },
  billNumber: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  metaRow: { gap: 2 },
  meta: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2 },
  totalAmount: {
    fontSize: 28,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    letterSpacing: -0.6,
    marginTop: 4,
  },
  notes: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 4 },
  warnBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 6,
    backgroundColor: "#FEF3C7",
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginTop: 6,
  },
  warnText: { flex: 1, fontSize: 12, fontFamily: "Inter_500Medium", color: "#92400E" },
  sectionRow: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 8 },
  sectionTitle: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    letterSpacing: -0.3,
  },
  itemsList: {
    marginHorizontal: 16,
    backgroundColor: ios.bgElev,
    borderRadius: 12,
    overflow: "hidden",
  },
  itemRow: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  itemName: { fontSize: 15, fontFamily: "Inter_500Medium", color: ios.label },
  itemMeta: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  itemTotal: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  linkText: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: ios.brand, marginTop: 6 },
  actionsRow: { flexDirection: "row", gap: 10, paddingHorizontal: 16, marginTop: 24 },
  primaryBtn: {
    flex: 1,
    backgroundColor: ios.brand,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 14,
    borderRadius: 14,
  },
  primaryBtnText: { color: "#fff", fontSize: 15, fontFamily: "Inter_600SemiBold" },
  ghostBtn: {
    backgroundColor: ios.fill3,
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  ghostBtnText: { color: ios.label, fontSize: 15, fontFamily: "Inter_500Medium" },
});
