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

// ─── expo-av optional import ─────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ExpoAV: any = null;
try {
  ExpoAV = require("expo-av");
} catch {
  // expo-av not installed — voice notes gracefully disabled
}
import * as Linking from "expo-linking";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors, borderRadius, shadows } from "@routeflow/ui/tokens";
import {
  useRouteRun,
  useUpdateStopStatus,
  useReopenStop,
  type RouteRunOrderItem,
} from "../../../../../lib/api/routes";
import { useConfirmOrder } from "../../../../../lib/api/orders";
import {
  useRouteStore,
  selectAllItemsResolved,
  selectStopResolutions,
  type ItemDeliveryStatus,
} from "../../../../../store/routeStore";
import { useProductByBarcode } from "../../../../../lib/api/products";
import { BarcodeScanner } from "../../../../../components/BarcodeScanner";
import { ProductPickerModal, type PickedProduct } from "../../../../../components/ProductPickerModal";
import { NetworkError } from "../../../../../components/NetworkError";
import { apiClient } from "../../../../../lib/api-client";

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
                const capped = Math.min(n, item.qty);
                setItemResolution(stopId, item.id, { status: "PARTIAL", partialQty: capped });
                if (n > item.qty) setPartialInput(String(item.qty));
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


// ─── Main Screen ──────────────────────────────────────────────────────────────

