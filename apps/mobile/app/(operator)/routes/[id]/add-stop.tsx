import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
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
import { NavBackButton, NavBar, SearchBar } from "@routeflow/ui/mobile/ios";
import { useAdminCustomers } from "../../../../lib/api/admin";
import { useAddRouteStop } from "../../../../lib/api/routes";
import { showToast } from "../../../../lib/toast";

export default function AddStopScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [search, setSearch] = useState("");
  const { data, isLoading } = useAdminCustomers({
    search: search.trim() || undefined,
    limit: 100,
  });
  const customers = data?.data ?? [];
  const mut = useAddRouteStop();

  const add = (customerId: string) => {
    if (!id) return;
    mut.mutate(
      { routeId: id, customerId },
      {
        onSuccess: () => {
          showToast("Stop added");
          router.back();
        },
        onError: (e: any) =>
          Alert.alert("Couldn't add", e?.response?.data?.message ?? e?.message ?? "Try again."),
      },
    );
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Add stop"
        leading={<NavBackButton label="Cancel" onPress={() => router.back()} />}
      />
      <SearchBar
        placeholder="Search customers…"
        value={search}
        onChangeText={setSearch}
      />
      <ScrollView showsVerticalScrollIndicator={false}>
        {isLoading ? (
          <View style={styles.center}>
            <ActivityIndicator color={ios.brand} />
          </View>
        ) : customers.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.empty}>No customers found.</Text>
          </View>
        ) : (
          <View style={{ paddingHorizontal: 16, gap: 6, paddingBottom: 24 }}>
            {customers.map((c) => (
              <Pressable
                key={c.id}
                style={styles.row}
                onPress={() => add(c.id)}
                disabled={mut.isPending}
              >
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.name} numberOfLines={1}>
                    {c.businessName}
                  </Text>
                  {c.contactName ? (
                    <Text style={styles.sub} numberOfLines={1}>
                      {c.contactName}
                    </Text>
                  ) : null}
                </View>
                <Ionicons name="add-circle" size={22} color={ios.brand} />
              </Pressable>
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
  empty: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label2 },
  row: {
    backgroundColor: ios.bgElev,
    borderRadius: 12,
    padding: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  name: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },
  sub: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
});
