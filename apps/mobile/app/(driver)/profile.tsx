import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { router, Stack } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors, borderRadius, shadows } from "@routeflow/ui/tokens";
import { useAuthStore } from "../../lib/auth-store";
import { useRouteStore, selectCompletedCount } from "../../store/routeStore";
import { MOCK_DRIVER } from "../../data/driverMockData";

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue}>{value}</Text>
    </View>
  );
}

function StatBox({ value, label }: { value: string | number; label: string }) {
  return (
    <View style={styles.statBox}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function ActionRow({
  icon,
  label,
  onPress,
  danger,
}: {
  icon: string;
  label: string;
  onPress: () => void;
  danger?: boolean;
}) {
  return (
    <Pressable
      style={styles.actionRow}
      onPress={onPress}
      accessibilityRole="button"
    >
      <Ionicons
        name={icon as any}
        size={22}
        color={danger ? colors.danger.DEFAULT : colors.navy.DEFAULT}
      />
      <Text
        style={[styles.actionLabel, danger && { color: colors.danger.DEFAULT }]}
      >
        {label}
      </Text>
      {!danger && (
        <Ionicons name="chevron-forward" size={16} color="#94a3b8" style={styles.chevron} />
      )}
    </Pressable>
  );
}

export default function DriverProfileScreen() {
  const logout = useAuthStore((s) => s.logout);
  const stopsCompleted = useRouteStore(selectCompletedCount);
  const route = useRouteStore((s) => s.route);
  const resolutions = useRouteStore((s) => s.itemResolutions);

  // Count total delivered items across completed stops
  const itemsDelivered = route.stops
    .filter((s) => s.status === "COMPLETED")
    .reduce((total, stop) => {
      const stopRes = resolutions[stop.id] ?? {};
      const delivered = stop.items.filter(
        (item) =>
          stopRes[item.id]?.status === "DELIVERED" ||
          stopRes[item.id]?.status === "PARTIAL",
      ).length;
      // If no resolutions yet (pre-loaded COMPLETED stops), count all items
      return total + (Object.keys(stopRes).length > 0 ? delivered : stop.items.length);
    }, 0);

  const handleSignOut = async () => {
    await logout();
    // _layout.tsx handles routing to login
  };

  return (
    <>
      <Stack.Screen options={{ title: "Profile" }} />
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        {/* Avatar + name */}
        <View style={styles.avatarSection}>
          <View style={styles.avatar}>
            <Ionicons name="person" size={34} color={colors.brand[700]} />
          </View>
          <Text style={styles.driverName}>{MOCK_DRIVER.name}</Text>
          <View style={styles.vehicleTag}>
            <Ionicons name="car-outline" size={15} color="#64748b" />
            <Text style={styles.vehicleText}>
              {MOCK_DRIVER.vehicleMake} · {MOCK_DRIVER.vehicleColour} ·{" "}
              {MOCK_DRIVER.vehiclePlate}
            </Text>
          </View>
        </View>

        {/* Today's stats */}
        <Text style={styles.sectionTitle}>Today's Stats</Text>
        <View style={styles.statsRow}>
          <StatBox value={stopsCompleted} label="Stops Completed" />
          <StatBox value={itemsDelivered} label="Items Delivered" />
          <StatBox
            value={`${route.stops.length - stopsCompleted}`}
            label="Stops Remaining"
          />
        </View>

        {/* Driver info */}
        <View style={styles.section}>
          <Text style={styles.sectionInnerTitle}>Driver Info</Text>
          <InfoRow label="Name" value={MOCK_DRIVER.name} />
          <InfoRow label="Vehicle" value={MOCK_DRIVER.vehicleMake} />
          <InfoRow label="Colour" value={MOCK_DRIVER.vehicleColour} />
          <InfoRow label="Plate" value={MOCK_DRIVER.vehiclePlate} />
        </View>

        {/* Account */}
        <View style={styles.section}>
          <Text style={styles.sectionInnerTitle}>Account</Text>
          <ActionRow
            icon="lock-closed-outline"
            label="Change Password"
            onPress={() => router.push("/(driver)/change-password")}
          />
        </View>

        {/* Sign out */}
        <View style={[styles.section, { marginTop: 4 }]}>
          <ActionRow
            icon="log-out-outline"
            label="Sign Out"
            onPress={handleSignOut}
            danger
          />
        </View>

        <Text style={styles.version}>RouteFlow v1.0.0</Text>
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.surface.raised,
  },
  scroll: {
    paddingBottom: 40,
  },
  avatarSection: {
    alignItems: "center",
    paddingVertical: 32,
    backgroundColor: "#fff",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.surface.border,
    marginBottom: 16,
  },
  avatar: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: colors.brand[100],
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 12,
  },
  driverName: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
    marginBottom: 6,
  },
  vehicleTag: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: colors.surface.raised,
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: borderRadius.full,
  },
  vehicleText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: "#64748b",
  },
  sectionTitle: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: "#94a3b8",
    textTransform: "uppercase",
    letterSpacing: 0.6,
    paddingHorizontal: 16,
    marginBottom: 10,
  },
  statsRow: {
    flexDirection: "row",
    paddingHorizontal: 16,
    gap: 10,
    marginBottom: 20,
  },
  statBox: {
    flex: 1,
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    paddingVertical: 16,
    alignItems: "center",
    gap: 4,
    ...shadows.card,
  },
  statValue: {
    fontSize: 28,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  statLabel: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    color: "#94a3b8",
    textAlign: "center",
  },
  section: {
    backgroundColor: "#fff",
    marginHorizontal: 16,
    marginBottom: 12,
    borderRadius: borderRadius.lg,
    paddingHorizontal: 16,
    paddingVertical: 4,
    ...shadows.card,
  },
  sectionInnerTitle: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: "#94a3b8",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    paddingVertical: 10,
  },
  infoRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 13,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.surface.border,
    gap: 12,
  },
  infoLabel: {
    fontSize: 16,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },
  infoValue: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    color: colors.navy.DEFAULT,
    textAlign: "right",
  },
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.surface.border,
    gap: 12,
    minHeight: 56,
  },
  actionLabel: {
    flex: 1,
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    color: colors.navy.DEFAULT,
  },
  chevron: {
    marginLeft: "auto",
  },
  version: {
    textAlign: "center",
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: "#cbd5e1",
    marginTop: 8,
  },
});
