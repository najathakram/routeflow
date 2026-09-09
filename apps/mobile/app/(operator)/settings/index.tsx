/**
 * RF-090 + RF-213: Settings screen with four tabs —
 *   General | Users | Branding | Integrations
 */
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { ios } from "@routeflow/ui/tokens";
import { NavBackButton, NavBar, Pill } from "@routeflow/ui/mobile/ios";
import { FormField, FormSection, FormTextInput } from "../../../components/FormSheet";
import {
  useAdminUsers,
  useBusinessSettings,
  useToggleUserStatus,
  useUpdateBusinessSettings,
  type AppUser,
} from "../../../lib/api/admin";
import {
  getPushEnabled,
  setPushEnabled as persistPushEnabled,
} from "../../../lib/notification-prefs";
import { registerPushToken, deregisterPushToken } from "../../../lib/auth";
import { showToast } from "../../../lib/toast";
import { alertInfo } from "../../../lib/confirm";

// ─── General tab ──────────────────────────────────────────────────────────────

function GeneralTab() {
  const { data, isLoading } = useBusinessSettings();
  const update = useUpdateBusinessSettings();

  const [phone, setPhone] = useState("");
  const [taxRate, setTaxRate] = useState("");
  const [city, setCity] = useState("");
  const [zip, setZip] = useState("");
  // B04: defaults ON — matches the server's opt-out semantics
  // (notification-prefs.ts / NotificationsService treat a missing/unread
  // preference as enabled) — and is immediately overwritten by the
  // preference fetch below once it resolves. `pushPrefLoading` disables the
  // switch until then so a tap can't race the fetch.
  const [pushEnabled, setPushEnabled] = useState(true);
  const [pushPrefLoading, setPushPrefLoading] = useState(true);

  useEffect(() => {
    if (data) {
      setPhone(data.phone ?? "");
      setTaxRate(data.taxRate != null ? String(data.taxRate) : "");
      setCity(data.city ?? "");
      setZip(data.zip ?? "");
    }
  }, [data]);

  useEffect(() => {
    let cancelled = false;
    getPushEnabled()
      .then((enabled) => {
        if (!cancelled) setPushEnabled(enabled);
      })
      .catch(() => {
        // REG-B04-A: fails OPEN — keep the ON default rather than blocking
        // the tab or flipping the switch to a false "disabled" read.
        if (!cancelled) setPushEnabled(true);
      })
      .finally(() => {
        if (!cancelled) setPushPrefLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={ios.brand} />
      </View>
    );
  }

  const save = () => {
    update.mutate(
      {
        phone: phone.trim() || undefined,
        city: city.trim() || undefined,
        zip: zip.trim() || undefined,
        taxRate: taxRate.trim() ? Number(taxRate) : undefined,
      },
      {
        onSuccess: () => showToast("Settings saved"),
        onError: (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
      },
    );
  };

  return (
    <ScrollView showsVerticalScrollIndicator={false}>
      <View style={{ padding: 16, gap: 18 }}>
        <View style={styles.identity}>
          <Text style={styles.identityName}>{data?.businessName ?? "Business"}</Text>
          <Text style={styles.identitySub}>{data?.email ?? ""}</Text>
        </View>

        <FormSection title="Contact">
          <FormField label="Phone">
            <FormTextInput value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
          </FormField>
        </FormSection>

        <FormSection title="Address">
          <FormField label="City">
            <FormTextInput value={city} onChangeText={setCity} />
          </FormField>
          <FormField label="ZIP">
            <FormTextInput value={zip} onChangeText={setZip} keyboardType="number-pad" />
          </FormField>
        </FormSection>

        <FormSection title="Invoicing">
          {/* A PERCENT (0-100), matching web's settings validation (z.number().max(100))
              and every consumer's `taxRate / 100`. The old "(e.g. 0.0875)" hint told
              owners to store a FRACTION, which web would then divide again. */}
          <FormField label="Default tax rate (%, e.g. 8.75)">
            <FormTextInput value={taxRate} onChangeText={setTaxRate} keyboardType="decimal-pad" />
          </FormField>
        </FormSection>

        <FormSection title="Notifications">
          <View style={styles.switchRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.switchLabel}>Push notifications</Text>
              <Text style={styles.switchHint}>
                Get alerted on new orders, exceptions, and route updates.
              </Text>
            </View>
            <Switch
              value={pushEnabled}
              disabled={pushPrefLoading}
              onValueChange={(v) => {
                setPushEnabled(v);
                // REG-B04-A: write the preference first, then (de)register
                // this device immediately rather than waiting for the next
                // login — toggle-on registers the token now, toggle-off
                // deletes it via the same deregister path `logout()` uses.
                persistPushEnabled(v)
                  .then(() => (v ? registerPushToken() : deregisterPushToken()))
                  .catch(() => {
                    // Best-effort — the server is still the authoritative gate
                    // (registration/send both re-check the preference), so a
                    // dropped write here degrades to "try again next toggle",
                    // never to "silently stays on".
                  });
                alertInfo(
                  v ? "Push enabled" : "Push disabled",
                  v
                    ? "We'll register this device with the push service."
                    : "Notifications won't be delivered to this device.",
                );
              }}
              trackColor={{ true: ios.brand }}
            />
          </View>
        </FormSection>

        <Pressable
          style={[styles.saveBtn, update.isPending && { opacity: 0.5 }]}
          onPress={save}
          disabled={update.isPending}
        >
          <Ionicons name="save-outline" size={16} color="#fff" />
          <Text style={styles.saveBtnText}>{update.isPending ? "Saving…" : "Save changes"}</Text>
        </Pressable>
      </View>
      <View style={{ height: 24 }} />
    </ScrollView>
  );
}

// ─── Users tab (RF-090) ───────────────────────────────────────────────────────

function rolePill(role: string) {
  switch (role) {
    case "OPERATOR":
      return <Pill variant="brand">Operator</Pill>;
    case "DRIVER":
      return <Pill variant="green">Driver</Pill>;
    case "CUSTOMER":
      return <Pill variant="orange">Buyer</Pill>;
    default:
      return <Pill variant="gray">{role.toLowerCase()}</Pill>;
  }
}

function UsersTab() {
  const { data: usersPage, isLoading, refetch } = useAdminUsers();
  const toggleMut = useToggleUserStatus();

  const handleToggle = (user: AppUser) => {
    toggleMut.mutate(
      { id: user.id, isActive: !user.isActive },
      {
        onSuccess: () => {
          showToast(user.isActive ? "User deactivated" : "User activated");
          refetch();
        },
        onError: (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
      },
    );
  };

  if (isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={ios.brand} />
      </View>
    );
  }

  // API returns { data: AppUser[], meta: {...} } — unwrap the array.
  const list: AppUser[] = Array.isArray(usersPage?.data) ? usersPage.data : [];

  return (
    <ScrollView showsVerticalScrollIndicator={false}>
      <View style={{ padding: 16, gap: 8 }}>
        {list.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.empty}>No users found.</Text>
          </View>
        ) : (
          list.map((u) => (
            <View key={u.id} style={styles.userRow}>
              <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <Text style={styles.userName} numberOfLines={1}>
                    {u.firstName || u.lastName
                      ? `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim()
                      : u.username}
                  </Text>
                  {rolePill(u.role)}
                  {!u.isActive ? <Pill variant="gray">Inactive</Pill> : null}
                </View>
                <Text style={styles.userSub} numberOfLines={1}>
                  @{u.username}
                  {u.email ? ` · ${u.email}` : ""}
                </Text>
              </View>
              <Pressable
                style={[styles.toggleBtn, !u.isActive && styles.toggleBtnActive]}
                onPress={() => handleToggle(u)}
                disabled={toggleMut.isPending}
              >
                <Text style={[styles.toggleBtnText, !u.isActive && styles.toggleBtnTextActive]}>
                  {u.isActive ? "Deactivate" : "Activate"}
                </Text>
              </Pressable>
            </View>
          ))
        )}
      </View>
      <View style={{ height: 24 }} />
    </ScrollView>
  );
}

// ─── Branding tab (RF-213) ────────────────────────────────────────────────────

function BrandingTab() {
  return (
    <ScrollView showsVerticalScrollIndicator={false}>
      <View style={{ padding: 16, gap: 16 }}>
        <View style={styles.infoCard}>
          <Ionicons name="color-palette-outline" size={32} color={ios.brand} />
          <Text style={styles.infoTitle}>Branding</Text>
          <Text style={styles.infoBody}>
            Logo uploads and custom brand colours are configured in the operator web portal. Open
            the web dashboard to set your logo and primary colour — changes apply across the mobile
            app automatically.
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Coming soon on mobile</Text>
          <View style={styles.comingSoonRow}>
            <Ionicons name="image-outline" size={18} color={ios.label2} />
            <Text style={styles.comingSoonText}>Logo upload</Text>
          </View>
          <View style={styles.comingSoonRow}>
            <Ionicons name="brush-outline" size={18} color={ios.label2} />
            <Text style={styles.comingSoonText}>Brand colour picker</Text>
          </View>
          <View style={styles.comingSoonRow}>
            <Ionicons name="document-text-outline" size={18} color={ios.label2} />
            <Text style={styles.comingSoonText}>Invoice header / footer</Text>
          </View>
        </View>
      </View>
      <View style={{ height: 24 }} />
    </ScrollView>
  );
}

// ─── Integrations tab (RF-213) ────────────────────────────────────────────────

const INTEGRATIONS = [
  { name: "Xero", icon: "receipt-outline" as const, desc: "Sync invoices & payments" },
  { name: "QuickBooks", icon: "calculator-outline" as const, desc: "Export accounting data" },
  { name: "Stripe", icon: "card-outline" as const, desc: "Online payment collection" },
  { name: "Shopify", icon: "storefront-outline" as const, desc: "Import e-commerce orders" },
  { name: "Google Maps API", icon: "map-outline" as const, desc: "Route optimisation" },
  { name: "Twilio SMS", icon: "chatbubble-outline" as const, desc: "Customer delivery alerts" },
];

function IntegrationsTab() {
  return (
    <ScrollView showsVerticalScrollIndicator={false}>
      <View style={{ padding: 16, gap: 8 }}>
        <View style={styles.infoCard}>
          <Ionicons name="link-outline" size={32} color={ios.brand} />
          <Text style={styles.infoTitle}>Integrations</Text>
          <Text style={styles.infoBody}>
            Connect your RouteFlow account with third-party services. All integrations are
            configured in the web dashboard.
          </Text>
        </View>
        {INTEGRATIONS.map((it) => (
          <View key={it.name} style={styles.integrationRow}>
            <View style={styles.integrationIcon}>
              <Ionicons name={it.icon} size={18} color={ios.brand} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.integrationName}>{it.name}</Text>
              <Text style={styles.integrationDesc} numberOfLines={1}>
                {it.desc}
              </Text>
            </View>
            <View style={styles.comingSoonBadge}>
              <Text style={styles.comingSoonBadgeText}>Coming soon</Text>
            </View>
          </View>
        ))}
      </View>
      <View style={{ height: 24 }} />
    </ScrollView>
  );
}

// ─── Root screen ──────────────────────────────────────────────────────────────

const TABS = ["General", "Users", "Branding", "Integrations"] as const;
type TabName = (typeof TABS)[number];

export default function SettingsScreen() {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<TabName>("General");

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        largeTitle="Settings"
        leading={<NavBackButton label="Back" onPress={() => router.back()} />}
      />
      {/* Tab bar — scrollable horizontal chip strip */}
      <View style={styles.tabBar}>
        {TABS.map((t) => (
          <Pressable
            key={t}
            style={[styles.tabChip, activeTab === t && styles.tabChipActive]}
            onPress={() => setActiveTab(t)}
          >
            <Text style={[styles.tabChipText, activeTab === t && styles.tabChipTextActive]}>
              {t}
            </Text>
          </Pressable>
        ))}
      </View>
      {activeTab === "General" && <GeneralTab />}
      {activeTab === "Users" && <UsersTab />}
      {activeTab === "Branding" && <BrandingTab />}
      {activeTab === "Integrations" && <IntegrationsTab />}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center" },
  empty: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label2 },

  // General tab
  identity: { backgroundColor: ios.bgElev, borderRadius: 14, padding: 16 },
  identityName: { fontSize: 18, fontFamily: "Inter_700Bold", color: ios.label },
  identitySub: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  switchRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  switchLabel: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },
  switchHint: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  saveBtn: {
    backgroundColor: ios.brand,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 14,
    borderRadius: 12,
  },
  saveBtnText: { color: "#fff", fontSize: 15, fontFamily: "Inter_600SemiBold" },

  // Users tab
  userRow: {
    backgroundColor: ios.bgElev,
    borderRadius: 12,
    padding: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  userName: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },
  userSub: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2 },
  toggleBtn: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
    backgroundColor: ios.fill3,
  },
  toggleBtnActive: { backgroundColor: ios.brandWash },
  toggleBtnText: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.label },
  toggleBtnTextActive: { color: ios.brand },

  // Branding / Integrations shared
  infoCard: {
    backgroundColor: ios.bgElev,
    borderRadius: 14,
    padding: 20,
    alignItems: "center",
    gap: 10,
  },
  infoTitle: { fontSize: 18, fontFamily: "Inter_700Bold", color: ios.label },
  infoBody: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    textAlign: "center",
    lineHeight: 20,
  },
  card: { backgroundColor: ios.bgElev, borderRadius: 14, padding: 14, gap: 12 },
  cardTitle: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },
  comingSoonRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  comingSoonText: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label2 },

  // Integration rows
  integrationRow: {
    backgroundColor: ios.bgElev,
    borderRadius: 12,
    padding: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  integrationIcon: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: ios.brandWash,
    alignItems: "center",
    justifyContent: "center",
  },
  integrationName: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },
  integrationDesc: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    marginTop: 2,
  },
  comingSoonBadge: {
    backgroundColor: ios.fill3,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  comingSoonBadgeText: { fontSize: 11, fontFamily: "Inter_500Medium", color: ios.label2 },

  // Tab bar
  tabBar: {
    flexDirection: "row",
    paddingHorizontal: 16,
    paddingBottom: 8,
    gap: 8,
  },
  tabChip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: ios.fill3,
  },
  tabChipActive: { backgroundColor: ios.brand },
  tabChipText: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.label },
  tabChipTextActive: { color: "#fff", fontFamily: "Inter_600SemiBold" },
});
