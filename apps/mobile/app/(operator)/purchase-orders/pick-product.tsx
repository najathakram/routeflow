import { useState } from "react";
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
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import {
  NavBackButton,
  NavBar,
  SearchBar,
} from "@routeflow/ui/mobile/ios";
import { useAdminProducts, type AdminProduct } from "../../../lib/api/admin";
import { useProductPickerStore } from "../../../store/productPickerStore";

export default function PickProductScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ callbackKey?: string }>();
  const callbackKey = params.callbackKey ?? "default";

  const [search, setSearch] = useState("");
  const { data, isLoading } = useAdminProducts({
    isActive: true,
    limit: 200,
    search: search.trim() || undefined,
  });
  const products = data?.data ?? [];

  const setSelection = useProductPickerStore((s) => s.setSelection);

  const pick = (p: AdminProduct) => {
    setSelection(callbackKey, {
      id: p.id,
      name: p.name,
      standardCost: p.standardCost != null ? Number(p.standardCost) : undefined,
    });
    router.back();
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Select product"
        leading={<NavBackButton label="Cancel" onPress={() => router.back()} />}
      />
      <SearchBar
        placeholder="Search products…"
        value={search}
        onChangeText={setSearch}
      />
      <ScrollView showsVerticalScrollIndicator={false}>
        {isLoading ? (
          <View style={styles.center}>
            <ActivityIndicator color={ios.brand} />
          </View>
        ) : products.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.empty}>
              {search ? "No products match." : "No active products."}
            </Text>
          </View>
        ) : (
          <View style={styles.list}>
            {products.map((p, i) => (
              <Pressable
                key={p.id}
                style={[
                  styles.row,
                  i > 0 && {
                    borderTopWidth: StyleSheet.hairlineWidth,
                    borderTopColor: ios.separator,
                  },
                ]}
                onPress={() => pick(p)}
              >
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.name} numberOfLines={1}>
                    {p.name}
                  </Text>
                  <Text style={styles.sub} numberOfLines={1}>
                    {[
                      p.sku ? `SKU ${p.sku}` : null,
                      p.standardCost != null
                        ? `$${Number(p.standardCost).toFixed(2)}`
                        : null,
                      p.unit,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={16} color={ios.gray[3]} />
              </Pressable>
            ))}
          </View>
        )}
        <View style={{ height: 20 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center" },
  empty: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label2 },
  list: {
    marginHorizontal: 16,
    backgroundColor: ios.bgElev,
    borderRadius: 12,
    overflow: "hidden",
    marginTop: 4,
  },
  row: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  name: { fontSize: 15, fontFamily: "Inter_500Medium", color: ios.label },
  sub: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
});
