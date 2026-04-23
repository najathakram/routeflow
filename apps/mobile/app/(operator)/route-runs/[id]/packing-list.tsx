import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavBackButton, NavBar } from "@routeflow/ui/mobile/ios";
import { usePackingList } from "../../../lib/api/routes";

export default function PackingListScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data, isLoading } = usePackingList(id);

  const items = Array.isArray(data) ? data : (data as any)?.packingList ?? [];

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Packing list"
        leading={<NavBackButton label="Run" onPress={() => router.back()} />}
      />
      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={ios.brand} />
        </View>
      ) : items.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.empty}>No items on this run.</Text>
        </View>
      ) : (
        <ScrollView showsVerticalScrollIndicator={false}>
          <View style={{ padding: 16, gap: 10 }}>
            {items.map((item: any, i: number) => (
              <View key={item.productId ?? i} style={styles.card}>
                <View style={styles.cardHead}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.productName}>{item.productName ?? "Product"}</Text>
                    {item.sku ? <Text style={styles.sku}>SKU: {item.sku}</Text> : null}
                  </View>
                  <View style={styles.totalBadge}>
                    <Text style={styles.totalText}>
                      {item.totalQty} {item.unit ?? ""}
                    </Text>
                  </View>
                </View>
                {(item.customers ?? []).length > 0 ? (
                  <View style={styles.customerList}>
                    {(item.customers as { name: string; qty: number }[]).map((c, ci) => (
                      <View
                        key={ci}
                        style={[
                          styles.customerRow,
                          ci > 0 && {
                            borderTopWidth: StyleSheet.hairlineWidth,
                            borderTopColor: ios.separator,
                          },
                        ]}
                      >
                        <Text style={styles.customerName} numberOfLines={1}>
                          {c.name}
                        </Text>
                        <Text style={styles.customerQty}>
                          {c.qty} {item.unit ?? ""}
                        </Text>
                      </View>
                    ))}
                  </View>
                ) : null}
              </View>
            ))}
          </View>
          <View style={{ height: 24 }} />
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 40 },
  empty: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label2, textAlign: "center" },
  card: { backgroundColor: ios.bgElev, borderRadius: 14, overflow: "hidden" },
  cardHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 14,
  },
  productName: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },
  sku: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  totalBadge: {
    backgroundColor: ios.brandWash,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
  },
  totalText: { fontSize: 14, fontFamily: "Inter_700Bold", color: ios.brand },
  customerList: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
    paddingHorizontal: 14,
  },
  customerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 9,
  },
  customerName: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2, flex: 1 },
  customerQty: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: ios.label },
});
