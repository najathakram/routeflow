import { useState, useEffect, useRef } from "react";
import {
  ActivityIndicator,
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  ToastAndroid,
  View,
} from "react-native";
import * as Linking from "expo-linking";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors, borderRadius, shadows } from "@routeflow/ui/tokens";
import {
  useRouteRun,
  useUpdateStopStatus,
  type RouteRunOrderItem,
} from "../../../../../lib/api/routes";
import {
  useRouteStore,
  selectAllItemsResolved,
  selectStopResolutions,
  type ItemDeliveryStatus,
} from "../../../../../store/routeStore";
import { useProductByBarcode } from "../../../../../lib/api/products";
import { BarcodeScanner } from "../../../../../components/BarcodeScanner";
import { NetworkError } from "../../../../../components/NetworkError";

// ─── Open Maps ────────────────────────────────────────────────────────────────

function openMaps(query: string) {
  const encoded = encodeURIComponent(query);
  const url = Platform.select({
    ios: `maps://maps.apple.com/?q=${encoded}`,
    android: `geo:0,0?q=${encoded}`,
    default: `https://maps.google.com/?q=${encoded}`,
  })!;
  Linking.openURL(url).catch(() =>
    Alert.alert("Could not open Maps", "Please open your maps app manually."),
  );
}

function callPhone(phone: string) {
  Linking.openURL(`tel:${phone.replace(/\s/g, "")}`).catch(() =>
    Alert.alert("Could not open Phone", "Please dial " + phone + " manually."),
  );
}

// ─── Item Status Selector ─────────────────────────────────────────────────────

const STATUSES: { key: ItemDeliveryStatus; label: string; color: string; bg: string }[] = [
  { key: "DELIVERED", label: "Delivered", color: colors.success.DEFAULT, bg: colors.success.bg },
  { key: "PARTIAL", label: "Partial", color: colors.warning.DEFAULT, bg: colors.warning.bg },
  { key: "REFUSED", label: "Refused", color: colors.danger.DEFAULT, bg: colors.danger.bg },
];

