import { useMemo, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavAction, NavBackButton, NavBar, SearchBar } from "@routeflow/ui/mobile/ios";
import { useAdminProducts, type AdminProduct } from "../../../../lib/api/admin";
import {
  useTrackedCategories,
  useAssignProductsToCategory,
  useUnassignProductsFromCategory,
} from "../../../../lib/api/tracked-categories";
import { displayProductName } from "../../../../lib/product-display";
import { showToast } from "../../../../lib/toast";

export default function AssignProductsScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const hasSeeded = useRef(false);

  // Single fetch-all call (limit:0 sentinel — see WP2 header note), NOT the
  // paginated admin hook: seeding "currently assigned" from a partial page
  // would silently unassign not-yet-loaded products on Save.
  const { data, isLoading } = useAdminProducts({ limit: 0 });
  const { data: categories = [] } = useTrackedCategories();
  const assign = useAssignProductsToCategory();
  const unassign = useUnassignProductsFromCategory();

  const products = useMemo(() => data?.data ?? [], [data]);
  const catName = useMemo(() => {
    const m: Record<string, string> = {};
    for (const c of categories) m[c.id] = c.name;
    return m;
  }, [categories]);

  if (!hasSeeded.current && products.length > 0) {
    hasSeeded.current = true;
    selected.clear(); // defensive no-op on first run (Set starts empty)
    for (const p of products) if (p.trackedCategoryId === id) selected.add(p.id);
    setSelected(new Set(selected));
  }

  const q = search.trim().toLowerCase();
  const displayName = (p: AdminProduct) => displayProductName(p, products);
  const visible = q
    ? products.filter(
        (p) => displayName(p).toLowerCase().includes(q) || (p.sku ?? "").toLowerCase().includes(q),
      )
    : products;

  const toggle = (pid: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(pid) ? next.delete(pid) : next.add(pid);
      return next;
    });

  const [saving, setSaving] = useState(false);
  const handleSave = async () => {
    const toAssign = products
      .filter((p) => selected.has(p.id) && p.trackedCategoryId !== id)
      .map((p) => p.id);
    const toUnassign = products
      .filter((p) => !selected.has(p.id) && p.trackedCategoryId === id)
      .map((p) => p.id);
    if (toAssign.length === 0 && toUnassign.length === 0) {
      router.back();
      return;
    }
    setSaving(true);
    try {
      if (toAssign.length) await assign.mutateAsync({ id: id!, productIds: toAssign });
      if (toUnassign.length) await unassign.mutateAsync({ id: id!, productIds: toUnassign });
      showToast(`${toAssign.length} added · ${toUnassign.length} removed`);
      router.back();
    } catch (e: any) {
      showToast(e?.response?.data?.message ?? e?.message ?? "Failed to update products.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Assign products"
        leading={<NavBackButton onPress={() => router.back()} />}
        trailing={<NavAction label={saving ? "Saving…" : "Save"} bold onPress={handleSave} />}
      />
      <SearchBar placeholder="Search products…" value={search} onChangeText={setSearch} />
      <Text style={styles.hint}>
        {selected.size} selected · checking a product in another section moves it here.
      </Text>
      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={ios.brand} />
        </View>
      ) : (
        <FlatList
          data={visible}
          keyExtractor={(p) => p.id}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24 }}
          ListEmptyComponent={
            <View style={styles.center}>
              <Text style={styles.empty}>No products match.</Text>
            </View>
          }
          renderItem={({ item }) => {
            const checked = selected.has(item.id);
            const otherCat =
              item.trackedCategoryId && item.trackedCategoryId !== id
                ? catName[item.trackedCategoryId]
                : null;
            return (
              <Pressable style={styles.row} onPress={() => toggle(item.id)}>
                <Ionicons
                  name={checked ? "checkbox" : "square-outline"}
                  size={20}
                  color={checked ? ios.brand : ios.label3}
                />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.rowName} numberOfLines={1}>
                    {displayName(item)}
                  </Text>
                  {item.sku ? (
                    <Text style={styles.rowSub} numberOfLines={1}>
                      {item.sku}
                    </Text>
                  ) : null}
                </View>
                {otherCat ? (
                  <View style={styles.otherBadge}>
                    <Text style={styles.otherBadgeText}>in {otherCat}</Text>
                  </View>
                ) : null}
              </Pressable>
            );
          }}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center" },
  empty: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label2 },
  hint: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10 },
  rowName: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label },
  rowSub: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label3, marginTop: 1 },
  otherBadge: {
    backgroundColor: ios.system.orangeWash,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  otherBadgeText: { fontSize: 10, fontFamily: "Inter_500Medium", color: ios.system.orangeInk },
});
