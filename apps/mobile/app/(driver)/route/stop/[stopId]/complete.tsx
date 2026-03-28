import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  Alert,
} from "react-native";
import { useState } from "react";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors, borderRadius, shadows } from "@routeflow/ui/tokens";
import { useRouteRun, useCompleteStop, useUpdateRunStatus, type CompleteStopItemDto } from "../../../../../lib/api/routes";
import { useRouteStore, selectStopResolutions } from "../../../../../store/routeStore";
import { useRecordInvoicePayment } from "../../../../../lib/api/invoices";
import { apiClient } from "../../../../../lib/api-client";
import { PhotoCapture } from "../../../../../components/PhotoCapture";

type PaymentMethod = "CASH" | "CHECK" | "ACH" | "OTHER";
const PAYMENT_METHODS: { key: PaymentMethod; label: string; icon: string }[] = [
  { key: "CASH", label: "Cash", icon: "cash-outline" },
  { key: "CHECK", label: "Check", icon: "document-text-outline" },
  { key: "ACH", label: "Bank Transfer", icon: "swap-horizontal-outline" },
  { key: "OTHER", label: "Other", icon: "ellipsis-horizontal-outline" },
];

const STATUS_CONFIG = {
  DELIVERED: { label: "Delivered", icon: "checkmark-circle", color: colors.success.DEFAULT, bg: colors.success.bg },
  PARTIAL: { label: "Partial", icon: "alert-circle", color: colors.warning.DEFAULT, bg: colors.warning.bg },
  REFUSED: { label: "Refused", icon: "close-circle", color: colors.danger.DEFAULT, bg: colors.danger.bg },
  UNRESOLVED: { label: "Unresolved", icon: "help-circle", color: "#94a3b8", bg: colors.surface.raised },
} as const;

