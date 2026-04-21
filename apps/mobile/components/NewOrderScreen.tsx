import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import {
  NavAction,
  NavBackButton,
  NavBar,
  SearchBar,
} from "@routeflow/ui/mobile/ios";
import { useAdminCustomers } from "../lib/api/admin";
import { useProducts } from "../lib/api/products";
import { useCreateOrderAsDriver } from "../lib/api/orders";

export interface NewOrderScreenProps {
  /** When present, customer is locked (e.g. invoked from a specific stop). */
  customerId?: string;
  customerName?: string;
  /** When present, the order is linked to this run/stop on the backend. */
  runId?: string;
  stopId?: string;
  /** Label shown on the back button. */
  backLabel?: string;
}

type Product = {
  id: string;
  name: string;
  sku?: string | null;
  unit?: string;
  pricePerUnit: number | string;
  category?: string | null;
};

function toNumber(v: number | string | null | undefined): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export function NewOrderScreen({
  customerId: initialCustomerId,
  customerName: initialCustomerName,
  runId,
  stopId,
  backLabel,
}: NewOrderScreenProps) {
  const router = useRouter();
  const [pickedCustomerId, setPickedCustomerId] = useState<string | null>(
    initialCustomerId ?? null,
  );
  const [pickedCustomerName, setPickedCustomerName] = useState<string | null>(
    initialCustomerName ?? null,
  );
  const customerLocked = !!initialCustomerId;

  // If a customer isn't selected yet, the picker takes over — product list hidden.
  const needsCustomer = !pickedCustomerId;

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      {needsCustomer ? (
        <CustomerPickerView
          backLabel={backLabel}
          onBack={() => router.back()}
          onPick={(id, name) => {
            setPickedCustomerId(id);
            setPickedCustomerName(name);
          }}
        />
      ) : (
        <ProductPickView
          customerId={pickedCustomerId!}
          customerName={pickedCustomerName}
          customerLocked={customerLocked}
          runId={runId}
          stopId={stopId}
          backLabel={backLabel}
          onBack={() => router.back()}
          onChangeCustomer={() => {
            setPickedCustomerId(null);
            setPickedCustomerName(null);
          }}
          onSaved={(orderNumber: string) => {
            Alert.alert("Order created", `Order ${orderNumber} saved as PENDING.`, [
              { text: "OK", onPress: () => router.back() },
            ]);
          }}
        />
      )}
    </SafeAreaView>
  );
}

// ─────────────────────── Customer picker ───────────────────────

function CustomerPickerView({
  backLabel,
  onBack,
  onPick,
}: {
  backLabel?: string;
  onBack: () => void;
  onPick: (id: string, name: string) => void;
}) {
  const [search, setSearch] = useState("");
  const { data, isLoading } = useAdminCustomers({
    search: search.trim() || undefined,
    limit: 50,
  });
  const customers = data?.data ?? [];

  return (
    <>
      <NavBar
        inlineTitle="Choose customer"
        leading={<NavBackButton label={backLabel ?? "Back"} onPress={onBack} />}
      />
      <SearchBar
        placeholder="Search customers…"
        value={search}
        onChangeText={setSearch}
      />
      <ScrollView showsVerticalScrollIndicator={false}>
        {isLoading ? (
          <View style={styles.center}>
            <ActivityIndicator color={ios.brand} />
          </View>
        ) : customers.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.emptyText}>
              {search ? "No customers match that search." : "No customers yet."}
            </Text>
          </View>
        ) : (
          <View style={styles.list}>
            {customers.map((c, i) => (
              <Pressable
                key={c.id}
                style={[
                  styles.customerRow,
                  i > 0 && {
                    borderTopWidth: StyleSheet.hairlineWidth,
                    borderTopColor: ios.separator,
                  },
                ]}
                onPress={() => onPick(c.id, c.businessName)}
              >
                <View style={styles.avatar}>
                  <Text style={styles.avatarText}>
                    {c.businessName
                      .split(/\s+/)
                      .filter(Boolean)
                      .slice(0, 2)
                      .map((w) => w[0]?.toUpperCase() ?? "")
                      .join("") || "?"}
                  </Text>
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.customerName} numberOfLines={1}>
                    {c.businessName}
                  </Text>
                  {c.contactName || c.phone ? (
                    <Text style={styles.customerSub} numberOfLines={1}>
                      {[c.contactName, c.phone].filter(Boolean).join(" · ")}
                    </Text>
                  ) : null}
                </View>
                <Ionicons name="chevron-forward" size={16} color={ios.gray[3]} />
              </Pressable>
            ))}
          </View>
        )}
      </ScrollView>
    </>
  );
}

