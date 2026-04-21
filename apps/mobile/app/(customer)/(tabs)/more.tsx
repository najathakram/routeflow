import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavBar } from "@routeflow/ui/mobile/ios";
import { useBuyerSessionStore } from "../../../lib/buyer-session-store";
import { useBuyerProfile } from "../../../lib/api/buyer";

export default function CustomerMoreScreen() {
  const router = useRouter();
  const { buyer, activeSeller, signOut } = useBuyerSessionStore();
  const { data: profile } = useBuyerProfile();

  const onSignOut = () =>
    Alert.alert("Sign out?", "You'll need to log in again.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Sign out",
        style: "destructive",
        onPress: async () => {
          await signOut();
          router.replace("/(auth)/customer-login");
        },
      },
    ]);

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar inlineTitle="More" />

      <ScrollView showsVerticalScrollIndicator={false}>
        {/* Account card */}
        <View style={styles.accountCard}>
          <View style={styles.avatar}>
            <Ionicons name="person" size={28} color={ios.brand} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.accountName} numberOfLines={1}>
              {profile?.businessName ?? buyer?.name ?? buyer?.email ?? "Customer"}
            </Text>
            <Text style={styles.accountEmail} numberOfLines={1}>{buyer?.email}</Text>
            {activeSeller ? (
              <Text style={styles.accountSeller} numberOfLines={1}>
                {activeSeller.tenant.name}
              </Text>
            ) : null}
          </View>
        </View>

        {/* ACCOUNT group */}
        <View style={styles.group}>
          <Text style={styles.groupHeader}>ACCOUNT</Text>
          <View style={styles.groupCard}>
            <MenuRow
              icon={<Ionicons name="receipt-outline" size={16} color={ios.brand} />}
              iconBg={ios.brandWash}
              title="My Orders"
              onPress={() => router.push("/(customer)/(tabs)/orders")}
            />
            <MenuRow
              icon={<Ionicons name="document-text-outline" size={16} color={ios.system.purpleInk} />}
              iconBg={ios.system.purpleWash}
              title="Invoices"
              onPress={() => router.push("/(customer)/(tabs)/invoices")}
            />
            <MenuRow
              icon={<Ionicons name="refresh-outline" size={16} color={ios.system.orangeInk} />}
              iconBg={ios.system.orangeWash}
              title="Standing Orders"
              onPress={() => router.push("/(customer)/standing-orders")}
              last
            />
          </View>
        </View>

        {/* SETTINGS group */}
        <View style={styles.group}>
          <Text style={styles.groupHeader}>SETTINGS</Text>
          <View style={styles.groupCard}>
            <MenuRow
              icon={<Ionicons name="person-outline" size={16} color={ios.system.greenInk} />}
              iconBg={ios.system.greenWash}
              title="Profile"
              subtitle={profile?.email ?? buyer?.email}
              onPress={() => router.push("/(customer)/profile")}
            />
            <MenuRow
              icon={<Ionicons name="lock-closed-outline" size={16} color={ios.label2} />}
              iconBg={ios.fill3}
              title="Change Password"
              onPress={() => router.push("/(customer)/change-password")}
              last
            />
          </View>
        </View>

        {/* Sign out */}
        <View style={{ paddingHorizontal: 16, marginTop: 8 }}>
          <Pressable style={styles.signOutBtn} onPress={onSignOut}>
            <Text style={styles.signOutText}>Sign out</Text>
          </Pressable>
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

function MenuRow({
  icon,
  iconBg,
  title,
  subtitle,
  onPress,
  last,
}: {
  icon: React.ReactNode;
  iconBg: string;
  title: string;
  subtitle?: string;
  onPress: () => void;
  last?: boolean;
}) {
  return (
    <Pressable
      style={[styles.menuRow, !last && styles.menuRowBorder]}
      onPress={onPress}
    >
      <View style={[styles.menuIcon, { backgroundColor: iconBg }]}>{icon}</View>
      <View style={{ flex: 1 }}>
        <Text style={styles.menuTitle}>{title}</Text>
        {subtitle ? (
          <Text style={styles.menuSub} numberOfLines={1}>{subtitle}</Text>
        ) : null}
      </View>
      <Ionicons name="chevron-forward" size={16} color={ios.gray[3]} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  accountCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    margin: 16,
    backgroundColor: ios.bgElev,
    borderRadius: 16,
    padding: 16,
  },
  avatar: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: ios.brandWash,
    alignItems: "center",
    justifyContent: "center",
  },
  accountName: { fontSize: 17, fontFamily: "Inter_700Bold", color: ios.label, letterSpacing: -0.3 },
  accountEmail: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  accountSeller: { fontSize: 12, fontFamily: "Inter_500Medium", color: ios.brand, marginTop: 3 },
  group: { paddingHorizontal: 16, marginBottom: 16 },
  groupHeader: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    letterSpacing: 0.6,
    textTransform: "uppercase",
    marginBottom: 8,
    paddingLeft: 4,
  },
  groupCard: { backgroundColor: ios.bgElev, borderRadius: 14, overflow: "hidden" },
  menuRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 12,
  },
  menuRowBorder: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: ios.separator,
  },
  menuIcon: { width: 32, height: 32, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  menuTitle: { fontSize: 15, fontFamily: "Inter_500Medium", color: ios.label },
  menuSub: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 1 },
  signOutBtn: {
    backgroundColor: ios.fill3,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: "center",
  },
  signOutText: { color: ios.system.redInk, fontSize: 15, fontFamily: "Inter_500Medium" },
});
