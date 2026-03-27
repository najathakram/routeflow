import { useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { router, Stack } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors, borderRadius, shadows } from "@routeflow/ui/tokens";
import { useCustomers, type CustomerSummary } from "../../../lib/api/customers";

function callPhone(phone: string) {
  Linking.openURL(`tel:${phone.replace(/\s/g, "")}`).catch(() =>
    Alert.alert("Could not open Phone", "Please dial " + phone + " manually."),
  );
}

function CustomerCard({ customer }: { customer: CustomerSummary }) {
  const initials = customer.businessName
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");

  return (
    <Pressable
      style={styles.card}
      onPress={() => router.push(`/(driver)/customers/${customer.id}` as any)}
      accessibilityRole="button"
      accessibilityLabel={`View ${customer.businessName}`}
    >
      <View style={styles.cardAvatar}>
        <Text style={styles.cardAvatarText}>{initials || "?"}</Text>
      </View>

      <View style={styles.cardBody}>
        <Text style={styles.cardName}>{customer.businessName}</Text>
        {customer.contactName ? (
          <Text style={styles.cardContact}>{customer.contactName}</Text>
        ) : null}
        {customer.phone ? (
          <Text style={styles.cardPhone}>{customer.phone}</Text>
        ) : null}
      </View>

      <View style={styles.cardActions}>
        {customer.phone ? (
          <Pressable
            style={styles.callBtn}
            onPress={(e) => {
              e.stopPropagation();
              callPhone(customer.phone!);
            }}
            accessibilityLabel={`Call ${customer.businessName}`}
          >
            <Ionicons name="call" size={18} color={colors.brand[500]} />
          </Pressable>
        ) : null}
        <Ionicons name="chevron-forward" size={18} color="#94a3b8" />
      </View>
    </Pressable>
  );
}

export default function CustomersScreen() {
  const [search, setSearch] = useState("");
  const { data, isLoading } = useCustomers(search);
  const customers = data?.data ?? [];

  const filtered = search
    ? customers.filter(
        (c) =>
          c.businessName.toLowerCase().includes(search.toLowerCase()) ||
          (c.contactName ?? "").toLowerCase().includes(search.toLowerCase()) ||
          (c.phone ?? "").includes(search),
      )
    : customers;

  return (
    <>
      <Stack.Screen options={{ title: "Customers" }} />
      <View style={styles.container}>
        {/* Search bar */}
        <View style={styles.searchWrapper}>
          <View style={styles.searchBox}>
            <Ionicons name="search-outline" size={18} color="#94a3b8" />
            <TextInput
              style={styles.searchInput}
              placeholder="Search by name, contact, phone…"
              placeholderTextColor="#94a3b8"
              value={search}
              onChangeText={setSearch}
              returnKeyType="search"
              clearButtonMode="while-editing"
            />
          </View>
        </View>

        {isLoading ? (
          <View style={styles.centered}>
            <ActivityIndicator size="large" color={colors.brand[500]} />
          </View>
        ) : filtered.length === 0 ? (
          <View style={styles.centered}>
            <Ionicons name="business-outline" size={48} color="#cbd5e1" style={{ marginBottom: 12 }} />
            <Text style={styles.emptyTitle}>
              {search ? "No results found" : "No customers yet"}
            </Text>
            {search ? (
              <Text style={styles.emptySubtitle}>Try a different search term</Text>
            ) : null}
          </View>
        ) : (
          <ScrollView
            contentContainerStyle={styles.list}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            <Text style={styles.countLabel}>
              {filtered.length} customer{filtered.length !== 1 ? "s" : ""}
            </Text>
            {filtered.map((c) => (
              <CustomerCard key={c.id} customer={c} />
            ))}
          </ScrollView>
        )}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surface.raised },
  searchWrapper: {
    backgroundColor: "#fff",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.surface.border,
  },
  searchBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: colors.surface.raised,
    borderRadius: borderRadius.DEFAULT,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: colors.surface.border,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: colors.navy.DEFAULT,
  },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  emptyTitle: {
    fontSize: 17,
    fontFamily: "Inter_600SemiBold",
    color: colors.navy.DEFAULT,
    marginBottom: 4,
  },
  emptySubtitle: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
  },
  list: {
    padding: 16,
    gap: 10,
    paddingBottom: 32,
  },
  countLabel: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: "#94a3b8",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  card: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    padding: 14,
    gap: 12,
    ...shadows.card,
  },
  cardAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.brand[50],
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  cardAvatarText: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: colors.brand[600] ?? colors.brand[500],
  },
  cardBody: { flex: 1, gap: 2 },
  cardName: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  cardContact: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },
  cardPhone: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: colors.brand[500],
  },
  cardActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexShrink: 0,
  },
  callBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.brand[50],
    alignItems: "center",
    justifyContent: "center",
  },
});
