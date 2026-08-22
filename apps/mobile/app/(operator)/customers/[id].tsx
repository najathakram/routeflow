import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavAction, NavBackButton, NavBar, Pill } from "@routeflow/ui/mobile/ios";
import {
  useCreateAdvancePayment,
  useCustomer,
  useCustomerStatement,
  useDeleteCustomer,
} from "../../../lib/api/customers";
import { MoneyTextInput } from "../../../components/MoneyTextInput";
import { openInMaps } from "../../../components/openInMaps";
import {
  SELECTABLE_METHOD_OPTIONS,
  type SelectablePaymentMethod,
} from "../../../lib/payment-methods";
import { roundMoney } from "../../../lib/pricing";
import { showToast } from "../../../lib/toast";
import { confirm } from "../../../lib/confirm";

function fmt(n: number | string | null | undefined): string {
  const v = n == null ? 0 : typeof n === "string" ? Number(n) : n;
  return `$${(Number.isFinite(v) ? v : 0).toFixed(2)}`;
}

export default function CustomerDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  // RF-203: defensive guard — if somehow "create" reaches this screen (e.g. the
  // static create.tsx was not matched), redirect to the proper create form
  // instead of firing a doomed /customers/create API call and spinning forever.
  const isCreateAlias = id === "create" || id === "new";
  useEffect(() => {
    if (isCreateAlias) router.replace("/(operator)/customers/new");
  }, [isCreateAlias, router]);

  const { data: customer, isLoading } = useCustomer(isCreateAlias ? "" : (id ?? ""));
  const { data: statement } = useCustomerStatement(isCreateAlias ? "" : (id ?? ""));
  const deleteMut = useDeleteCustomer();
  const [advanceOpen, setAdvanceOpen] = useState(false);

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
    ? [
        primaryAddress.line1,
        primaryAddress.line2,
        primaryAddress.city,
        primaryAddress.state,
        primaryAddress.zip,
      ]
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
                <Text
                  style={[
                    styles.statValue,
                    (statement?.pendingOrdersAmount ?? 0) > 0 && styles.amber,
                  ]}
                >
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
            <Pressable
              style={styles.linkRow}
              onPress={() =>
                router.push({
                  pathname: "/(operator)/payments/record",
                  params: { customerId: id, customerName: customer.businessName },
                } as any)
              }
            >
              <Text style={styles.linkText}>Record payment</Text>
              <Ionicons name="chevron-forward" size={14} color={ios.brand} />
            </Pressable>
            <Pressable style={styles.linkRow} onPress={() => setAdvanceOpen(true)}>
              <Text style={styles.linkText}>Record advance payment</Text>
              <Ionicons name="chevron-forward" size={14} color={ios.brand} />
            </Pressable>
            <Pressable
              style={styles.linkRow}
              onPress={() => router.push(`/(operator)/customers/${id}/statement`)}
            >
              <Text style={styles.linkText}>View full statement</Text>
              <Ionicons name="chevron-forward" size={14} color={ios.brand} />
            </Pressable>
          </View>

          {/* Account details */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Account</Text>
            {customer.email ? (
              <Row label="Email" value={<Text style={styles.rowValue}>{customer.email}</Text>} />
            ) : null}
            {customer.phone ? (
              <Row label="Phone" value={<Text style={styles.rowValue}>{customer.phone}</Text>} />
            ) : null}
            {customer.currency ? (
              <Row
                label="Currency"
                value={<Text style={styles.rowValue}>{customer.currency}</Text>}
              />
            ) : null}
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
              <Ionicons
                name="chevron-forward"
                size={14}
                color={ios.label3}
                style={{ marginLeft: "auto" }}
              />
            </Pressable>
            <Pressable
              style={styles.actionListRow}
              onPress={() => router.push(`/(operator)/invoices?customerId=${id}`)}
            >
              <Ionicons name="document-text-outline" size={16} color={ios.brand} />
              <Text style={styles.actionListText}>View invoices</Text>
              <Ionicons
                name="chevron-forward"
                size={14}
                color={ios.label3}
                style={{ marginLeft: "auto" }}
              />
            </Pressable>
            <Pressable
              style={styles.actionListRow}
              onPress={() => router.push(`/(operator)/customers/${id}/documents`)}
            >
              <Ionicons name="folder-outline" size={16} color={ios.brand} />
              <Text style={styles.actionListText}>Documents</Text>
              <Ionicons
                name="chevron-forward"
                size={14}
                color={ios.label3}
                style={{ marginLeft: "auto" }}
              />
            </Pressable>
            <Pressable
              style={styles.actionListRow}
              onPress={() => router.push(`/(operator)/customers/${id}/licenses`)}
            >
              <Ionicons name="shield-checkmark-outline" size={16} color={ios.brand} />
              <Text style={styles.actionListText}>Licenses</Text>
              <Ionicons
                name="chevron-forward"
                size={14}
                color={ios.label3}
                style={{ marginLeft: "auto" }}
              />
            </Pressable>
            <Pressable
              style={styles.actionListRow}
              onPress={() => router.push(`/(operator)/customers/${id}/standing-orders`)}
            >
              <Ionicons name="repeat-outline" size={16} color={ios.brand} />
              <Text style={styles.actionListText}>Standing orders</Text>
              <Ionicons
                name="chevron-forward"
                size={14}
                color={ios.label3}
                style={{ marginLeft: "auto" }}
              />
            </Pressable>
            <Pressable
              style={styles.actionListRow}
              onPress={() => router.push(`/(operator)/customers/${id}/contacts`)}
            >
              <Ionicons name="people-outline" size={16} color={ios.brand} />
              <Text style={styles.actionListText}>Contacts</Text>
              <Ionicons
                name="chevron-forward"
                size={14}
                color={ios.label3}
                style={{ marginLeft: "auto" }}
              />
            </Pressable>
            <Pressable
              style={styles.actionListRow}
              onPress={() => router.push(`/(operator)/customers/${id}/comments`)}
            >
              <Ionicons name="chatbubble-ellipses-outline" size={16} color={ios.brand} />
              <Text style={styles.actionListText}>Comments</Text>
              <Ionicons
                name="chevron-forward"
                size={14}
                color={ios.label3}
                style={{ marginLeft: "auto" }}
              />
            </Pressable>
          </View>

          <Pressable style={styles.deleteBtn} onPress={handleDelete} disabled={deleteMut.isPending}>
            <Ionicons name="trash-outline" size={18} color={ios.system.red} />
            <Text style={styles.deleteBtnText}>Delete customer</Text>
          </Pressable>
        </View>
        <View style={{ height: 24 }} />
      </ScrollView>

      {advanceOpen && id ? (
        <RecordAdvanceModal
          customerId={id}
          customerName={customer.businessName}
          onClose={() => setAdvanceOpen(false)}
        />
      ) : null}
    </SafeAreaView>
  );
}