export default function StopCompleteScreen() {
  const { stopId, runId } = useLocalSearchParams<{ stopId: string; runId: string }>();

  const { data: run } = useRouteRun(runId ?? "");
  const { mutate: completeStop, isPending } = useCompleteStop();
  const { mutate: recordPayment } = useRecordInvoicePayment();
  const { mutate: updateRunStatus } = useUpdateRunStatus();

  const resolutions = useRouteStore((s) => s.itemResolutions[stopId]) ?? {};
  const stopNote = useRouteStore((s) => s.stopNotes[stopId]) ?? "";
  const setStopNote = useRouteStore((s) => s.setStopNote);
  const addedItems = useRouteStore((s) => s.addedItems[stopId]) ?? [];
  const clearStop = useRouteStore((s) => s.clearStop);

  const [cashAmount, setCashAmount] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("CASH");
  const [cashReference, setCashReference] = useState("");
  const [podPhotos, setPodPhotos] = useState<string[]>([]);
  const [safeDropEnabled, setSafeDropEnabled] = useState(false);

  const stop = run?.stops?.find((s) => s.id === stopId) ?? null;

  if (!stop) {
    return (
      <View style={styles.notFound}>
        <Text style={styles.notFoundText}>Stop not found.</Text>
      </View>
    );
  }

  // Flatten all items across orders
  const allOrderItems = (stop.orders ?? []).flatMap((o) => o.lineItems ?? []);

  // Build item summary list
  type SummaryItem = {
    id: string;
    name: string;
    orderedQty: number;
    orderItemId?: string;
    productId: string;
    resolution: (typeof resolutions)[string] | undefined;
  };

  const allItems: SummaryItem[] = [
    ...allOrderItems.map((i) => ({
      id: i.id,
      name: i.product?.name ?? i.productId,
      orderedQty: i.qty,
      orderItemId: i.id,
      productId: i.productId,
      resolution: resolutions[i.id],
    })),
    ...addedItems.map((i) => ({
      id: i.id,
      name: i.name,
      orderedQty: i.qty,
      orderItemId: undefined,
      productId: i.productId,
      resolution: resolutions[i.id],
    })),
  ];

  const delivered = allItems.filter((i) => i.resolution?.status === "DELIVERED");
  const partial = allItems.filter((i) => i.resolution?.status === "PARTIAL");
  const refused = allItems.filter((i) => i.resolution?.status === "REFUSED");

  // Find the next pending stop for navigation
  const stops = run?.stops ?? [];
  const nextStop = stops.find(
    (s) => s.stopNumber > stop.stopNumber && (s.status === "PENDING" || s.status === "IN_PROGRESS"),
  );

  const handleConfirm = () => {
    if (!runId) return;

    // Safe drop requires at least one POD photo
    if (safeDropEnabled && podPhotos.length === 0) {
      Alert.alert("Photo Required", "Please capture at least one proof of delivery photo when safe drop is enabled.");
      return;
    }

    // Build DTO items
    const items: CompleteStopItemDto[] = allItems
      .filter((i) => i.resolution && i.resolution.status !== "UNRESOLVED")
      .map((i) => ({
        orderItemId: i.orderItemId,
        productId: i.productId,
        type: i.resolution!.status as "DELIVERED" | "PARTIAL" | "REFUSED",
        qty:
          i.resolution!.status === "PARTIAL"
            ? (i.resolution!.partialQty ?? 0)
            : i.orderedQty,
        driverNote: stopNote || undefined,
      }));

    // Add ADD_ON items from addedItems that weren't in original orders
    addedItems.forEach((added) => {
      if (!allOrderItems.find((oi) => oi.id === added.id)) {
        items.push({
          orderItemId: undefined,
          productId: added.productId || "",
          type: "ADD_ON",
          qty: added.qty,
        });
      }
    });

    const navigateAfterComplete = () => {
      clearStop(stopId);
      if (nextStop) {
        router.replace(`/(driver)/route/stop/${nextStop.id}?runId=${runId}` as any);
      } else {
        updateRunStatus(
          { id: runId, status: "COMPLETED" },
          { onSettled: () => router.replace("/(driver)/route") },
        );
      }
    };

    completeStop(
      { runId, stopId, driverNote: stopNote || undefined, items, podPhotoUrls: podPhotos, safeDropEnabled },
      {
        onSuccess: async () => {
          // If cash was collected, look up the customer's unpaid invoice and record payment
          const amount = parseFloat(cashAmount);
          const customerId = stop.customer?.id;
          if (!isNaN(amount) && amount > 0 && customerId) {
            try {
              const resp = await apiClient.get("/invoices", {
                params: { customerId, limit: 1 },
              });
              const invoiceId: string | undefined = resp.data?.data?.[0]?.id;
              if (invoiceId) {
                recordPayment(
                  {
                    invoiceId,
                    amount,
                    method: paymentMethod,
                    reference: cashReference || undefined,
                  },
                  { onSettled: navigateAfterComplete },
                );
                return;
              }
            } catch (_) {
              // Invoice lookup failed — proceed without recording payment
            }
          }
          navigateAfterComplete();
        },
        onError: (err) => {
          Alert.alert(
            "Error",
            "Failed to complete stop. Please try again.\n" + (err.message || ""),
          );
        },
      },
    );
  };

  return (
    <>
      <Stack.Screen
        options={{ title: "Confirm Stop", headerBackTitle: "Back" }}
      />
      <View style={styles.container}>
        <ScrollView
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}
        >
          {/* Stop identity */}
          <View style={styles.identityCard}>
            <Text style={styles.stopLabel}>
              Stop {stop.stopNumber} of {stops.length}
            </Text>
            <Text style={styles.businessName}>
              {stop.customer?.businessName ?? "Customer"}
            </Text>
            {stop.customerAddress && (
              <Text style={styles.address}>
                {stop.customerAddress.line1}, {stop.customerAddress.city},{" "}
                {stop.customerAddress.state}
              </Text>
            )}
          </View>

          {/* Delivery summary */}
          <Text style={styles.sectionTitle}>Delivery Summary</Text>
          <View style={styles.summaryRow}>
            {(
              [
                { key: "delivered", items: delivered, cfg: STATUS_CONFIG.DELIVERED },
                { key: "partial", items: partial, cfg: STATUS_CONFIG.PARTIAL },
                { key: "refused", items: refused, cfg: STATUS_CONFIG.REFUSED },
              ] as const
            ).map(({ key, items: list, cfg }) => (
              <View key={key} style={[styles.summaryChip, { backgroundColor: cfg.bg }]}>
                <Ionicons name={cfg.icon as any} size={22} color={cfg.color} />
                <Text style={[styles.summaryCount, { color: cfg.color }]}>
                  {list.length}
                </Text>
                <Text style={[styles.summaryLabel, { color: cfg.color }]}>
                  {cfg.label}
                </Text>
              </View>
            ))}
          </View>

          {/* Per-item breakdown */}
          {allItems.length > 0 && (
            <View style={styles.itemsCard}>
              {allItems.map((item, idx) => {
                const res = item.resolution;
                const cfg = res?.status ? STATUS_CONFIG[res.status] : STATUS_CONFIG.UNRESOLVED;
                const isLast = idx === allItems.length - 1;
                return (
                  <View key={item.id} style={[styles.itemRow, isLast && styles.itemRowLast]}>
                    <View style={styles.itemLeft}>
                      <Text style={styles.itemName}>{item.name}</Text>
                      <Text style={styles.itemQty}>
                        {res?.status === "PARTIAL"
                          ? `${res.partialQty ?? 0} of ${item.orderedQty} delivered`
                          : `${item.orderedQty} ordered`}
                      </Text>
                    </View>
                    <View style={[styles.itemStatus, { backgroundColor: cfg.bg }]}>
                      <Ionicons name={cfg.icon as any} size={16} color={cfg.color} />
                      <Text style={[styles.itemStatusText, { color: cfg.color }]}>
                        {cfg.label}
                      </Text>
                    </View>
                  </View>
                );
              })}
            </View>
          )}

          {/* Proof of Delivery */}
          <Text style={styles.sectionTitle}>Proof of Delivery</Text>
          <View style={styles.podCard}>
            <PhotoCapture
              photos={podPhotos}
              onAdd={(uri) => setPodPhotos((prev) => [...prev, uri])}
              onRemove={(uri) => setPodPhotos((prev) => prev.filter((p) => p !== uri))}
              maxPhotos={3}
              label="Add Photo"
            />
            <View style={styles.safeDropRow}>
              <View style={styles.safeDropLeft}>
                <Ionicons name="home-outline" size={18} color="#64748b" />
                <View>
                  <Text style={styles.safeDropTitle}>Safe Drop</Text>
                  <Text style={styles.safeDropSub}>Left at door — unattended delivery</Text>
                </View>
              </View>
              <Switch
                value={safeDropEnabled}
                onValueChange={setSafeDropEnabled}
                trackColor={{ false: colors.surface.border, true: colors.brand[500] }}
              />
            </View>
          </View>

          {/* Cash collection */}
          <Text style={styles.sectionTitle}>Payment Collected</Text>
          <View style={styles.cashCard}>
            <View style={styles.cashAmountRow}>
              <Text style={styles.cashDollar}>$</Text>
              <TextInput
                style={styles.cashInput}
                placeholder="0.00"
                placeholderTextColor="#94a3b8"
                value={cashAmount}
                onChangeText={setCashAmount}
                keyboardType="decimal-pad"
                returnKeyType="done"
              />
              <Text style={styles.cashOptional}>optional</Text>
            </View>
            <View style={styles.paymentMethodRow}>
              {PAYMENT_METHODS.map(({ key, label, icon }) => (
                <Pressable
                  key={key}
                  style={[
                    styles.methodBtn,
                    paymentMethod === key && styles.methodBtnActive,
                  ]}
                  onPress={() => setPaymentMethod(key)}
                >
                  <Ionicons
                    name={icon as any}
                    size={16}
                    color={paymentMethod === key ? colors.brand[500] : "#94a3b8"}
                  />
                  <Text
                    style={[
                      styles.methodBtnText,
                      paymentMethod === key && styles.methodBtnTextActive,
                    ]}
                  >
                    {label}
                  </Text>
                </Pressable>
              ))}
            </View>
            {(paymentMethod === "CHECK" || paymentMethod === "OTHER") && (
              <TextInput
                style={styles.referenceInput}
                placeholder="Reference / cheque number…"
                placeholderTextColor="#94a3b8"
                value={cashReference}
                onChangeText={setCashReference}
                returnKeyType="done"
              />
            )}
          </View>

          {/* Notes */}
          <Text style={styles.sectionTitle}>Driver Notes</Text>
          <TextInput
            style={styles.notesInput}
            placeholder="Add or edit your note for this stop…"
            placeholderTextColor="#94a3b8"
            value={stopNote}
            onChangeText={(v) => setStopNote(stopId, v)}
            multiline
            numberOfLines={3}
            textAlignVertical="top"
          />
        </ScrollView>

        {/* Footer: Back + Confirm */}
        <View style={styles.footer}>
          <Pressable
            style={styles.backBtn}
            onPress={() => router.back()}
            accessibilityRole="button"
          >
            <Text style={styles.backBtnText}>Back</Text>
          </Pressable>
          <Pressable
            style={[styles.confirmBtn, isPending && { opacity: 0.7 }]}
            onPress={handleConfirm}
            disabled={isPending}
            accessibilityRole="button"
          >
            {isPending ? (
              <ActivityIndicator size="small" color="#fff" style={{ marginRight: 8 }} />
            ) : (
              <Ionicons
                name={nextStop ? "arrow-forward-circle" : "checkmark-done-circle"}
                size={22}
                color="#fff"
                style={{ marginRight: 8 }}
              />
            )}
            <Text style={styles.confirmBtnText}>
              {nextStop ? "Confirm & Next Stop" : "Confirm & Finish Route"}
            </Text>
          </Pressable>
        </View>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surface.raised },
  scroll: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 24,
    gap: 14,
  },
  identityCard: {
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    padding: 16,
    gap: 4,
    ...shadows.card,
  },
  stopLabel: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: "#94a3b8",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  businessName: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  address: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },
  sectionTitle: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: "#94a3b8",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  summaryRow: { flexDirection: "row", gap: 10 },
  summaryChip: {
    flex: 1,
    borderRadius: borderRadius.lg,
    paddingVertical: 14,
    alignItems: "center",
    gap: 4,
  },
  summaryCount: { fontSize: 24, fontFamily: "Inter_700Bold" },
  summaryLabel: { fontSize: 12, fontFamily: "Inter_600SemiBold" },
  itemsCard: {
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    paddingHorizontal: 16,
    paddingVertical: 4,
    ...shadows.card,
  },
  itemRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.surface.border,
  },
  itemRowLast: { borderBottomWidth: 0 },
  itemLeft: { flex: 1, gap: 2, paddingRight: 10 },
  itemName: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    color: colors.navy.DEFAULT,
  },
  itemQty: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },
  itemStatus: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: borderRadius.full,
  },
  itemStatusText: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  cashCard: {
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    padding: 16,
    gap: 12,
    ...shadows.card,
  },
  cashAmountRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  cashDollar: {
    fontSize: 28,
    fontFamily: "Inter_700Bold",
    color: "#64748b",
  },
  cashInput: {
    flex: 1,
    fontSize: 32,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
    paddingVertical: 4,
  },
  cashOptional: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
    alignSelf: "flex-end",
    paddingBottom: 6,
  },
  paymentMethodRow: {
    flexDirection: "row",
    gap: 8,
    flexWrap: "wrap",
  },
  methodBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: borderRadius.full,
    borderWidth: 1.5,
    borderColor: colors.surface.border,
    backgroundColor: colors.surface.raised,
  },
  methodBtnActive: {
    borderColor: colors.brand[500],
    backgroundColor: colors.brand[50],
  },
  methodBtnText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: "#94a3b8",
  },
  methodBtnTextActive: {
    color: colors.brand[500],
  },
  podCard: {
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    padding: 16,
    gap: 14,
    ...shadows.card,
  },
  safeDropRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: colors.surface.border,
  },
  safeDropLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    flex: 1,
  },
  safeDropTitle: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: colors.navy.DEFAULT,
  },
  safeDropSub: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
  },
  referenceInput: {
    height: 44,
    borderWidth: 1,
    borderColor: colors.surface.border,
    borderRadius: borderRadius.DEFAULT,
    paddingHorizontal: 12,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: colors.navy.DEFAULT,
    backgroundColor: colors.surface.raised,
  },
  notesInput: {
    borderWidth: 1,
    borderColor: colors.surface.border,
    borderRadius: borderRadius.lg,
    padding: 14,
    fontSize: 16,
    fontFamily: "Inter_400Regular",
    color: colors.navy.DEFAULT,
    minHeight: 90,
    backgroundColor: "#fff",
    textAlignVertical: "top",
  },
  footer: {
    paddingHorizontal: 16,
    paddingBottom: 28,
    paddingTop: 12,
    backgroundColor: "#fff",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.surface.border,
    gap: 10,
  },
  backBtn: {
    height: 56,
    borderRadius: borderRadius.DEFAULT,
    borderWidth: 1.5,
    borderColor: colors.surface.border,
    alignItems: "center",
    justifyContent: "center",
  },
  backBtnText: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    color: colors.navy.DEFAULT,
  },
  confirmBtn: {
    height: 56,
    backgroundColor: colors.brand[500],
    borderRadius: borderRadius.DEFAULT,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },
  confirmBtnText: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: "#fff",
  },
  notFound: { flex: 1, alignItems: "center", justifyContent: "center" },
  notFoundText: {
    fontSize: 16,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
  },
});
