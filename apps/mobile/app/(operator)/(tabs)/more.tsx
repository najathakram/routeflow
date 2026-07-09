import { ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { ListGroup, ListRow, NavBar } from "@routeflow/ui/mobile/ios";
import { useAuthStore } from "../../../lib/auth-store";
import { useTenantStore } from "../../../lib/tenant-store";
import { useHasAddon, TOBACCO_ADDON } from "../../../lib/api/tobacco";

export default function OperatorMoreScreen() {
  const router = useRouter();
  const { user, logout } = useAuthStore();
  const tenantName = useTenantStore((s) => s.branding?.businessName);
  const hasTobacco = useHasAddon(TOBACCO_ADDON);

  const initials =
    user?.username
      ?.split(/[._\s]/)
      .filter(Boolean)
      .map((p) => p[0]?.toUpperCase())
      .slice(0, 2)
      .join("") ?? "OP";

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar largeTitle="More" />

      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={styles.identityRow}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{initials}</Text>
          </View>
          <View>
            <Text style={styles.name}>{user?.username ?? "Operator"}</Text>
            <Text style={styles.sub}>Operator{tenantName ? ` · ${tenantName}` : ""}</Text>
          </View>
        </View>

        <ListGroup header="MANAGE">
          <ListRow
            icon={<Ionicons name="wallet-outline" size={16} color={ios.system.orangeInk} />}
            iconBg={ios.system.orangeWash}
            title="Finance"
            subtitle="Vendor bills & expenses"
            onPress={() => router.push("/(operator)/finance")}
            chevron
          />
          <ListRow
            icon={<Ionicons name="business-outline" size={16} color={ios.system.purpleInk} />}
            iconBg={ios.system.purpleWash}
            title="Contacts"
            subtitle="Directory & addresses"
            onPress={() => router.push("/(operator)/customers")}
            chevron
          />
          <ListRow
            icon={<Ionicons name="cube-outline" size={16} color={ios.system.greenInk} />}
            iconBg={ios.system.greenWash}
            title="Products"
            subtitle="Catalog & stock"
            onPress={() => router.push("/(operator)/products")}
            chevron
          />
          <ListRow
            icon={<Ionicons name="document-text-outline" size={16} color={ios.system.orangeInk} />}
            iconBg={ios.system.orangeWash}
            title="Invoices"
            subtitle="Statements & payments"
            onPress={() => router.push("/(operator)/invoices")}
            chevron
          />
          <ListRow
            icon={<Ionicons name="reader-outline" size={16} color={ios.system.purpleInk} />}
            iconBg={ios.system.purpleWash}
            title="Estimates"
            subtitle="Quotes & proposals"
            onPress={() => router.push("/(operator)/estimates")}
            chevron
          />
          <ListRow
            icon={<Ionicons name="cube-outline" size={16} color={ios.brand} />}
            iconBg={ios.brandWash}
            title="Shipments"
            subtitle="Carrier tracking"
            onPress={() => router.push("/(operator)/shipments")}
            chevron
          />
          <ListRow
            icon={<Ionicons name="return-down-back-outline" size={16} color={ios.system.redInk} />}
            iconBg={ios.system.redWash}
            title="Returns"
            subtitle="Approvals & credits"
            onPress={() => router.push("/(operator)/returns")}
            chevron
          />
          <ListRow
            icon={<Ionicons name="cart-outline" size={16} color={ios.system.orangeInk} />}
            iconBg={ios.system.orangeWash}
            title="Purchase Orders"
            subtitle="Restock & receive inventory"
            onPress={() => router.push("/(operator)/purchase-orders")}
            chevron
          />
          <ListRow
            icon={<Ionicons name="receipt-outline" size={16} color={ios.system.greenInk} />}
            iconBg={ios.system.greenWash}
            title="Expenses"
            subtitle="Track business spending"
            onPress={() => router.push("/(operator)/expenses")}
            chevron
          />
          <ListRow
            icon={<Ionicons name="git-branch-outline" size={16} color={ios.brand} />}
            iconBg={ios.brandWash}
            title="Routes"
            subtitle="Templates & stops"
            onPress={() => router.push("/(operator)/routes")}
            chevron
          />
          <ListRow
            icon={<Ionicons name="map-outline" size={16} color={ios.system.purpleInk} />}
            iconBg={ios.system.purpleWash}
            title="Fleet"
            subtitle="Live map & driver tracking"
            onPress={() => router.push("/(operator)/fleet")}
            chevron
          />
          <ListRow
            icon={<Ionicons name="people-outline" size={16} color={ios.system.greenInk} />}
            iconBg={ios.system.greenWash}
            title="Drivers"
            subtitle="Team management"
            onPress={() => router.push("/(operator)/drivers")}
            chevron
          />
        </ListGroup>

        <ListGroup header="WAREHOUSE">
          <ListRow
            icon={<Ionicons name="alert-circle-outline" size={16} color={ios.system.red} />}
            iconBg={ios.system.redWash}
            title="Exceptions"
            subtitle="Urgent orders, late routes, pending returns"
            onPress={() => router.push("/(operator)/exceptions")}
            chevron
          />
          <ListRow
            icon={<Ionicons name="scan-outline" size={16} color={ios.brand} />}
            iconBg={ios.brandWash}
            title="Pick & load"
            subtitle="Warehouse scanning (coming soon)"
            onPress={() => router.push("/(operator)/pick")}
            chevron
          />
        </ListGroup>

        <ListGroup header="INSIGHTS">
          <ListRow
            icon={<Ionicons name="stats-chart-outline" size={16} color={ios.system.purpleInk} />}
            iconBg={ios.system.purpleWash}
            title="Analytics"
            subtitle="Revenue, top items, margins"
            onPress={() => router.push("/(operator)/analytics")}
            chevron
          />
          {hasTobacco ? (
            <ListRow
              icon={<Ionicons name="leaf-outline" size={16} color={ios.system.orangeInk} />}
              iconBg={ios.system.orangeWash}
              title="Tobacco"
              subtitle="Compliance tracking & monthly reports"
              onPress={() => router.push("/(operator)/tobacco")}
              chevron
            />
          ) : null}
          <ListRow
            icon={<Ionicons name="settings-outline" size={16} color={ios.gray[1]} />}
            iconBg={ios.fill3}
            title="Settings"
            subtitle="Business details & notifications"
            onPress={() => router.push("/(operator)/settings")}
            chevron
          />
        </ListGroup>

        <ListGroup header="COMMUNICATION">
          <ListRow
            icon={<Ionicons name="chatbubbles-outline" size={16} color={ios.brand} />}
            iconBg={ios.brandWash}
            title="Messages"
            subtitle="Dispatch & drivers"
            onPress={() => router.push("/(operator)/messages")}
            chevron
          />
        </ListGroup>

        <ListGroup header="ACCOUNT">
          <ListRow
            icon={<Ionicons name="person-outline" size={16} color={ios.system.purpleInk} />}
            iconBg={ios.system.purpleWash}
            title="Profile"
            onPress={() => router.push("/(operator)/profile")}
            chevron
          />
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
