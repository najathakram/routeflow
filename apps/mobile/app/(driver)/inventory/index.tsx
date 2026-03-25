import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useState, useEffect } from "react";
import { router, Stack } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors, borderRadius, shadows } from "@routeflow/ui/tokens";
import { useStockOverview, type StockItem } from "../../../lib/api/inventory";
import { NetworkError } from "../../../components/NetworkError";
import { useProductByBarcode } from "../../../lib/api/products";
import { BarcodeScanner } from "../../../components/BarcodeScanner";

function StockCard({ item }: { item: StockItem }) {
  const isLow =
    item.reorderPoint != null && item.currentStock <= item.reorderPoint;

  return (
    <Pressable
      style={styles.card}
      onPress={() =>
        router.push(
          `/(driver)/inventory/adjust?productId=${item.productId}&productName=${encodeURIComponent(item.productName)}&unit=${encodeURIComponent(item.unit)}&currentStock=${item.currentStock}` as any,
        )
      }
      accessibilityRole="button"
    >
      <View style={styles.cardLeft}>
        <Text style={styles.productName} numberOfLines={1}>
          {item.productName}
        </Text>
        <Text style={styles.unitText}>{item.unit}</Text>
      </View>
      <View style={styles.cardRight}>
        <View
          style={[
            styles.stockBadge,
            {
              backgroundColor: isLow ? colors.danger.bg : colors.success.bg,
            },
          ]}
        >
          <Text
            style={[
              styles.stockQty,
              { color: isLow ? colors.danger.DEFAULT : colors.success.DEFAULT },
            ]}
          >
            {item.currentStock}
          </Text>
          {isLow && (
            <Ionicons
              name="warning"
              size={13}
              color={colors.danger.DEFAULT}
              style={{ marginLeft: 3 }}
            />
          )}
        </View>
        <Ionicons name="chevron-forward" size={16} color="#cbd5e1" />
      </View>
    </Pressable>
  );
}

export default function InventoryScreen() {
  const { data: stock, isLoading, isError, refetch } = useStockOverview();
  const [search, setSearch] = useState("");
  const [showScanner, setShowScanner] = useState(false);
  const [scannedBarcode, setScannedBarcode] = useState<string | null>(null);

  const { data: barcodeProduct, isError: barcodeError } = useProductByBarcode(scannedBarcode);

  useEffect(() => {
    if (!barcodeProduct) return;
    const match = (stock ?? []).find((s) => s.productId === barcodeProduct.id);
    if (match) {
      router.push(
        `/(driver)/inventory/adjust?productId=${match.productId}&productName=${encodeURIComponent(match.productName)}&unit=${encodeURIComponent(match.unit)}&currentStock=${match.currentStock}` as any,
      );
    } else {
      Alert.alert("Not in Stock", `"${barcodeProduct.name}" was found but has no stock record.`);
    }
    setScannedBarcode(null);
  }, [barcodeProduct]);

  useEffect(() => {
    if (barcodeError && scannedBarcode) {
      Alert.alert("Not Found", "No product found for that barcode.");
      setScannedBarcode(null);
    }
  }, [barcodeError, scannedBarcode]);

  const filtered = (stock ?? []).filter((s) =>
    s.productName.toLowerCase().includes(search.toLowerCase()),
  );

  if (isLoading) {
    return (
      <>
        <Stack.Screen options={{ title: "Stock" }} />
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.brand[500]} />
        </View>
      </>
    );
  }

  if (isError) {
    return (
      <>
        <Stack.Screen options={{ title: "Stock" }} />
        <NetworkError onRetry={() => refetch()} />
      </>
    );
  }

  const lowStock = (stock ?? []).filter(
    (s) => s.reorderPoint != null && s.currentStock <= s.reorderPoint,
  );

  return (
    <>
      <Stack.Screen options={{ title: "Stock" }} />
      <View style={styles.container}>
        {/* Search */}
        <View style={styles.searchBar}>
          <Ionicons name="search-outline" size={18} color="#94a3b8" />
          <TextInput
            style={styles.searchInput}
            placeholder="Search products…"
            placeholderTextColor="#94a3b8"
            value={search}
            onChangeText={setSearch}
            returnKeyType="search"
            clearButtonMode="while-editing"
          />
          <Pressable
            onPress={() => setShowScanner(true)}
            accessibilityLabel="Scan barcode to find product"
            style={styles.scanBtn}
          >
            <Ionicons name="barcode-outline" size={22} color={colors.brand[500]} />
          </Pressable>
        </View>

        {/* Low stock alert */}
        {lowStock.length > 0 && !search && (
          <View style={styles.alertBanner}>
            <Ionicons name="warning-outline" size={16} color={colors.danger.DEFAULT} />
            <Text style={styles.alertText}>
              {lowStock.length} product{lowStock.length !== 1 ? "s" : ""} below reorder point
            </Text>
          </View>
        )}

        <FlatList
          data={filtered}
          keyExtractor={(item) => item.productId}
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator={false}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyText}>
                {search ? "No products match your search." : "No stock data."}
              </Text>
            </View>
          }
          renderItem={({ item }) => <StockCard item={item} />}
        />

        {/* Quick purchase FAB */}
        <Pressable
          style={styles.fab}
          onPress={() => router.push("/(driver)/inventory/purchase" as any)}
          accessibilityRole="button"
          accessibilityLabel="Record a purchase"
        >
          <Ionicons name="add" size={28} color="#fff" />
        </Pressable>
      </View>

      {/* Barcode scanner modal */}
      <Modal visible={showScanner} animationType="slide" onRequestClose={() => setShowScanner(false)}>
        <BarcodeScanner
          onScanned={(code) => {
            setShowScanner(false);
            setScannedBarcode(code);
          }}
          onClose={() => setShowScanner(false)}
        />
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surface.raised },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  searchBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    margin: 16,
    marginBottom: 8,
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    paddingHorizontal: 14,
    paddingVertical: 10,
    ...shadows.card,
  },
  searchInput: {
    flex: 1,
    fontSize: 16,
    fontFamily: "Inter_400Regular",
    color: colors.navy.DEFAULT,
  },
  scanBtn: {
    padding: 4,
  },
  alertBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 16,
    marginBottom: 8,
    backgroundColor: colors.danger.bg,
    borderRadius: borderRadius.DEFAULT,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  alertText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: colors.danger.DEFAULT,
  },
  list: {
    paddingHorizontal: 16,
    paddingBottom: 100,
    gap: 8,
  },
  empty: { alignItems: "center", paddingTop: 48 },
  emptyText: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
  },
  card: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 12,
    ...shadows.card,
  },
  cardLeft: { flex: 1, gap: 2 },
  productName: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: colors.navy.DEFAULT,
  },
  unitText: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
  },
  cardRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  stockBadge: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: borderRadius.full,
  },
  stockQty: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
  },
  fab: {
    position: "absolute",
    bottom: 28,
    right: 20,
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: colors.brand[500],
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 8,
  },
});
