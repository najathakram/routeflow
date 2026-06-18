import { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavBackButton, NavBar, SearchBar } from "@routeflow/ui/mobile/ios";
import { useAdminProducts, type AdminProduct } from "../../../lib/api/admin";
import { BarcodeScanner } from "../../../components/BarcodeScanner";
import { BarcodeFab } from "../../../components/BarcodeFab";
import { resolveProductByCode } from "../../../lib/barcode-resolve";
import { showToast } from "../../../lib/toast";

export default function AdjustPickerScreen() {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [scanOpen, setScanOpen] = useState(false);

  // limit: 0 → return everything matching the search term so the operator
  // can find any SKU in their catalogue, not just the first 50.
  const { data, isLoading } = useAdminProducts({
    search: search.trim() || undefined,
    limit: 0,
  });
  const products = data?.data ?? [];

  const goToAdjust = (id: string) => router.push(`/(operator)/products/${id}/adjust-stock`);

  const onScanned = async (code: string) => {
    setScanOpen(false);
    const trimmed = code.trim();
    if (!trimmed) return;
    try {
      const result = await resolveProductByCode(trimmed);
      if (!result.notFound) {
        goToAdjust(result.product.id);
        return;
      }
    } catch {
      // network error → fall through
    }
    showToast(`No product for "${trimmed}"`);
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Adjust stock"
        leading={<NavBackButton label="Back" onPress={() => router.back()} />}
      />

      <SearchBar
        placeholder="Search by name or SKU…"
        value={search}
        onChangeText={setSearch}
        trailing={
          <Pressable onPress={() => setScanOpen(true)} hitSlop={10}>
            <Ionicons name="barcode-outline" size={20} color={ios.brand} />
          </Pressable>
        }
      />

      <ScrollView showsVerticalScrollIndicator={false}>
        {isLoading ? (
          <View style={styles.center}>
            <ActivityIndicator color={ios.brand} />
          </View>
        ) : products.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.empty}>{search ? "No matches." : "No products yet."}</Text>
          </View>
        ) : (
          <View style={styles.list}>
            {products.map((p) => (
              <ProductRow key={p.id} product={p} onPress={() => goToAdjust(p.id)} />
            ))}
          </View>
        )}
        <View style={{ height: 24 }} />
      </ScrollView>

      {scanOpen ? (
        <BarcodeScanner onScanned={onScanned} onClose={() => setScanOpen(false)} />
      ) : null}

      <BarcodeFab onScanned={onScanned} hidden={scanOpen} />
    </SafeAreaView>
  );
}

function ProductRow({ product, onPress }: { product: AdminProduct; onPress: () => void }) {
  const stock =
    typeof product.currentStock === "string"
      ? Number(product.currentStock) || 0
      : product.currentStock;
  return (
    <Pressable style={styles.row} onPress={onPress}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.name} numberOfLines={1}>
          {product.name}
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {product.sku ? `SKU ${product.sku}` : "No SKU"}
          {product.unit ? ` · ${product.unit}` : ""}
        </Text>
      </View>
      <View style={styles.stockPill}>
        <Text style={styles.stockText}>{stock}</Text>
      </View>
      <Ionicons name="chevron-forward" size={16} color={ios.gray[3]} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center" },
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
  stockPill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: ios.brandWash,
  },
  stockText: {
    fontSize: 13,
    fontFamily: "Inter_700Bold",
    color: ios.brand,
  },
});
