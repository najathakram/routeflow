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
import { useQuery } from "@tanstack/react-query";
import { Ionicons } from "@expo/vector-icons";
import { ios, borderRadius, shadows } from "@routeflow/ui/tokens";
import { useRouteRun, useCompleteStop, useUpdateRunStatus, type CompleteStopItemDto } from "../../../../../lib/api/routes";
import { useRouteStore } from "../../../../../store/routeStore";
import { useRecordInvoicePayment } from "../../../../../lib/api/invoices";
import { apiClient } from "../../../../../lib/api-client";
import * as Haptics from "expo-haptics";
import { PhotoCapture } from "../../../../../components/PhotoCapture";
import { SignaturePad } from "../../../../../components/SignaturePad";
import { showToast } from "../../../../../lib/toast";

type PaymentMethod = "CASH" | "CHECK" | "ACH" | "OTHER";
const PAYMENT_METHODS: { key: PaymentMethod; label: string; icon: string }[] = [
  { key: "CASH", label: "Cash", icon: "cash-outline" },
  { key: "CHECK", label: "Check", icon: "document-text-outline" },
  { key: "ACH", label: "Bank Transfer", icon: "swap-horizontal-outline" },
  { key: "OTHER", label: "Other", icon: "ellipsis-horizontal-outline" },
];

const STATUS_CONFIG = {
  DELIVERED: { label: "Delivered", icon: "checkmark-circle", color: ios.system.green, bg: ios.system.greenWash },
  PARTIAL: { label: "Partial", icon: "alert-circle", color: ios.system.orange, bg: ios.system.orangeWash },
  REFUSED: { label: "Refused", icon: "close-circle", color: ios.system.red, bg: ios.system.redWash },
  UNRESOLVED: { label: "Unresolved", icon: "help-circle", color: ios.label2, bg: ios.bg },
} as const;

