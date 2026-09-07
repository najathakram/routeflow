import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavBackButton, NavBar, SearchBar } from "@routeflow/ui/mobile/ios";
import { useAdminCustomers, useAdminOrders, type AdminOrder } from "../../../lib/api/admin";
import { useCreateReturn, type ReturnReason } from "../../../lib/api/returns";
import { buildReturnItems, restockForReason } from "../../../lib/returns-logic";
import { sanitizeIntInput } from "../../../lib/qty";
import { showToast } from "../../../lib/toast";

const REASONS: { id: ReturnReason; label: string }[] = [
  { id: "DAMAGED", label: "Damaged" },
  { id: "WRONG_ITEM", label: "Wrong item" },
  { id: "EXCESS_ORDER", label: "Excess order" },
  { id: "CUSTOMER_REFUSED", label: "Refused" },
  { id: "QUALITY_ISSUE", label: "Quality issue" },
];

export default function NewReturnScreen() {
  const router = useRouter();
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [customerName, setCustomerName] = useState<string | null>(null);
  const [order, setOrder] = useState<AdminOrder | null>(null);

  if (!customerId) {
    return (
      <CustomerStep
        onBack={() => router.back()}
        onPick={(id, name) => {
          setCustomerId(id);
          setCustomerName(name);
        }}
      />
    );
  }
  if (!order) {
    return (
      <OrderStep
        customerId={customerId}
        customerName={customerName}
        onBack={() => setCustomerId(null)}
        onPick={setOrder}
      />
    );
  }
  return (
    <ItemsStep
      order={order}
      customerName={customerName}
      onBack={() => setOrder(null)}
      onDone={() => router.replace("/(operator)/returns" as any)}
    />
  );
}

