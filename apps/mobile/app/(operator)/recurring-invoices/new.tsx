import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
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
import { useAdminCustomers } from "../../../lib/api/admin";
import { useProductSearch } from "../../../lib/use-product-search";
import {
  useCreateRecurringInvoice,
  type RecurringFrequency,
} from "../../../lib/api/recurring-invoices";
import { recurringScheduleFields } from "../../../lib/recurring-invoices-logic";
import { sanitizeIntInput } from "../../../lib/qty";
import { showToast } from "../../../lib/toast";

interface DraftLine {
  key: string;
  productId?: string;
  description: string;
  qty: string;
  unitPrice: string;
}

const FREQS: { id: RecurringFrequency; label: string }[] = [
  { id: "WEEKLY", label: "Weekly" },
  { id: "BIWEEKLY", label: "Every 2 wks" },
  { id: "MONTHLY", label: "Monthly" },
];
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function todayPlus(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function toNumber(v: string): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export default function NewRecurringInvoiceScreen() {
  const router = useRouter();
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [customerName, setCustomerName] = useState<string | null>(null);

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
  return (
    <Composer
      customerId={customerId}
      customerName={customerName}
      onBack={() => setCustomerId(null)}
      onDone={() => router.replace("/(operator)/recurring-invoices" as any)}
    />
  );
}

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
        inlineTitle="Recurring · Customer"
        leading={<NavBackButton label="Back" onPress={onBack} />}
      />
      <SearchBar placeholder="Search customers…" value={search} onChangeText={setSearch} />
      <ScrollView showsVerticalScrollIndicator={false}>
        {isLoading ? (
          <View style={styles.center}>
            <ActivityIndicator color={ios.brand} />
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

function Composer({
  customerId,
  customerName,
  onBack,
  onDone,
}: {
  customerId: string;
  customerName: string | null;
  onBack: () => void;
  onDone: () => void;
}) {
  const createMut = useCreateRecurringInvoice();
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [frequency, setFrequency] = useState<RecurringFrequency>("MONTHLY");
  const [dayOfWeek, setDayOfWeek] = useState(1);
  const [dayOfMonth, setDayOfMonth] = useState("1");
  const [nextRunAt, setNextRunAt] = useState(todayPlus(7));
  const [autoSend, setAutoSend] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Monotonic, removal-independent key source: deriving keys from lines.length
  // collides after a delete (a re-added line reuses a freed index) — which would
  // make setLine/removeLine mutate two rows at once.
  const keySeq = useRef(0);
  const nextKey = () => `k-${keySeq.current++}`;
  const addProduct = (p: { id: string; name: string; pricePerUnit: number | string }) => {
    setLines((l) => [
      ...l,
      {
        key: nextKey(),
        productId: p.id,
        description: p.name,
        qty: "1",
        unitPrice: String(Number(p.pricePerUnit) || 0),
      },
    ]);
    setPickerOpen(false);
  };
  const addCustom = () =>
    setLines((l) => [...l, { key: nextKey(), description: "", qty: "1", unitPrice: "" }]);
  const setLine = (key: string, patch: Partial<DraftLine>) =>
    setLines((l) => l.map((x) => (x.key === key ? { ...x, ...patch } : x)));
  const removeLine = (key: string) => setLines((l) => l.filter((x) => x.key !== key));

  const submit = () => {
    const items = lines
      .map((l) => ({
        description: l.description.trim(),
        productId: l.productId,
        qty: Math.max(0, Math.floor(toNumber(l.qty))),
        unitPrice: Math.max(0, toNumber(l.unitPrice)),
      }))
      .filter((i) => i.description !== "" && i.qty > 0);
    if (items.length === 0) return setError("Add at least one line with a description and qty.");
    const raw = nextRunAt.trim();
    const d = new Date(raw);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(raw) ||
      Number.isNaN(d.getTime()) ||
      d.toISOString().slice(0, 10) !== raw
    ) {
      return setError("Enter a valid first-run date as YYYY-MM-DD.");
    }
    setError(null);
    createMut.mutate(
      {
        customerId,
        frequency,
        ...recurringScheduleFields(frequency, dayOfWeek, Math.floor(toNumber(dayOfMonth)) || 1),
        autoSend,
        nextRunAt: d.toISOString(),
        items,
      },
      {
        onSuccess: () => {
          showToast("Recurring template created");
          onDone();
        },
        onError: (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
      },
    );
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="New recurring"
        leading={<NavBackButton label={customerName ?? "Back"} onPress={onBack} />}
      />
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ padding: 16, gap: 14 }}
      >
        {/* Schedule */}
        <View>
          <Text style={styles.sectionTitle}>Schedule</Text>
          <View style={styles.chipRow}>
            {FREQS.map((f) => (
              <Pressable
                key={f.id}
                onPress={() => setFrequency(f.id)}
                style={[styles.chip, frequency === f.id ? styles.chipActive : styles.chipInactive]}
              >
                <Text style={[styles.chipText, frequency === f.id && styles.chipTextActive]}>
                  {f.label}
                </Text>
              </Pressable>
            ))}
          </View>
          {frequency === "MONTHLY" ? (
            <View style={styles.fieldRow}>
              <Text style={styles.fieldLabel}>Day of month (1–28)</Text>
              <TextInput
                style={styles.smallInput}
                value={dayOfMonth}
                onChangeText={(v) => setDayOfMonth(sanitizeIntInput(v))}
                keyboardType="number-pad"
                placeholder="1"
                placeholderTextColor={ios.label3}
              />
            </View>
          ) : (
            <View style={styles.dowRow}>
              {DOW.map((d, i) => (
                <Pressable
                  key={d}
                  onPress={() => setDayOfWeek(i)}
                  style={[
                    styles.dowChip,
                    dayOfWeek === i ? styles.chipActive : styles.chipInactive,
                  ]}
                >
                  <Text style={[styles.dowText, dayOfWeek === i && styles.chipTextActive]}>
                    {d}
                  </Text>
                </Pressable>
              ))}
            </View>
          )}
          <View style={styles.fieldRow}>
            <Text style={styles.fieldLabel}>First run</Text>
            <TextInput
              style={styles.dateInput}
              value={nextRunAt}
              onChangeText={setNextRunAt}
              placeholder="YYYY-MM-DD"
              placeholderTextColor={ios.label3}
              keyboardType="numbers-and-punctuation"
            />
          </View>
          <View style={styles.switchRow}>
            <Text style={styles.fieldLabel}>Auto-send each run</Text>
            <Switch value={autoSend} onValueChange={setAutoSend} trackColor={{ true: ios.brand }} />
          </View>
        </View>

        {/* Items */}
        <View>
          <Text style={styles.sectionTitle}>Lines</Text>
          <View style={styles.card}>
            {lines.length === 0 ? (
              <Text style={styles.emptyLine}>No lines yet.</Text>
            ) : (
              lines.map((l, i) => (
                <View
                  key={l.key}
                  style={[
                    styles.lineRow,
                    i > 0 && {
                      borderTopWidth: StyleSheet.hairlineWidth,
                      borderTopColor: ios.separator,
                    },
                  ]}
                >
                  <View style={{ flex: 1, gap: 6 }}>
                    <TextInput
                      style={styles.lineName}
                      value={l.description}
                      onChangeText={(v) => setLine(l.key, { description: v })}
                      placeholder="Description"
                      placeholderTextColor={ios.label3}
                    />
                    <View style={{ flexDirection: "row", gap: 8 }}>
                      <TextInput
                        style={styles.lineQty}
                        value={l.qty}
                        onChangeText={(v) => setLine(l.key, { qty: sanitizeIntInput(v) })}
                        keyboardType="number-pad"
                        placeholder="Qty"
                        placeholderTextColor={ios.label3}
                      />
                      <TextInput
                        style={styles.linePrice}
                        value={l.unitPrice}
                        onChangeText={(v) => setLine(l.key, { unitPrice: v })}
                        keyboardType="decimal-pad"
                        placeholder="Unit price"
                        placeholderTextColor={ios.label3}
                      />
                    </View>
                  </View>
                  <Pressable onPress={() => removeLine(l.key)} hitSlop={8} style={styles.removeBtn}>
                    <Ionicons name="trash-outline" size={16} color={ios.system.redInk} />
                  </Pressable>
                </View>
              ))
            )}
            <View style={styles.addRow}>
              <Pressable style={styles.addBtn} onPress={() => setPickerOpen(true)}>
                <Ionicons name="add-circle-outline" size={16} color={ios.brand} />
                <Text style={styles.addText}>Add product</Text>
              </Pressable>
              <Pressable style={styles.addBtn} onPress={addCustom}>
                <Ionicons name="create-outline" size={16} color={ios.brand} />
                <Text style={styles.addText}>Custom line</Text>
              </Pressable>
            </View>
          </View>
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <Pressable
          style={[styles.submitBtn, createMut.isPending && { opacity: 0.5 }]}
          disabled={createMut.isPending}
          onPress={submit}
        >
          <Text style={styles.submitText}>
            {createMut.isPending ? "Creating…" : "Create template"}
          </Text>
        </Pressable>
      </ScrollView>

      <ProductPickerModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={addProduct}
      />
    </SafeAreaView>
  );
}

function ProductPickerModal({
  open,
  onClose,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (p: { id: string; name: string; pricePerUnit: number | string }) => void;
}) {
  // The catalogue no longer preloads at mount — it loads on a term or a
  // deliberate "Browse catalogue" tap (owner ask 2026-09-14). `browsing`
  // resets on close so the next open starts quiet again; the modal itself
  // stays mounted for the life of the screen, so without this reset a browse
  // from one open would leak into the next.
  const [browsing, setBrowsing] = useState(false);
  useEffect(() => {
    if (!open) setBrowsing(false);
  }, [open]);

  // Debounced + paged, replacing the `limit: 0` fetch-all. Gated on `open` so
  // a mounted-but-closed picker doesn't fetch the catalogue.
  const {
    search,
    setSearch,
    products: pagedProducts,
    isLoading,
    idle,
    isPlaceholder,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
  } = useProductSearch<{ id: string }>({ enabled: open, browsing });
  const products = pagedProducts as unknown as Array<{
    id: string;
    name: string;
    pricePerUnit: number | string;
  }>;
  return (
    <Modal visible={open} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar
          inlineTitle="Add product"
          leading={<NavBackButton label="Cancel" onPress={onClose} />}
        />
        <SearchBar placeholder="Search products…" value={search} onChangeText={setSearch} />
        <ScrollView
          showsVerticalScrollIndicator={false}
          scrollEventThrottle={200}
          onScroll={({ nativeEvent: e }) => {
            const nearBottom =
              e.layoutMeasurement.height + e.contentOffset.y >= e.contentSize.height - 400;
            if (!nearBottom || isPlaceholder || !hasNextPage || isFetchingNextPage) return;
            fetchNextPage();
          }}
        >
          {isLoading ? (
            <View style={styles.center}>
              <ActivityIndicator color={ios.brand} />
            </View>
          ) : idle ? (
            <View style={styles.center}>
              <Text style={styles.empty}>Search for a product, or browse the catalogue.</Text>
              <Pressable
                onPress={() => setBrowsing(true)}
                accessibilityRole="button"
                accessibilityLabel="Browse the full catalogue"
              >
                <Text style={styles.empty}>Browse catalogue</Text>
              </Pressable>
            </View>
          ) : (
            <View style={styles.list}>
              {products.map((p) => (
                <Pressable key={p.id} style={styles.pickRow} onPress={() => onPick(p)}>
                  <Text style={styles.pickName} numberOfLines={1}>
                    {p.name}
                  </Text>
                  <Text style={styles.pickSub}>${(Number(p.pricePerUnit) || 0).toFixed(2)}</Text>
                </Pressable>
              ))}
            </View>
          )}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center", gap: 10 },
  empty: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label2 },
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
  pickSub: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.label2 },
  sectionTitle: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    textTransform: "uppercase",
    letterSpacing: 0.4,
    marginBottom: 8,
  },
  chipRow: { flexDirection: "row", gap: 8, marginBottom: 10 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999 },
  chipActive: { backgroundColor: ios.brand },
  chipInactive: { backgroundColor: ios.fill3 },
  chipText: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.label },
  chipTextActive: { color: "#fff" },
  dowRow: { flexDirection: "row", gap: 6, marginBottom: 10, flexWrap: "wrap" },
  dowChip: { paddingHorizontal: 10, paddingVertical: 7, borderRadius: 999 },
  dowText: { fontSize: 12, fontFamily: "Inter_500Medium", color: ios.label },
  fieldRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  fieldLabel: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.label },
  smallInput: {
    width: 64,
    backgroundColor: ios.bgElev,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    textAlign: "center",
  },
  dateInput: {
    width: 140,
    backgroundColor: ios.bgElev,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: ios.label,
    textAlign: "center",
  },
  switchRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  card: { backgroundColor: ios.bgElev, borderRadius: 12, padding: 14 },
  emptyLine: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    paddingVertical: 6,
  },
  lineRow: { flexDirection: "row", alignItems: "flex-start", gap: 10, paddingVertical: 10 },
  lineName: {
    backgroundColor: ios.fill3,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: ios.label,
  },
  lineQty: {
    width: 70,
    backgroundColor: ios.fill3,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
    color: ios.label,
    textAlign: "center",
  },
  linePrice: {
    flex: 1,
    backgroundColor: ios.fill3,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
    color: ios.label,
  },
  removeBtn: { padding: 6 },
  addRow: { flexDirection: "row", gap: 16, marginTop: 8 },
  addBtn: { flexDirection: "row", alignItems: "center", gap: 6 },
  addText: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: ios.brand },
  error: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.system.red },
  submitBtn: {
    backgroundColor: ios.brand,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: "center",
  },
  submitText: { color: "#fff", fontSize: 16, fontFamily: "Inter_600SemiBold" },
});
