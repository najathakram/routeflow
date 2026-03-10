import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors, borderRadius, shadows } from "@routeflow/ui/tokens";
import {
  useRouteStore,
  selectStopResolutions,
} from "../../../../../store/routeStore";

const STATUS_CONFIG = {
  DELIVERED: { label: "Delivered", icon: "checkmark-circle", color: colors.success.DEFAULT, bg: colors.success.bg },
  PARTIAL: { label: "Partial", icon: "alert-circle", color: colors.warning.DEFAULT, bg: colors.warning.bg },
  REFUSED: { label: "Refused", icon: "close-circle", color: colors.danger.DEFAULT, bg: colors.danger.bg },
  UNRESOLVED: { label: "Unresolved", icon: "help-circle", color: "#94a3b8", bg: colors.surface.raised },
} as const;

export default function StopCompleteScreen() {
  const { stopId } = useLocalSearchParams<{ stopId: string }>();
  const route = useRouteStore((s) => s.route);
  const resolutions = useRouteStore((s) => selectStopResolutions(s, stopId)) ?? {};
  const stopNote = useRouteStore((s) => s.stopNotes[stopId]) ?? "";
  const setStopNote = useRouteStore((s) => s.setStopNote);
  const addedItems = useRouteStore((s) => s.addedItems[stopId]) ?? [];
  const completeStop = useRouteStore((s) => s.completeStop);

  const stop = route.stops.find((s) => s.id === stopId);
  if (!stop) {
    return (
      <View style={styles.notFound}>
        <Text style={styles.notFoundText}>Stop not found.</Text>
      </View>
    );
  }

  // Build summary counts
  const allItems = [
    ...stop.items.map((i) => ({
      id: i.id,
      name: i.name,
      orderedQty: i.orderedQty,
      resolution: resolutions[i.id],
    })),
    ...addedItems.map((i) => ({
      id: i.id,
      name: i.name,
      orderedQty: i.qty,
      resolution: resolutions[i.id],
    })),
  ];

  const delivered = allItems.filter((i) => i.resolution?.status === "DELIVERED");
  const partial = allItems.filter((i) => i.resolution?.status === "PARTIAL");
  const refused = allItems.filter((i) => i.resolution?.status === "REFUSED");

  const nextStop = route.stops.find(
    (s) => s.stopNumber > stop.stopNumber && s.status === "PENDING",
  );

  const handleConfirm = () => {
    completeStop(stopId);
    if (nextStop) {
      // navigate to next stop
      router.replace(`/(driver)/route/stop/${nextStop.id}`);
    } else {
      // back to route overview
      router.replace("/(driver)/route");
    }
  };

  return (
    <>
      <Stack.Screen
        options={{
          title: "Confirm Stop",
          headerBackTitle: "Back",
        }}
      />
      <View style={styles.container}>
        <ScrollView
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}
        >
          {/* Stop identity */}
          <View style={styles.identityCard}>
            <Text style={styles.stopLabel}>
              Stop {stop.stopNumber} of {route.stops.length}
            </Text>
            <Text style={styles.businessName}>{stop.businessName}</Text>
            <Text style={styles.address}>{stop.address}</Text>
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
            ).map(({ key, items, cfg }) => (
              <View
                key={key}
                style={[styles.summaryChip, { backgroundColor: cfg.bg }]}
              >
                <Ionicons name={cfg.icon as any} size={22} color={cfg.color} />
                <Text style={[styles.summaryCount, { color: cfg.color }]}>
                  {items.length}
                </Text>
                <Text style={[styles.summaryLabel, { color: cfg.color }]}>
                  {cfg.label}
                </Text>
              </View>
            ))}
          </View>

          {/* Per-item breakdown */}
          <View style={styles.itemsCard}>
            {allItems.map((item, idx) => {
              const res = item.resolution;
              const cfg = res?.status
                ? STATUS_CONFIG[res.status]
                : STATUS_CONFIG.UNRESOLVED;
              const isLast = idx === allItems.length - 1;
              return (
                <View
                  key={item.id}
                  style={[styles.itemRow, isLast && styles.itemRowLast]}
                >
                  <View style={styles.itemLeft}>
                    <Text style={styles.itemName}>{item.name}</Text>
                    <Text style={styles.itemQty}>
                      {res?.status === "PARTIAL"
                        ? `${res.partialQty ?? 0} of ${item.orderedQty} delivered`
                        : `${item.orderedQty} ordered`}
                    </Text>
                  </View>
                  <View style={[styles.itemStatus, { backgroundColor: cfg.bg }]}>
                    <Ionicons
                      name={cfg.icon as any}
                      size={16}
                      color={cfg.color}
                    />
                    <Text style={[styles.itemStatusText, { color: cfg.color }]}>
                      {cfg.label}
                    </Text>
                  </View>
                </View>
              );
            })}
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

        {/* Two buttons: Back (ghost) + Confirm & Next Stop (primary) */}
        <View style={styles.footer}>
          <Pressable
            style={styles.backBtn}
            onPress={() => router.back()}
            accessibilityRole="button"
          >
            <Text style={styles.backBtnText}>Back</Text>
          </Pressable>
          <Pressable
            style={styles.confirmBtn}
            onPress={handleConfirm}
            accessibilityRole="button"
          >
            <Ionicons
              name={nextStop ? "arrow-forward-circle" : "checkmark-done-circle"}
              size={22}
              color="#fff"
              style={{ marginRight: 8 }}
            />
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
  container: {
    flex: 1,
    backgroundColor: colors.surface.raised,
  },
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
  summaryRow: {
    flexDirection: "row",
    gap: 10,
  },
  summaryChip: {
    flex: 1,
    borderRadius: borderRadius.lg,
    paddingVertical: 14,
    alignItems: "center",
    gap: 4,
  },
  summaryCount: {
    fontSize: 24,
    fontFamily: "Inter_700Bold",
  },
  summaryLabel: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
  },
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
  itemRowLast: {
    borderBottomWidth: 0,
  },
  itemLeft: {
    flex: 1,
    gap: 2,
    paddingRight: 10,
  },
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
  itemStatusText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
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
  notFound: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  notFoundText: {
    fontSize: 16,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
  },
});