/**
 * Take a deposit into the customer's advance wallet (Wave 3). The server has
 * NO validation on this route beyond amount > 0 — everything else is enforced
 * here (cents rounding, method allowlist). Mirrors web's Record Advance
 * Payment modal on the customer page.
 */
function RecordAdvanceModal({
  customerId,
  customerName,
  onClose,
}: {
  customerId: string;
  customerName: string;
  onClose: () => void;
}) {
  const mut = useCreateAdvancePayment();
  const [method, setMethod] = useState<SelectablePaymentMethod>("CASH");
  const [amount, setAmount] = useState<number | null>(null);
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");

  const submit = () => {
    const amt = amount != null ? roundMoney(amount) : 0;
    if (amt <= 0) {
      showToast("Enter a positive amount.");
      return;
    }
    mut.mutate(
      {
        customerId,
        amount: amt,
        method,
        ...(reference.trim() ? { reference: reference.trim() } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      },
      {
        onSuccess: () => {
          showToast("Advance recorded");
          onClose();
        },
        onError: (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
      },
    );
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.advOverlay} onPress={onClose}>
        <Pressable style={styles.advCard} onPress={(e) => e.stopPropagation()}>
          <Text style={styles.advTitle}>Record advance payment</Text>
          <Text style={styles.advBody}>
            A pre-payment from {customerName} that can be applied to future invoices.
          </Text>
          <View style={styles.advChips}>
            {SELECTABLE_METHOD_OPTIONS.map((m) => (
              <Pressable
                key={m.id}
                style={[styles.advChip, method === m.id ? styles.advChipOn : styles.advChipOff]}
                onPress={() => setMethod(m.id)}
              >
                <Text
                  style={[
                    styles.advChipText,
                    method === m.id ? styles.advChipTextOn : styles.advChipTextOff,
                  ]}
                >
                  {m.label}
                </Text>
              </Pressable>
            ))}
          </View>
          <Text style={styles.advLabel}>Amount ($)</Text>
          <MoneyTextInput
            style={styles.advInput}
            value={amount}
            onChangeValue={setAmount}
            placeholder="0.00"
            returnKeyType="done"
          />
          <Text style={styles.advLabel}>Reference (optional)</Text>
          <TextInput
            style={styles.advInput}
            value={reference}
            onChangeText={setReference}
            placeholder="Check #, txn ID…"
            placeholderTextColor={ios.label3}
          />
          <Text style={styles.advLabel}>Notes (optional)</Text>
          <TextInput
            style={styles.advInput}
            value={notes}
            onChangeText={setNotes}
            placeholder="Internal notes…"
            placeholderTextColor={ios.label3}
          />
          <View style={styles.advBtns}>
            <Pressable style={styles.advBtnGhost} onPress={onClose}>
              <Text style={styles.advBtnGhostText}>Cancel</Text>
            </Pressable>
            <Pressable
              style={[styles.advBtnFill, mut.isPending && { opacity: 0.6 }]}
              disabled={mut.isPending}
              onPress={submit}
            >
              <Text style={styles.advBtnFillText}>{mut.isPending ? "Saving…" : "Record"}</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
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
  // ── Record-advance modal ──────────────────────────────────────────────────
  advOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  advCard: {
    backgroundColor: ios.bgElev,
    borderRadius: 20,
    padding: 20,
    width: "100%",
    maxWidth: 380,
    gap: 6,
  },
  advTitle: { fontSize: 17, fontFamily: "Inter_700Bold", color: ios.label },
  advBody: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    marginBottom: 6,
  },
  advChips: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 4 },
  advChip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999 },
  advChipOn: { backgroundColor: ios.brand },
  advChipOff: { backgroundColor: ios.fill3 },
  advChipText: { fontSize: 13, fontFamily: "Inter_500Medium" },
  advChipTextOn: { color: "#fff" },
  advChipTextOff: { color: ios.label },
  advLabel: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    marginTop: 6,
  },
  advInput: {
    backgroundColor: ios.fill3,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    fontFamily: "Inter_500Medium",
    color: ios.label,
  },
  advBtns: { flexDirection: "row", gap: 10, marginTop: 12 },
  advBtnGhost: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: 12,
    alignItems: "center",
    backgroundColor: ios.fill3,
  },
  advBtnGhostText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },
  advBtnFill: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: 12,
    alignItems: "center",
    backgroundColor: ios.brand,
  },
  advBtnFillText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: "#fff" },
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
  detailRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 6,
    alignItems: "center",
  },
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