function ItemRow({
  item,
  stopId,
  highlighted,
}: {
  item: RouteRunOrderItem & { isAdded?: boolean };
  stopId: string;
  highlighted?: boolean;
}) {
  const resolution = useRouteStore((s) => selectStopResolutions(s, stopId)[item.id]);
  const setItemResolution = useRouteStore((s) => s.setItemResolution);
  const current = resolution?.status ?? "UNRESOLVED";
  const [partialInput, setPartialInput] = useState(
    resolution?.partialQty?.toString() ?? "",
  );

  const handleSelect = (key: ItemDeliveryStatus) => {
    if (key === "PARTIAL") {
      setItemResolution(stopId, item.id, {
        status: "PARTIAL",
        partialQty: parseInt(partialInput || "0", 10) || 0,
      });
    } else {
      setItemResolution(stopId, item.id, { status: key });
    }
  };

  return (
    <View style={[itemStyles.container, highlighted && itemStyles.highlighted]}>
      <View style={itemStyles.header}>
        <Text style={itemStyles.name}>{item.product?.name ?? item.productId}</Text>
        <Text style={itemStyles.qty}>
          Ordered: <Text style={itemStyles.qtyBold}>{item.qty}</Text>
          {item.product?.unit ? ` × ${item.product.unit}` : ""}
        </Text>
      </View>

      {/* Three large toggle buttons */}
      <View style={itemStyles.toggleRow}>
        {STATUSES.map(({ key, label, color, bg }) => {
          const selected = current === key;
          return (
            <Pressable
              key={key}
              style={[
                itemStyles.toggleBtn,
                selected && { backgroundColor: bg, borderColor: color },
              ]}
              onPress={() => handleSelect(key)}
              accessibilityRole="button"
              accessibilityLabel={`Mark ${item.product?.name ?? ""} as ${label}`}
              accessibilityState={{ selected }}
            >
              <Text style={[itemStyles.toggleText, selected && { color }]}>
                {label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* Partial qty input */}
      {current === "PARTIAL" && (
        <View style={itemStyles.partialRow}>
          <Text style={itemStyles.partialLabel}>Qty delivered:</Text>
          <TextInput
            style={itemStyles.partialInput}
            keyboardType="number-pad"
            value={partialInput}
            onChangeText={(v) => {
              setPartialInput(v);
              const n = parseInt(v, 10);
              if (!isNaN(n)) {
                setItemResolution(stopId, item.id, { status: "PARTIAL", partialQty: n });
              }
            }}
            placeholder="0"
            maxLength={3}
            returnKeyType="done"
            onSubmitEditing={Keyboard.dismiss}
          />
          <Text style={itemStyles.partialMax}>/ {item.qty}</Text>
        </View>
      )}
    </View>
  );
}

const itemStyles = StyleSheet.create({
  container: {
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    padding: 16,
    gap: 12,
    ...shadows.card,
  },
  highlighted: {
    borderWidth: 2,
    borderColor: colors.brand[500],
    backgroundColor: colors.brand[50],
  },
  header: { gap: 2 },
  name: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  qty: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },
  qtyBold: {
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  toggleRow: { flexDirection: "row", gap: 8 },
  toggleBtn: {
    flex: 1,
    height: 56,
    borderRadius: borderRadius.DEFAULT,
    borderWidth: 1.5,
    borderColor: colors.surface.border,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface.raised,
  },
  toggleText: {
    fontSize: 14,
    fontFamily: "Inter_700Bold",
    color: "#64748b",
  },
  partialRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingTop: 4,
  },
  partialLabel: {
    fontSize: 15,
    fontFamily: "Inter_500Medium",
    color: colors.navy.DEFAULT,
  },
  partialInput: {
    width: 72,
    height: 48,
    borderWidth: 1.5,
    borderColor: colors.warning.DEFAULT,
    borderRadius: borderRadius.DEFAULT,
    textAlign: "center",
    fontSize: 20,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
    backgroundColor: colors.warning.bg,
  },
  partialMax: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },
});

// ─── Add Item Inline Form ─────────────────────────────────────────────────────

function AddItemForm({ stopId, onDone }: { stopId: string; onDone: () => void }) {
  const addStopItem = useRouteStore((s) => s.addStopItem);
  const setItemResolution = useRouteStore((s) => s.setItemResolution);
  const [name, setName] = useState("");
  const [qty, setQty] = useState("1");

  const handleAdd = () => {
    const n = parseInt(qty, 10);
    if (!name.trim() || isNaN(n) || n <= 0) return;
    const id = `added-${Date.now()}`;
    addStopItem(stopId, "", name.trim(), n);
    // Auto-mark as delivered
    setItemResolution(stopId, id, { status: "DELIVERED" });
    setName("");
    setQty("1");
    onDone();
    Keyboard.dismiss();
  };

  return (
    <View style={addStyles.container}>
      <Text style={addStyles.title}>Add Item</Text>
      <TextInput
        style={addStyles.nameInput}
        placeholder="Item name"
        placeholderTextColor="#94a3b8"
        value={name}
        onChangeText={setName}
        autoFocus
        returnKeyType="next"
      />
      <View style={addStyles.row}>
        <TextInput
          style={addStyles.qtyInput}
          placeholder="Qty"
          placeholderTextColor="#94a3b8"
          value={qty}
          onChangeText={setQty}
          keyboardType="number-pad"
          returnKeyType="done"
        />
        <Pressable style={addStyles.addBtn} onPress={handleAdd}>
          <Text style={addStyles.addBtnText}>Add</Text>
        </Pressable>
        <Pressable style={addStyles.cancelBtn} onPress={onDone}>
          <Text style={addStyles.cancelBtnText}>Cancel</Text>
        </Pressable>
      </View>
    </View>
  );
}

const addStyles = StyleSheet.create({
  container: {
    backgroundColor: colors.brand[50],
    borderRadius: borderRadius.lg,
    padding: 16,
    gap: 10,
    borderWidth: 1,
    borderColor: colors.brand[100],
  },
  title: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: colors.navy.DEFAULT,
  },
  nameInput: {
    height: 48,
    borderWidth: 1,
    borderColor: colors.surface.border,
    borderRadius: borderRadius.DEFAULT,
    paddingHorizontal: 12,
    fontSize: 16,
    fontFamily: "Inter_400Regular",
    color: colors.navy.DEFAULT,
    backgroundColor: "#fff",
  },
  row: { flexDirection: "row", gap: 8 },
  qtyInput: {
    width: 72,
    height: 48,
    borderWidth: 1,
    borderColor: colors.surface.border,
    borderRadius: borderRadius.DEFAULT,
    textAlign: "center",
    fontSize: 17,
    fontFamily: "Inter_600SemiBold",
    color: colors.navy.DEFAULT,
    backgroundColor: "#fff",
  },
  addBtn: {
    flex: 1,
    height: 48,
    backgroundColor: colors.brand[500],
    borderRadius: borderRadius.DEFAULT,
    alignItems: "center",
    justifyContent: "center",
  },
  addBtnText: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    color: "#fff",
  },
  cancelBtn: {
    flex: 1,
    height: 48,
    backgroundColor: "#fff",
    borderRadius: borderRadius.DEFAULT,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.surface.border,
  },
  cancelBtnText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: "#64748b",
  },
});

