import { ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { ListGroup, ListRow, NavBar } from "@routeflow/ui/mobile/ios";
import { useAuthStore } from "../../../lib/auth-store";
import { useTenantStore } from "../../../lib/tenant-store";
import { useDeliveryAccess, useDeveloperMode, useRoutesAccess } from "../../../lib/api/addons";
import { usePlanFlag } from "../../../lib/api/billing";
import { planFlagVisible } from "../../../lib/plan-flags";

export default function OperatorMoreScreen() {
  const router = useRouter();
  const { user, logout, setActiveRole } = useAuthStore();
  const tenantName = useTenantStore((s) => s.branding?.businessName);
  // Owner split 2026-08-25: the MANAGE rows below mirror (operator)/_layout.tsx's
  // section sets, so a tenant that bought only one addon still reaches its own
  // surfaces — Routes/Fleet are recurring-routes screens, Drivers is shared by
  // both features (EITHER_SECTIONS). Owner decision 2026-08-28: the helpers no
  // longer fold in developer_mode — these rows follow the feature addons alone.
  const routesAccess = useRoutesAccess();
  const deliveryAccess = useDeliveryAccess();
  const driversAccess = routesAccess.enabled || deliveryAccess.enabled;
  // Drive mode keeps the RAW dev switch: the (driver) app is still gated on
  // developer_mode in app/_layout.tsx, so widening this row would hand an
  // addon-only operator a button that bounces them straight back.
  const { enabled: devMode } = useDeveloperMode();
  // Lite-L2 (WP12/R4.4): rows for a plan-gated section are wrapped in planFlagVisible —
  // same three-valued rule as the web sidebar (lib/plan-flags.ts).
  const estimatesVisible = planFlagVisible(usePlanFlag("flag.estimates"));
  const recurringInvoicesVisible = planFlagVisible(usePlanFlag("flag.recurring_invoices"));
  const creditNotesVisible = planFlagVisible(usePlanFlag("flag.credit_notes"));
  const returnsVisible = planFlagVisible(usePlanFlag("flag.returns"));
  const analyticsVisible = planFlagVisible(usePlanFlag("flag.analytics"));
  const reportsVisible = planFlagVisible(usePlanFlag("flag.reports"));
  const messagingVisible = planFlagVisible(usePlanFlag("flag.messaging"));

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
            icon={<Ionicons name="repeat-outline" size={16} color={ios.brand} />}
            iconBg={ios.brandWash}
            title="Order Templates"
            subtitle="Standing orders & auto-generation"
            onPress={() => router.push("/(operator)/order-templates")}
            chevron
          />
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
            icon={<Ionicons name="shield-checkmark-outline" size={16} color={ios.brand} />}
            iconBg={ios.brandWash}
            title="Regulated"
            subtitle="Tax, licensing & subcategories"
            onPress={() => router.push("/(operator)/regulated")}
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
            icon={<Ionicons name="card-outline" size={16} color={ios.system.greenInk} />}
            iconBg={ios.system.greenWash}
            title="Payments"
            subtitle="Receipts across all invoices"
            onPress={() => router.push("/(operator)/payments")}
            chevron
          />
          {recurringInvoicesVisible ? (
            <ListRow
              icon={<Ionicons name="repeat-outline" size={16} color={ios.system.orangeInk} />}
              iconBg={ios.system.orangeWash}
              title="Recurring Invoices"
              subtitle="Scheduled auto-billing"
              onPress={() => router.push("/(operator)/recurring-invoices")}
              chevron
            />
          ) : null}
          {estimatesVisible ? (
            <ListRow
              icon={<Ionicons name="reader-outline" size={16} color={ios.system.purpleInk} />}
              iconBg={ios.system.purpleWash}
              title="Estimates"
              subtitle="Quotes & proposals"
              onPress={() => router.push("/(operator)/estimates")}
              chevron
            />
          ) : null}
          {creditNotesVisible ? (
            <ListRow
              icon={<Ionicons name="cash-outline" size={16} color={ios.system.greenInk} />}
              iconBg={ios.system.greenWash}
              title="Credit Notes"
              subtitle="Refunds & adjustments"
              onPress={() => router.push("/(operator)/credit-notes")}
              chevron
            />
          ) : null}
          <ListRow
            icon={<Ionicons name="cube-outline" size={16} color={ios.brand} />}
            iconBg={ios.brandWash}
            title="Shipments"
            subtitle="Carrier tracking"
            onPress={() => router.push("/(operator)/shipments")}
            chevron
          />
          {returnsVisible ? (
            <ListRow
              icon={
                <Ionicons name="return-down-back-outline" size={16} color={ios.system.redInk} />
              }
              iconBg={ios.system.redWash}
              title="Returns"
              subtitle="Approvals & credits"
              onPress={() => router.push("/(operator)/returns")}
              chevron
            />
          ) : null}
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
          {routesAccess.enabled ? (
            <ListRow
              icon={<Ionicons name="git-branch-outline" size={16} color={ios.brand} />}
              iconBg={ios.brandWash}
              title="Routes"
              subtitle="Templates & stops"
              onPress={() => router.push("/(operator)/routes")}
              chevron
            />
          ) : null}
          {routesAccess.enabled ? (
            <ListRow
              icon={<Ionicons name="map-outline" size={16} color={ios.system.purpleInk} />}
              iconBg={ios.system.purpleWash}
              title="Fleet"
              subtitle="Live map & driver tracking"
              onPress={() => router.push("/(operator)/fleet")}
              chevron
            />
          ) : null}
          {driversAccess ? (
            <ListRow
              icon={<Ionicons name="people-outline" size={16} color={ios.system.greenInk} />}
              iconBg={ios.system.greenWash}
              title="Drivers"
              subtitle="Team management"
              onPress={() => router.push("/(operator)/drivers")}
              chevron
            />
          ) : null}
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
          {analyticsVisible ? (
            <ListRow
              icon={<Ionicons name="stats-chart-outline" size={16} color={ios.system.purpleInk} />}
              iconBg={ios.system.purpleWash}
              title="Analytics"
              subtitle="Revenue, top items, margins"
              onPress={() => router.push("/(operator)/analytics")}
              chevron
            />
          ) : null}
          {reportsVisible ? (
            <ListRow
              icon={<Ionicons name="document-text-outline" size={16} color={ios.brand} />}
              iconBg={ios.brandWash}
              title="Reports"
              subtitle="P&L, sales, AR aging, cash flow"
              onPress={() => router.push("/(operator)/reports")}
              chevron
            />
          ) : null}
          <ListRow
            icon={<Ionicons name="shield-checkmark-outline" size={16} color={ios.brand} />}
            iconBg={ios.brandWash}
            title="Regulated Items"
            subtitle="Sections, tax rollup & filings"
            onPress={() => router.push("/(operator)/compliance")}
            chevron
          />
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
          {messagingVisible ? (
            <ListRow
              icon={<Ionicons name="chatbubbles-outline" size={16} color={ios.brand} />}
              iconBg={ios.brandWash}
              title="Messages"
              subtitle="Dispatch & drivers"
              onPress={() => router.push("/(operator)/messages")}
              chevron
            />
          ) : null}
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
          {devMode && user?.canActAsDriver ? (
            <ListRow
              icon={<Ionicons name="car-outline" size={16} color={ios.system.orangeInk} />}
              iconBg={ios.system.orangeWash}
              title="Drive mode"
              subtitle="Switch to the field layout"
              onPress={() => {
                setActiveRole("driver");
                router.replace("/(driver)/route");
              }}
              chevron
            />
          ) : null}
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
