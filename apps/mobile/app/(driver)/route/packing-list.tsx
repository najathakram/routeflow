import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors, borderRadius, shadows } from "@routeflow/ui/tokens";
import { usePackingList } from "../../../lib/api/routes";
import { NetworkError } from "../../../components/NetworkError";

export default function PackingListScreen() {
  const { runId } = useLocalSearchParams<{ runId: string }>();
  const { data: items, isLoading, isError, refetch } = usePackingList(runId ?? "");

  if (isLoading) {
    return (
      <>
        <Stack.Screen options={{ title: "Packing List", headerBackTitle: "Route" }} />
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.brand[500]} />
        </View>
      </>
    );
  }

  if (isError) {
    return (
      <>
        <Stack.Screen options={{ title: "Packing List", headerBackTitle: "Route" }} />
        <NetworkError onRetry={() => refetch()} />
      </>
    );
  }

  const list = items ?? [];

  return (
    <>
      <Stack.Screen options={{ title: "Packing List", headerBackTitle: "Route" }} />
      <FlatList
        data={list}
        keyExtractor={(item) => item.productId}
        style={styles.list}
        contentContainerStyle={styles.content}
        ListHeaderComponent={
          <Text style={styles.subtitle}>
            {list.length} product{list.length !== 1 ? "s" : ""} to pack
          </Text>
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="checkmark-done-circle-outline" size={48} color="#cbd5e1" />
            <Text style={styles.emptyText}>No items in this run.</Text>
          </View>
        }
        renderItem={({ item }) => (
          <View style={styles.card}>
            {/* Product name + total qty */}
            <View style={styles.cardHeader}>
              <View style={styles.qtyBubble}>
                <Text style={styles.qtyBubbleText}>{item.totalQty}</Text>
              </View>
              <View style={styles.cardInfo}>
                <Text style={styles.productName}>{item.productName}</Text>
                <Text style={styles.unitText}>{item.unit}</Text>
              </View>
            </View>

            {/* Per-customer breakdown */}
            {item.customers?.length > 0 && (
              <View style={styles.stopsBox}>
                {item.customers.map((c, idx) => (
                  <View
                    key={idx}
                    style={[
                      styles.stopRow,
                      idx === item.customers.length - 1 && styles.stopRowLast,
                    ]}
                  >
                    <Text style={styles.stopName} numberOfLines={1}>
                      {c.name}
                    </Text>
                    <Text style={styles.stopQty}>× {c.qty}</Text>
                  </View>
                ))}
              </View>
            )}
          </View>
        )}
      />
    </>
  );
}

const styles = StyleSheet.create({
  list: { backgroundColor: colors.surface.raised },
  content: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 32,
    gap: 12,
  },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  subtitle: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: "#94a3b8",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  empty: {
    alignItems: "center",
    paddingTop: 64,
    gap: 12,
  },
  emptyText: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
  },
  card: {
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    padding: 16,
    gap: 12,
    ...shadows.card,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
  },
  qtyBubble: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.brand[500],
    alignItems: "center",
    justifyContent: "center",
  },
  qtyBubbleText: {
    fontSize: 20,
    fontFamily: "Inter_700Bold",
    color: "#fff",
  },
  cardInfo: { flex: 1 },
  productName: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  unitText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
    marginTop: 2,
  },
  stopsBox: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.surface.border,
    paddingTop: 8,
  },
  stopRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.surface.border,
  },
  stopRowLast: { borderBottomWidth: 0 },
  stopNumBubble: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: colors.surface.raised,
    borderWidth: 1,
    borderColor: colors.surface.border,
    alignItems: "center",
    justifyContent: "center",
  },
  stopNumText: {
    fontSize: 12,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  stopName: {
    flex: 1,
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: colors.navy.DEFAULT,
  },
  stopQty: {
    fontSize: 14,
    fontFamily: "Inter_700Bold",
    color: colors.brand[500],
  },
});
