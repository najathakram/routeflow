import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { format, parseISO } from "date-fns";
import { Ionicons } from "@expo/vector-icons";
import { StatusBadge } from "@routeflow/ui/mobile";
import { colors, borderRadius, shadows } from "@routeflow/ui/tokens";
import {
  useRouteRun,
  useReopenStop,
  useUpdateRun,
  type RouteRunStop,
  type DeliveryMutation,
} from "../../../lib/api/routes";
import { NetworkError } from "../../../components/NetworkError";

const MUTATION_CONFIG = {
  DELIVERED: { label: "Delivered", icon: "checkmark-circle" as const, color: colors.success.DEFAULT, bg: colors.success.bg },
  PARTIAL: { label: "Partial", icon: "alert-circle" as const, color: colors.warning.DEFAULT, bg: colors.warning.bg },
  REFUSED: { label: "Refused", icon: "close-circle" as const, color: colors.danger.DEFAULT, bg: colors.danger.bg },
  ADD_ON: { label: "Add-on", icon: "add-circle" as const, color: colors.brand[500], bg: colors.brand[50] },
};

function DeliveryMutationRow({ mutation }: { mutation: DeliveryMutation }) {
  const cfg = MUTATION_CONFIG[mutation.type] ?? MUTATION_CONFIG.DELIVERED;
  const qty = Number(mutation.quantityDelivered ?? 0);
  return (
    <View style={styles.mutationRow}>
      <View style={styles.mutationLeft}>
        <Text style={styles.mutationProduct}>
          {mutation.product?.name ?? mutation.productId}
        </Text>
        <Text style={styles.mutationQty}>
          {mutation.type === "PARTIAL" ? `${qty} delivered` : `Qty ${qty}`}
          {mutation.product?.unit ? ` ${mutation.product.unit}` : ""}
        </Text>
        {mutation.note ? (
          <Text style={styles.mutationNote}>{mutation.note}</Text>
        ) : null}
      </View>
      <View style={[styles.mutationBadge, { backgroundColor: cfg.bg }]}>
        <Ionicons name={cfg.icon} size={14} color={cfg.color} />
        <Text style={[styles.mutationBadgeText, { color: cfg.color }]}>{cfg.label}</Text>
      </View>
    </View>
  );
}

