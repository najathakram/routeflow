import { useMemo, useState } from "react";
import {
  ActivityIndicator,
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
  FilterChipRow,
  NavBackButton,
  NavBar,
  Pill,
  SearchBar,
} from "@routeflow/ui/mobile/ios";
import {
  useInventoryMovements,
  type InventoryMovement,
  type MovementType,
} from "../../lib/api/inventory";
import { BarcodeScanner } from "../../components/BarcodeScanner";
import { BarcodeFab } from "../../components/BarcodeFab";
import { resolveProductByCode } from "../../lib/barcode-resolve";
import { showToast } from "../../lib/toast";

const FILTERS: { id: "ALL" | MovementType; label: string }[] = [
  { id: "ALL", label: "All" },
  { id: "PURCHASE", label: "Received" },
  { id: "SALE", label: "Sold" },
  { id: "ADJUSTMENT", label: "Adjusted" },
  { id: "RETURN", label: "Returned" },
];

function pillForType(t: MovementType): {
  variant: "brand" | "green" | "orange" | "red" | "gray";
  label: string;
} {
  switch (t) {
    case "PURCHASE":
      return { variant: "green", label: "Received" };
    case "SALE":
      return { variant: "brand", label: "Sold" };
    case "ADJUSTMENT":
      return { variant: "orange", label: "Adjusted" };
    case "RETURN":
      return { variant: "red", label: "Returned" };
    default:
      return { variant: "gray", label: t };
  }
}

export default function MovementsScreen() {
  const router = useRouter();
  const [filter, setFilter] = useState<"ALL" | MovementType>("ALL");
  const [search, setSearch] = useState("");
  const [scanOpen, setScanOpen] = useState(false);
  const [productFilter, setProductFilter] = useState<{
    id: string;
    label: string;
  } | null>(null);

  const params = {
    type: filter === "ALL" ? undefined : filter,
    productId: productFilter?.id,
    limit: 100,
  };
  const { data, isLoading } = useInventoryMovements(params);
  const movements = data?.data ?? [];

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return movements;
    return movements.filter((m) =>
      (m.productName ?? "").toLowerCase().includes(term),
    );
  }, [movements, search]);

  const onScanned = async (code: string) => {
    setScanOpen(false);
    const trimmed = code.trim();
    if (!trimmed) return;
    try {
      const result = await resolveProductByCode(trimmed);
      if (!result.notFound) {
        setProductFilter({ id: result.product.id, label: result.product.name });
        return;
      }
    } catch {
      // network error → fall through to the friendly toast below
    }
    showToast(`No product for "${trimmed}"`);
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Stock movements"
        leading={<NavBackButton label="Back" onPress={() => router.back()} />}
      />

      <SearchBar
        placeholder="Filter by product name…"
        value={search}
        onChangeText={setSearch}
        trailing={
          <Pressable onPress={() => setScanOpen(true)} hitSlop={10}>
            <Ionicons name="barcode-outline" size={20} color={ios.brand} />
          </Pressable>
        }
      />

      {productFilter ? (
        <Pressable
          style={styles.activeFilterBanner}
          onPress={() => setProductFilter(null)}
        >
          <Ionicons name="cube-outline" size={14} color={ios.brand} />
          <Text style={styles.activeFilterText} numberOfLines={1}>
            Showing: {productFilter.label}
          </Text>
          <Ionicons name="close" size={14} color={ios.brand} />
        </Pressable>
      ) : null}

      <FilterChipRow
        chips={FILTERS.map((f) => ({ label: f.label }))}
        value={FILTERS.find((f) => f.id === filter)?.label ?? "All"}
        onChange={(label) =>
          setFilter(
            (FILTERS.find((f) => f.label === label)?.id as
              | "ALL"
              | MovementType) ?? "ALL",
          )
        }
      />

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ flexGrow: 1 }}
      >
        {isLoading ? (
          <View style={styles.center}>
            <ActivityIndicator color={ios.brand} />
          </View>
        ) : filtered.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.empty}>No stock movements yet.</Text>
          </View>
        ) : (
          <View style={styles.list}>
            {filtered.map((m) => (
              <MovementRow key={m.id} m={m} />
            ))}
          </View>
        )}
      </ScrollView>

      {scanOpen ? (
        <BarcodeScanner onScanned={onScanned} onClose={() => setScanOpen(false)} />
      ) : null}

      {/* Draggable scan FAB — same handler as the inline barcode icon. */}
      <BarcodeFab onScanned={onScanned} hidden={scanOpen} />
    </SafeAreaView>
  );
}

function MovementRow({ m }: { m: InventoryMovement }) {
  const p = pillForType(m.type);
  const positive = m.quantity > 0;
  const date = new Date(m.createdAt).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return (
    <View style={styles.row}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.name} numberOfLines={1}>
          {m.productName ?? "Product"}
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {date}
          {m.reference ? ` · ${m.reference}` : ""}
          {m.notes ? ` · ${m.notes}` : ""}
        </Text>
      </View>
      <Text
        style={[
          styles.qty,
          { color: positive ? ios.system.greenInk : ios.system.redInk },
        ]}
      >
        {positive ? "+" : ""}
        {m.quantity}
      </Text>
      <Pill variant={p.variant} dot>
        {p.label}
      </Pill>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: {
    padding: 40,
    alignItems: "center",
    justifyContent: "center",
    flex: 1,
  },
  empty: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label2 },
  list: {
    marginHorizontal: 16,
    marginTop: 8,
    backgroundColor: ios.bgElev,
    borderRadius: 12,
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: ios.separator,
  },
  name: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },
  meta: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    marginTop: 2,
  },
  qty: { fontSize: 15, fontFamily: "Inter_700Bold" },
  activeFilterBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginHorizontal: 16,
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: ios.brandWash,
    borderRadius: 10,
  },
  activeFilterText: {
    flex: 1,
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: ios.brand,
  },
});
