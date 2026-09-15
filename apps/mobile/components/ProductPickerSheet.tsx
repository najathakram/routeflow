import { useEffect, useState } from "react";
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
import { type AdminProduct } from "../lib/api/admin";
import { useAdminProductSearch } from "../lib/use-product-search";
import { BarcodeScanner } from "./BarcodeScanner";
import { archivedMessage, resolveProductByCode } from "../lib/barcode-resolve";
import { showToast } from "../lib/toast";
import { apiClient } from "../lib/api-client";

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
  activeOnly = false,
  initialSearch,
}: {
  visible: boolean;
  selectedId?: string;
  onClose: () => void;
  onSelect: (product: AdminProduct) => void;
  title?: string;
  /** Only offer standalone products (e.g. picking a variant PARENT). */
  standaloneOnly?: boolean;
  /**
   * B142: filter archived products out of the list — for the order/invoice/
   * standing-order (template) callers, where picking one commits a brand-new
   * line. Stock-count, PO-receive, vendor-bill-scan, and variant-parent
   * pickers need the unfiltered catalog and leave this false.
   */
  activeOnly?: boolean;
  /**
   * Pre-fill the search box each time the sheet opens. Used by the sale
   * builders when a scanned code has several substring matches: the sheet opens
   * already showing them, so choosing is one tap.
   */
  initialSearch?: string;
}) {
  const [scanOpen, setScanOpen] = useState(false);
  // The catalogue loads only when the operator asks for it — a typed/scanned
  // term or a deliberate "Browse catalogue" tap (owner ask 2026-09-14) —
  // instead of the old `limit: 0` fetch-all (10,000-row clamp server-side,
  // one presigned thumbnail URL per row). Resets on close so the next open
  // starts quiet again.
  const [browsing, setBrowsing] = useState(false);
  const {
    search,
    setSearch,
    products: rows,
    isLoading,
    idle,
    isPlaceholder,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
  } = useAdminProductSearch<AdminProduct>({
    enabled: visible,
    browsing,
    // B142: parity with web's SearchableProductPicker — filter archived
    // products out of the manual tap list rather than letting them be
    // committed as a brand-new line (the scan path was already guarded).
    // Opt-in only: see the `activeOnly` prop doc above.
    isActive: activeOnly ? true : undefined,
  });
  const products = rows.filter((p) => !standaloneOnly || !p.parentProductId);

  // Re-seed on each open — `initialSearch` is a different scanned code each
  // time — and drop browse so the next open starts quiet again.
  useEffect(() => {
    if (visible) setSearch(initialSearch ?? "");
    else setBrowsing(false);
  }, [visible, initialSearch, setSearch]);

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
      if (result.archived) {
        // F30 / R5: this sheet feeds sale, purchase and count lines — handing
        // an archived product to `onSelect` commits it. Name it instead; the
        // "No product" toast below would be a lie.
        showToast(archivedMessage(result.product));
        return;
      }
      if (!result.notFound) {
        const hit = result.product as AdminProduct & { parentProductId?: string | null };
        if (standaloneOnly && hit.parentProductId) {
          // Scanned a variant while picking a parent — resolve to its parent
          // directly. The page rows are now gated on a term/browse, so a
          // scanned variant would otherwise always miss the local `find`.
          const { data: parent } = await apiClient.get<AdminProduct>(
            `/products/${hit.parentProductId}`,
          );
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

        <ScrollView
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
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
              <Text style={styles.empty}>Scan or search to find a product.</Text>
              <Pressable
                onPress={() => setBrowsing(true)}
                accessibilityRole="button"
                accessibilityLabel="Browse the full catalogue"
              >
                <Text style={styles.empty}>Browse catalogue</Text>
              </Pressable>
            </View>
          ) : products.length === 0 ? (
            <View style={styles.center}>
              <Text style={styles.empty}>No matches.</Text>
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
                        {/* This list is unfiltered by `isActive`, and a scan that
                            resolved ambiguously seeds it — so an archived row can
                            sit next to sellable ones. Say which it is (F30 / R5)
                            rather than letting it be picked as an ordinary line. */}
                        {p.isActive === false ? " · Archived" : ""}
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
          {isFetchingNextPage ? (
            <View style={styles.center}>
              <ActivityIndicator color={ios.brand} />
            </View>
          ) : null}
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
  center: { padding: 40, alignItems: "center", gap: 10 },
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
