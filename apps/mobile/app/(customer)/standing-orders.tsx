import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavBackButton, NavBar } from "@routeflow/ui/mobile/ios";
import { useBuyerTemplates, useBuyerReorder } from "../../lib/api/buyer";
import { showToast } from "../../lib/toast";
import { Alert } from "react-native";

export default function StandingOrdersScreen() {
  const router = useRouter();
  const { data: templates, isLoading } = useBuyerTemplates();
  const reorderMut = useBuyerReorder();

  const onReorder = (id: string, name: string) =>
    Alert.alert(`Reorder from "${name}"?`, "A new order will be created.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Reorder",
        onPress: () =>
          reorderMut.mutate(id, {
            onSuccess: (order) => {
              showToast("Order created");
              router.push(`/(customer)/orders/${order.id}`);
            },
            onError: (e: any) =>
              Alert.alert("Error", e?.response?.data?.message ?? "Try again."),
          }),
      },
    ]);

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Standing Orders"
        leading={<NavBackButton label="Back" onPress={() => router.back()} />}
      />
      <ScrollView showsVerticalScrollIndicator={false}>
        {isLoading ? (
          <View style={styles.center}><ActivityIndicator color={ios.brand} /></View>
        ) : !templates || templates.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.empty}>No standing orders.</Text>
          </View>
        ) : (
          <View style={styles.list}>
            {templates.map((t) => (
              <View key={t.id} style={styles.card}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.cardName}>{t.name ?? "Standing order"}</Text>
                  <Text style={styles.cardMeta}>
                    {t.frequencyLabel ?? t.frequency ?? ""} · {t.items?.length ?? 0} items
                  </Text>
                </View>
                <Pressable
                  style={styles.reorderBtn}
                  onPress={() => onReorder(t.id, t.name ?? "Standing order")}
                  disabled={reorderMut.isPending}
                >
                  <Ionicons name="refresh-outline" size={14} color={ios.brand} />
                  <Text style={styles.reorderText}>Reorder</Text>
                </Pressable>
              </View>
            ))}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center" },
  empty: { fontSize: 15, fontFamily: "Inter_500Medium", color: ios.label2 },
  list: { paddingHorizontal: 16, gap: 8, paddingBottom: 32 },
  card: {
    backgroundColor: ios.bgElev,
    borderRadius: 14,
    padding: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  cardName: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },
  cardMeta: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  reorderBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: ios.brandWash,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  reorderText: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: ios.brand },
});
