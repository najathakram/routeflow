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
import { useEffect, useRef, useState } from "react";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors, borderRadius, shadows } from "@routeflow/ui/tokens";
import { useRouteRun } from "../../../../../../lib/api/routes";
import {
  useCreateReturn,
  type ReturnReason,
  type CreateReturnItemDto,
} from "../../../../../../lib/api/returns";

const REASONS: { key: ReturnReason; label: string; icon: string }[] = [
  { key: "DAMAGED",          label: "Damaged",        icon: "alert-circle-outline" },
  { key: "WRONG_ITEM",       label: "Wrong Item",     icon: "swap-horizontal-outline" },
  { key: "CUSTOMER_REFUSED", label: "Refused",        icon: "close-circle-outline" },
  { key: "QUALITY_ISSUE",    label: "Quality Issue",  icon: "thumbs-down-outline" },
  { key: "EXCESS_ORDER",     label: "Excess",         icon: "layers-outline" },
];

interface ReturnLineItem {
  itemId: string;       // original order item id
  productId: string;
  name: string;
  orderedQty: number;
  returnQty: string;    // string for input
  reason: ReturnReason;
  selected: boolean;
}

export default function DriverReturnScreen() {
  const { stopId, runId } = useLocalSearchParams<{ stopId: string; runId: string }>();
  const { data: run } = useRouteRun(runId ?? "");
  const { mutate: createReturn, isPending } = useCreateReturn();

  const stop = run?.stops?.find((s) => s.id === stopId);
  const allItems = (stop?.orders ?? []).flatMap((o) =>
    (o.lineItems ?? []).map((i) => ({
      itemId: i.id,
      productId: i.productId,
      name: i.product?.name ?? i.productId,
      orderedQty: i.qty,
      orderId: o.id,
    })),
  );

  const [globalReason, setGlobalReason] = useState<ReturnReason>("DAMAGED");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<ReturnLineItem[]>([]);
  const linesInitialized = useRef(false);

  useEffect(() => {
    if (!linesInitialized.current && allItems.length > 0) {
      linesInitialized.current = true;
      setLines(
        allItems.map((i) => ({
          itemId: i.itemId,
          productId: i.productId,
          name: i.name,
          orderedQty: i.orderedQty,
          returnQty: "",
          reason: "DAMAGED",
          selected: false,
        })),
      );
    }
  }, [allItems]);

  const toggleLine = (itemId: string) =>
    setLines((prev) =>
      prev.map((l) =>
        l.itemId === itemId
          ? { ...l, selected: !l.selected, returnQty: l.selected ? "" : String(l.orderedQty) }
          : l,
      ),
    );

  const updateQty = (itemId: string, qty: string) =>
    setLines((prev) => prev.map((l) => (l.itemId === itemId ? { ...l, returnQty: qty } : l)));

  const updateReason = (itemId: string, reason: ReturnReason) =>
    setLines((prev) => prev.map((l) => (l.itemId === itemId ? { ...l, reason } : l)));

  const selectedLines = lines.filter((l) => l.selected);
  const isValid = selectedLines.length > 0 && selectedLines.every((l) => {
    const n = parseInt(l.returnQty, 10);
    return !isNaN(n) && n > 0 && n <= l.orderedQty;
  });

  const handleSubmit = () => {
    if (!isValid || !stop) return;

    // Group by orderId (each stop may have multiple orders; returns are per-order)
    const orderId = stop.orders?.[0]?.id;
    if (!orderId) {
      Alert.alert("Error", "No order linked to this stop.");
      return;
    }

    const returnItems: CreateReturnItemDto[] = selectedLines.map((l) => ({
      productId: l.productId,
      qty: parseInt(l.returnQty, 10),
      reason: l.reason,
      restock: l.reason !== "DAMAGED" && l.reason !== "QUALITY_ISSUE",
    }));

    createReturn(
      { orderId, reason: globalReason, notes: notes || undefined, items: returnItems },
      {
        onSuccess: () => {
          Alert.alert("Return Logged", "The return has been recorded.", [
            { text: "OK", onPress: () => router.back() },
          ]);
        },
        onError: (err) => {
          Alert.alert("Error", "Failed to log return.\n" + (err.message || ""));
        },
      },
    );
  };

  if (!stop) {
    return (
      <View style={styles.centered}>
        <Text style={styles.notFoundText}>Stop not found.</Text>
      </View>
    );
  }

  return (
    <>
      <Stack.Screen
        options={{
          title: "Log Return",
          headerBackTitle: "Stop",
        }}
      />
      <View style={styles.container}>
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Customer */}
          <View style={styles.customerCard}>
            <Ionicons name="business-outline" size={18} color="#94a3b8" />
            <View>
              <Text style={styles.customerName}>{stop.customer?.businessName ?? "Customer"}</Text>
              <Text style={styles.customerSub}>Stop {stop.stopNumber}</Text>
            </View>
          </View>

          {/* Overall reason */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Return Reason</Text>
            <View style={styles.reasonGrid}>
              {REASONS.map(({ key, label, icon }) => (
                <Pressable
                  key={key}
                  style={[styles.reasonBtn, globalReason === key && styles.reasonBtnActive]}
                  onPress={() => {
                    setGlobalReason(key);
                    setLines((prev) => prev.map((l) => ({ ...l, reason: key })));
                  }}
                >
                  <Ionicons
                    name={icon as any}
                    size={18}
                    color={globalReason === key ? colors.brand[500] : "#94a3b8"}
                  />
                  <Text style={[styles.reasonBtnText, globalReason === key && styles.reasonBtnTextActive]}>
                    {label}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>

          {/* Items */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Items to Return</Text>
            {lines.length === 0 ? (
              <Text style={styles.emptyText}>No items in this stop's order.</Text>
            ) : (
              lines.map((line) => (
                <View key={line.itemId} style={styles.itemCard}>
                  <Pressable style={styles.itemHeader} onPress={() => toggleLine(line.itemId)}>
                    <View
                      style={[styles.checkbox, line.selected && styles.checkboxChecked]}
                    >
                      {line.selected && <Ionicons name="checkmark" size={14} color="#fff" />}
                    </View>
                    <View style={styles.itemInfo}>
                      <Text style={styles.itemName}>{line.name}</Text>
                      <Text style={styles.itemMeta}>Ordered: {line.orderedQty}</Text>
                    </View>
                  </Pressable>

                  {line.selected && (
                    <View style={styles.itemDetail}>
                      <View style={styles.qtyRow}>
                        <Text style={styles.qtyLabel}>Return qty:</Text>
                        <TextInput
                          style={styles.qtyInput}
                          value={line.returnQty}
                          onChangeText={(v) => updateQty(line.itemId, v)}
                          keyboardType="number-pad"
                          placeholder="0"
                          maxLength={3}
                        />
                        <Text style={styles.qtyMax}>/ {line.orderedQty}</Text>
                      </View>
                      <View style={styles.itemReasonRow}>
                        {REASONS.map(({ key, label }) => (
                          <Pressable
                            key={key}
                            style={[
                              styles.smallReasonBtn,
                              line.reason === key && styles.smallReasonBtnActive,
                            ]}
                            onPress={() => updateReason(line.itemId, key)}
                          >
                            <Text
                              style={[
                                styles.smallReasonText,
                                line.reason === key && styles.smallReasonTextActive,
                              ]}
                            >
                              {label}
                            </Text>
                          </Pressable>
                        ))}
                      </View>
                    </View>
                  )}
                </View>
              ))
            )}
          </View>

          {/* Notes */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Notes (optional)</Text>
            <TextInput
              style={styles.notesInput}
              placeholder="Additional notes about this return…"
              placeholderTextColor="#94a3b8"
              value={notes}
              onChangeText={setNotes}
              multiline
              numberOfLines={3}
              textAlignVertical="top"
            />
          </View>
        </ScrollView>

        <View style={styles.footer}>
          <Text style={styles.selectedCount}>
            {selectedLines.length} item{selectedLines.length !== 1 ? "s" : ""} selected
          </Text>
          <Pressable
            style={[styles.submitBtn, (!isValid || isPending) && styles.submitBtnDisabled]}
            onPress={handleSubmit}
            disabled={!isValid || isPending}
          >
            {isPending ? (
              <ActivityIndicator size="small" color="#fff" style={{ marginRight: 8 }} />
            ) : (
              <Ionicons name="return-down-back" size={22} color="#fff" style={{ marginRight: 8 }} />
            )}
            <Text style={styles.submitBtnText}>
              {isPending ? "Logging…" : "Log Return"}
            </Text>
          </Pressable>
        </View>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surface.raised },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  notFoundText: { fontSize: 16, fontFamily: "Inter_400Regular", color: "#94a3b8" },
  scroll: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 24,
    gap: 12,
  },
  customerCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    padding: 14,
    ...shadows.card,
  },
  customerName: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  customerSub: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },
  section: {
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    padding: 16,
    gap: 12,
    ...shadows.card,
  },
  sectionTitle: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: "#94a3b8",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  reasonGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  reasonBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: borderRadius.full,
    borderWidth: 1.5,
    borderColor: colors.surface.border,
    backgroundColor: colors.surface.raised,
  },
  reasonBtnActive: {
    borderColor: colors.brand[500],
    backgroundColor: colors.brand[50],
  },
  reasonBtnText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: "#94a3b8",
  },
  reasonBtnTextActive: { color: colors.brand[500] },
  emptyText: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
    textAlign: "center",
    paddingVertical: 8,
  },
  itemCard: {
    borderWidth: 1,
    borderColor: colors.surface.border,
    borderRadius: borderRadius.DEFAULT,
    overflow: "hidden",
  },
  itemHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 12,
  },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: colors.surface.border,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  checkboxChecked: {
    backgroundColor: colors.brand[500],
    borderColor: colors.brand[500],
  },
  itemInfo: { flex: 1, gap: 2 },
  itemName: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: colors.navy.DEFAULT,
  },
  itemMeta: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
  },
  itemDetail: {
    borderTopWidth: 1,
    borderTopColor: colors.surface.border,
    backgroundColor: colors.surface.raised,
    padding: 12,
    gap: 10,
  },
  qtyRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  qtyLabel: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: "#64748b",
  },
  qtyInput: {
    width: 64,
    height: 44,
    borderWidth: 1.5,
    borderColor: colors.brand[500],
    borderRadius: borderRadius.DEFAULT,
    textAlign: "center",
    fontSize: 20,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
    backgroundColor: "#fff",
  },
  qtyMax: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
  },
  itemReasonRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  smallReasonBtn: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: borderRadius.full,
    borderWidth: 1,
    borderColor: colors.surface.border,
  },
  smallReasonBtnActive: {
    borderColor: colors.brand[500],
    backgroundColor: colors.brand[50],
  },
  smallReasonText: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: "#94a3b8",
  },
  smallReasonTextActive: { color: colors.brand[500] },
  notesInput: {
    borderWidth: 1,
    borderColor: colors.surface.border,
    borderRadius: borderRadius.DEFAULT,
    padding: 12,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: colors.navy.DEFAULT,
    minHeight: 80,
    backgroundColor: colors.surface.raised,
    textAlignVertical: "top",
  },
  footer: {
    paddingHorizontal: 16,
    paddingBottom: 28,
    paddingTop: 12,
    backgroundColor: "#fff",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.surface.border,
    gap: 8,
  },
  selectedCount: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: "#94a3b8",
    textAlign: "center",
  },
  submitBtn: {
    height: 56,
    backgroundColor: colors.danger.DEFAULT,
    borderRadius: borderRadius.DEFAULT,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },
  submitBtnDisabled: { opacity: 0.4 },
  submitBtnText: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: "#fff",
  },
});
