import { ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { ListGroup, ListRow, NavBar } from "@routeflow/ui/mobile/ios";
import { useAuthStore } from "../../lib/auth-store";
import { useTenantStore } from "../../lib/tenant-store";

export default function DriverMoreScreen() {
  const router = useRouter();
  const { user, logout, setActiveRole } = useAuthStore();
  const tenantName = useTenantStore((s) => s.branding?.businessName);

  const initials =
    user?.username
      ?.split(/[._\s]/)
      .filter(Boolean)
      .map((p) => p[0]?.toUpperCase())
      .slice(0, 2)
      .join("") ?? "??";

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar largeTitle="More" />

      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={styles.identityRow}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{initials}</Text>
          </View>
          <View>
            <Text style={styles.name}>{user?.username ?? "Driver"}</Text>
            <Text style={styles.sub}>Driver{tenantName ? ` · ${tenantName}` : ""}</Text>
          </View>
        </View>

        <ListGroup header="COMMUNICATION">
          <ListRow
            icon={<Ionicons name="chatbubbles-outline" size={16} color={ios.brand} />}
            iconBg={ios.brandWash}
            title="Messages"
            subtitle="Dispatch & drivers"
            onPress={() => router.push("/(driver)/driver-messages")}
            chevron
          />
        </ListGroup>

        <ListGroup header="ACCOUNT">
          <ListRow
            icon={<Ionicons name="person-outline" size={16} color={ios.system.purpleInk} />}
            iconBg={ios.system.purpleWash}
            title="Profile"
            onPress={() => router.push("/(driver)/driver-profile")}
            chevron
          />
          <ListRow
            icon={<Ionicons name="key-outline" size={16} color={ios.gray[1]} />}
            iconBg={ios.fill3}
            title="Change password"
            onPress={() => router.push("/(driver)/driver-change-password")}
            chevron
          />
          <ListRow
            icon={
              <Ionicons name="swap-horizontal-outline" size={16} color={ios.system.orangeInk} />
            }
            iconBg={ios.system.orangeWash}
            title="Switch role"
            subtitle="Go to operator view"
            onPress={() => {
              setActiveRole("operator");
              router.replace("/(operator)/home");
            }}
            chevron
          />
        </ListGroup>

        <ListGroup>
          <ListRow
            icon={<Ionicons name="log-out-outline" size={16} color={ios.system.red} />}
            iconBg={ios.system.redWash}
            title="Sign out"
            onPress={() => logout()}
          />
        </ListGroup>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  identityRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  avatar: {
    width: 52,
    height: 52,
    borderRadius: 999,
    backgroundColor: ios.brand,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: "#fff", fontSize: 18, fontFamily: "Inter_700Bold" },
  name: {
    fontSize: 20,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    letterSpacing: -0.3,
  },
  sub: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label2 },
});
