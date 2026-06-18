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
import { FilterChipRow, NavBar, Pill } from "@routeflow/ui/mobile/ios";
import { useState } from "react";
import { useBuyerInvoices, type BuyerInvoice } from "../../../lib/api/buyer";

const FILTERS = [
  { id: "ALL", label: "All" },
  { id: "UNPAID", label: "Unpaid" },
  { id: "PAID", label: "Paid" },
  { id: "OVERDUE", label: "Overdue" },
] as const;

type FilterId = (typeof FILTERS)[number]["id"];

function invoicePill(status: string) {
  switch (status) {
    case "PAID":
      return { variant: "green" as const, label: "Paid" };
    case "PARTIAL":
      return { variant: "orange" as const, label: "Partial" };
    case "SENT":
      return { variant: "orange" as const, label: "Unpaid" };
    case "OVERDUE":
      return { variant: "red" as const, label: "Overdue" };
    case "VOID":
      return { variant: "gray" as const, label: "Void" };
    default:
      return { variant: "gray" as const, label: status };
  }
}

export default function CustomerInvoicesScreen() {
  const router = useRouter();
  const [filter, setFilter] = useState<FilterId>("ALL");

  const statusParam = filter === "ALL" || filter === "UNPAID" ? undefined : filter;
  const statusesParam = filter === "UNPAID" ? ["SENT", "OVERDUE"] : undefined;
  const { data, isLoading, isFetching, refetch } = useBuyerInvoices({
    status: statusParam,
    statuses: statusesParam,
    limit: 30,
  });
  const invoices = data?.data ?? [];

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar inlineTitle="Invoices" />

      <FilterChipRow
        chips={FILTERS.map((f) => ({ label: f.label }))}
        value={FILTERS.find((f) => f.id === filter)?.label ?? "All"}
        onChange={(label) =>
          setFilter((FILTERS.find((f) => f.label === label)?.id as FilterId) ?? "ALL")
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
        ) : invoices.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.empty}>No invoices yet.</Text>
          </View>
        ) : (
          <View style={styles.list}>
            {invoices.map((inv) => (
              <InvoiceRow
                key={inv.id}
                invoice={inv}
                onPress={() => router.push(`/(customer)/invoices/${inv.id}`)}
              />
            ))}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function InvoiceRow({ invoice, onPress }: { invoice: BuyerInvoice; onPress: () => void }) {
  const p = invoicePill(invoice.status);
  const dateLabel = invoice.issueDate
    ? new Date(invoice.issueDate).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "";
  const amountDue = Number(invoice.amountDue ?? invoice.total) || 0;

  return (
    <Pressable style={styles.card} onPress={onPress}>
      <View style={styles.cardHead}>
        <View style={{ flex: 1 }}>
          <Text style={styles.cardNumber}>#{invoice.invoiceNumber}</Text>
          <Text style={styles.cardMeta}>{dateLabel}</Text>
        </View>
        <Pill variant={p.variant} dot>
          {p.label}
        </Pill>
      </View>
      <View style={styles.cardFoot}>
        <View>
          <Text style={styles.cardTotal}>${Number(invoice.total).toFixed(2)}</Text>
          {amountDue > 0 && invoice.status !== "PAID" ? (
            <Text style={styles.cardDue}>Due: ${amountDue.toFixed(2)}</Text>
          ) : null}
        </View>
        <Ionicons name="chevron-forward" size={16} color={ios.gray[3]} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center" },
  empty: { fontSize: 15, fontFamily: "Inter_500Medium", color: ios.label2 },
  list: { paddingHorizontal: 16, gap: 8, paddingBottom: 32 },
  card: { backgroundColor: ios.bgElev, borderRadius: 14, padding: 14 },
  cardHead: { flexDirection: "row", alignItems: "center", gap: 10 },
  cardNumber: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    letterSpacing: -0.2,
  },
  cardMeta: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  cardFoot: {
    marginTop: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  cardTotal: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  cardDue: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.system.redInk, marginTop: 2 },
});
