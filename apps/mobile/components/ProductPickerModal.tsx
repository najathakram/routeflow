import { useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, borderRadius, shadows } from "@routeflow/ui/tokens";
import { useProducts } from "../lib/api/products";

export interface PickedProduct {
  id: string;
  name: string;
  unit: string;
  pricePerUnit: string;
}

interface Props {
  visible: boolean;
  onClose: () => void;
  /** Called when user confirms a product + quantity */
  onSelect: (product: PickedProduct, qty: number) => void;
  title?: string;
}

export function ProductPickerModal({ visible, onClose, onSelect, title = "Add Item" }: Props) {
  const { data: productsResponse, isLoading } = useProducts({ isActive: true });
  const products: any[] = Array.isArray(productsResponse)
    ? productsResponse
    : (productsResponse as any)?.data ?? [];
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<PickedProduct | null>(null);
  const [qty, setQty] = useState(1);

  const filtered = products.filter((p: any) =>
    p.name.toLowerCase().includes(search.toLowerCase()),
  );

  const handleClose = () => {
    setSearch("");
    setSelected(null);
    setQty(1);
    onClose();
  };

  const handleConfirm = () => {
    if (!selected || qty < 1) return;
    onSelect(selected, qty);
    setSearch("");
    setSelected(null);
    setQty(1);
  };

  const handleProductTap = (p: any) => {
    setSelected({ id: p.id, name: p.name, unit: p.unit, pricePerUnit: String(p.pricePerUnit) });
    setQty(1);
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={handleClose}>
      <View style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          {selected ? (
            <Pressable onPress={() => setSelected(null)} style={styles.backBtn} accessibilityLabel="Back to product list">
              <Ionicons name="arrow-back" size={22} color={colors.navy.DEFAULT} />
            </Pressable>
          ) : (
            <Pressable onPress={handleClose} style={styles.backBtn} accessibilityLabel="Close">
              <Ionicons name="close" size={22} color={colors.navy.DEFAULT} />
            </Pressable>
          )}
          <Text style={styles.headerTitle}>{selected ? selected.name : title}</Text>
          <View style={styles.backBtn} />
        </View>

        {selected ? (
          // ── Step 2: Quantity ────────────────────────────────────────────
          <View style={styles.qtyStep}>
            <View style={styles.selectedCard}>
              <Text style={styles.selectedName}>{selected.name}</Text>
              <Text style={styles.selectedUnit}>{selected.unit}</Text>
              <Text style={styles.selectedPrice}>
                ${parseFloat(selected.pricePerUnit).toFixed(2)} / {selected.unit}
              </Text>
            </View>

            <Text style={styles.qtyLabel}>Quantity</Text>
            <View style={styles.qtyStepper}>
              <Pressable
                style={styles.stepperBtn}
                onPress={() => setQty(Math.max(1, qty - 1))}
                accessibilityLabel="Decrease quantity"
              >
                <Ionicons name="remove" size={22} color={colors.navy.DEFAULT} />
              </Pressable>
              <TextInput
                style={styles.stepperInput}
                value={String(qty)}
                onChangeText={(v) => { const n = parseInt(v, 10); if (!isNaN(n) && n > 0) setQty(n); }}
                keyboardType="number-pad"
                selectTextOnFocus
              />
              <Pressable
                style={styles.stepperBtn}
                onPress={() => setQty(qty + 1)}
                accessibilityLabel="Increase quantity"
              >
                <Ionicons name="add" size={22} color={colors.navy.DEFAULT} />
              </Pressable>
            </View>

            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Line total</Text>
              <Text style={styles.totalValue}>
                ${(qty * parseFloat(selected.pricePerUnit)).toFixed(2)}
              </Text>
            </View>

            <Pressable style={styles.confirmBtn} onPress={handleConfirm} accessibilityRole="button">
              <Ionicons name="add-circle" size={20} color="#fff" />
              <Text style={styles.confirmBtnText}>Add {qty} × {selected.name}</Text>
            </Pressable>
          </View>
        ) : (
          // ── Step 1: Product list ────────────────────────────────────────
          <>
            <View style={styles.searchBar}>
              <Ionicons name="search-outline" size={18} color="#94a3b8" />
              <TextInput
                style={styles.searchInput}
                placeholder="Search products…"
                placeholderTextColor="#94a3b8"
                value={search}
                onChangeText={setSearch}
                clearButtonMode="while-editing"
                autoFocus
              />
            </View>

            {isLoading ? (
              <View style={styles.centered}>
                <ActivityIndicator size="large" color={colors.brand[500]} />
              </View>
            ) : (
              <FlatList
                data={filtered}
                keyExtractor={(p: any) => p.id}
                contentContainerStyle={styles.list}
                showsVerticalScrollIndicator={false}
                ListEmptyComponent={
                  <View style={styles.centered}>
                    <Text style={styles.emptyText}>No products found.</Text>
                  </View>
                }
                renderItem={({ item: p }: { item: any }) => (
                  <Pressable
                    style={styles.productRow}
                    onPress={() => handleProductTap(p)}
                    accessibilityRole="button"
                    accessibilityLabel={p.name}
                  >
                    <View style={styles.productInfo}>
                      <Text style={styles.productName}>{p.name}</Text>
                      <Text style={styles.productMeta}>
                        {p.unit} · ${parseFloat(String(p.pricePerUnit)).toFixed(2)} each
                      </Text>
                    </View>
                    <Ionicons name="chevron-forward" size={16} color="#cbd5e1" />
                  </Pressable>
                )}
              />
            )}
          </>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surface.raised },

  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 8,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.surface.border,
    backgroundColor: "#fff",
  },
  backBtn: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  headerTitle: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
    flex: 1,
    textAlign: "center",
  },

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

  list: { paddingHorizontal: 16, paddingBottom: 40, gap: 6 },

  productRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 12,
    ...shadows.card,
  },
  productInfo: { flex: 1, gap: 2 },
  productName: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: colors.navy.DEFAULT,
  },
  productMeta: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },

  centered: { flex: 1, alignItems: "center", justifyContent: "center", paddingTop: 48 },
  emptyText: { fontSize: 15, fontFamily: "Inter_400Regular", color: "#94a3b8" },

  // ── Step 2 ──
  qtyStep: {
    flex: 1,
    padding: 20,
    gap: 20,
  },
  selectedCard: {
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    padding: 20,
    gap: 4,
    alignItems: "center",
    ...shadows.card,
  },
  selectedName: {
    fontSize: 20,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
    textAlign: "center",
  },
  selectedUnit: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },
  selectedPrice: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: colors.brand[500],
    marginTop: 4,
  },

  qtyLabel: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: "#94a3b8",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  qtyStepper: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 0,
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    ...shadows.card,
    overflow: "hidden",
  },
  stepperBtn: {
    width: 56,
    height: 64,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface.raised,
  },
  stepperInput: {
    flex: 1,
    height: 64,
    textAlign: "center",
    fontSize: 32,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },

  totalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 4,
  },
  totalLabel: { fontSize: 15, fontFamily: "Inter_400Regular", color: "#64748b" },
  totalValue: { fontSize: 20, fontFamily: "Inter_700Bold", color: colors.navy.DEFAULT },

  confirmBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    backgroundColor: colors.brand[500],
    borderRadius: borderRadius.lg,
    height: 56,
    marginTop: "auto" as any,
  },
  confirmBtnText: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: "#fff",
  },
});
