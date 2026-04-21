import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavAction, NavBackButton, NavBar } from "@routeflow/ui/mobile/ios";
import { useSuppliers, type Supplier } from "../../../lib/api/purchase-orders";

export default function SuppliersScreen() {
  const router = useRouter();
  const { data: suppliers, isLoading, isFetching, refetch } = useSuppliers();

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        largeTitle="Suppliers"
        leading={<NavBackButton label="Back" onPress={() => router.back()} />}
        trailing={
          <NavAction
            label="Add"
            bold
            onPress={() => router.push("/(operator)/suppliers/new")}
          />
        }
      />

      <ScrollView
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={isFetching && !isLoading} onRefresh={refetch} />
        }
      >
        {isLoading ? (
          <View style={styles.center}>
            <ActivityIndicator color={ios.brand} />
          </View>
        ) : !suppliers || suppliers.length === 0 ? (
          <View style={styles.center}>
            <Ionicons name="business-outline" size={40} color={ios.label3} />
            <Text style={styles.emptyTitle}>No suppliers yet</Text>
            <Text style={styles.emptyBody}>Tap Add to create your first supplier.</Text>
          </View>
        ) : (
          <View style={{ padding: 16, gap: 12 }}>
            {suppliers.map((s) => (
              <SupplierRow
                key={s.id}
                supplier={s}
                onPress={() => router.push(`/(operator)/suppliers/${s.id}/edit`)}
              />
            ))}
          </View>
        )}
        <View style={{ height: 24 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

function SupplierRow({ supplier, onPress }: { supplier: Supplier; onPress: () => void }) {
  return (
    <Pressable style={styles.card} onPress={onPress}>
      <View style={{ flex: 1 }}>
        <Text style={styles.name}>{supplier.name}</Text>
        {supplier.contactName ? (
          <Text style={styles.meta}>{supplier.contactName}</Text>
        ) : null}
        {supplier.email ? (
          <Text style={styles.meta}>{supplier.email}</Text>
        ) : null}
        {supplier.phone ? (
          <Text style={styles.meta}>{supplier.phone}</Text>
        ) : null}
      </View>
      <Ionicons name="chevron-forward" size={16} color={ios.label3} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 48, alignItems: "center", gap: 8 },
  emptyTitle: { fontSize: 16, fontFamily: "Inter_600SemiBold", color: ios.label },
  emptyBody: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2, textAlign: "center" },
  card: {
    backgroundColor: ios.bgElev,
    borderRadius: 14,
    padding: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  name: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },
  meta: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
});
