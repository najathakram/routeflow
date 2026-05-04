import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { ios } from "@routeflow/ui/tokens";
import { NavBar, NavBackButton, NavAction } from "@routeflow/ui/mobile/ios";
import { useCreatePartialInvoiceFromOrder } from "../lib/api/invoices";
import { showToast } from "../lib/toast";

export interface SplitInvoiceItem {
  id: string;
  productName: string;
  qty: number;
  invoicedQty: number;
  unitPrice: number;
  unit?: string;
}

export interface SplitInvoiceScreenProps {
  orderId: string;
  orderNumber: string | null;
  items: SplitInvoiceItem[];
  defaultTerms?: string;
  /** Called after a successful create. Caller decides where to navigate next. */
  onCreated: (invoiceId: string) => void;
  onCancel: () => void;
  backLabel?: string;
}

const TERM_DAYS: Record<string, number> = {
  "Due on Receipt": 0,
  "Net 15": 15,
  "Net 30": 30,
  "Net 45": 45,
  "Net 60": 60,
};

function todayPlusDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Split an order into one OR MORE partial invoices.
 *
 * Each Create POSTs `/invoices/from-order/<orderId>/partial` with the per-item
 * qty the operator chose. The server increments OrderItem.invoicedQty so the
 * order can never be over-billed.
 *
 * The previous version of this screen made multi-invoice splitting non-obvious:
 *   - Qty fields defaulted to full remaining → hitting Create billed everything
 *     as one invoice. The operator's intent ("split into multiple") wasn't
 *     supported by the UI cues.
 *   - On success it called `onCreated` immediately, navigating away. To create
 *     a second invoice the operator had to find their way back to the order
 *     detail and click "Split into invoice…" again — friction the user called
 *     out as "we don't have the option".
 *
 * The new version:
 *   - Adds explicit per-row quick-fill buttons (All / Half / None) so it's
 *     obvious you can pick a portion.
 *   - On success, stays on the screen and shows a success card with
 *     "Create another invoice" (clears the form, refreshed remaining qtys
 *     come from the parent's refetched `items` prop) and "Done".
 *   - The empty/all-invoiced state hides the form and just shows "All
 *     items invoiced — Done."
 */
export function SplitInvoiceScreen({
  orderId,
  orderNumber,
  items,
  defaultTerms = "Net 30",
  onCreated,
  onCancel,
  backLabel = "Back",
}: SplitInvoiceScreenProps) {
  const billable = useMemo(
    () => items.filter((it) => it.qty - it.invoicedQty > 0.001),
    [items],
  );

  const [qtyById, setQtyById] = useState<Record<string, string>>({});
  const [terms, setTerms] = useState(defaultTerms);
  const [dueDate, setDueDate] = useState(() => todayPlusDays(TERM_DAYS[defaultTerms] ?? 30));
  const [send, setSend] = useState(false);
  /** Track the last invoice created in this session so we can show the
   *  "create another / done" affordance and a running list. */
  const [createdInvoices, setCreatedInvoices] = useState<
    Array<{ id: string; invoiceNumber: string; total: number }>
  >([]);
  const createPartial = useCreatePartialInvoiceFromOrder();

  // Reset qty defaults whenever the billable set changes (e.g. after a successful
  // create the parent refetches the order and `items` updates with fresh
  // invoicedQty). Default to full remaining — operator can dial down with the
  // quick-fill row.
  useEffect(() => {
    const next: Record<string, string> = {};
    billable.forEach((it) => {
      const remaining = Math.max(0, it.qty - it.invoicedQty);
      next[it.id] = String(remaining);
    });
    setQtyById(next);
  }, [billable]);

  const onTermsChange = (newTerms: string) => {
    setTerms(newTerms);
    setDueDate(todayPlusDays(TERM_DAYS[newTerms] ?? 30));
  };

  const total = billable.reduce((s, it) => {
    const q = Number(qtyById[it.id] ?? 0);
    if (!Number.isFinite(q)) return s;
    return s + q * it.unitPrice;
  }, 0);

  const itemsWithQty = billable.filter((it) => {
    const q = Number(qtyById[it.id] ?? 0);
    return Number.isFinite(q) && q > 0;
  }).length;

  const onSubmit = () => {
    const chosen = billable
      .map((it) => ({ orderItemId: it.id, qty: Number(qtyById[it.id] ?? 0) }))
      .filter((row) => Number.isFinite(row.qty) && row.qty > 0);

    if (chosen.length === 0) {
      Alert.alert(
        "Pick at least one item",
        "Set a qty greater than zero on any row, or use the All / Half buttons.",
      );
      return;
    }

    createPartial.mutate(
      { orderId, items: chosen, terms, dueDate, send },
      {
        onSuccess: (invoice) => {
          showToast(`Invoice ${invoice.invoiceNumber} ${send ? "sent" : "saved as draft"}`);
          // Append to the running list so the operator sees what's been
          // created and how much remains. Parent refetches via the mutation's
          // cache invalidation; the items prop will refresh and the useEffect
          // above resets qty defaults to the new remaining.
          setCreatedInvoices((prev) => [
            ...prev,
            {
              id: invoice.id,
              invoiceNumber: invoice.invoiceNumber,
              total: Number(invoice.total ?? 0),
            },
          ]);
        },
        onError: (err: Error) => {
          const errAny = err as unknown as { response?: { data?: { message?: string } } };
          Alert.alert(
            "Could not create invoice",
            errAny?.response?.data?.message ?? err?.message ?? "Try again.",
          );
        },
      },
    );
  };

  const setQtyAll = (it: SplitInvoiceItem) => {
    const remaining = Math.max(0, it.qty - it.invoicedQty);
    setQtyById((prev) => ({ ...prev, [it.id]: String(remaining) }));
  };
  const setQtyHalf = (it: SplitInvoiceItem) => {
    const remaining = Math.max(0, it.qty - it.invoicedQty);
    setQtyById((prev) => ({ ...prev, [it.id]: String(Math.ceil(remaining / 2)) }));
  };
  const setQtyNone = (it: SplitInvoiceItem) => {
    setQtyById((prev) => ({ ...prev, [it.id]: "0" }));
  };

  const allDoneNow = createdInvoices.length > 0 && billable.length === 0;
  const noBillableEver = createdInvoices.length === 0 && billable.length === 0;

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Split invoice"
        leading={<NavBackButton label={backLabel} onPress={onCancel} />}
        trailing={
          billable.length > 0 ? (
            <NavAction
              label={createPartial.isPending ? "Saving…" : "Create"}
              bold
              onPress={createPartial.isPending || itemsWithQty === 0 ? undefined : onSubmit}
            />
          ) : (
            <NavAction label="Done" bold onPress={onCancel} />
          )
        }
      />

      <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }}>
        {/* Helper banner so the multi-invoice flow is obvious from the first
            glance — was the user's specific complaint. */}
        {billable.length > 0 ? (
          <View style={styles.helperCard}>
            <Ionicons name="information-circle-outline" size={18} color={ios.brand} />
            <Text style={styles.helperText}>
              Allocate part of this order to one invoice now. After saving you
              can stay here and add another invoice for the rest.
            </Text>
          </View>
        ) : null}

        {/* Already-created list — gives the operator visible progress */}
        {createdInvoices.length > 0 ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>
              Created in this session ({createdInvoices.length})
            </Text>
            {createdInvoices.map((inv) => (
              <View key={inv.id} style={styles.createdRow}>
                <Ionicons name="checkmark-circle" size={16} color={ios.system.greenInk} />
                <Text style={styles.createdNumber}>{inv.invoiceNumber}</Text>
                <Text style={styles.createdTotal}>${inv.total.toFixed(2)}</Text>
              </View>
            ))}
          </View>
        ) : null}

        {/* Items + qty editor (or all-done state) */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>
            Order {orderNumber ?? orderId.slice(0, 8)}
          </Text>
          {noBillableEver ? (
            <Text style={styles.empty}>
              All items on this order are already invoiced.
            </Text>
          ) : allDoneNow ? (
            <View style={{ alignItems: "center", paddingVertical: 12, gap: 6 }}>
              <Ionicons name="checkmark-circle" size={32} color={ios.system.greenInk} />
              <Text style={styles.allDoneTitle}>All items invoiced</Text>
              <Text style={styles.allDoneSub}>
                {createdInvoices.length} invoice
                {createdInvoices.length === 1 ? "" : "s"} created. Tap Done to
                go back.
              </Text>
            </View>
          ) : (
            billable.map((it) => {
              const remaining = it.qty - it.invoicedQty;
              const q = Number(qtyById[it.id] ?? 0);
              const lineTotal = Number.isFinite(q) ? q * it.unitPrice : 0;
              return (
                <View key={it.id} style={styles.itemBlock}>
                  <View style={styles.itemHeader}>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={styles.itemName} numberOfLines={1}>
                        {it.productName}
                      </Text>
                      <Text style={styles.itemSub}>
                        {remaining} {it.unit ?? "ea"} remaining · $
                        {it.unitPrice.toFixed(2)}/ea
                      </Text>
                    </View>
                    <Text style={styles.itemLineTotal}>${lineTotal.toFixed(2)}</Text>
                  </View>
                  <View style={styles.qtyRow}>
                    <Text style={styles.qtyLabel}>Bill now:</Text>
                    <TextInput
                      keyboardType="decimal-pad"
                      style={styles.qtyInput}
                      value={qtyById[it.id] ?? ""}
                      onChangeText={(v) => {
                        // Allow free typing; on commit clamp to remaining.
                        const n = Number(v);
                        if (Number.isFinite(n) && n > remaining) {
                          setQtyById((prev) => ({ ...prev, [it.id]: String(remaining) }));
                        } else {
                          setQtyById((prev) => ({ ...prev, [it.id]: v }));
                        }
                      }}
                      selectTextOnFocus
                    />
                    <View style={styles.quickRow}>
                      <Pressable onPress={() => setQtyNone(it)} style={styles.quickBtn} hitSlop={4}>
                        <Text style={styles.quickBtnText}>None</Text>
                      </Pressable>
                      <Pressable onPress={() => setQtyHalf(it)} style={styles.quickBtn} hitSlop={4}>
                        <Text style={styles.quickBtnText}>Half</Text>
                      </Pressable>
                      <Pressable onPress={() => setQtyAll(it)} style={styles.quickBtn} hitSlop={4}>
                        <Text style={styles.quickBtnText}>All</Text>
                      </Pressable>
                    </View>
                  </View>
                </View>
              );
            })
          )}
        </View>

        {/* Terms + due date — hide when nothing left to bill */}
        {billable.length > 0 ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Payment terms</Text>
            <View style={styles.termsRow}>
              {Object.keys(TERM_DAYS).map((t) => {
                const active = t === terms;
                return (
                  <Pressable
                    key={t}
                    style={[styles.termPill, active && styles.termPillActive]}
                    onPress={() => onTermsChange(t)}
                  >
                    <Text style={[styles.termPillText, active && styles.termPillTextActive]}>
                      {t}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            <Text style={styles.dueDateLabel}>Due date</Text>
            <TextInput
              value={dueDate}
              onChangeText={setDueDate}
              placeholder="YYYY-MM-DD"
              style={styles.dueInput}
            />
          </View>
        ) : null}

        {billable.length > 0 ? (
          <Pressable style={styles.sendRow} onPress={() => setSend((s) => !s)}>
            <View style={[styles.checkbox, send && styles.checkboxOn]}>
              {send ? <Text style={styles.checkboxTick}>✓</Text> : null}
            </View>
            <Text style={styles.sendLabel}>Send immediately (mark as SENT)</Text>
          </Pressable>
        ) : null}

        {billable.length > 0 ? (
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>This invoice subtotal</Text>
            <Text style={styles.totalValue}>${total.toFixed(2)}</Text>
          </View>
        ) : null}

        {/* Bottom actions — primary changes based on state */}
        <View style={styles.actionStack}>
          {billable.length > 0 ? (
            <Pressable
              style={[
                styles.primaryBtn,
                (createPartial.isPending || itemsWithQty === 0) && styles.primaryBtnDisabled,
              ]}
              onPress={onSubmit}
              disabled={createPartial.isPending || itemsWithQty === 0}
            >
              <Text style={styles.primaryBtnText}>
                {createPartial.isPending
                  ? "Saving…"
                  : createdInvoices.length > 0
                    ? `Create invoice ${createdInvoices.length + 1}`
                    : "Create invoice"}
              </Text>
              <Ionicons name="arrow-forward" size={14} color="#fff" />
            </Pressable>
          ) : null}
          {createdInvoices.length > 0 ? (
            <Pressable
              style={styles.doneBtn}
              onPress={() => onCreated(createdInvoices[createdInvoices.length - 1]!.id)}
            >
              <Text style={styles.doneBtnText}>Done</Text>
            </Pressable>
          ) : null}
        </View>
      </ScrollView>

      {createPartial.isPending ? (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator color={ios.brand} />
        </View>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  card: {
    backgroundColor: ios.bgElev,
    borderRadius: 14,
    padding: 14,
    gap: 10,
  },
  cardTitle: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: ios.label },
  empty: { fontSize: 14, color: ios.label2 },

  // Helper banner
  helperCard: {
    backgroundColor: ios.brandWash,
    borderRadius: 12,
    padding: 12,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
  },
  helperText: {
    flex: 1,
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.brand,
    lineHeight: 18,
  },

  // Created-this-session list
  createdRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 4,
  },
  createdNumber: {
    flex: 1,
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: ios.label,
  },
  createdTotal: {
    fontSize: 13,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },

  // Item block
  itemBlock: {
    paddingTop: 10,
    paddingBottom: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
    gap: 8,
  },
  itemHeader: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  itemName: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },
  itemSub: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  itemLineTotal: {
    fontSize: 14,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  qtyRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  qtyLabel: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    color: ios.label2,
  },
  qtyInput: {
    width: 70,
    borderWidth: 1,
    borderColor: ios.separator,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 6,
    textAlign: "right",
    color: ios.label,
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    fontVariant: ["tabular-nums"],
  },
  quickRow: { flexDirection: "row", gap: 4 },
  quickBtn: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: ios.fill3,
  },
  quickBtnText: { fontSize: 12, fontFamily: "Inter_600SemiBold", color: ios.brand },

  // Terms
  termsRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  termPill: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: ios.separator,
  },
  termPillActive: { backgroundColor: ios.brand, borderColor: ios.brand },
  termPillText: { fontSize: 13, color: ios.label },
  termPillTextActive: { color: "#fff", fontFamily: "Inter_600SemiBold" },
  dueDateLabel: { fontSize: 12, color: ios.label2, marginTop: 6 },
  dueInput: {
    borderWidth: 1,
    borderColor: ios.separator,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
    color: ios.label,
  },
  sendRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 4 },
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
  sendLabel: { fontSize: 14, color: ios.label },
  totalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 4,
    paddingTop: 4,
  },
  totalLabel: { fontSize: 14, color: ios.label2 },
  totalValue: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },

  // All-done state
  allDoneTitle: { fontSize: 16, fontFamily: "Inter_700Bold", color: ios.label },
  allDoneSub: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    textAlign: "center",
  },

  // Action stack
  actionStack: { gap: 10, paddingTop: 4 },
  primaryBtn: {
    backgroundColor: ios.brand,
    borderRadius: 14,
    paddingHorizontal: 18,
    paddingVertical: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  primaryBtnDisabled: { opacity: 0.4 },
  primaryBtnText: { color: "#fff", fontSize: 15, fontFamily: "Inter_600SemiBold" },
  doneBtn: {
    backgroundColor: ios.fill3,
    borderRadius: 14,
    paddingHorizontal: 18,
    paddingVertical: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  doneBtnText: { color: ios.label, fontSize: 15, fontFamily: "Inter_600SemiBold" },

  loadingOverlay: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.05)",
  },
});
