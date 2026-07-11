import { useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { ios } from "@routeflow/ui/tokens";
import { SearchBar } from "@routeflow/ui/mobile/ios";
import { useAdminProducts, type AdminProduct } from "../lib/api/admin";
import { BarcodeScanner } from "./BarcodeScanner";
import { resolveProductByCode } from "../lib/barcode-resolve";
import { showToast } from "../lib/toast";

/**
 * Reusable searchable + scannable product picker sheet — replaces the dumb
 * capped OptionPickerSheet lists (200-item cap, no search, no scan). Search
 * hits the server (name/SKU/barcode), the barcode icon opens the camera, and
 * a scan resolves through the shared barcode→SKU→substring ladder.
 */
export function ProductPickerSheet({
  visible,
  selectedId,
  onClose,
  onSelect,
  title = "Product",
  standaloneOnly = false,
}: {
  visible: boolean;
  selectedId?: string;
  onClose: () => void;
  onSelect: (product: AdminProduct) => void;
  title?: string;
  /** Only offer standalone products (e.g. picking a variant PARENT). */
  standaloneOnly?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [scanOpen, setScanOpen] = useState(false);

  const { data, isLoading } = useAdminProducts({
    search: search.trim() || undefined,
    limit: 0,
  });
  const products = (data?.data ?? []).filter((p) => !standaloneOnly || !p.parentProductId);

  const pick = (p: AdminProduct) => {
    setSearch("");
    onSelect(p);
  };

  const onScanned = async (code: string) => {
    setScanOpen(false);
    const trimmed = code.trim();
    if (!trimmed) return;
    try {
      const result = await resolveProductByCode(trimmed);
      if (!result.notFound) {
        const hit = result.product as AdminProduct & { parentProductId?: string | null };
        if (standaloneOnly && hit.parentProductId) {
          // Scanned a variant while picking a parent — resolve to its parent.
          const parent = products.find((p) => p.id === hit.parentProductId);
          if (parent) {
            pick(parent);
            return;
          }
        } else {
          pick(hit as AdminProduct);
          return;
        }
      }
    } catch {
      // network error → fall through to the toast
    }
    showToast(`No product for "${trimmed}"`);
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.header}>
          <Text style={styles.title}>{title}</Text>
          <Pressable onPress={onClose} hitSlop={10}>
            <Ionicons name="close" size={20} color={ios.label2} />
          </Pressable>
        </View>

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

        <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
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
              {products.map((p) => {
                const stock =
                  typeof p.currentStock === "string" ? Number(p.currentStock) || 0 : p.currentStock;
                const label = p.parent?.name ? `${p.parent.name} - ${p.name}` : p.name;
                return (
                  <Pressable key={p.id} style={styles.row} onPress={() => pick(p)}>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={styles.name} numberOfLines={1}>
                        {label}
                      </Text>
                      <Text style={styles.meta} numberOfLines={1}>
                        {p.sku ? `SKU ${p.sku}` : "No SKU"}
                        {p.unit ? ` · ${p.unit}` : ""}
                      </Text>
                    </View>
                    <View style={styles.stockPill}>
                      <Text style={styles.stockText}>{stock}</Text>
                    </View>
                    {p.id === selectedId ? (
                      <Ionicons name="checkmark" size={16} color={ios.brand} />
                    ) : (
                      <Ionicons name="chevron-forward" size={16} color={ios.gray[3]} />
                    )}
                  </Pressable>
                );
              })}
            </View>
          )}
          <View style={{ height: 24 }} />
        </ScrollView>

        {scanOpen ? (
          <BarcodeScanner onScanned={(c) => void onScanned(c)} onClose={() => setScanOpen(false)} />
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)" },
  sheet: {
    maxHeight: "80%",
    minHeight: "55%",
    backgroundColor: ios.bg,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingTop: 6,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  title: { fontSize: 16, fontFamily: "Inter_700Bold", color: ios.label },
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
  meta: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  stockPill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: ios.brandWash,
  },
  stockText: { fontSize: 13, fontFamily: "Inter_700Bold", color: ios.brand },
});