// ── Step 1: customer ──────────────────────────────────────────────────────────
function CustomerStep({
  onBack,
  onPick,
}: {
  onBack: () => void;
  onPick: (id: string, name: string) => void;
}) {
  const [search, setSearch] = useState("");
  const { data, isLoading } = useAdminCustomers({ search: search.trim() || undefined, limit: 50 });
  const customers = data?.data ?? [];
  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Return · Customer"
        leading={<NavBackButton label="Back" onPress={onBack} />}
      />
      <SearchBar placeholder="Search customers…" value={search} onChangeText={setSearch} />
      <ScrollView showsVerticalScrollIndicator={false}>
        {isLoading ? (
          <View style={styles.center}>
            <ActivityIndicator color={ios.brand} />
          </View>
        ) : customers.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.empty}>No customers found.</Text>
          </View>
        ) : (
          <View style={styles.list}>
            {customers.map((c) => (
              <Pressable
                key={c.id}
                style={styles.pickRow}
                onPress={() => onPick(c.id, c.businessName)}
              >
                <Text style={styles.pickName} numberOfLines={1}>
                  {c.businessName}
                </Text>
                <Ionicons name="chevron-forward" size={16} color={ios.gray[3]} />
              </Pressable>
            ))}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

// ── Step 2: delivered order ───────────────────────────────────────────────────
function OrderStep({
  customerId,
  customerName,
  onBack,
  onPick,
}: {
  customerId: string;
  customerName: string | null;
  onBack: () => void;
  onPick: (o: AdminOrder) => void;
}) {
  const { data, isLoading } = useAdminOrders({ customerId, status: "DELIVERED", limit: 50 });
  const orders = data?.data ?? [];
  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Return · Order"
        leading={<NavBackButton label={customerName ?? "Back"} onPress={onBack} />}
      />
      <ScrollView showsVerticalScrollIndicator={false}>
        {isLoading ? (
          <View style={styles.center}>
            <ActivityIndicator color={ios.brand} />
          </View>
        ) : orders.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.empty}>No delivered orders for this customer.</Text>
          </View>
        ) : (
          <View style={styles.list}>
            {orders.map((o) => (
              <Pressable key={o.id} style={styles.pickRow} onPress={() => onPick(o)}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.pickName} numberOfLines={1}>
                    {o.orderNumber}
                  </Text>
                  <Text style={styles.pickSub}>
                    ${Number(o.total).toFixed(2)} ·{" "}
                    {o.deliveredAt ? new Date(o.deliveredAt).toLocaleDateString() : "delivered"}
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={16} color={ios.gray[3]} />
              </Pressable>
            ))}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

// ── Step 3: items + reason + submit ───────────────────────────────────────────
function ItemsStep({
  order,
  customerName,
  onBack,
  onDone,
}: {
  order: AdminOrder;
  customerName: string | null;
  onBack: () => void;
  onDone: () => void;
}) {
  const createMut = useCreateReturn();
  const lines = useMemo(() => order.lineItems.filter((li) => !!li.productId), [order]);
  const [qtys, setQtys] = useState<Record<string, string>>({});
  const [restock, setRestock] = useState<Record<string, boolean>>({});
  const [reason, setReason] = useState<ReturnReason | null>(null);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);

  // REG-B61: an explicit per-line restock choice wins; otherwise the default
  // comes from the chosen reason (`restockForReason`), never a hardcoded `true`.
  const items = buildReturnItems(
    lines.map((li) => ({ productId: li.productId, orderedQty: Number(li.qty) })),
    qtys,
    restock,
    reason ?? "",
  );

  const submit = () => {
    if (!reason) return setError("Choose a reason for the return.");
    if (items.length === 0) return setError("Enter a return quantity for at least one item.");
    setError(null);
    createMut.mutate(
      {
        orderId: order.id,
        reason,
        notes: notes.trim() || undefined,
        items: items.map((i) => ({ ...i, reason })),
      },
      {
        onSuccess: () => {
          showToast("Return created");
          onDone();
        },
        onError: (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
      },
    );
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle={`Return · ${order.orderNumber}`}
        leading={<NavBackButton label="Order" onPress={onBack} />}
      />
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ padding: 16, gap: 14 }}
      >
        {customerName ? <Text style={styles.hint}>{customerName}</Text> : null}

        <View>
          <Text style={styles.sectionTitle}>Reason</Text>
          <View style={styles.reasonRow}>
            {REASONS.map((r) => (
              <Pressable
                key={r.id}
                onPress={() => setReason(r.id)}
                style={[styles.chip, reason === r.id ? styles.chipActive : styles.chipInactive]}
              >
                <Text style={[styles.chipText, reason === r.id && styles.chipTextActive]}>
                  {r.label}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>

        <View>
          <Text style={styles.sectionTitle}>Items</Text>
          <View style={styles.card}>
            {lines.map((li, i) => {
              const pid = li.productId as string;
              const ordered = Number(li.qty);
              return (
                <View
                  key={li.id}
                  style={[
                    styles.itemRow,
                    i > 0 && {
                      borderTopWidth: StyleSheet.hairlineWidth,
                      borderTopColor: ios.separator,
                    },
                  ]}
                >
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.itemName} numberOfLines={1}>
                      {li.product?.name ?? li.name ?? "Item"}
                    </Text>
                    <Text style={styles.itemMeta}>Ordered {ordered}</Text>
                    <View style={styles.restockRow}>
                      <Switch
                        value={restock[pid] ?? restockForReason(reason ?? "")}
                        onValueChange={(v) => setRestock((m) => ({ ...m, [pid]: v }))}
                        trackColor={{ true: ios.brand }}
                      />
                      <Text style={styles.restockText}>Restock</Text>
                    </View>
                  </View>
                  <TextInput
                    style={styles.qtyInput}
                    value={qtys[pid] ?? ""}
                    onChangeText={(v) => setQtys((m) => ({ ...m, [pid]: sanitizeIntInput(v) }))}
                    placeholder="0"
                    placeholderTextColor={ios.label3}
                    keyboardType="number-pad"
                  />
                </View>
              );
            })}
          </View>
        </View>

        <View>
          <Text style={styles.sectionTitle}>Notes (optional)</Text>
          <TextInput
            style={styles.notes}
            value={notes}
            onChangeText={setNotes}
            placeholder="Condition, reference…"
            placeholderTextColor={ios.label3}
            multiline
          />
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <Pressable
          style={[styles.submitBtn, createMut.isPending && { opacity: 0.5 }]}
          disabled={createMut.isPending}
          onPress={submit}
        >
          <Text style={styles.submitText}>
            {createMut.isPending ? "Creating…" : `Create return (${items.length})`}
          </Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center" },
  empty: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label2, textAlign: "center" },
  hint: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.label2 },
  list: { paddingHorizontal: 16, gap: 8, paddingVertical: 8 },
  pickRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: ios.bgElev,
    borderRadius: 12,
    padding: 14,
  },
  pickName: { flex: 1, fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },
  pickSub: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  sectionTitle: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    textTransform: "uppercase",
    letterSpacing: 0.4,
    marginBottom: 8,
  },
  reasonRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999 },
  chipActive: { backgroundColor: ios.brand },
  chipInactive: { backgroundColor: ios.fill3 },
  chipText: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.label },
  chipTextActive: { color: "#fff" },
  card: { backgroundColor: ios.bgElev, borderRadius: 12, padding: 14 },
  itemRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10 },
  itemName: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.label },
  itemMeta: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  restockRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 6 },
  restockText: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2 },
  qtyInput: {
    width: 64,
    backgroundColor: ios.fill3,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    textAlign: "center",
  },
  notes: {
    backgroundColor: ios.bgElev,
    borderRadius: 12,
    padding: 12,
    minHeight: 64,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: ios.label,
    textAlignVertical: "top",
  },
  error: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.system.red },
  submitBtn: {
    backgroundColor: ios.brand,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: "center",
    marginTop: 4,
  },
  submitText: { color: "#fff", fontSize: 16, fontFamily: "Inter_600SemiBold" },
});
