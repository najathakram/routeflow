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
 * Shared screen body for splitting an order into a partial invoice. Used by:
 *   - operator: from the order detail screen
 *   - driver:   from the stop-completion flow
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
  const createPartial = useCreatePartialInvoiceFromOrder();

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

  const onSubmit = () => {
    const chosen = billable
      .map((it) => ({ orderItemId: it.id, qty: Number(qtyById[it.id] ?? 0) }))
      .filter((row) => Number.isFinite(row.qty) && row.qty > 0);

    if (chosen.length === 0) {
      Alert.alert("Pick at least one item", "Set a qty greater than zero on any row.");
      return;
    }

    createPartial.mutate(
      { orderId, items: chosen, terms, dueDate, send },
      {
        onSuccess: (invoice) => {
          showToast(`Invoice ${invoice.invoiceNumber} ${send ? "sent" : "saved as draft"}`);
          onCreated(invoice.id);
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

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Split invoice"
        leading={<NavBackButton label={backLabel} onPress={onCancel} />}
        trailing={
          <NavAction
            label={createPartial.isPending ? "Saving…" : "Create"}
            bold
            onPress={createPartial.isPending ? undefined : onSubmit}
          />
        }
      />

      <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }}>
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Order {orderNumber ?? orderId.slice(0, 8)}</Text>
          {billable.length === 0 ? (
            <Text style={styles.empty}>All items on this order are already invoiced.</Text>
          ) : (
            billable.map((it) => {
              const remaining = it.qty - it.invoicedQty;
              return (
                <View key={it.id} style={styles.row}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.itemName} numberOfLines={1}>
                      {it.productName}
                    </Text>
                    <Text style={styles.itemSub}>
                      {remaining} {it.unit ?? "ea"} remaining · ${it.unitPrice.toFixed(2)}/ea
                    </Text>
                  </View>
                  <TextInput
                    keyboardType="decimal-pad"
                    style={styles.qtyInput}
                    value={qtyById[it.id] ?? ""}
                    onChangeText={(v) => {
                      // clamp to remaining; keep raw string so partial typing works
                      const n = Number(v);
                      if (Number.isFinite(n) && n > remaining) {
                        setQtyById((prev) => ({ ...prev, [it.id]: String(remaining) }));
                      } else {
                        setQtyById((prev) => ({ ...prev, [it.id]: v }));
                      }
                    }}
                  />
                </View>
              );
            })
          )}
        </View>

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

        <Pressable style={styles.sendRow} onPress={() => setSend((s) => !s)}>
          <View style={[styles.checkbox, send && styles.checkboxOn]}>
            {send ? <Text style={styles.checkboxTick}>✓</Text> : null}
          </View>
          <Text style={styles.sendLabel}>Send immediately (mark as SENT)</Text>
        </Pressable>

        <View style={styles.totalRow}>
          <Text style={styles.totalLabel}>Invoice subtotal</Text>
          <Text style={styles.totalValue}>${total.toFixed(2)}</Text>
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
  cardTitle: { fontSize: 14, fontWeight: "600", color: ios.label },
  empty: { fontSize: 14, color: ios.label2 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
  },
  itemName: { fontSize: 15, fontWeight: "500", color: ios.label },
  itemSub: { fontSize: 12, color: ios.label2, marginTop: 2 },
  qtyInput: {
    width: 80,
    borderWidth: 1,
    borderColor: ios.separator,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 6,
    textAlign: "right",
    color: ios.label,
    fontSize: 14,
  },
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
  termPillTextActive: { color: "#fff", fontWeight: "600" },
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
  checkboxTick: { color: "#fff", fontWeight: "700" },
  sendLabel: { fontSize: 14, color: ios.label },
  totalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 4,
    paddingTop: 4,
  },
  totalLabel: { fontSize: 14, color: ios.label2 },
  totalValue: { fontSize: 18, fontWeight: "700", color: ios.label },
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
