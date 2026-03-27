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

function StockCard({
  item,
  onPress,
}: {
  item: StockItem;
  onPress: (item: StockItem) => void;
}) {
  const isLow =
    item.reorderPoint != null && item.currentStock <= item.reorderPoint;

  return (
    <Pressable
      style={styles.card}
      onPress={() => onPress(item)}
      accessibilityRole="button"
      accessibilityLabel={`${item.productName}, ${item.currentStock} in stock — tap for options`}
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
        <Ionicons name="ellipsis-horizontal" size={18} color="#94a3b8" />
      </View>
    </Pressable>
  );
}

export default function InventoryScreen() {
  const { data: stock, isLoading, isError, refetch } = useStockOverview();
  const [search, setSearch] = useState("");
  const [showScanner, setShowScanner] = useState(false);
  const [scannedBarcode, setScannedBarcode] = useState<string | null>(null);
  const [actionItem, setActionItem] = useState<StockItem | null>(null);

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
          renderItem={({ item }) => (
            <StockCard item={item} onPress={(i) => setActionItem(i)} />
          )}
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

      {/* Stock item action sheet */}
      <Modal
        visible={!!actionItem}
        transparent
        animationType="fade"
        onRequestClose={() => setActionItem(null)}
      >
        <Pressable
          style={styles.actionOverlay}
          onPress={() => setActionItem(null)}
        >
          <View style={styles.actionSheet}>
            <View style={styles.actionSheetHandle} />
            <Text style={styles.actionSheetTitle} numberOfLines={1}>
              {actionItem?.productName}
            </Text>
            <Text style={styles.actionSheetStock}>
              Current stock: {actionItem?.currentStock} {actionItem?.unit}
            </Text>

            <Pressable
              style={styles.actionSheetBtn}
              onPress={() => {
                const i = actionItem;
                setActionItem(null);
                if (i) {
                  router.push(
                    `/(driver)/inventory/adjust?productId=${i.productId}&productName=${encodeURIComponent(i.productName)}&unit=${encodeURIComponent(i.unit)}&currentStock=${i.currentStock}` as any,
                  );
                }
              }}
            >
              <View style={[styles.actionSheetIconWrap, { backgroundColor: colors.brand[50] }]}>
                <Ionicons name="clipboard-outline" size={22} color={colors.brand[500]} />
              </View>
              <View style={styles.actionSheetBtnText}>
                <Text style={styles.actionSheetBtnLabel}>Adjust Stock</Text>
                <Text style={styles.actionSheetBtnSub}>Correct count, add or remove stock</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color="#cbd5e1" />
            </Pressable>

            <View style={styles.actionSheetDivider} />

            <Pressable
              style={styles.actionSheetBtn}
              onPress={() => {
                const i = actionItem;
                setActionItem(null);
                if (i) {
                  router.push(
                    `/(driver)/inventory/purchase?productId=${i.productId}&productName=${encodeURIComponent(i.productName)}` as any,
                  );
                }
              }}
            >
              <View style={[styles.actionSheetIconWrap, { backgroundColor: "#f0fdf4" }]}>
                <Ionicons name="bag-add-outline" size={22} color={colors.success.DEFAULT} />
              </View>
              <View style={styles.actionSheetBtnText}>
                <Text style={styles.actionSheetBtnLabel}>Record Purchase</Text>
                <Text style={styles.actionSheetBtnSub}>Log a delivery or stock receipt</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color="#cbd5e1" />
            </Pressable>

            <Pressable
              style={[styles.actionSheetBtn, { marginTop: 8, justifyContent: "center" }]}
              onPress={() => setActionItem(null)}
            >
              <Text style={styles.actionSheetCancelText}>Cancel</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>

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
  actionOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.4)",
    justifyContent: "flex-end",
  },
  actionSheet: {
    backgroundColor: "#fff",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    paddingBottom: 36,
    gap: 4,
  },
  actionSheetHandle: {
    width: 36,
    height: 4,
    backgroundColor: colors.surface.border,
    borderRadius: 2,
    alignSelf: "center",
    marginBottom: 12,
  },
  actionSheetTitle: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
    marginBottom: 2,
  },
  actionSheetStock: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
    marginBottom: 12,
  },
  actionSheetBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingVertical: 12,
    paddingHorizontal: 4,
  },
  actionSheetIconWrap: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  actionSheetBtnText: {
    flex: 1,
    gap: 2,
  },
  actionSheetBtnLabel: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: colors.navy.DEFAULT,
  },
  actionSheetBtnSub: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },
  actionSheetDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.surface.border,
    marginHorizontal: 4,
  },
  actionSheetCancelText: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    color: "#64748b",
    textAlign: "center",
  },
});
