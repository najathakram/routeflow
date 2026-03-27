import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import { colors, borderRadius, shadows } from "@routeflow/ui/tokens";
import { useCustomer } from "../../../lib/api/customers";
import { NetworkError } from "../../../components/NetworkError";
import { apiClient } from "../../../lib/api-client";

function callPhone(phone: string) {
  Linking.openURL(`tel:${phone.replace(/\s/g, "")}`).catch(() =>
    Alert.alert("Could not open Phone", "Please dial " + phone + " manually."),
  );
}

export default function CustomerDetailFromListScreen() {
  const { customerId } = useLocalSearchParams<{ customerId: string }>();
  const { data: customer, isLoading, isError, refetch } = useCustomer(customerId ?? "");

  const { data: invoicesData } = useQuery({
    queryKey: ["invoices", "customer", customerId],
    queryFn: () =>
      apiClient
        .get("/invoices", { params: { customerId, limit: 5 } })
        .then((r) => r.data),
    enabled: !!customerId,
    staleTime: 60_000,
  });
  const invoices = invoicesData?.data ?? [];

  if (isLoading) {
    return (
      <>
        <Stack.Screen options={{ title: "Customer", headerBackTitle: "Customers" }} />
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.brand[500]} />
        </View>
      </>
    );
  }

  if (isError || !customer) {
    return (
      <>
        <Stack.Screen options={{ title: "Customer", headerBackTitle: "Customers" }} />
        <NetworkError onRetry={() => refetch()} />
      </>
    );
  }

  const defaultAddress =
    customer.addresses?.find((a) => a.isDefault) ?? customer.addresses?.[0];

  return (
    <>
      <Stack.Screen
        options={{ title: customer.businessName, headerBackTitle: "Customers" }}
      />
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        {/* Business card */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <View style={styles.iconCircle}>
              <Ionicons name="business" size={24} color={colors.brand[500]} />
            </View>
            <View style={styles.cardHeaderText}>
              <Text style={styles.businessName}>{customer.businessName}</Text>
              {customer.contactName ? (
                <Text style={styles.contactName}>{customer.contactName}</Text>
              ) : null}
            </View>
          </View>
        </View>

        {/* Contact */}
        {(customer.phone || customer.email) && (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Contact</Text>
            {customer.phone ? (
              <Pressable
                style={styles.contactRow}
                onPress={() => callPhone(customer.phone!)}
                accessibilityRole="button"
                accessibilityLabel={`Call ${customer.phone}`}
              >
                <View style={styles.contactIcon}>
                  <Ionicons name="call-outline" size={18} color={colors.brand[500]} />
                </View>
                <Text style={styles.contactValue}>{customer.phone}</Text>
                <Ionicons name="chevron-forward" size={16} color="#94a3b8" />
              </Pressable>
            ) : null}
            {customer.email ? (
              <View style={styles.contactRow}>
                <View style={styles.contactIcon}>
                  <Ionicons name="mail-outline" size={18} color="#64748b" />
                </View>
                <Text style={styles.contactValue}>{customer.email}</Text>
              </View>
            ) : null}
          </View>
        )}

        {/* Delivery window */}
        {(customer.deliveryWindowStart || customer.deliveryWindowEnd) && (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Delivery Window</Text>
            <View style={styles.infoRow}>
              <Ionicons name="time-outline" size={18} color={colors.brand[500]} />
              <Text style={styles.infoText}>
                {customer.deliveryWindowStart ?? "—"}
                {customer.deliveryWindowEnd ? ` – ${customer.deliveryWindowEnd}` : ""}
              </Text>
            </View>
          </View>
        )}

        {/* Address */}
        {defaultAddress && (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Delivery Address</Text>
            <View style={styles.infoRow}>
              <Ionicons name="location-outline" size={18} color={colors.brand[500]} />
              <View style={styles.addressBlock}>
                <Text style={styles.addressLine}>{defaultAddress.line1}</Text>
                {defaultAddress.line2 ? (
                  <Text style={styles.addressLine}>{defaultAddress.line2}</Text>
                ) : null}
                <Text style={styles.addressLine}>
                  {defaultAddress.city}, {defaultAddress.state} {defaultAddress.zip}
                </Text>
              </View>
            </View>
          </View>
        )}

        {/* Outstanding invoices */}
        {invoices.length > 0 && (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Outstanding Invoices</Text>
            {invoices.slice(0, 5).map((inv: any) => (
              <View key={inv.id} style={styles.invoiceRow}>
                <View style={styles.invoiceLeft}>
                  <Text style={styles.invoiceNum}>
                    {inv.invoiceNumber ?? `INV-${inv.id.slice(0, 6)}`}
                  </Text>
                  <Text style={styles.invoiceDue}>
                    {inv.dueDate
                      ? `Due ${new Date(inv.dueDate).toLocaleDateString()}`
                      : inv.status}
                  </Text>
                </View>
                <View
                  style={[
                    styles.invoiceAmountChip,
                    inv.status === "OVERDUE" && { backgroundColor: colors.danger.bg },
                    inv.status === "PAID" && { backgroundColor: colors.success.bg },
                  ]}
                >
                  <Text
                    style={[
                      styles.invoiceAmount,
                      inv.status === "OVERDUE" && { color: colors.danger.DEFAULT },
                      inv.status === "PAID" && { color: colors.success.DEFAULT },
                    ]}
                  >
                    ${Number(inv.total).toFixed(2)}
                  </Text>
                </View>
              </View>
            ))}
          </View>
        )}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surface.raised },
  scroll: { padding: 16, gap: 12, paddingBottom: 40 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  card: {
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    padding: 16,
    gap: 12,
    ...shadows.card,
  },
  cardHeader: { flexDirection: "row", alignItems: "center", gap: 12 },
  iconCircle: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.brand[50],
    alignItems: "center",
    justifyContent: "center",
  },
  cardHeaderText: { flex: 1 },
  businessName: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  contactName: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },
  sectionTitle: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: "#64748b",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  contactRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 2,
  },
  contactIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.surface.raised,
    alignItems: "center",
    justifyContent: "center",
  },
  contactValue: {
    flex: 1,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: colors.navy.DEFAULT,
  },
  infoRow: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  infoText: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: colors.navy.DEFAULT,
  },
  addressBlock: { flex: 1, gap: 2 },
  addressLine: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: colors.navy.DEFAULT,
  },
  invoiceRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.surface.border,
  },
  invoiceLeft: { flex: 1 },
  invoiceNum: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: colors.navy.DEFAULT,
  },
  invoiceDue: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
    marginTop: 2,
  },
  invoiceAmountChip: {
    backgroundColor: colors.surface.raised,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  invoiceAmount: {
    fontSize: 14,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
});
