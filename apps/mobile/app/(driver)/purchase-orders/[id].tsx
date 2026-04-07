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
import { useState } from "react";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors, borderRadius, shadows } from "@routeflow/ui/tokens";
import {
  usePurchaseOrder,
  useReceivePO,
  type POItem,
  type POStatus,
} from "../../../lib/api/purchase-orders";
import { NetworkError } from "../../../components/NetworkError";

// ─── Status config ────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<POStatus, { label: string; color: string; bg: string }> = {
  DRAFT: { label: "Draft", color: "#64748b", bg: "#f1f5f9" },
  SENT: { label: "Sent", color: colors.brand[600], bg: colors.brand[50] },
  PARTIALLY_RECEIVED: { label: "Partially Received", color: "#d97706", bg: "#fef3c7" },
  RECEIVED: { label: "Fully Received", color: colors.success.DEFAULT, bg: colors.success.bg },
  CLOSED: { label: "Closed", color: "#94a3b8", bg: "#f8fafc" },
};

// ─── Receive item row ─────────────────────────────────────────────────────────

function ReceiveItemRow({
  item,
  receivedQty,
  onChange,
  disabled,
}: {
  item: POItem;
  receivedQty: string;
  onChange: (val: string) => void;
  disabled: boolean;
}) {
  const alreadyReceived = Number(item.qtyReceived ?? 0);
  const ordered = Number(item.qtyOrdered);
  const remaining = Math.max(0, ordered - alreadyReceived);
  const isFullyReceived = alreadyReceived >= ordered;

  return (
    <View style={styles.itemRow}>
      <View style={styles.itemInfo}>
        <Text style={styles.itemName}>{item.product?.name ?? "Unknown"}</Text>
        <View style={styles.itemMeta}>
          <Text style={styles.itemMetaText}>
            Ordered: {ordered} {item.product?.unit}
          </Text>
          {alreadyReceived > 0 && (
            <Text style={[styles.itemMetaText, { color: colors.success.DEFAULT }]}>
              · Already received: {alreadyReceived}
            </Text>
          )}
          {!isFullyReceived && (
            <Text style={[styles.itemMetaText, { color: "#d97706" }]}>
              · Remaining: {remaining}
            </Text>
          )}
        </View>
      </View>

      {isFullyReceived ? (
        <View style={styles.receivedBadge}>
          <Ionicons name="checkmark-circle" size={16} color={colors.success.DEFAULT} />
          <Text style={styles.receivedBadgeText}>Done</Text>
        </View>
      ) : (
        <View style={styles.qtyInputWrap}>
          <Pressable
            style={styles.qtyBtn}
            onPress={() => onChange(String(Math.max(0, parseFloat(receivedQty || "0") - 1)))}
            disabled={disabled}
          >
            <Ionicons name="remove" size={18} color={colors.navy.DEFAULT} />
          </Pressable>
          <TextInput
            style={styles.qtyInput}
            value={receivedQty}
            onChangeText={onChange}
            keyboardType="decimal-pad"
            textAlign="center"
            editable={!disabled}
          />
          <Pressable
            style={styles.qtyBtn}
            onPress={() => onChange(String(parseFloat(receivedQty || "0") + 1))}
            disabled={disabled}
          >
            <Ionicons name="add" size={18} color={colors.navy.DEFAULT} />
          </Pressable>
        </View>
      )}
    </View>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function PODetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: po, isLoading, isError, refetch } = usePurchaseOrder(id);
  const receiveMutation = useReceivePO();

  // Map itemId → received qty string (init to remaining qty)
  const [receivedQtys, setReceivedQtys] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState("");

  if (isLoading) {
    return (
      <>
        <Stack.Screen options={{ title: "Purchase Order" }} />
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.brand[500]} />
        </View>
      </>
    );
  }

  if (isError || !po) {
    return (
      <>
        <Stack.Screen options={{ title: "Purchase Order" }} />
        <NetworkError onRetry={() => refetch()} />
      </>
    );
  }

  const statusCfg = STATUS_CONFIG[po.status] ?? STATUS_CONFIG.DRAFT;
  const canReceive = po.status === "SENT" || po.status === "PARTIALLY_RECEIVED";

  // Initialise receivedQty for each item to its remaining qty (first render)
  const getReceived = (item: POItem) => {
    if (receivedQtys[item.id] !== undefined) return receivedQtys[item.id];
    const remaining = Math.max(0, Number(item.qtyOrdered) - Number(item.qtyReceived ?? 0));
    return String(remaining);
  };

  function handleReceive() {
    if (!po) return;

    const itemsToReceive = po.items
      .filter((item) => {
        const alreadyDone = Number(item.qtyReceived ?? 0) >= Number(item.qtyOrdered);
        if (alreadyDone) return false;
        const qty = parseFloat(getReceived(item));
        return qty > 0;
      })
      .map((item) => ({
        itemId: item.id,
        qtyReceived: parseFloat(getReceived(item)),
      }));

    if (itemsToReceive.length === 0) {
      return Alert.alert("Nothing to receive", "Enter quantities for at least one item.");
    }

    Alert.alert(
      "Confirm Receipt",
      `Record receipt of ${itemsToReceive.length} item(s) from ${po.supplier?.name ?? "supplier"}?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Confirm",
          onPress: () =>
            receiveMutation.mutate(
              { id: po.id, dto: { items: itemsToReceive, notes: notes.trim() || undefined } },
              {
                onSuccess: () =>
                  Alert.alert("Received", "Stock has been updated.", [
                    { text: "OK", onPress: () => router.back() },
                  ]),
                onError: (e) => Alert.alert("Error", e.message ?? "Failed to receive PO."),
              },
            ),
        },
      ],
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: po.poNumber }} />
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        {/* Header card */}
        <View style={styles.headerCard}>
          <View style={styles.headerRow}>
            <View style={styles.headerLeft}>
              <Text style={styles.poNumber}>{po.poNumber}</Text>
              <Text style={styles.supplierName}>
                {po.supplier?.name ?? "Unknown Supplier"}
              </Text>
            </View>
            <View style={[styles.statusBadge, { backgroundColor: statusCfg.bg }]}>
              <Text style={[styles.statusBadgeText, { color: statusCfg.color }]}>
                {statusCfg.label}
              </Text>
            </View>
          </View>

          {po.expectedDate && (
            <View style={styles.metaRow}>
              <Ionicons name="calendar-outline" size={14} color="#64748b" />
              <Text style={styles.metaText}>
                Expected:{" "}
                {new Date(po.expectedDate).toLocaleDateString("en-US", {
                  weekday: "long",
                  month: "short",
                  day: "numeric",
                })}
              </Text>
            </View>
          )}

          {po.notes && (
            <View style={styles.metaRow}>
              <Ionicons name="document-text-outline" size={14} color="#64748b" />
              <Text style={styles.metaText}>{po.notes}</Text>
            </View>
          )}
        </View>

        {/* Items */}
        <Text style={styles.sectionTitle}>Items</Text>
        <View style={styles.itemsCard}>
          {po.items.map((item, idx) => (
            <View key={item.id}>
              {idx > 0 && <View style={styles.divider} />}
              <ReceiveItemRow
                item={item}
                receivedQty={getReceived(item)}
                onChange={(val) =>
                  setReceivedQtys((prev) => ({ ...prev, [item.id]: val }))
                }
                disabled={!canReceive || receiveMutation.isPending}
              />
            </View>
          ))}
        </View>

        {/* Discrepancy / notes */}
        {canReceive && (
          <>
            <Text style={styles.sectionTitle}>Receipt Notes</Text>
            <View style={styles.card}>
              <TextInput
                style={styles.notesInput}
                placeholder="Note any discrepancies, damaged goods, etc…"
                placeholderTextColor="#94a3b8"
                value={notes}
                onChangeText={setNotes}
                multiline
                numberOfLines={3}
              />
            </View>

            <Pressable
              style={[styles.receiveBtn, receiveMutation.isPending && { opacity: 0.5 }]}
              onPress={handleReceive}
              disabled={receiveMutation.isPending}
            >
              {receiveMutation.isPending ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <>
                  <Ionicons name="checkmark-circle-outline" size={20} color="#fff" />
                  <Text style={styles.receiveBtnText}>Confirm Receipt</Text>
                </>
              )}
            </Pressable>
          </>
        )}

        {!canReceive && po.status === "RECEIVED" && (
          <View style={styles.completeBanner}>
            <Ionicons name="checkmark-circle" size={20} color={colors.success.DEFAULT} />
            <Text style={styles.completeBannerText}>
              All items fully received. Stock has been updated.
            </Text>
          </View>
        )}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surface.raised },
  content: { padding: 16, paddingBottom: 48, gap: 0 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },

  headerCard: {
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    padding: 16,
    gap: 10,
    marginBottom: 20,
    ...shadows.card,
  },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 8,
  },
  headerLeft: { flex: 1, gap: 2 },
  poNumber: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  supplierName: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },
  statusBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: borderRadius.full,
  },
  statusBadgeText: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  metaText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
    flex: 1,
  },

  sectionTitle: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: "#94a3b8",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 8,
    marginTop: 4,
  },

  itemsCard: {
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    overflow: "hidden",
    marginBottom: 20,
    ...shadows.card,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.surface.border,
    marginHorizontal: 16,
  },
  itemRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 12,
  },
  itemInfo: { flex: 1, gap: 4 },
  itemName: {
    fontSize: 15,
    fontFamily: "Inter_500Medium",
    color: colors.navy.DEFAULT,
  },
  itemMeta: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 4,
  },
  itemMetaText: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },

  receivedBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: colors.success.bg,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: borderRadius.full,
  },
  receivedBadgeText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: colors.success.DEFAULT,
  },

  qtyInputWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  qtyBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.surface.raised,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.surface.border,
  },
  qtyInput: {
    width: 54,
    height: 36,
    borderRadius: borderRadius.DEFAULT,
    borderWidth: 1,
    borderColor: colors.surface.border,
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    color: colors.navy.DEFAULT,
    backgroundColor: "#fff",
  },

  card: {
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    marginBottom: 16,
    ...shadows.card,
  },
  notesInput: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: colors.navy.DEFAULT,
    paddingHorizontal: 16,
    paddingVertical: 14,
    minHeight: 90,
    textAlignVertical: "top",
  },

  receiveBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: colors.brand[600],
    borderRadius: borderRadius.lg,
    paddingVertical: 16,
    marginTop: 8,
  },
  receiveBtnText: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    color: "#fff",
  },

  completeBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: colors.success.bg,
    borderRadius: borderRadius.lg,
    padding: 16,
    marginTop: 8,
  },
  completeBannerText: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: colors.success.DEFAULT,
    flex: 1,
  },
});