const fmt = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);

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
  const [signatureCaptured, setSignatureCaptured] = useState(false);

  // Attempted delivery mode (customer not present)
  const [isAttempted, setIsAttempted] = useState(false);
  const [attemptedNote, setAttemptedNote] = useState("");
  const [attemptedPhotos, setAttemptedPhotos] = useState<string[]>([]);

  // Credits to apply before cash payment
  const [selectedCreditNoteId, setSelectedCreditNoteId] = useState<string | null>(null);
  const [applyAdvance, setApplyAdvance] = useState(false);

  const stop = run?.stops?.find((s) => s.id === stopId) ?? null;
  const customerId = stop?.customer?.id;

  // Pre-fetch customer's outstanding invoice to show balance before completion
  const { data: invoiceData } = useQuery({
    queryKey: ["invoices", "stop-preview", customerId],
    queryFn: () =>
      apiClient
        .get("/invoices", { params: { customerId, status: "SENT,PARTIAL,OVERDUE", limit: 5 } })
        .then((r) => r.data),
    enabled: !!customerId,
    staleTime: 30_000,
  });
  const openInvoices: any[] = invoiceData?.data ?? [];
  const totalOutstanding = openInvoices.reduce((sum: number, inv: any) => sum + (inv.balanceDue ?? inv.total ?? 0), 0);

  // Fetch available credit notes (ISSUED status) for this customer
  const { data: creditNotesData } = useQuery({
    queryKey: ["credit-notes", "stop", customerId],
    queryFn: () =>
      apiClient
        .get("/credit-notes", { params: { customerId, status: "ISSUED", limit: 10 } })
        .then((r) => r.data),
    enabled: !!customerId,
    staleTime: 30_000,
  });
  const availableCreditNotes: any[] = creditNotesData?.data ?? [];
  const selectedCreditNote = availableCreditNotes.find((cn) => cn.id === selectedCreditNoteId) ?? null;
  const creditNoteAmount = selectedCreditNote ? Number(selectedCreditNote.amount ?? 0) : 0;

  // Fetch advance balance for this customer
  const { data: paymentStats } = useQuery({
    queryKey: ["payment-stats", customerId],
    queryFn: () =>
      apiClient.get("/invoices/payment-summary", { params: { customerId } }).then((r) => r.data),
    enabled: !!customerId,
    staleTime: 30_000,
  });
  const advanceBalance = Number(paymentStats?.summary?.advanceBalance ?? 0);

  // Net outstanding after credits
  const creditsApplied = creditNoteAmount + (applyAdvance ? advanceBalance : 0);
  const netOutstanding = Math.max(0, totalOutstanding - creditsApplied);
  const firstInvoice = openInvoices[0];

  if (!stop) {
    return (
      <View style={styles.notFound}>
        <Text style={styles.notFoundText}>Stop not found.</Text>
      </View>
    );
  }

  // Flatten all items across orders
  const allOrderItems = (stop.orders ?? []).flatMap((o) => o.lineItems ?? []);

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

  const stops = run?.stops ?? [];
  const nextStop = stops.find(
    (s) => s.stopNumber > stop.stopNumber && (s.status === "PENDING" || s.status === "IN_PROGRESS"),
  );

  const cashAmountNum = parseFloat(cashAmount);
  const cashIsValid = !isNaN(cashAmountNum) && cashAmountNum > 0;
  const changeAmount = cashIsValid && netOutstanding > 0 ? cashAmountNum - netOutstanding : null;

  const handleConfirm = () => {
    if (!runId) return;

    // ── Attempted delivery path ──────────────────────────────────────────────
    if (isAttempted) {
      if (!attemptedNote.trim()) {
        Alert.alert("Note Required", "Please add a note explaining the attempted delivery (e.g. customer not present).");
        return;
      }
      if (attemptedPhotos.length === 0) {
        Alert.alert("Photo Required", "Please capture at least one photo for the attempted delivery.");
        return;
      }

      // Mark all items as REFUSED with an attempted note
      const items: CompleteStopItemDto[] = allItems.map((i) => ({
        orderItemId: i.orderItemId,
        productId: i.productId,
        type: "REFUSED" as const,
        qty: i.orderedQty,
        driverNote: `Attempted delivery: ${attemptedNote}`,
      }));

      completeStop(
        {
          runId,
          stopId,
          driverNote: `ATTEMPTED DELIVERY: ${attemptedNote}`,
          items,
          podPhotoUrls: attemptedPhotos,
          safeDropEnabled: false,
        },
        {
          onSuccess: () => {
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
            showToast("Attempted delivery recorded.");
            clearStop(stopId);
            if (nextStop) {
              router.replace(`/(driver)/route/stop/${nextStop.id}?runId=${runId}` as any);
            } else {
              updateRunStatus(
                { id: runId, status: "COMPLETED" },
                { onSettled: () => router.replace("/(driver)/route") },
              );
            }
          },
          onError: (err) => {
            Alert.alert("Error", "Failed to record attempted delivery.\n" + (err.message || ""));
          },
        },
      );
      return;
    }

    // ── Normal delivery path ─────────────────────────────────────────────────
    if (safeDropEnabled && podPhotos.length === 0) {
      Alert.alert("Photo Required", "Please capture at least one proof of delivery photo when safe drop is enabled.");
      return;
    }

    const unresolvedItems = allItems.filter((i) => !i.resolution || i.resolution.status === "UNRESOLVED");
    if (unresolvedItems.length > 0) {
      Alert.alert(
        "Unresolved Items",
        `Please resolve all items before completing this stop:\n\n• ${unresolvedItems.map((i) => i.name).join("\n• ")}`,
      );
      return;
    }

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

    const zeroPartialItem = items.find((i) => i.type === "PARTIAL" && i.qty < 1);
    if (zeroPartialItem) {
      Alert.alert("Invalid Quantity", "Partial delivery quantity must be at least 1.");
      return;
    }

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
      {
        runId,
        stopId,
        driverNote: stopNote || undefined,
        items,
        podPhotoUrls: podPhotos,
        signatureUrl: signatureCaptured ? "signed" : undefined,
        safeDropEnabled,
      },
      {
        onSuccess: async () => {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          showToast("Delivery confirmed!");

          const hasCredits = creditNoteAmount > 0 || applyAdvance;
          const hasCashPayment = cashIsValid;

          if ((hasCredits || hasCashPayment) && customerId) {
            // Resolve the invoice ID to post payments against
            let invoiceId: string | undefined = firstInvoice?.id;
            if (!invoiceId) {
              try {
                const resp = await apiClient.get("/invoices", {
                  params: { customerId, status: "SENT,PARTIAL,OVERDUE", limit: 1 },
                });
                invoiceId = resp.data?.data?.[0]?.id;
              } catch (_) {
                // ignore — fall through to navigate
              }
            }

            if (invoiceId) {
              // Apply credit note first (if selected)
              if (creditNoteAmount > 0) {
                try {
                  await apiClient.post(`/invoices/${invoiceId}/payments`, {
                    amount: Math.min(creditNoteAmount, totalOutstanding),
                    method: "CREDIT_NOTE",
                    reference: selectedCreditNote?.creditNoteNumber,
                    notes: `Credit note ${selectedCreditNote?.creditNoteNumber ?? ""} applied at stop`,
                  });
                } catch (_) { /* non-fatal */ }
              }
              // Apply advance balance (if toggled)
              if (applyAdvance && advanceBalance > 0) {
                const advanceToApply = Math.min(advanceBalance, totalOutstanding - creditNoteAmount);
                if (advanceToApply > 0) {
                  try {
                    await apiClient.post(`/invoices/${invoiceId}/payments`, {
                      amount: advanceToApply,
                      method: "ADVANCE",
                      notes: "Advance payment applied at stop",
                    });
                  } catch (_) { /* non-fatal */ }
                }
              }
              // Record cash / card payment
              if (hasCashPayment) {
                recordPayment(
                  {
                    invoiceId,
                    amount: cashAmountNum,
                    method: paymentMethod,
                    reference: cashReference || undefined,
                  },
                  { onSettled: navigateAfterComplete },
                );
                return;
              }
            }
          }
          navigateAfterComplete();
        },
        onError: (err) => {
          Alert.alert("Error", "Failed to complete stop. Please try again.\n" + (err.message || ""));
        },
      },
    );
  };

  return (
    <>
      <Stack.Screen options={{ title: "Confirm Stop", headerBackTitle: "Back" }} />
      <View style={styles.container}>
        <ScrollView
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
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

          {/* Attempted delivery toggle */}
          <Pressable
            style={[styles.attemptedToggle, isAttempted && styles.attemptedToggleActive]}
            onPress={() => setIsAttempted((v) => !v)}
          >
            <Ionicons
              name={isAttempted ? "close-circle" : "alert-circle-outline"}
              size={20}
              color={isAttempted ? ios.system.red : ios.label2}
            />
            <Text style={[styles.attemptedToggleText, isAttempted && styles.attemptedToggleTextActive]}>
              {isAttempted ? "Attempted Delivery (tap to cancel)" : "Mark as Attempted Delivery"}
            </Text>
          </Pressable>

          {/* ── ATTEMPTED DELIVERY FORM ─────────────────────────────────────── */}
          {isAttempted ? (
            <View style={styles.attemptedCard}>
              <Text style={styles.attemptedCardTitle}>
                <Ionicons name="person-remove-outline" size={15} color={ios.system.red} />{" "}
                Attempted Delivery
              </Text>
              <Text style={styles.attemptedCardSub}>
                Customer was not present. All items will be marked as undelivered.
              </Text>
              <TextInput
                style={styles.attemptedNoteInput}
                placeholder="Reason (e.g. no answer, premises closed…)"
                placeholderTextColor={ios.label2}
                value={attemptedNote}
                onChangeText={setAttemptedNote}
                multiline
                numberOfLines={2}
                textAlignVertical="top"
              />
              <Text style={styles.attemptedPhotoLabel}>Photo evidence (required)</Text>
              <PhotoCapture
                photos={attemptedPhotos}
                onAdd={(uri) => setAttemptedPhotos((prev) => [...prev, uri])}
                onRemove={(uri) => setAttemptedPhotos((prev) => prev.filter((p) => p !== uri))}
                maxPhotos={3}
                label="Add Photo"
              />
            </View>
          ) : (
            <>
              {/* ── NORMAL DELIVERY SECTIONS ─────────────────────────────────── */}

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
                    <Text style={[styles.summaryCount, { color: cfg.color }]}>{list.length}</Text>
                    <Text style={[styles.summaryLabel, { color: cfg.color }]}>{cfg.label}</Text>
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
                          <Text style={[styles.itemStatusText, { color: cfg.color }]}>{cfg.label}</Text>
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
                    <Ionicons name="home-outline" size={18} color={ios.label2} />
                    <View>
                      <Text style={styles.safeDropTitle}>Safe Drop</Text>
                      <Text style={styles.safeDropSub}>Left at door — unattended delivery</Text>
                    </View>
                  </View>
                  <Switch
                    value={safeDropEnabled}
                    onValueChange={setSafeDropEnabled}
                    trackColor={{ false: ios.separator, true: ios.brand }}
                  />
                </View>
              </View>

              {/* Customer Signature */}
              <Text style={styles.sectionTitle}>Customer Signature</Text>
              <View style={styles.signatureCard}>
                <SignaturePad onCapture={setSignatureCaptured} />
              </View>

              {/* Payment Collected */}
              <Text style={styles.sectionTitle}>Payment Collected</Text>
              <View style={styles.cashCard}>
                {/* Outstanding balance display */}
                {totalOutstanding > 0 && (
                  <View style={styles.balanceRow}>
                    <View style={styles.balanceItem}>
                      <Text style={styles.balanceLabel}>
                        {openInvoices.length === 1
                          ? `Invoice ${firstInvoice?.invoiceNumber ?? ""}`
                          : `${openInvoices.length} open invoices`}
                      </Text>
                      <Text style={styles.balanceAmount}>{fmt(totalOutstanding)}</Text>
                    </View>

                    {/* ── Credit Notes ── */}
                    {availableCreditNotes.length > 0 && (
                      <View style={styles.creditsSection}>
                        <Text style={styles.creditsSectionTitle}>Apply Credit Note</Text>
                        {availableCreditNotes.map((cn: any) => (
                          <Pressable
                            key={cn.id}
                            style={[
                              styles.creditRow,
                              selectedCreditNoteId === cn.id && styles.creditRowSelected,
                            ]}
                            onPress={() =>
                              setSelectedCreditNoteId((prev) => (prev === cn.id ? null : cn.id))
                            }
                          >
                            <Ionicons
                              name={selectedCreditNoteId === cn.id ? "checkmark-circle" : "ellipse-outline"}
                              size={18}
                              color={selectedCreditNoteId === cn.id ? ios.system.green : ios.label2}
                            />
                            <Text style={styles.creditLabel}>{cn.creditNoteNumber}</Text>
                            <Text style={styles.creditAmount}>{fmt(Number(cn.amount))}</Text>
                          </Pressable>
                        ))}
                      </View>
                    )}

                    {/* ── Advance Balance ── */}
                    {advanceBalance > 0 && (
                      <Pressable
                        style={[styles.creditRow, applyAdvance && styles.creditRowSelected]}
                        onPress={() => setApplyAdvance((v) => !v)}
                      >
                        <Ionicons
                          name={applyAdvance ? "checkmark-circle" : "ellipse-outline"}
                          size={18}
                          color={applyAdvance ? ios.system.green : ios.label2}
                        />
                        <Text style={styles.creditLabel}>Advance Balance</Text>
                        <Text style={styles.creditAmount}>{fmt(advanceBalance)}</Text>
                      </Pressable>
                    )}

                    {/* Net outstanding after credits */}
                    {creditsApplied > 0 && (
                      <View style={styles.netOutstandingRow}>
                        <Text style={styles.netOutstandingLabel}>Net Due After Credits</Text>
                        <Text style={styles.netOutstandingAmount}>{fmt(netOutstanding)}</Text>
                      </View>
                    )}
                    {cashIsValid && changeAmount !== null && (
                      <View
                        style={[
                          styles.changeRow,
                          changeAmount >= 0 ? styles.changeRowPositive : styles.changeRowNegative,
                        ]}
                      >
                        <Ionicons
                          name={changeAmount >= 0 ? "arrow-up-circle-outline" : "arrow-down-circle-outline"}
                          size={15}
                          color={changeAmount >= 0 ? ios.system.green : ios.system.orange}
                        />
                        <Text
                          style={[
                            styles.changeText,
                            { color: changeAmount >= 0 ? ios.system.green : ios.system.orange },
                          ]}
                        >
                          {changeAmount >= 0
                            ? `Change to give: ${fmt(changeAmount)}`
                            : `Remaining balance: ${fmt(Math.abs(changeAmount))}`}
                        </Text>
                      </View>
                    )}
                  </View>
                )}

                <View style={styles.cashAmountRow}>
                  <Text style={styles.cashDollar}>$</Text>
                  <TextInput
                    style={styles.cashInput}
                    placeholder="0.00"
                    placeholderTextColor={ios.label2}
                    value={cashAmount}
                    onChangeText={(v) => setCashAmount(v.replace(/[^0-9.]/g, ""))}
                    keyboardType="decimal-pad"
                    returnKeyType="done"
                  />
                  <Text style={styles.cashOptional}>optional</Text>
                </View>
                <View style={styles.paymentMethodRow}>
                  {PAYMENT_METHODS.map(({ key, label, icon }) => (
                    <Pressable
                      key={key}
                      style={[styles.methodBtn, paymentMethod === key && styles.methodBtnActive]}
                      onPress={() => setPaymentMethod(key)}
                    >
                      <Ionicons
                        name={icon as any}
                        size={16}
                        color={paymentMethod === key ? ios.brand : ios.label2}
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
                    placeholderTextColor={ios.label2}
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
                placeholderTextColor={ios.label2}
                value={stopNote}
                onChangeText={(v) => setStopNote(stopId, v)}
                multiline
                numberOfLines={3}
                textAlignVertical="top"
              />
            </>
          )}
        </ScrollView>

        {/* Footer */}
        <View style={styles.footer}>
          <Pressable style={styles.backBtn} onPress={() => router.back()} accessibilityRole="button">
            <Text style={styles.backBtnText}>Back</Text>
          </Pressable>
          <Pressable
            style={[
              styles.confirmBtn,
              (isPending || (isAttempted && (!attemptedNote.trim() || attemptedPhotos.length === 0))) && { opacity: 0.7 },
              isAttempted && styles.confirmBtnAttempted,
            ]}
            onPress={handleConfirm}
            disabled={isPending}
            accessibilityRole="button"
          >
            {isPending ? (
              <ActivityIndicator size="small" color="#fff" style={{ marginRight: 8 }} />
            ) : (
              <Ionicons
                name={isAttempted ? "alert-circle" : nextStop ? "arrow-forward-circle" : "checkmark-done-circle"}
                size={22}
                color="#fff"
                style={{ marginRight: 8 }}
              />
            )}
            <Text style={styles.confirmBtnText}>
              {isAttempted
                ? "Record Attempted Delivery"
                : nextStop
                ? "Confirm & Next Stop"
                : "Confirm & Finish Route"}
            </Text>
          </Pressable>
        </View>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: ios.bg },
  scroll: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 24, gap: 14 },
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
    color: ios.label2,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  businessName: { fontSize: 22, fontFamily: "Inter_700Bold", color: ios.label },
  address: { fontSize: 15, fontFamily: "Inter_400Regular", color: ios.label2 },
  sectionTitle: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  attemptedToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: borderRadius.DEFAULT,
    borderWidth: 1.5,
    borderColor: ios.separator,
    backgroundColor: "#fff",
  },
  attemptedToggleActive: {
    borderColor: ios.system.red,
    backgroundColor: ios.system.redWash,
  },
  attemptedToggleText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    flex: 1,
  },
  attemptedToggleTextActive: { color: ios.system.red },
  attemptedCard: {
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    padding: 16,
    gap: 12,
    borderWidth: 1.5,
    borderColor: ios.system.red,
    ...shadows.card,
  },
  attemptedCardTitle: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    color: ios.system.red,
  },
  attemptedCardSub: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
  },
  attemptedNoteInput: {
    borderWidth: 1,
    borderColor: ios.separator,
    borderRadius: borderRadius.DEFAULT,
    padding: 12,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: ios.label,
    minHeight: 72,
    textAlignVertical: "top",
    backgroundColor: ios.bg,
  },
  attemptedPhotoLabel: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
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
    borderBottomColor: ios.separator,
  },
  itemRowLast: { borderBottomWidth: 0 },
  itemLeft: { flex: 1, gap: 2, paddingRight: 10 },
  itemName: { fontSize: 16, fontFamily: "Inter_600SemiBold", color: ios.label },
  itemQty: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2 },
  itemStatus: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: borderRadius.full,
  },
  itemStatusText: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
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
    borderTopColor: ios.separator,
  },
  safeDropLeft: { flexDirection: "row", alignItems: "center", gap: 10, flex: 1 },
  safeDropTitle: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },
  safeDropSub: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2 },
  signatureCard: {
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    padding: 16,
    ...shadows.card,
  },
  cashCard: {
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    padding: 16,
    gap: 12,
    ...shadows.card,
  },
  balanceRow: {
    gap: 6,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: ios.separator,
  },
  balanceItem: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  balanceLabel: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
  },
  balanceAmount: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: ios.label,
  },
  creditsSection: { marginTop: 10, gap: 6 },
  creditsSectionTitle: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  creditRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: borderRadius.DEFAULT,
    borderWidth: 1.5,
    borderColor: ios.separator,
    backgroundColor: ios.bg,
  },
  creditRowSelected: { borderColor: ios.system.green, backgroundColor: ios.system.greenWash },
  creditLabel: { flex: 1, fontSize: 14, fontFamily: "Inter_600SemiBold", color: ios.label },
  creditAmount: { fontSize: 14, fontFamily: "Inter_700Bold", color: ios.system.green },
  netOutstandingRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: borderRadius.DEFAULT,
    backgroundColor: ios.brandWash,
    marginTop: 4,
  },
  netOutstandingLabel: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: ios.brand },
  netOutstandingAmount: { fontSize: 16, fontFamily: "Inter_700Bold", color: ios.brand },
  changeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: borderRadius.DEFAULT,
  },
  changeRowPositive: { backgroundColor: ios.system.greenWash },
  changeRowNegative: { backgroundColor: ios.system.orangeWash },
  changeText: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  cashAmountRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  cashDollar: { fontSize: 28, fontFamily: "Inter_700Bold", color: ios.label2 },
  cashInput: {
    flex: 1,
    fontSize: 32,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    paddingVertical: 4,
  },
  cashOptional: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    alignSelf: "flex-end",
    paddingBottom: 6,
  },
  paymentMethodRow: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  methodBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: borderRadius.full,
    borderWidth: 1.5,
    borderColor: ios.separator,
    backgroundColor: ios.bg,
  },
  methodBtnActive: { borderColor: ios.brand, backgroundColor: ios.brandWash },
  methodBtnText: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: ios.label2 },
  methodBtnTextActive: { color: ios.brand },
  referenceInput: {
    height: 44,
    borderWidth: 1,
    borderColor: ios.separator,
    borderRadius: borderRadius.DEFAULT,
    paddingHorizontal: 12,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: ios.label,
    backgroundColor: ios.bg,
  },
  notesInput: {
    borderWidth: 1,
    borderColor: ios.separator,
    borderRadius: borderRadius.lg,
    padding: 14,
    fontSize: 16,
    fontFamily: "Inter_400Regular",
    color: ios.label,
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
    borderTopColor: ios.separator,
    gap: 10,
  },
  backBtn: {
    height: 56,
    borderRadius: borderRadius.DEFAULT,
    borderWidth: 1.5,
    borderColor: ios.separator,
    alignItems: "center",
    justifyContent: "center",
  },
  backBtnText: { fontSize: 16, fontFamily: "Inter_600SemiBold", color: ios.label },
  confirmBtn: {
    height: 56,
    backgroundColor: ios.brand,
    borderRadius: borderRadius.DEFAULT,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },
  confirmBtnAttempted: { backgroundColor: ios.system.red },
  confirmBtnText: { fontSize: 17, fontFamily: "Inter_700Bold", color: "#fff" },
  notFound: { flex: 1, alignItems: "center", justifyContent: "center" },
  notFoundText: { fontSize: 16, fontFamily: "Inter_400Regular", color: ios.label2 },
});
