import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ActivityIndicator } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Linking } from "react-native";
import { ios } from "@routeflow/ui/tokens";
import { NavBackButton, NavBar, Pill } from "@routeflow/ui/mobile/ios";
import { useBuyerInvoice } from "../../../lib/api/buyer";

function invoicePill(status: string) {
  switch (status) {
    case "PAID": return { variant: "green" as const, label: "Paid" };
    case "PARTIAL": return { variant: "orange" as const, label: "Partial" };
    case "SENT": return { variant: "orange" as const, label: "Unpaid" };
    case "OVERDUE": return { variant: "gray" as const, label: "Overdue" };
    case "VOID": return { variant: "gray" as const, label: "Void" };
    default: return { variant: "gray" as const, label: status };
  }
}

export default function CustomerInvoiceDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: invoice, isLoading } = useBuyerInvoice(id);

  if (isLoading || !invoice) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar inlineTitle="Invoice" leading={<NavBackButton label="Back" onPress={() => router.back()} />} />
        <View style={styles.center}><ActivityIndicator color={ios.brand} /></View>
      </SafeAreaView>
    );
  }

  const p = invoicePill(invoice.status);
  const amountDue = Number(invoice.amountDue ?? invoice.total) || 0;

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Invoice"
        leading={<NavBackButton label="Back" onPress={() => router.back()} />}
      />

      <ScrollView showsVerticalScrollIndicator={false}>
        {/* Header */}
        <View style={styles.headerCard}>
          <View style={styles.headerRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.invoiceNum}>#{invoice.invoiceNumber}</Text>
              {invoice.issueDate ? (
                <Text style={styles.issuedDate}>
                  Issued:{" "}
                  {new Date(invoice.issueDate).toLocaleDateString(undefined, {
                    month: "short", day: "numeric", year: "numeric",
                  })}
                </Text>
              ) : null}
            </View>
            <Pill variant={p.variant} dot>{p.label}</Pill>
          </View>

          <Text style={styles.total}>${Number(invoice.total).toFixed(2)}</Text>

          {invoice.dueDate ? (
            <Text style={styles.dueDate}>
              Due:{" "}
              {new Date(invoice.dueDate).toLocaleDateString(undefined, {
                month: "short", day: "numeric", year: "numeric",
              })}
            </Text>
          ) : null}
        </View>

        {/* Payment info */}
        {invoice.status !== "PAID" && amountDue > 0 ? (
          <View style={styles.dueCard}>
            <Ionicons name="alert-circle-outline" size={18} color={ios.system.orangeInk} />
            <View style={{ flex: 1 }}>
              <Text style={styles.dueCardTitle}>Amount due</Text>
              <Text style={styles.dueCardAmount}>${Number(amountDue).toFixed(2)}</Text>
            </View>
          </View>
        ) : null}

        {/* Summary rows */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Summary</Text>
          <View style={styles.detailCard}>
            <DetailRow label="Invoice #" value={`#${invoice.invoiceNumber}`} />
            <DetailRow label="Status" value={p.label} />
            {invoice.total != null ? (
              <DetailRow label="Total" value={`$${Number(invoice.total).toFixed(2)}`} />
            ) : null}
            {invoice.amountPaid != null && Number(invoice.amountPaid) > 0 ? (
              <DetailRow label="Amount paid" value={`$${Number(invoice.amountPaid).toFixed(2)}`} />
            ) : null}
            {amountDue > 0 && invoice.status !== "PAID" ? (
              <DetailRow label="Balance due" value={`$${amountDue.toFixed(2)}`} />
            ) : null}
          </View>
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  headerCard: { margin: 16, backgroundColor: ios.bgElev, borderRadius: 16, padding: 18, gap: 6 },
  headerRow: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  invoiceNum: { fontSize: 18, fontFamily: "Inter_700Bold", color: ios.label, letterSpacing: -0.3 },
  issuedDate: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  total: { fontSize: 28, fontFamily: "Inter_700Bold", color: ios.label, letterSpacing: -0.6, marginTop: 4 },
  dueDate: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2 },
  dueCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginHorizontal: 16,
    marginBottom: 8,
    backgroundColor: ios.system.orangeWash,
    borderRadius: 12,
    padding: 14,
  },
  dueCardTitle: { fontSize: 12, fontFamily: "Inter_500Medium", color: ios.system.orangeInk },
  dueCardAmount: { fontSize: 18, fontFamily: "Inter_700Bold", color: ios.system.orangeInk },
  section: { paddingHorizontal: 16, paddingBottom: 16 },
  sectionTitle: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    letterSpacing: 0.4,
    textTransform: "uppercase",
    marginBottom: 8,
    paddingLeft: 4,
  },
  detailCard: { backgroundColor: ios.bgElev, borderRadius: 12, overflow: "hidden" },
  detailRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: ios.separator,
  },
  detailLabel: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.label2 },
  detailValue: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.label },
});