export default function StopDetailScreen() {
  const { stopId, runId } = useLocalSearchParams<{ stopId: string; runId: string }>();

  const { data: run, isLoading, isError, refetch } = useRouteRun(runId ?? "");
  const { mutate: updateStopStatus } = useUpdateStopStatus();
  const { mutate: reopenStop, isPending: isReopening } = useReopenStop();
  const { mutate: confirmOrder, isPending: isConfirming } = useConfirmOrder();

  const stopNoteFromStore = useRouteStore((s) => s.stopNotes[stopId]) ?? "";
  const setStopNote = useRouteStore((s) => s.setStopNote);
  const addedItems = useRouteStore((s) => s.addedItems[stopId]) ?? [];
  const addStopItemStore = useRouteStore((s) => s.addStopItem);

  const [showProductPicker, setShowProductPicker] = useState(false);
  const [showScanner, setShowScanner] = useState(false);
  const [pendingBarcode, setPendingBarcode] = useState<string | null>(null);
  const [highlightedItemId, setHighlightedItemId] = useState<string | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noteDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ─── Delivery window alert state ──────────────────────────────────────────
  const [windowStatus, setWindowStatus] = useState<"ok" | "soon" | "late">("ok");

  // ─── Voice recording state ────────────────────────────────────────────────
  const [isRecording, setIsRecording] = useState(false);
  const recordingRef = useRef<any>(null);

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

  // ─── Delivery window status — re-evaluated every 30 s ───────────────────
  useEffect(() => {
    function checkWindow() {
      const windowEnd = stop?.customer?.deliveryWindowEnd;
      if (!windowEnd || stop?.status === "COMPLETED" || stop?.status === "SKIPPED") {
        setWindowStatus("ok");
        return;
      }
      const [wHour, wMin] = windowEnd.split(":").map(Number);
      const now = new Date();
      const windowEndDate = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
        wHour,
        wMin,
      );
      const diffMs = windowEndDate.getTime() - now.getTime();
      if (diffMs < 0) {
        setWindowStatus("late");
      } else if (diffMs < 30 * 60 * 1000) {
        setWindowStatus("soon");
      } else {
        setWindowStatus("ok");
      }
    }
    checkWindow();
    const interval = setInterval(checkWindow, 30_000);
    return () => clearInterval(interval);
  }, [stop?.customer?.deliveryWindowEnd, stop?.status]);

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

  const handleNoteChange = (text: string) => {
    setStopNote(stopId, text);
    if (noteDebounceRef.current) clearTimeout(noteDebounceRef.current);
    noteDebounceRef.current = setTimeout(() => {
      if (runId) {
        apiClient
          .patch(`/route-runs/${runId}/stops/${stopId}`, { driverNote: text })
          .catch(() => {/* silent — note saved locally */});
      }
    }, 800);
  };

  // ─── Voice note handler ─────────────────────────────────────────────────
  const handleVoiceNote = async () => {
    if (!ExpoAV) {
      Alert.alert(
        "Voice Notes Unavailable",
        "Voice notes are available when expo-av is installed. Run: npx expo install expo-av",
      );
      return;
    }

    try {
      const { Audio } = ExpoAV;
      if (isRecording) {
        // Stop recording
        await recordingRef.current?.stopAndUnloadAsync();
        const uri = recordingRef.current?.getURI?.();
        setIsRecording(false);
        recordingRef.current = null;
        Alert.alert("Voice Note Saved", uri ? "Recording saved." : "Recording stopped.");
      } else {
        // Start recording
        const { status } = await Audio.requestPermissionsAsync();
        if (status !== "granted") {
          Alert.alert("Permission Denied", "Microphone access is required for voice notes.");
          return;
        }
        await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
        const { recording } = await Audio.Recording.createAsync(
          Audio.RecordingOptionsPresets.HIGH_QUALITY,
        );
        recordingRef.current = recording;
        setIsRecording(true);
      }
    } catch (err) {
      Alert.alert("Voice Note Error", "Could not start recording. Please try again.");
      setIsRecording(false);
    }
  };

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
                <View style={styles.headerActions}>
                  {stop.customer?.id ? (
                    <Pressable
                      style={styles.profileBtn}
                      onPress={() =>
                        router.push(
                          `/(driver)/route/customer/${stop.customer!.id}` as any,
                        )
                      }
                      accessibilityRole="button"
                      accessibilityLabel="View customer profile"
                    >
                      <Ionicons name="person-outline" size={18} color={colors.brand[500]} />
                    </Pressable>
                  ) : null}
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

            {/* Delivery window warnings (3-H) */}
            {windowStatus === "late" && (
              <View style={styles.bannerLate}>
                <Ionicons name="warning" size={18} color={colors.danger.DEFAULT} />
                <Text style={styles.bannerLateText}>
                  Running late — delivery window has passed
                </Text>
              </View>
            )}
            {windowStatus === "soon" && (
              <View style={styles.bannerSoon}>
                <Ionicons name="time-outline" size={18} color={colors.warning.DEFAULT} />
                <Text style={styles.bannerSoonText}>Delivery window ends soon</Text>
              </View>
            )}

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

            {/* Items grouped by order */}
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Orders at This Stop</Text>
              <Pressable
                onPress={() => setShowScanner(true)}
                style={styles.scanBtn}
                accessibilityLabel="Scan barcode to find item"
              >
                <Ionicons name="barcode-outline" size={18} color={colors.brand[500]} />
                <Text style={styles.scanBtnText}>Scan</Text>
              </Pressable>
            </View>

            {(stop.orders ?? []).length === 0 && addedItems.length === 0 ? (
              <View style={styles.noItemsBox}>
                <Text style={styles.noItemsText}>No orders at this stop.</Text>
              </View>
            ) : (
              <View style={styles.itemsList}>
                {(stop.orders ?? []).map((order) => (
                  <View key={order.id} style={styles.orderGroup}>
                    {/* Order header */}
                    <View style={styles.orderGroupHeader}>
                      <View style={styles.orderGroupLeft}>
                        <Text style={styles.orderGroupNum}>{order.orderNumber}</Text>
                        <View style={[
                          styles.orderStatusBadge,
                          order.status === "PENDING" && { backgroundColor: "#fef3c7" },
                          order.status === "CONFIRMED" && { backgroundColor: colors.brand[50] },
                          order.status === "OUT_FOR_DELIVERY" && { backgroundColor: colors.brand[50] },
                          order.status === "DELIVERED" && { backgroundColor: colors.success.bg },
                        ]}>
                          <Text style={[
                            styles.orderStatusText,
                            order.status === "PENDING" && { color: colors.warning.DEFAULT },
                            order.status === "CONFIRMED" && { color: colors.brand[500] },
                            order.status === "OUT_FOR_DELIVERY" && { color: colors.brand[500] },
                            order.status === "DELIVERED" && { color: colors.success.DEFAULT },
                          ]}>
                            {order.status.replace(/_/g, " ")}
                          </Text>
                        </View>
                        <Text style={styles.orderItemCount}>
                          {(order.lineItems ?? []).length} item{(order.lineItems ?? []).length !== 1 ? "s" : ""}
                        </Text>
                      </View>
                      {order.status === "PENDING" && (
                        <View style={styles.orderActions}>
                          <Pressable
                            style={styles.editOrderBtn}
                            onPress={() => router.push(`/(driver)/orders/${order.id}` as any)}
                            accessibilityRole="button"
                            accessibilityLabel="Edit order"
                          >
                            <Ionicons name="create-outline" size={16} color={colors.navy.DEFAULT} />
                            <Text style={styles.editOrderBtnText}>Edit</Text>
                          </Pressable>
                          <Pressable
                            style={[styles.confirmOrderBtn, isConfirming && { opacity: 0.6 }]}
                            disabled={isConfirming}
                            onPress={() => confirmOrder(order.id, {
                              onError: (err: any) => Alert.alert("Error", err?.response?.data?.message ?? "Failed to confirm."),
                            })}
                            accessibilityRole="button"
                          >
                            <Ionicons name="checkmark-circle-outline" size={16} color={colors.success.DEFAULT} />
                            <Text style={styles.confirmOrderBtnText}>Confirm</Text>
                          </Pressable>
                        </View>
                      )}
                    </View>
                    {/* Items within this order */}
                    <View style={styles.orderItemsContainer}>
                      {(order.lineItems ?? []).map((item) => (
                        <ItemRow
                          key={item.id}
                          item={item}
                          stopId={stopId}
                          highlighted={highlightedItemId === item.id}
                        />
                      ))}
                    </View>
                  </View>
                ))}

                {/* Added items (not tied to an order) */}
                {addedItems.length > 0 && (
                  <View style={styles.orderGroup}>
                    <View style={styles.orderGroupHeader}>
                      <View style={styles.orderGroupLeft}>
                        <Text style={styles.orderGroupNum}>Added Items</Text>
                        <View style={[styles.orderStatusBadge, { backgroundColor: colors.brand[50] }]}>
                          <Text style={[styles.orderStatusText, { color: colors.brand[500] }]}>ON SPOT</Text>
                        </View>
                      </View>
                    </View>
                    <View style={styles.orderItemsContainer}>
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
                    </View>
                  </View>
                )}

                {/* Add item button or form */}
                <Pressable
                  style={styles.addItemBtn}
                  onPress={() => setShowProductPicker(true)}
                  accessibilityRole="button"
                >
                  <Ionicons name="add-circle-outline" size={22} color={colors.brand[500]} />
                  <Text style={styles.addItemText}>Add item not on order</Text>
                </Pressable>
              </View>
            )}

            {/* Driver notes */}
            <View style={styles.notesSectionHeader}>
              <Text style={styles.sectionTitle}>Driver Notes</Text>
              {/* Voice note button (3-I) */}
              <Pressable
                style={[styles.voiceBtn, isRecording && styles.voiceBtnActive]}
                onPress={handleVoiceNote}
                accessibilityRole="button"
                accessibilityLabel={isRecording ? "Stop voice recording" : "Record voice note"}
              >
                <Ionicons
                  name={isRecording ? "stop-circle-outline" : "mic-outline"}
                  size={22}
                  color={isRecording ? colors.danger.DEFAULT : colors.brand[500]}
                />
              </Pressable>
            </View>
            <TextInput
              style={styles.notesInput}
              placeholder="Add a note about this stop…"
              placeholderTextColor="#94a3b8"
              value={stopNoteFromStore}
              onChangeText={handleNoteChange}
              multiline
              numberOfLines={3}
              textAlignVertical="top"
            />
          </ScrollView>

          {/* Reopen Stop — for completed/skipped stops */}
          {(stop.status === "COMPLETED" || stop.status === "SKIPPED") && runId && (
            <View style={styles.footer}>
              <Pressable
                style={[styles.reopenBtn, isReopening && { opacity: 0.6 }]}
                disabled={isReopening}
                onPress={() =>
                  reopenStop(
                    { runId, stopId },
                    {
                      onSuccess: () => refetch(),
                      onError: (err: any) =>
                        Alert.alert("Error", err?.response?.data?.message ?? "Failed to reopen stop."),
                    },
                  )
                }
                accessibilityRole="button"
                accessibilityLabel="Reopen stop for editing"
              >
                {isReopening
                  ? <ActivityIndicator size="small" color={colors.brand[500]} />
                  : <Ionicons name="refresh-outline" size={20} color={colors.brand[500]} />
                }
                <Text style={styles.reopenBtnText}>{isReopening ? "Reopening…" : "Reopen Stop"}</Text>
              </Pressable>
            </View>
          )}

          {/* Complete Stop — primary action */}
          {stop.status !== "COMPLETED" && stop.status !== "SKIPPED" && (
          <View style={styles.footer}>
            <View style={styles.footerActions}>
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
              <Pressable
                style={styles.addOrderBtn}
                onPress={() =>
                  router.push(
                    `/(driver)/route/stop/${stopId}/new-order?runId=${runId}` as any,
                  )
                }
                accessibilityRole="button"
                accessibilityLabel="Add order for this stop"
              >
                <Ionicons name="add-circle-outline" size={18} color={colors.brand[500]} />
                <Text style={styles.addOrderBtnText}>Add Order</Text>
              </Pressable>
            </View>

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
          )}
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

      <ProductPickerModal
        visible={showProductPicker}
        onClose={() => setShowProductPicker(false)}
        title="Add Item to Stop"
        onSelect={(product: PickedProduct, qty: number) => {
          addStopItemStore(stopId, product.id, product.name, qty);
          setShowProductPicker(false);
        }}
      />
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
  orderGroup: { gap: 8, marginBottom: 4 },
  orderGroupHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 4 },
  orderGroupLeft: { flexDirection: "row", alignItems: "center", gap: 8, flex: 1 },
  orderGroupNum: { fontSize: 14, fontFamily: "Inter_700Bold", color: colors.navy.DEFAULT },
  orderStatusBadge: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  orderStatusText: { fontSize: 11, fontFamily: "Inter_600SemiBold", color: "#64748b", textTransform: "uppercase" },
  orderItemCount: { fontSize: 12, fontFamily: "Inter_400Regular", color: "#94a3b8" },
  orderItemsContainer: { gap: 8 },
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
    flex: 1,
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
  reopenBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    height: 52,
    borderRadius: borderRadius.lg,
    borderWidth: 1.5,
    borderColor: colors.brand[500],
    backgroundColor: colors.brand[50] ?? "#eff6ff",
  },
  reopenBtnText: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    color: colors.brand[500],
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
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  profileBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.brand[50],
    borderWidth: 1,
    borderColor: colors.brand[200] ?? colors.brand[500] + "33",
    alignItems: "center",
    justifyContent: "center",
  },
  footerActions: {
    flexDirection: "row",
    gap: 8,
  },
  addOrderBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    height: 44,
    borderRadius: borderRadius.DEFAULT,
    borderWidth: 1.5,
    borderColor: colors.brand[500],
    backgroundColor: colors.brand[50],
  },
  addOrderBtnText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: colors.brand[500],
  },
  notFound: { flex: 1, alignItems: "center", justifyContent: "center" },
  notFoundText: {
    fontSize: 16,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
  },
  orderActions: { flexDirection: "row", alignItems: "center", gap: 6 },
  editOrderBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    borderWidth: 1,
    borderColor: colors.navy.DEFAULT,
    borderRadius: borderRadius.DEFAULT,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: "#fff",
  },
  editOrderBtnText: {
    fontSize: 13,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  confirmOrderBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: colors.success.DEFAULT,
    borderRadius: borderRadius.DEFAULT,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  confirmOrderBtnText: {
    fontSize: 13,
    fontFamily: "Inter_700Bold",
    color: "#fff",
  },
  // 3-H: running-late banners
  bannerLate: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: colors.danger.bg,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.danger.DEFAULT,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  bannerLateText: {
    flex: 1,
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: colors.danger.DEFAULT,
  },
  bannerSoon: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: colors.warning.bg,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.warning.DEFAULT,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  bannerSoonText: {
    flex: 1,
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: colors.warning.DEFAULT,
  },
  // 3-I: voice notes
  notesSectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 4,
  },
  voiceBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.brand[50],
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.brand[100],
  },
  voiceBtnActive: {
    backgroundColor: colors.danger.bg,
    borderColor: colors.danger.DEFAULT,
  },
});
