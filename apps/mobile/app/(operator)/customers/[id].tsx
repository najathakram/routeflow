import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavAction, NavBackButton, NavBar, Pill } from "@routeflow/ui/mobile/ios";
import {
  useCustomer,
  useCustomerStatement,
  useDeleteCustomer,
} from "../../../lib/api/customers";
import { openInMaps } from "../../../components/openInMaps";
import { showToast } from "../../../lib/toast";
import { confirm } from "../../../lib/confirm";

function fmt(n: number | string | null | undefined): string {
  const v = n == null ? 0 : typeof n === "string" ? Number(n) : n;
  return `$${(Number.isFinite(v) ? v : 0).toFixed(2)}`;
}

export default function CustomerDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: customer, isLoading } = useCustomer(id ?? "");
  const { data: statement } = useCustomerStatement(id ?? "");
  const deleteMut = useDeleteCustomer();

  if (isLoading || !customer) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar inlineTitle="Customer" leading={<NavBackButton onPress={() => router.back()} />} />
        <View style={styles.center}>
          <ActivityIndicator color={ios.brand} />
        </View>
      </SafeAreaView>
    );
  }

  const primaryAddress = customer.addresses?.find((a) => a.isDefault) ?? customer.addresses?.[0];

  const handleDelete = () => {
    if (!id) return;
    confirm(
      "Delete customer?",
      `${customer.businessName} will be removed. This is permanent.`,
      () =>
        deleteMut.mutate(id, {
          onSuccess: () => {
            showToast("Customer deleted");
            router.back();
          },
          onError: (e: unknown) => {
            const err = e as { response?: { data?: { message?: string } }; message?: string };
            showToast(err?.response?.data?.message ?? err?.message ?? "Try again.");
          },
        }),
      { confirmText: "Delete", destructive: true },
    );
  };

  const addressLine = primaryAddress
    ? [primaryAddress.line1, primaryAddress.line2, primaryAddress.city, primaryAddress.state, primaryAddress.zip]
        .filter(Boolean)
        .join(", ")
    : undefined;

  const tier = customer.pricingTier ?? 1;
  const creditLimit = customer.creditLimit != null ? Number(customer.creditLimit) : null;

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle={customer.businessName}
        leading={<NavBackButton label="Customers" onPress={() => router.back()} />}
        trailing={
          <NavAction
            label="Edit"
            bold
            onPress={() => router.push(`/(operator)/customers/${id}/edit`)}
          />
        }
      />

      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={{ padding: 16, gap: 14 }}>
          {/* Identity card */}
          <View style={styles.card}>
            <Text style={styles.name}>{customer.businessName}</Text>
            {customer.contactName ? (
              <Text style={styles.contact}>{customer.contactName}</Text>
            ) : null}
            {customer.tagAssignments && customer.tagAssignments.length > 0 ? (
              <View style={styles.tagRow}>
                {customer.tagAssignments.map(({ tag }) => (
                  <View key={tag.id} style={styles.tag}>
                    <Text style={styles.tagText}>{tag.name}</Text>
                  </View>
                ))}
              </View>
            ) : null}
            <View style={styles.actionRow}>
              {customer.phone ? (
                <Pressable
                  style={styles.actionBtn}
                  onPress={() => Linking.openURL(`tel:${customer.phone}`)}
                >
                  <Ionicons name="call-outline" size={16} color={ios.brand} />
                  <Text style={styles.actionText}>Call</Text>
                </Pressable>
              ) : null}
              {customer.phone ? (
                <Pressable
                  style={styles.actionBtn}
                  onPress={() => Linking.openURL(`sms:${customer.phone}`)}
                >
                  <Ionicons name="chatbubble-outline" size={16} color={ios.brand} />
                  <Text style={styles.actionText}>Text</Text>
                </Pressable>
              ) : null}
              {customer.email ? (
                <Pressable
                  style={styles.actionBtn}
                  onPress={() => Linking.openURL(`mailto:${customer.email}`)}
                >
                  <Ionicons name="mail-outline" size={16} color={ios.brand} />
                  <Text style={styles.actionText}>Email</Text>
                </Pressable>
              ) : null}
              {addressLine ? (
                <Pressable
                  style={styles.actionBtn}
                  onPress={() =>
                    openInMaps({
                      address: addressLine,
                      lat: primaryAddress?.lat ?? undefined,
                      lng: primaryAddress?.lng ?? undefined,
                      label: customer.businessName,
                    })
                  }
                >
                  <Ionicons name="navigate-outline" size={16} color={ios.brand} />
                  <Text style={styles.actionText}>Directions</Text>
                </Pressable>
              ) : null}
              <Pressable
                style={styles.actionBtn}
                onPress={() => router.push(`/(operator)/customers/${id}/addresses`)}
              >
                <Ionicons name="location-outline" size={16} color={ios.brand} />
                <Text style={styles.actionText}>Addresses</Text>
              </Pressable>
            </View>
          </View>

          {/* Address */}
          {primaryAddress ? (
            <View style={styles.card}>
              <View style={styles.cardHeader}>
                <Text style={styles.cardTitle}>Address</Text>
                <Pressable onPress={() => router.push(`/(operator)/customers/${id}/addresses`)}>
                  <Text style={styles.linkText}>Manage</Text>
                </Pressable>
              </View>
              <Text style={styles.addressText}>
                {primaryAddress.line1}
                {primaryAddress.line2 ? `\n${primaryAddress.line2}` : ""}
                {"\n"}
                {primaryAddress.city}, {primaryAddress.state} {primaryAddress.zip}
              </Text>
            </View>
          ) : null}

          {/* Financial summary */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Account standing</Text>
            <View style={styles.statGrid}>
              <View style={styles.statBox}>
                <Text style={styles.statValue}>{fmt(statement?.outstandingAmount)}</Text>
                <Text style={styles.statLabel}>Outstanding</Text>
              </View>
              <View style={styles.statBox}>
                <Text style={[styles.statValue, (statement?.overdueAmount ?? 0) > 0 && styles.red]}>
                  {fmt(statement?.overdueAmount)}
                </Text>
                <Text style={styles.statLabel}>Overdue</Text>
              </View>
              <View style={styles.statBox}>
                <Text style={[styles.statValue, (statement?.pendingOrdersAmount ?? 0) > 0 && styles.amber]}>
                  {fmt(statement?.pendingOrdersAmount)}
                </Text>
                <Text style={styles.statLabel}>Pending orders</Text>
              </View>
              <View style={styles.statBox}>
                <Text style={[styles.statValue, styles.green]}>
                  {fmt(statement?.availableCredit)}
                </Text>
                <Text style={styles.statLabel}>Credit notes</Text>
              </View>
              <View style={styles.statBox}>
                <Text style={styles.statValue}>{fmt(statement?.advanceBalance)}</Text>
                <Text style={styles.statLabel}>Advance paid</Text>
              </View>
            </View>
            {creditLimit != null ? (
              <Row
                label="Credit limit"
                value={<Text style={styles.rowValue}>{fmt(creditLimit)}</Text>}
              />
            ) : null}
            <Row
              label="Pricing tier"
              value={
                <Pill variant={tier === 1 ? "gray" : "brand"} dot={false}>
                  {`Tier ${tier}`}
                </Pill>
              }
            />
            <Pressable
              style={styles.linkRow}
              onPress={() => router.push(`/(operator)/customers/${id}/catalog`)}
            >
              <Text style={styles.linkText}>View custom prices</Text>
              <Ionicons name="chevron-forward" size={14} color={ios.brand} />
            </Pressable>
          </View>

          {/* Account details */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Account</Text>
            {customer.email ? <Row label="Email" value={<Text style={styles.rowValue}>{customer.email}</Text>} /> : null}
            {customer.phone ? <Row label="Phone" value={<Text style={styles.rowValue}>{customer.phone}</Text>} /> : null}
            {customer.currency ? <Row label="Currency" value={<Text style={styles.rowValue}>{customer.currency}</Text>} /> : null}
            {customer.deliveryWindowStart || customer.deliveryWindowEnd ? (
              <Row
                label="Delivery window"
                value={
                  <Text style={styles.rowValue}>
                    {customer.deliveryWindowStart ?? "—"} – {customer.deliveryWindowEnd ?? "—"}
                  </Text>
                }
              />
            ) : null}
            {customer.notes ? (
              <View style={{ marginTop: 8 }}>
                <Text style={styles.notesLabel}>Notes</Text>
                <Text style={styles.notesText}>{customer.notes}</Text>
              </View>
            ) : null}
          </View>

          {/* Quick actions */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Actions</Text>
            <Pressable
              style={styles.actionListRow}
              onPress={() => router.push(`/(operator)/orders?customerId=${id}`)}
            >
              <Ionicons name="receipt-outline" size={16} color={ios.brand} />
              <Text style={styles.actionListText}>View orders</Text>
              <Ionicons name="chevron-forward" size={14} color={ios.label3} style={{ marginLeft: "auto" }} />
            </Pressable>
            <Pressable
              style={styles.actionListRow}
              onPress={() => router.push(`/(operator)/invoices?customerId=${id}`)}
            >
              <Ionicons name="document-text-outline" size={16} color={ios.brand} />
              <Text style={styles.actionListText}>View invoices</Text>
              <Ionicons name="chevron-forward" size={14} color={ios.label3} style={{ marginLeft: "auto" }} />
            </Pressable>
          </View>

          <Pressable style={styles.deleteBtn} onPress={handleDelete} disabled={deleteMut.isPending}>
            <Ionicons name="trash-outline" size={18} color={ios.system.red} />
            <Text style={styles.deleteBtnText}>Delete customer</Text>
          </Pressable>
        </View>
        <View style={{ height: 24 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <View style={{ flexShrink: 1 }}>{value}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center" },
  card: { backgroundColor: ios.bgElev, borderRadius: 14, padding: 14, gap: 6 },
  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 4,
  },
  cardTitle: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },
  linkText: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.brand },
  name: { fontSize: 22, fontFamily: "Inter_700Bold", color: ios.label, letterSpacing: -0.4 },
  contact: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  tagRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 6 },
  tag: {
    backgroundColor: ios.brandWash,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  tagText: { fontSize: 11, fontFamily: "Inter_500Medium", color: ios.brand },
  actionRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10 },
  actionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: ios.brandWash,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 10,
  },
  actionText: { color: ios.brand, fontSize: 13, fontFamily: "Inter_500Medium" },
  addressText: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label, lineHeight: 20 },
  statGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginBottom: 8,
  },
  statBox: {
    flex: 1,
    minWidth: "40%",
    backgroundColor: ios.fill3,
    borderRadius: 10,
    padding: 10,
    alignItems: "center",
  },
  statValue: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  statLabel: { fontSize: 11, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  red: { color: ios.system.redInk },
  green: { color: ios.system.greenInk },
  amber: { color: ios.system.orangeInk },
  detailRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 6, alignItems: "center" },
  detailLabel: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2 },
  rowValue: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.label },
  linkRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
    marginTop: 4,
  },
  notesLabel: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginBottom: 2 },
  notesText: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label, lineHeight: 18 },
  actionListRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: ios.separator,
  },
  actionListText: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.label },
  deleteBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: ios.bgElev,
    paddingVertical: 14,
    borderRadius: 12,
  },
  deleteBtnText: { color: ios.system.red, fontSize: 15, fontFamily: "Inter_500Medium" },
});
