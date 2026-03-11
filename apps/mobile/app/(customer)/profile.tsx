import {
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

// Mock customer profile — in production this would come from an API
const MOCK_PROFILE = {
  businessName: "Sunrise Café",
  contactName: "Jamie Nguyen",
  email: "jamie@sunrisecafe.com.au",
  phone: "+61 2 9876 5432",
  address: "14 Harbour St, Sydney NSW 2000",
};

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
        size={20}
        color={danger ? colors.danger.DEFAULT : colors.navy.DEFAULT}
      />
      <Text
        style={[styles.actionLabel, danger && { color: colors.danger.DEFAULT }]}
      >
        {label}
      </Text>
      {!danger ? (
        <Ionicons
          name="chevron-forward"
          size={16}
          color="#94a3b8"
          style={styles.actionChevron}
        />
      ) : null}
    </Pressable>
  );
}

export default function ProfileScreen() {
  const logout = useAuthStore((s) => s.logout);

  const handleSignOut = async () => {
    await logout();
    // _layout.tsx handles routing to login
  };

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
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        {/* Avatar + business name */}
        <View style={styles.avatarSection}>
          <View style={styles.avatar}>
            <Text style={styles.avatarInitials}>
              {MOCK_PROFILE.businessName
                .split(" ")
                .slice(0, 2)
                .map((w) => w[0])
                .join("")}
            </Text>
          </View>
          <Text style={styles.businessName}>{MOCK_PROFILE.businessName}</Text>
          <Text style={styles.contactName}>{MOCK_PROFILE.contactName}</Text>
        </View>

        {/* Business info */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Business Info</Text>
          <InfoRow label="Business Name" value={MOCK_PROFILE.businessName} />
          <InfoRow label="Contact Name" value={MOCK_PROFILE.contactName} />
          <InfoRow label="Email" value={MOCK_PROFILE.email} />
          <InfoRow label="Phone" value={MOCK_PROFILE.phone} />
          <InfoRow label="Address" value={MOCK_PROFILE.address} />
        </View>

        {/* Account actions */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Account</Text>
          <ActionRow
            icon="lock-closed-outline"
            label="Change Password"
            onPress={() => router.push("/(customer)/change-password")}
          />
        </View>

        {/* Sign out */}
        <View style={[styles.section, styles.signOutSection]}>
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
  avatarInitials: {
    fontSize: 26,
    fontFamily: "Inter_700Bold",
    color: colors.brand[700],
  },
  businessName: {
    fontSize: 20,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
    marginBottom: 2,
  },
  contactName: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
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
  infoLabel: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
    flex: 1,
  },
  infoValue: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: colors.navy.DEFAULT,
    flex: 2,
    textAlign: "right",
  },
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.surface.border,
    gap: 12,
  },
  actionLabel: {
    flex: 1,
    fontSize: 15,
    fontFamily: "Inter_500Medium",
    color: colors.navy.DEFAULT,
  },
  actionChevron: {
    marginLeft: "auto",
  },
  signOutSection: {
    marginTop: 4,
  },
  version: {
    textAlign: "center",
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: "#cbd5e1",
    marginTop: 8,
  },
});
