import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors, borderRadius, shadows } from "@routeflow/ui/tokens";
import { useAuthStore } from "../../lib/auth-store";

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
        <Ionicons
          name="chevron-forward"
          size={16}
          color="#94a3b8"
          style={styles.chevron}
        />
      )}
    </Pressable>
  );
}

export default function AdminProfileScreen() {
  const { user, logout } = useAuthStore();

  const displayName = user?.username ?? "Admin";
  const initials = displayName
    .split(/[\s._-]/)
    .slice(0, 2)
    .map((w: string) => w[0]?.toUpperCase() ?? "")
    .join("");

  const handleSignOut = async () => {
    await logout();
    // _layout.tsx handles routing to login
  };

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.scroll}
      showsVerticalScrollIndicator={false}
    >
      {/* Avatar + name */}
      <View style={styles.avatarSection}>
        <View style={styles.avatar}>
          <Text style={styles.avatarInitials}>{initials || "A"}</Text>
        </View>
        <Text style={styles.adminName}>{displayName}</Text>
        <View style={styles.roleTag}>
          <Ionicons name="shield-checkmark-outline" size={14} color="#64748b" />
          <Text style={styles.roleText}>Administrator</Text>
        </View>
      </View>

      {/* Account info */}
      <View style={styles.section}>
        <Text style={styles.sectionInnerTitle}>Account</Text>
        <InfoRow label="Username" value={displayName} />
        <InfoRow label="Role" value="Operator / Admin" />
      </View>

      {/* Account actions */}
      <View style={styles.section}>
        <Text style={styles.sectionInnerTitle}>Settings</Text>
        <ActionRow
          icon="lock-closed-outline"
          label="Change Password"
          onPress={() => router.push("/(admin)/change-password")}
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
    backgroundColor: "#dbeafe",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 12,
  },
  avatarInitials: {
    fontSize: 26,
    fontFamily: "Inter_700Bold",
    color: "#1e40af",
  },
  adminName: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
    marginBottom: 6,
  },
  roleTag: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: colors.surface.raised,
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: borderRadius.full,
  },
  roleText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: "#64748b",
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