// ─────────────────────── Product pick + save ───────────────────────

function ProductPickView({
  customerId,
  customerName,
  customerLocked,
  runId,
  stopId,
  backLabel,
  onBack,
  onChangeCustomer,
  onSaved,
}: {
  customerId: string;
  customerName: string | null;
  customerLocked: boolean;
  runId?: string;
  stopId?: string;
  backLabel?: string;
  onBack: () => void;
  onChangeCustomer: () => void;
  onSaved: (orderNumber: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("All");
  const [items, setItems] = useState<Record<string, number>>({});

  const { data: productsData, isLoading: productsLoading } = useProducts({
    search: search.trim() || undefined,
    limit: 200,
  });
  const products: Product[] = productsData?.data ?? [];

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const p of products) if (p.category) set.add(p.category);
    return ["All", ...Array.from(set).slice(0, 6)];
  }, [products]);

  const filtered = useMemo(() => {
    if (category === "All") return products;
    return products.filter((p) => p.category === category);
  }, [products, category]);

  const totalItems = Object.values(items).reduce((a, b) => a + b, 0);
  const total = products.reduce((sum, p) => {
    const q = items[p.id] ?? 0;
    return sum + q * toNumber(p.pricePerUnit);
  }, 0);

  const inc = (id: string) =>
    setItems((m) => ({ ...m, [id]: (m[id] ?? 0) + 1 }));
  const dec = (id: string) =>
    setItems((m) => ({ ...m, [id]: Math.max(0, (m[id] ?? 0) - 1) }));

  const createOrder = useCreateOrderAsDriver();

  const canSave = totalItems > 0 && !createOrder.isPending;

  const onSave = () => {
    const itemPayload = Object.entries(items)
      .filter(([, q]) => q > 0)
      .map(([productId, qty]) => ({ productId, qty }));

    if (itemPayload.length === 0) {
      Alert.alert("Add at least one item", "Tap + on any product to start the order.");
      return;
    }

    createOrder.mutate(
      {
        customerId,
        items: itemPayload,
        routeRunId: runId,
        routeRunStopId: stopId,
      },
      {
        onSuccess: (order) => {
          onSaved(order.orderNumber);
        },
        onError: (err: Error) => {
          const msg =
            (err as unknown as { response?: { data?: { message?: string } } })
              ?.response?.data?.message ?? err?.message ?? "Unable to save order.";
          Alert.alert("Couldn't save order", String(msg));
        },
      },
    );
  };

  return (
    <>
      <NavBar
        inlineTitle="New order"
        leading={
          <NavBackButton
            label={backLabel ?? customerName ?? "Back"}
            onPress={onBack}
          />
        }
        trailing={
          <NavAction
            label={createOrder.isPending ? "Saving…" : "Save"}
            bold
            onPress={canSave ? onSave : undefined}
          />
        }
      />

      {/* Customer chip — tappable to re-pick when not locked */}
      <View style={styles.customerChipWrap}>
        <Pressable
          style={styles.customerChip}
          onPress={customerLocked ? undefined : onChangeCustomer}
          disabled={customerLocked}
        >
          <Ionicons name="person-outline" size={14} color={ios.brand} />
          <Text style={styles.customerChipText} numberOfLines={1}>
            {customerName ?? "Customer"}
          </Text>
          {customerLocked ? null : (
            <Text style={styles.customerChipChange}>Change</Text>
          )}
        </Pressable>
      </View>

      <ScrollView showsVerticalScrollIndicator={false}>
        <SearchBar
          placeholder="Search items…"
          value={search}
          onChangeText={setSearch}
          trailing={<Ionicons name="barcode-outline" size={18} color={ios.label2} />}
        />

        {categories.length > 1 ? (
          <View style={styles.chipRow}>
            {categories.map((c) => (
              <Pressable
                key={c}
                onPress={() => setCategory(c)}
                style={[styles.chip, category === c ? styles.chipActive : styles.chipInactive]}
              >
                <Text
                  style={[
                    styles.chipText,
                    category === c ? styles.chipTextActive : styles.chipTextInactive,
                  ]}
                >
                  {c}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        {productsLoading ? (
          <View style={styles.center}>
            <ActivityIndicator color={ios.brand} />
          </View>
        ) : filtered.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.emptyText}>
              No products{search ? " match your search" : ""}.
            </Text>
          </View>
        ) : (
          <View style={{ paddingHorizontal: 16, paddingTop: 14, gap: 10 }}>
            {filtered.map((p) => {
              const q = items[p.id] ?? 0;
              const price = toNumber(p.pricePerUnit);
              return (
                <View key={p.id} style={styles.productRow}>
                  <View style={styles.productImg} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.productName} numberOfLines={1}>
                      {p.name}
                    </Text>
                    <Text style={styles.productMeta}>
                      {p.sku ? `SKU ${p.sku} · ` : ""}${price.toFixed(2)}
                      {p.unit ? ` / ${p.unit}` : ""}
                    </Text>
                  </View>
                  {q > 0 ? (
                    <View style={styles.stepper}>
                      <Pressable style={styles.stepBtn} onPress={() => dec(p.id)}>
                        <Text style={styles.stepBtnText}>−</Text>
                      </Pressable>
                      <Text style={styles.stepQty}>{q}</Text>
                      <Pressable style={styles.stepBtn} onPress={() => inc(p.id)}>
                        <Text style={styles.stepBtnText}>+</Text>
                      </Pressable>
                    </View>
                  ) : (
                    <Pressable style={styles.addBtn} onPress={() => inc(p.id)}>
                      <Text style={styles.addBtnText}>+</Text>
                    </Pressable>
                  )}
                </View>
              );
            })}
          </View>
        )}
        <View style={{ height: 16 }} />
      </ScrollView>

      <View style={styles.footer}>
        <View style={styles.footerRow}>
          <View>
            <Text style={styles.footerEyebrow}>
              {totalItems} ITEM{totalItems === 1 ? "" : "S"}
            </Text>
            <Text style={styles.footerTotal}>${total.toFixed(2)}</Text>
          </View>
          <Pressable
            style={[
              styles.confirmBtn,
              (!canSave || createOrder.isPending) && styles.confirmBtnDisabled,
            ]}
            disabled={!canSave}
            onPress={onSave}
          >
            <Text style={styles.confirmBtnText}>
              {createOrder.isPending ? "Saving…" : "Confirm order"}
            </Text>
            <Ionicons name="arrow-forward" size={14} color="#fff" />
          </Pressable>
        </View>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bgElev },
  center: { padding: 40, alignItems: "center" },
  emptyText: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label2 },
  list: {
    marginHorizontal: 16,
    backgroundColor: ios.bgElev,
    borderRadius: 12,
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: ios.separator,
  },
  customerRow: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 999,
    backgroundColor: ios.brandWash,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: ios.brand, fontSize: 13, fontFamily: "Inter_700Bold" },
  customerName: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },
  customerSub: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 1 },
  customerChipWrap: {
    paddingHorizontal: 16,
    paddingTop: 10,
  },
  customerChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: ios.brandWash,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
    alignSelf: "flex-start",
    maxWidth: "100%",
  },
  customerChipText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: ios.brand,
    flexShrink: 1,
  },
  customerChipChange: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    color: ios.brand,
    opacity: 0.65,
    marginLeft: 6,
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 4,
  },
  chip: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 999 },
  chipActive: { backgroundColor: ios.brand },
  chipInactive: { backgroundColor: ios.fill3 },
  chipText: { fontSize: 14, fontFamily: "Inter_500Medium" },
  chipTextActive: { color: "#fff" },
  chipTextInactive: { color: ios.label },
  productRow: {
    backgroundColor: ios.bg,
    borderRadius: 14,
    padding: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  productImg: {
    width: 48,
    height: 48,
    borderRadius: 10,
    backgroundColor: ios.brandWash,
  },
  productName: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    letterSpacing: -0.2,
  },
  productMeta: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    marginTop: 1,
    fontVariant: ["tabular-nums"],
  },
  stepper: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: ios.bgElev,
    borderRadius: 10,
    padding: 3,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: ios.separator,
  },
  stepBtn: { width: 30, height: 30, alignItems: "center", justifyContent: "center" },
  stepBtnText: { color: ios.brand, fontSize: 18 },
  stepQty: {
    minWidth: 28,
    textAlign: "center",
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  addBtn: {
    width: 36,
    height: 36,
    backgroundColor: ios.brandWash,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  addBtnText: { color: ios.brand, fontSize: 20 },
  footer: {
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 16,
    backgroundColor: ios.bgElev,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
  },
  footerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  footerEyebrow: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    letterSpacing: 0.4,
  },
  footerTotal: {
    fontSize: 24,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    letterSpacing: -0.6,
    fontVariant: ["tabular-nums"],
  },
  confirmBtn: {
    backgroundColor: ios.brand,
    borderRadius: 14,
    paddingHorizontal: 20,
    paddingVertical: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  confirmBtnDisabled: { opacity: 0.55 },
  confirmBtnText: { color: "#fff", fontSize: 16, fontFamily: "Inter_600SemiBold" },
});