function StopCard({ stop, runId, canReopen }: { stop: RouteRunStop; runId: string; canReopen: boolean }) {
  const { mutate: reopenStop, isPending } = useReopenStop();
  const mutations = stop.deliveryMutations ?? [];
  const photosCount = stop.podPhotoUrls?.length ?? 0;

  const handleReopen = () => {
    Alert.alert(
      "Reopen Stop?",
      `This will undo the delivery record for ${stop.customer?.businessName ?? "this customer"} so you can re-submit it.\n\nNote: If a payment has already been recorded, reopening is blocked.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Reopen",
          style: "destructive",
          onPress: () => {
            reopenStop(
              { runId, stopId: stop.id },
              {
                onSuccess: () => {
                  Alert.alert("Stop Reopened", "Navigate to your active route to re-deliver this stop.");
                  router.replace("/(driver)/route" as any);
                },
                onError: (err: any) => {
                  Alert.alert("Cannot Reopen", err?.response?.data?.message ?? err.message ?? "An error occurred.");
                },
              },
            );
          },
        },
      ],
    );
  };

  return (
    <View style={styles.stopCard}>
      {/* Stop header — tappable to navigate to stop detail/edit */}
      <Pressable
        style={styles.stopHeader}
        onPress={() => router.push(`/(driver)/route/stop/${stop.id}?runId=${runId}` as any)}
        accessibilityRole="button"
        accessibilityLabel={`Open stop ${stop.stopNumber}: ${stop.customer?.businessName ?? "Customer"}`}
      >
        <View style={styles.stopNumBubble}>
          <Text style={styles.stopNum}>{stop.stopNumber}</Text>
        </View>
        <View style={styles.stopHeaderMid}>
          <Text style={styles.stopBusiness}>
            {stop.customer?.businessName ?? "Customer"}
          </Text>
          {stop.customerAddress ? (
            <Text style={styles.stopAddress} numberOfLines={1}>
              {stop.customerAddress.line1}, {stop.customerAddress.city}
            </Text>
          ) : null}
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <StatusBadge
            status={
              stop.status === "COMPLETED"
                ? "COMPLETED"
                : stop.status === "SKIPPED"
                ? "CANCELLED"
                : "PENDING"
            }
          />
          <Ionicons name="chevron-forward" size={16} color="#cbd5e1" />
        </View>
      </Pressable>

      {/* Completed at */}
      {stop.completedAt ? (
        <View style={styles.metaRow}>
          <Ionicons name="time-outline" size={14} color="#94a3b8" />
          <Text style={styles.metaText}>
            Completed {format(parseISO(stop.completedAt), "h:mm a")}
          </Text>
        </View>
      ) : null}

      {/* Skipped — no delivery data */}
      {stop.status === "SKIPPED" ? (
        <View style={styles.skippedNote}>
          <Ionicons name="arrow-undo-circle-outline" size={16} color="#94a3b8" />
          <Text style={styles.skippedText}>This stop was skipped</Text>
        </View>
      ) : null}

      {/* Delivery mutations */}
      {mutations.length > 0 ? (
        <View style={styles.mutationsContainer}>
          <Text style={styles.sectionLabel}>Items Delivered</Text>
          {mutations.map((m) => (
            <DeliveryMutationRow key={m.id} mutation={m} />
          ))}
        </View>
      ) : stop.status === "COMPLETED" ? (
        <Text style={styles.noMutations}>No item records found for this stop.</Text>
      ) : null}

      {/* POD + safe drop */}
      {(photosCount > 0 || stop.safeDropEnabled) ? (
        <View style={styles.podRow}>
          {photosCount > 0 ? (
            <View style={styles.podChip}>
              <Ionicons name="camera-outline" size={14} color={colors.brand[500]} />
              <Text style={styles.podChipText}>{photosCount} photo{photosCount !== 1 ? "s" : ""}</Text>
            </View>
          ) : null}
          {stop.safeDropEnabled ? (
            <View style={styles.podChip}>
              <Ionicons name="home-outline" size={14} color={colors.brand[500]} />
              <Text style={styles.podChipText}>Safe drop</Text>
            </View>
          ) : null}
        </View>
      ) : null}

      {/* Driver note */}
      {stop.driverNote ? (
        <View style={styles.noteBox}>
          <Ionicons name="document-text-outline" size={14} color="#64748b" />
          <Text style={styles.noteText}>{stop.driverNote}</Text>
        </View>
      ) : null}

      {/* Reopen button */}
      {canReopen && stop.status === "COMPLETED" ? (
        <Pressable
          style={[styles.reopenBtn, isPending && { opacity: 0.6 }]}
          onPress={handleReopen}
          disabled={isPending}
          accessibilityRole="button"
          accessibilityLabel="Reopen this stop"
        >
          {isPending ? (
            <ActivityIndicator size="small" color={colors.warning.DEFAULT} />
          ) : (
            <Ionicons name="refresh-circle-outline" size={18} color={colors.warning.DEFAULT} />
          )}
          <Text style={styles.reopenBtnText}>Reopen Stop</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

// ─── Calendar Picker ──────────────────────────────────────────────────────────

function chunkWeeks<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) result.push(arr.slice(i, i + size));
  return result;
}

function CalendarPicker({
  selectedDate,
  onSelect,
}: {
  selectedDate: Date;
  onSelect: (date: Date) => void;
}) {
  const [viewYear, setViewYear] = useState(selectedDate.getFullYear());
  const [viewMonth, setViewMonth] = useState(selectedDate.getMonth());

  const today = new Date();
  const firstDayOfWeek = new Date(viewYear, viewMonth, 1).getDay();
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const monthLabel = format(new Date(viewYear, viewMonth, 1), "MMMM yyyy");

  const prevMonth = () => {
    if (viewMonth === 0) { setViewYear(y => y - 1); setViewMonth(11); }
    else setViewMonth(m => m - 1);
  };
  const nextMonth = () => {
    if (viewMonth === 11) { setViewYear(y => y + 1); setViewMonth(0); }
    else setViewMonth(m => m + 1);
  };

  const cells: (number | null)[] = [];
  for (let i = 0; i < firstDayOfWeek; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  return (
    <View style={calStyles.cal}>
      <View style={calStyles.calHeader}>
        <Pressable onPress={prevMonth} style={calStyles.calArrow} accessibilityLabel="Previous month">
          <Ionicons name="chevron-back" size={22} color={colors.navy.DEFAULT} />
        </Pressable>
        <Text style={calStyles.calMonth}>{monthLabel}</Text>
        <Pressable onPress={nextMonth} style={calStyles.calArrow} accessibilityLabel="Next month">
          <Ionicons name="chevron-forward" size={22} color={colors.navy.DEFAULT} />
        </Pressable>
      </View>

      <View style={calStyles.weekRow}>
        {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map(d => (
          <Text key={d} style={calStyles.weekDay}>{d}</Text>
        ))}
      </View>

      {chunkWeeks(cells, 7).map((week, wi) => (
        <View key={wi} style={calStyles.weekRow}>
          {week.map((day, di) => {
            if (!day) return <View key={di} style={calStyles.dayCell} />;
            const isSelected =
              selectedDate.getFullYear() === viewYear &&
              selectedDate.getMonth() === viewMonth &&
              selectedDate.getDate() === day;
            const isTodayDay =
              today.getFullYear() === viewYear &&
              today.getMonth() === viewMonth &&
              today.getDate() === day;
            return (
              <Pressable
                key={di}
                style={[
                  calStyles.dayCell,
                  isSelected && calStyles.dayCellSelected,
                  isTodayDay && !isSelected && calStyles.dayCellToday,
                ]}
                onPress={() => onSelect(new Date(viewYear, viewMonth, day))}
                accessibilityRole="button"
                accessibilityLabel={`${day} ${monthLabel}`}
              >
                <Text
                  style={[
                    calStyles.dayText,
                    isSelected && calStyles.dayTextSelected,
                    isTodayDay && !isSelected && calStyles.dayTextToday,
                  ]}
                >
                  {day}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function RunDetailScreen() {
  const { runId } = useLocalSearchParams<{ runId: string }>();
  const { data: run, isLoading, isError, refetch } = useRouteRun(runId ?? "");
  const { mutate: updateRun, isPending: isRescheduling } = useUpdateRun();

  const [rescheduleModalVisible, setRescheduleModalVisible] = useState(false);
  const [selectedDate, setSelectedDate] = useState<Date>(new Date());

  if (isLoading) {
    return (
      <>
        <Stack.Screen options={{ title: "Route Detail", headerBackTitle: "History" }} />
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.brand[500]} />
        </View>
      </>
    );
  }

  if (isError || !run) {
    return (
      <>
        <Stack.Screen options={{ title: "Route Detail", headerBackTitle: "History" }} />
        <NetworkError onRetry={() => refetch()} />
      </>
    );
  }

  const stops = run.stops ?? [];
  const totalStops = stops.length;
  const completedStops = stops.filter((s) => s.status === "COMPLETED").length;
  const skippedStops = stops.filter((s) => s.status === "SKIPPED").length;

  const scheduledDate = run.scheduledDate
    ? format(parseISO(run.scheduledDate), "EEEE, MMM d, yyyy")
    : "—";

  const canReopen = run.status === "COMPLETED" || run.status === "IN_PROGRESS";

  return (
    <>
      <Stack.Screen
        options={{
          title: run.route?.name ?? "Route Detail",
          headerBackTitle: "History",
        }}
      />
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {/* Header card */}
        <View style={styles.headerCard}>
          <View style={styles.headerRow}>
            <View style={styles.headerLeft}>
              <Text style={styles.routeName}>{run.route?.name ?? "Route"}</Text>
              <Text style={styles.dateText}>{scheduledDate}</Text>
            </View>
            <StatusBadge
              status={
                run.status === "COMPLETED"
                  ? "COMPLETED"
                  : run.status === "IN_PROGRESS"
                  ? "IN_PROGRESS"
                  : run.status === "CANCELLED"
                  ? "CANCELLED"
                  : "PENDING"
              }
            />
          </View>

          {/* Summary chips */}
          <View style={styles.summaryRow}>
            <View style={styles.summaryChip}>
              <Ionicons name="flag-outline" size={16} color={colors.success.DEFAULT} />
              <Text style={styles.summaryChipText}>
                <Text style={{ fontFamily: "Inter_700Bold" }}>{completedStops}</Text>
                {" "}completed
              </Text>
            </View>
            {skippedStops > 0 ? (
              <View style={styles.summaryChip}>
                <Ionicons name="close-circle-outline" size={16} color="#94a3b8" />
                <Text style={styles.summaryChipText}>
                  <Text style={{ fontFamily: "Inter_700Bold" }}>{skippedStops}</Text>
                  {" "}skipped
                </Text>
              </View>
            ) : null}
            <View style={styles.summaryChip}>
              <Ionicons name="layers-outline" size={16} color="#64748b" />
              <Text style={styles.summaryChipText}>
                <Text style={{ fontFamily: "Inter_700Bold" }}>{totalStops}</Text>
                {" "}total
              </Text>
            </View>
          </View>

          {/* Timing */}
          {run.startedAt ? (
            <View style={styles.timingRow}>
              <Ionicons name="play-circle-outline" size={14} color="#94a3b8" />
              <Text style={styles.timingText}>
                Started {format(parseISO(run.startedAt), "h:mm a")}
              </Text>
              {run.completedAt ? (
                <>
                  <Text style={styles.timingDivider}>·</Text>
                  <Ionicons name="checkmark-done-circle-outline" size={14} color="#94a3b8" />
                  <Text style={styles.timingText}>
                    Finished {format(parseISO(run.completedAt), "h:mm a")}
                  </Text>
                </>
              ) : null}
            </View>
          ) : null}
        </View>

        {/* Reschedule button — shown for SCHEDULED runs */}
        {run.status === "SCHEDULED" && (
          <Pressable
            style={[styles.rescheduleBtn, isRescheduling && { opacity: 0.6 }]}
            disabled={isRescheduling}
            onPress={() => {
              try {
                setSelectedDate(parseISO(run.scheduledDate));
              } catch {
                setSelectedDate(new Date());
              }
              setRescheduleModalVisible(true);
            }}
            accessibilityRole="button"
            accessibilityLabel="Reschedule this run"
          >
            <Ionicons name="calendar-outline" size={18} color={colors.brand[500]} />
            <Text style={styles.rescheduleBtnText}>Reschedule Run</Text>
          </Pressable>
        )}

        {/* Reschedule Modal */}
        <Modal
          visible={rescheduleModalVisible}
          transparent
          animationType="fade"
          onRequestClose={() => setRescheduleModalVisible(false)}
        >
          <Pressable style={styles.modalOverlay} onPress={() => setRescheduleModalVisible(false)}>
            <Pressable style={styles.modalSheet} onPress={() => {}}>
              <Text style={styles.modalTitle}>Reschedule Run</Text>
              <Text style={styles.modalSubtitle}>
                {run.route?.name ?? "Route"} — pick a new date
              </Text>
              <Text style={styles.modalSelectedDate}>
                {format(selectedDate, "EEEE, MMM d, yyyy")}
              </Text>

              <CalendarPicker selectedDate={selectedDate} onSelect={setSelectedDate} />

              <View style={styles.modalActions}>
                <Pressable
                  style={styles.modalCancelBtn}
                  onPress={() => setRescheduleModalVisible(false)}
                >
                  <Text style={styles.modalCancelText}>Cancel</Text>
                </Pressable>
                <Pressable
                  style={styles.modalSaveBtn}
                  onPress={() => {
                    setRescheduleModalVisible(false);
                    updateRun(
                      { id: run.id, scheduledDate: selectedDate.toISOString() },
                      {
                        onSuccess: () =>
                          Alert.alert("Rescheduled", `Run moved to ${format(selectedDate, "MMM d, yyyy")}.`),
                        onError: (err: any) =>
                          Alert.alert("Error", err?.response?.data?.message ?? err.message),
                      },
                    );
                  }}
                >
                  {isRescheduling ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Text style={styles.modalSaveText}>Reschedule</Text>
                  )}
                </Pressable>
              </View>
            </Pressable>
          </Pressable>
        </Modal>

        {/* Stops */}
        <Text style={styles.stopsLabel}>Stops</Text>
        {stops.map((stop) => (
          <StopCard key={stop.id} stop={stop} runId={run.id} canReopen={canReopen} />
        ))}

        {stops.length === 0 ? (
          <View style={styles.emptyStops}>
            <Ionicons name="location-outline" size={40} color="#cbd5e1" />
            <Text style={styles.emptyText}>No stop data available.</Text>
          </View>
        ) : null}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surface.raised },
  content: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 40,
    gap: 10,
  },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },

  // Header card
  headerCard: {
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    padding: 16,
    gap: 12,
    ...shadows.card,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },
  headerLeft: { flex: 1, gap: 2 },
  routeName: {
    fontSize: 20,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  dateText: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },
  summaryRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  summaryChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: colors.surface.raised,
    borderRadius: borderRadius.full,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  summaryChipText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },
  timingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    flexWrap: "wrap",
  },
  timingText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
  },
  timingDivider: {
    fontSize: 13,
    color: "#94a3b8",
  },

  // Stop cards
  stopsLabel: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: "#94a3b8",
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginTop: 4,
    marginBottom: 2,
  },
  stopCard: {
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    padding: 16,
    gap: 10,
    ...shadows.card,
  },
  stopHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  stopNumBubble: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.surface.raised,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.surface.border,
    flexShrink: 0,
  },
  stopNum: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  stopHeaderMid: { flex: 1, gap: 1 },
  stopBusiness: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  stopAddress: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  metaText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
  },
  skippedNote: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 6,
  },
  skippedText: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
    fontStyle: "italic",
  },

  // Mutations
  mutationsContainer: { gap: 0 },
  sectionLabel: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: "#94a3b8",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  mutationRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.surface.border,
    gap: 10,
  },
  mutationLeft: { flex: 1, gap: 1 },
  mutationProduct: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: colors.navy.DEFAULT,
  },
  mutationQty: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },
  mutationNote: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
    fontStyle: "italic",
  },
  mutationBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: borderRadius.full,
  },
  mutationBadgeText: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
  },
  noMutations: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
    fontStyle: "italic",
  },

  // POD chips
  podRow: {
    flexDirection: "row",
    gap: 8,
    flexWrap: "wrap",
  },
  podChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: colors.brand[50],
    borderRadius: borderRadius.full,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  podChipText: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: colors.brand[500],
  },

  // Notes
  noteBox: {
    flexDirection: "row",
    gap: 8,
    backgroundColor: colors.surface.raised,
    borderRadius: borderRadius.DEFAULT,
    padding: 10,
    alignItems: "flex-start",
  },
  noteText: {
    flex: 1,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },

  // Reopen
  reopenBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    borderWidth: 1.5,
    borderColor: colors.warning.DEFAULT,
    borderRadius: borderRadius.DEFAULT,
    paddingVertical: 10,
    marginTop: 2,
  },
  reopenBtnText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: colors.warning.DEFAULT,
  },

  // Reschedule
  rescheduleBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderWidth: 1.5,
    borderColor: colors.brand[500],
    borderRadius: borderRadius.lg,
    paddingVertical: 12,
    backgroundColor: colors.brand[50],
  },
  rescheduleBtnText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: colors.brand[500],
  },

  // Reschedule modal
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  modalSheet: {
    backgroundColor: "#fff",
    borderRadius: 20,
    padding: 20,
    width: "100%",
    maxWidth: 380,
    gap: 12,
  },
  modalTitle: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  modalSubtitle: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
    marginTop: -4,
  },
  modalSelectedDate: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: colors.brand[500],
    textAlign: "center",
    paddingVertical: 6,
    backgroundColor: colors.brand[50],
    borderRadius: borderRadius.DEFAULT,
  },
  modalActions: {
    flexDirection: "row",
    gap: 10,
    marginTop: 4,
  },
  modalCancelBtn: {
    flex: 1,
    height: 50,
    borderRadius: borderRadius.DEFAULT,
    borderWidth: 1,
    borderColor: colors.surface.border,
    alignItems: "center",
    justifyContent: "center",
  },
  modalCancelText: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    color: "#64748b",
  },
  modalSaveBtn: {
    flex: 2,
    height: 50,
    backgroundColor: colors.brand[500],
    borderRadius: borderRadius.DEFAULT,
    alignItems: "center",
    justifyContent: "center",
  },
  modalSaveText: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: "#fff",
  },

  // Empty state
  emptyStops: {
    alignItems: "center",
    paddingTop: 48,
    gap: 10,
  },
  emptyText: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
  },
});

const calStyles = StyleSheet.create({
  cal: {
    gap: 4,
  },
  calHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 4,
  },
  calArrow: {
    padding: 8,
    borderRadius: borderRadius.DEFAULT,
    backgroundColor: colors.surface.raised,
  },
  calMonth: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  weekRow: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  weekDay: {
    width: "14.28%",
    textAlign: "center",
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: "#94a3b8",
    paddingBottom: 4,
  },
  dayCell: {
    width: "14.28%",
    aspectRatio: 1,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 100,
  },
  dayCellSelected: {
    backgroundColor: colors.brand[500],
  },
  dayCellToday: {
    backgroundColor: colors.brand[50],
    borderWidth: 1,
    borderColor: colors.brand[200],
  },
  dayText: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: colors.navy.DEFAULT,
  },
  dayTextSelected: {
    fontFamily: "Inter_700Bold",
    color: "#fff",
  },
  dayTextToday: {
    fontFamily: "Inter_600SemiBold",
    color: colors.brand[500],
  },
});
