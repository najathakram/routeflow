import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { router, Stack } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors, borderRadius, shadows } from "@routeflow/ui/tokens";
import { useAuthStore } from "../../lib/auth-store";
import { useMyCustomerProfile } from "../../lib/api/customers";

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue}>{value}</Text>
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
    <Pressable style={styles.actionRow} onPress={onPress} accessibilityRole="button">
      <Ionicons
        name={icon as any}
        size={20}
        color={danger ? colors.danger.DEFAULT : colors.navy.DEFAULT}
      />
      <Text style={[styles.actionLabel, danger && { color: colors.danger.DEFAULT }]}>
        {label}
      </Text>
      {!danger ? (
        <Ionicons name="chevron-forward" size={16} color="#94a3b8" style={styles.actionChevron} />
      ) : null}
    </Pressable>
  );
}

export default function ProfileScreen() {
  const logout = useAuthStore((s) => s.logout);
  const { data: profile, isLoading } = useMyCustomerProfile();

  const initials = profile?.businessName
    ? profile.businessName.split(" ").slice(0, 2).map((w) => w[0]).join("")
    : "?";

  return (
    <>
      <Stack.Screen
        options={{
          title: "Profile",
          headerLeft: () => (
            <Pressable
              onPress={() => router.back()}
              hitSlop={10}
              style={{ paddingLeft: 4 }}
              accessibilityLabel="Close"
              accessibilityRole="button"
            >
              <Ionicons name="arrow-back" size={24} color={colors.navy.DEFAULT} />
            </Pressable>
          ),
        }}
      />
      {isLoading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.brand[500]} />
        </View>
      ) : (
        <ScrollView style={styles.container} contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
          {/* Avatar + business name */}
          <View style={styles.avatarSection}>
            <View style={styles.avatar}>
              <Text style={styles.avatarInitials}>{initials}</Text>
            </View>
            <Text style={styles.businessName}>{profile?.businessName ?? "—"}</Text>
            <Text style={styles.contactName}>{profile?.contactName ?? ""}</Text>
          </View>

          {/* Business info */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Business Info</Text>
            <InfoRow label="Business Name" value={profile?.businessName ?? "—"} />
            <InfoRow label="Contact" value={profile?.contactName ?? "—"} />
            {profile?.user?.email ? <InfoRow label="Email" value={profile.user.email} /> : null}
            {profile?.phone ? <InfoRow label="Phone" value={profile.phone} /> : null}
            {profile?.deliveryWindowStart && profile?.deliveryWindowEnd ? (
              <InfoRow
                label="Delivery Window"
                value={`${profile.deliveryWindowStart} – ${profile.deliveryWindowEnd}`}
              />
            ) : null}
          </View>

          {/* Delivery addresses */}
          {profile?.addresses && profile.addresses.length > 0 ? (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Delivery Addresses</Text>
              {profile.addresses.map((addr) => (
                <View key={addr.id} style={styles.addressRow}>
                  <View style={styles.addressLabelRow}>
                    <Ionicons name="location-outline" size={14} color="#94a3b8" />
                    <Text style={styles.addressLabel}>{addr.label ?? "Address"}</Text>
                    {addr.isDefault && (
                      <View style={styles.defaultBadge}>
                        <Text style={styles.defaultBadgeText}>Default</Text>
                      </View>
                    )}
                  </View>
                  <Text style={styles.addressText}>
                    {addr.line1}{addr.line2 ? `, ${addr.line2}` : ""}
                  </Text>
                  <Text style={styles.addressText}>
                    {addr.city}, {addr.state} {addr.zip}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}

          {/* Quick links */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>My Account</Text>
            <ActionRow
              icon="repeat-outline"
              label="Standing Orders"
              onPress={() => router.push("/(customer)/standing-orders" as any)}
            />
            <ActionRow
              icon="return-down-back-outline"
              label="Returns"
              onPress={() => router.push("/(customer)/returns" as any)}
            />
          </View>

          {/* Settings */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Settings</Text>
            <ActionRow
              icon="lock-closed-outline"
              label="Change Password"
              onPress={() => router.push("/(customer)/change-password")}
            />
          </View>

          <View style={[styles.section, styles.signOutSection]}>
            <ActionRow icon="log-out-outline" label="Sign Out" onPress={() => logout()} danger />
          </View>

          <Text style={styles.version}>RouteFlow v1.0.0</Text>
        </ScrollView>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surface.raised },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  scroll: { paddingBottom: 40 },
  avatarSection: {
    alignItems: "center",
    paddingVertical: 32,
    backgroundColor: "#fff",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.surface.border,
    marginBottom: 8,
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
  avatarInitials: { fontSize: 26, fontFamily: "Inter_700Bold", color: colors.brand[700] },
  businessName: { fontSize: 20, fontFamily: "Inter_700Bold", color: colors.navy.DEFAULT, marginBottom: 2 },
  contactName: { fontSize: 14, fontFamily: "Inter_400Regular", color: "#64748b" },
  section: {
    backgroundColor: "#fff",
    marginHorizontal: 16,
    marginBottom: 12,
    borderRadius: borderRadius.lg,
    paddingHorizontal: 16,
    paddingVertical: 4,
    ...shadows.card,
  },
  sectionTitle: {
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
    alignItems: "flex-start",
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.surface.border,
    gap: 12,
  },
  infoLabel: { fontSize: 14, fontFamily: "Inter_400Regular", color: "#64748b", flex: 1 },
  infoValue: { fontSize: 14, fontFamily: "Inter_500Medium", color: colors.navy.DEFAULT, flex: 2, textAlign: "right" },
  addressRow: {
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.surface.border,
    gap: 3,
  },
  addressLabelRow: { flexDirection: "row", alignItems: "center", gap: 4, marginBottom: 4 },
  addressLabel: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: "#64748b",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  defaultBadge: { backgroundColor: colors.brand[50], borderRadius: 4, paddingHorizontal: 6, paddingVertical: 1, marginLeft: 4 },
  defaultBadgeText: { fontSize: 11, fontFamily: "Inter_600SemiBold", color: colors.brand[700] },
  addressText: { fontSize: 14, fontFamily: "Inter_400Regular", color: colors.navy.DEFAULT },
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.surface.border,
    gap: 12,
  },
  actionLabel: { flex: 1, fontSize: 15, fontFamily: "Inter_500Medium", color: colors.navy.DEFAULT },
  actionChevron: { marginLeft: "auto" },
  signOutSection: { marginTop: 4 },
  version: { textAlign: "center", fontSize: 12, fontFamily: "Inter_400Regular", color: "#cbd5e1", marginTop: 8 },
});