// ─── Main Screen ──────────────────────────────────────────────────────────────

export default function StopDetailScreen() {
  const { stopId, runId } = useLocalSearchParams<{ stopId: string; runId: string }>();

  const { data: run, isLoading, isError, refetch } = useRouteRun(runId ?? "");
  const { mutate: updateStopStatus } = useUpdateStopStatus();

  const stopNoteFromStore = useRouteStore((s) => s.stopNotes[stopId]) ?? "";
  const setStopNote = useRouteStore((s) => s.setStopNote);
  const addedItems = useRouteStore((s) => s.addedItems[stopId]) ?? [];

  const [showAddForm, setShowAddForm] = useState(false);
  const [showScanner, setShowScanner] = useState(false);
  const [pendingBarcode, setPendingBarcode] = useState<string | null>(null);
  const [highlightedItemId, setHighlightedItemId] = useState<string | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { data: barcodeProduct, isError: barcodeError } = useProductByBarcode(pendingBarcode);

  const stop = run?.stops?.find((s) => s.id === stopId) ?? null;

  // Collect all order item IDs for resolution check
  const orderItemIds = (stop?.orders ?? []).flatMap((o) =>
    (o.lineItems ?? []).map((i) => i.id),
  );
  const allResolved = useRouteStore((s) =>
    selectAllItemsResolved(s, stopId, orderItemIds),
  );

  // When barcode product is found, highlight matching item
  useEffect(() => {
    if (!barcodeProduct || !stop) return;
    setPendingBarcode(null);
    const allItems = (stop.orders ?? []).flatMap((o) => o.lineItems ?? []);
    const matched = allItems.find(
      (item) =>
        item.product?.name?.toLowerCase() === barcodeProduct.name?.toLowerCase(),
    );
    if (matched) {
      setHighlightedItemId(matched.id);
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = setTimeout(() => setHighlightedItemId(null), 4000);
    } else {
      const msg = `"${barcodeProduct.name}" is not in this stop's order.`;
      if (Platform.OS === "android") {
        ToastAndroid.show(msg, ToastAndroid.SHORT);
      } else {
        Alert.alert("Not in Order", msg);
      }
    }
  }, [barcodeProduct]);

  useEffect(() => {
    if (barcodeError && pendingBarcode) {
      setPendingBarcode(null);
      const msg = "No product found for this barcode.";
      if (Platform.OS === "android") {
        ToastAndroid.show(msg, ToastAndroid.SHORT);
      } else {
        Alert.alert("Not Found", msg);
      }
    }
  }, [barcodeError, pendingBarcode]);

  if (isLoading) {
    return (
      <>
        <Stack.Screen options={{ title: "Stop" }} />
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator size="large" color={colors.brand[500]} />
        </View>
      </>
    );
  }

  if (isError) {
    return (
      <>
        <Stack.Screen options={{ title: "Stop" }} />
        <NetworkError onRetry={() => refetch()} />
      </>
    );
  }

  if (!stop) {
    return (
      <View style={styles.notFound}>
        <Text style={styles.notFoundText}>Stop not found.</Text>
      </View>
    );
  }

  const totalStops = run?.stops?.length ?? 0;
  const address = stop.customerAddress
    ? `${stop.customerAddress.line1}, ${stop.customerAddress.city}, ${stop.customerAddress.state} ${stop.customerAddress.zip}`
    : null;
  const mapsQuery = address ?? stop.customer?.businessName ?? "";

  // Flatten all items across orders at this stop
  const allOrderItems = (stop.orders ?? []).flatMap((o) => o.lineItems ?? []);

  const handleMarkArrived = () => {
    if (stop.status === "PENDING" && runId) {
      updateStopStatus({ runId, stopId, status: "IN_PROGRESS" });
    }
  };

  const handleSkip = () => {
    Alert.alert("Skip Stop", "Are you sure you want to skip this stop?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Skip",
        style: "destructive",
        onPress: () => {
          if (runId) {
            updateStopStatus({ runId, stopId, status: "SKIPPED" });
            router.back();
          }
        },
      },
    ]);
  };

  return (
    <>
      <Stack.Screen
        options={{
          title: `Stop ${stop.stopNumber} of ${totalStops}`,
          headerBackTitle: "Route",
          headerRight: () => (
            <Pressable
              onPress={handleSkip}
              style={{ paddingRight: 4 }}
              accessibilityLabel="Skip stop"
            >
              <Text style={{ color: colors.danger.DEFAULT, fontFamily: "Inter_600SemiBold", fontSize: 15 }}>
                Skip
              </Text>
            </Pressable>
          ),
        }}
      />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={88}
      >
        <View style={styles.container}>
          <ScrollView
            contentContainerStyle={styles.scroll}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            {/* Business name + stop count */}
            <View style={styles.stopHeader}>
              <View style={styles.stopHeaderTop}>
                <View style={styles.stopHeaderLeft}>
                  <Text style={styles.businessName}>{stop.customer?.businessName ?? "Customer"}</Text>
                  <Text style={styles.stopMeta}>
                    Stop {stop.stopNumber} of {totalStops}
                    {" · "}
                    {allOrderItems.length + addedItems.length} item
                    {allOrderItems.length + addedItems.length !== 1 ? "s" : ""}
                  </Text>
                </View>
                {stop.customer?.phone ? (
                  <Pressable
                    style={styles.callBtn}
                    onPress={() => callPhone(stop.customer!.phone!)}
                    accessibilityRole="button"
                    accessibilityLabel={`Call ${stop.customer?.businessName}`}
                  >
                    <Ionicons name="call" size={20} color="#fff" />
                  </Pressable>
                ) : null}
              </View>
              {stop.customer?.deliveryWindowStart && (
                <Text style={styles.windowText}>
                  Delivery window: {stop.customer.deliveryWindowStart}
                  {stop.customer.deliveryWindowEnd ? ` – ${stop.customer.deliveryWindowEnd}` : ""}
                </Text>
              )}
              {stop.notes && (
                <View style={styles.notesChip}>
                  <Ionicons name="information-circle-outline" size={14} color={colors.brand[500]} />
                  <Text style={styles.notesChipText}>{stop.notes}</Text>
                </View>
              )}
            </View>

            {/* Address + Navigate */}
            {address ? (
              <View style={styles.addressCard}>
                <View style={styles.addressLeft}>
                  <Ionicons name="location-outline" size={20} color={colors.brand[500]} />
                  <Text style={styles.addressText}>{address}</Text>
                </View>
                <Pressable
                  style={styles.navigateBtn}
                  onPress={() => openMaps(mapsQuery)}
                  accessibilityRole="button"
                  accessibilityLabel="Open in Maps"
                >
                  <Ionicons name="navigate" size={18} color="#fff" />
                  <Text style={styles.navigateBtnText}>Navigate</Text>
                </Pressable>
              </View>
            ) : null}

            {/* Mark arrived button (only if PENDING) */}
            {stop.status === "PENDING" && (
              <Pressable style={styles.arrivedBtn} onPress={handleMarkArrived}>
                <Ionicons name="checkmark-circle-outline" size={20} color={colors.brand[500]} />
                <Text style={styles.arrivedBtnText}>Mark as Arrived</Text>
              </Pressable>
            )}

            {/* Items section */}
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Order Items</Text>
              <Pressable
                onPress={() => setShowScanner(true)}
                style={styles.scanBtn}
                accessibilityLabel="Scan barcode to find item"
              >
                <Ionicons name="barcode-outline" size={18} color={colors.brand[500]} />
                <Text style={styles.scanBtnText}>Scan</Text>
              </Pressable>
            </View>

            {allOrderItems.length === 0 && addedItems.length === 0 ? (
              <View style={styles.noItemsBox}>
                <Text style={styles.noItemsText}>No items in this order.</Text>
              </View>
            ) : (
              <View style={styles.itemsList}>
                {allOrderItems.map((item) => (
                  <ItemRow
                    key={item.id}
                    item={item}
                    stopId={stopId}
                    highlighted={highlightedItemId === item.id}
                  />
                ))}

                {/* Added items */}
                {addedItems.map((item) => (
                  <ItemRow
                    key={item.id}
                    item={{
                      id: item.id,
                      productId: item.productId,
                      product: { id: item.productId, name: item.name, unit: "" },
                      qty: item.qty,
                      unitPrice: 0,
                      status: "PENDING",
                      isAdded: true,
                    }}
                    stopId={stopId}
                  />
                ))}

                {/* Add item button or form */}
                {showAddForm ? (
                  <AddItemForm stopId={stopId} onDone={() => setShowAddForm(false)} />
                ) : (
                  <Pressable
                    style={styles.addItemBtn}
                    onPress={() => setShowAddForm(true)}
                    accessibilityRole="button"
                  >
                    <Ionicons name="add-circle-outline" size={22} color={colors.brand[500]} />
                    <Text style={styles.addItemText}>Add item not on order</Text>
                  </Pressable>
                )}
              </View>
            )}

            {/* Driver notes */}
            <Text style={styles.sectionTitle}>Driver Notes</Text>
            <TextInput
              style={styles.notesInput}
              placeholder="Add a note about this stop…"
              placeholderTextColor="#94a3b8"
              value={stopNoteFromStore}
              onChangeText={(v) => setStopNote(stopId, v)}
              multiline
              numberOfLines={3}
              textAlignVertical="top"
            />
          </ScrollView>

          {/* Complete Stop — primary action */}
          <View style={styles.footer}>
            <Pressable
              style={styles.returnBtn}
              onPress={() =>
                router.push(`/(driver)/route/stop/${stopId}/return?runId=${runId}` as any)
              }
              accessibilityRole="button"
              accessibilityLabel="Log Return"
            >
              <Ionicons name="return-down-back-outline" size={18} color={colors.danger.DEFAULT} />
              <Text style={styles.returnBtnText}>Log Return</Text>
            </Pressable>

            {!allResolved && allOrderItems.length > 0 && (
              <Text style={styles.resolveHint}>
                Resolve all items above to continue
              </Text>
            )}
            <Pressable
              style={[
                styles.completeBtn,
                (allResolved || allOrderItems.length === 0) && styles.completeBtnReady,
              ]}
              onPress={() =>
                (allResolved || allOrderItems.length === 0)
                  ? router.push(`/(driver)/route/stop/${stopId}/complete?runId=${runId}`)
                  : null
              }
              accessibilityRole="button"
              accessibilityLabel="Complete Stop"
            >
              <Ionicons
                name={
                  allResolved || allOrderItems.length === 0
                    ? "checkmark-circle"
                    : "ellipse-outline"
                }
                size={22}
                color={allResolved || allOrderItems.length === 0 ? "#fff" : "#94a3b8"}
                style={{ marginRight: 10 }}
              />
              <Text
                style={[
                  styles.completeBtnText,
                  (allResolved || allOrderItems.length === 0) &&
                    styles.completeBtnTextReady,
                ]}
              >
                Complete Stop
              </Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>

      {showScanner && (
        <BarcodeScanner
          onScanned={(code) => {
            setShowScanner(false);
            setPendingBarcode(code);
          }}
          onClose={() => setShowScanner(false)}
        />
      )}
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surface.raised },
  scroll: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 24,
    gap: 12,
  },
  stopHeader: { gap: 6 },
  stopHeaderTop: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },
  stopHeaderLeft: { flex: 1, gap: 2 },
  callBtn: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.success.DEFAULT,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  businessName: {
    fontSize: 24,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  stopMeta: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },
  windowText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: colors.brand[500],
    marginTop: 2,
  },
  notesChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: colors.brand[50],
    borderRadius: borderRadius.full,
    paddingHorizontal: 10,
    paddingVertical: 4,
    alignSelf: "flex-start",
    marginTop: 4,
  },
  notesChipText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: colors.navy.DEFAULT,
  },
  addressCard: {
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    padding: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    ...shadows.card,
  },
  addressLeft: {
    flex: 1,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
  },
  addressText: {
    flex: 1,
    fontSize: 16,
    fontFamily: "Inter_500Medium",
    color: colors.navy.DEFAULT,
    lineHeight: 22,
  },
  navigateBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: colors.brand[500],
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: borderRadius.DEFAULT,
    minHeight: 56,
  },
  navigateBtnText: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    color: "#fff",
  },
  arrivedBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: borderRadius.lg,
    borderWidth: 1.5,
    borderColor: colors.brand[500],
    backgroundColor: colors.brand[50],
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  arrivedBtnText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: colors.brand[500],
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 4,
  },
  sectionTitle: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: "#94a3b8",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  scanBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: borderRadius.DEFAULT,
    backgroundColor: colors.brand[50],
    borderWidth: 1,
    borderColor: colors.brand[100],
  },
  scanBtnText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: colors.brand[500],
  },
  noItemsBox: {
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    padding: 24,
    alignItems: "center",
    ...shadows.card,
  },
  noItemsText: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
  },
  itemsList: { gap: 10 },
  addItemBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 16,
    paddingHorizontal: 16,
    borderRadius: borderRadius.lg,
    borderWidth: 1.5,
    borderStyle: "dashed",
    borderColor: colors.brand[500],
    backgroundColor: colors.brand[50],
    minHeight: 56,
    justifyContent: "center",
  },
  addItemText: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    color: colors.brand[500],
  },
  notesInput: {
    borderWidth: 1,
    borderColor: colors.surface.border,
    borderRadius: borderRadius.lg,
    padding: 14,
    fontSize: 16,
    fontFamily: "Inter_400Regular",
    color: colors.navy.DEFAULT,
    minHeight: 96,
    backgroundColor: "#fff",
    textAlignVertical: "top",
  },
  footer: {
    paddingHorizontal: 16,
    paddingBottom: 28,
    paddingTop: 10,
    backgroundColor: "#fff",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.surface.border,
    gap: 8,
  },
  returnBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    height: 44,
    borderRadius: borderRadius.DEFAULT,
    borderWidth: 1.5,
    borderColor: colors.danger.DEFAULT,
    backgroundColor: colors.danger.bg,
  },
  returnBtnText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: colors.danger.DEFAULT,
  },
  resolveHint: {
    textAlign: "center",
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
  },
  completeBtn: {
    height: 56,
    borderRadius: borderRadius.DEFAULT,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface.border,
  },
  completeBtnReady: { backgroundColor: colors.success.DEFAULT },
  completeBtnText: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: "#94a3b8",
  },
  completeBtnTextReady: { color: "#fff" },
  notFound: { flex: 1, alignItems: "center", justifyContent: "center" },
  notFoundText: {
    fontSize: 16,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
  },
});
