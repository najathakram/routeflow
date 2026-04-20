import { ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import {
  ListGroup,
  ListRow,
  NavBackButton,
  NavBar,
} from "@routeflow/ui/mobile/ios";
import { useAuthStore } from "../../lib/auth-store";

export default function OperatorProfileScreen() {
  const router = useRouter();
  const { user, logout } = useAuthStore();
  const displayName = user?.username ?? "Operator";
  const initials =
    displayName
      .split(/[\s._-]/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? "")
      .join("") || "O";

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Profile"
        leading={<NavBackButton label="More" onPress={() => router.back()} />}
      />
      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={styles.avatarBlock}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{initials}</Text>
          </View>
          <Text style={styles.name}>{displayName}</Text>
          <Text style={styles.role}>Operator · North Depot</Text>
        </View>

        <ListGroup header="ACCOUNT">
          <ListRow title="Username" value={displayName} />
          <ListRow title="Role" value={user?.role ?? "Operator"} />
        </ListGroup>

        <ListGroup header="SETTINGS">
          <ListRow
            icon={<Ionicons name="key-outline" size={16} color={ios.gray[1]} />}
            iconBg={ios.fill3}
            title="Change password"
            onPress={() => router.push("/(operator)/change-password")}
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

        <Text style={styles.version}>RouteFlow v1.0.0</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  avatarBlock: {
    alignItems: "center",
    paddingVertical: 28,
    backgroundColor: ios.bgElev,
    marginBottom: 16,
  },
  avatar: {
    width: 72,
    height: 72,
    borderRadius: 999,
    backgroundColor: ios.brandWash,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 10,
  },
  avatarText: { color: ios.brand, fontSize: 22, fontFamily: "Inter_700Bold" },
  name: { fontSize: 22, fontFamily: "Inter_700Bold", color: ios.label },
  role: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.label2, marginTop: 4 },
  version: {
    textAlign: "center",
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: ios.label3,
    marginTop: 8,
  },
});
