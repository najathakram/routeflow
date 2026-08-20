import { useState } from "react";
import {
  ActivityIndicator,
  Linking,
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
import { NavAction, NavBackButton, NavBar } from "@routeflow/ui/mobile/ios";
import { useSuppliers } from "../../../lib/api/purchase-orders";
import { RecordSupplierPaymentSheet } from "../../../components/RecordSupplierPaymentSheet";
import { useSupplierStatement } from "../../../lib/api/supplier-payments";

function fmt(n: number | string | null | undefined): string {
  const v = n == null ? 0 : typeof n === "string" ? Number(n) : n;
  return `$${(Number.isFinite(v) ? v : 0).toFixed(2)}`;
}

const STATEMENT_ROW_LABEL: Record<string, string> = {
  BILL: "Bill",
  PAYMENT: "Payment",
  CREDIT: "Credit",
};

export default function SupplierDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: suppliers, isLoading } = useSuppliers();
  const supplier = suppliers?.find((s) => s.id === id);
  const { data: statement } = useSupplierStatement(id ?? "");
  const [paymentSheetOpen, setPaymentSheetOpen] = useState(false);
  // Most-recent-first for the on-screen activity feed; the statement itself
  // is sorted oldest-first so its `balance` column accumulates correctly.
  const recentRows = [...(statement?.timeline ?? [])].reverse().slice(0, 8);

  if (isLoading) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar
          inlineTitle="Supplier"
          leading={<NavBackButton label="Back" onPress={() => router.back()} />}
        />
        <View style={styles.center}>
          <ActivityIndicator color={ios.brand} />
        </View>
      </SafeAreaView>
    );
  }

  if (!supplier) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar
          inlineTitle="Supplier"
          leading={<NavBackButton label="Back" onPress={() => router.back()} />}
        />
        <View style={styles.center}>
          <Text style={styles.notFoundText}>Supplier not found</Text>
          <Pressable
            onPress={() => router.replace("/(operator)/suppliers" as any)}
            style={styles.notFoundBtn}
          >
            <Text style={styles.notFoundBtnText}>Back to suppliers</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle={supplier.name}
        leading={<NavBackButton label="Back" onPress={() => router.back()} />}
        trailing={
          <NavAction
            label="Edit"
            bold
            onPress={() => router.push(`/(operator)/suppliers/${id}/edit` as any)}
          />
        }
      />

      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={styles.section}>
          <View style={styles.card}>
            <DetailRow label="Name" value={supplier.name} />
            {supplier.contactName ? (
              <DetailRow label="Contact" value={supplier.contactName} />
            ) : null}
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Account standing</Text>
          <View style={styles.balanceCard}>
            <View style={styles.statGrid}>
              <View style={styles.statBox}>
                <Text style={[styles.statValue, (statement?.outstanding ?? 0) > 0 && styles.red]}>
                  {fmt(statement?.outstanding)}
                </Text>
                <Text style={styles.statLabel}>Outstanding</Text>
              </View>
              <View style={styles.statBox}>
                <Text style={styles.statValue}>{fmt(statement?.totalOwed)}</Text>
                <Text style={styles.statLabel}>Total owed</Text>
              </View>
              <View style={styles.statBox}>
                <Text style={styles.statValue}>{fmt(statement?.totalPaid)}</Text>
                <Text style={styles.statLabel}>Total paid</Text>
              </View>
              <View style={styles.statBox}>
                <Text
                  style={[styles.statValue, (statement?.creditBalance ?? 0) > 0 && styles.green]}
                >
                  {fmt(statement?.creditBalance)}
                </Text>
                <Text style={styles.statLabel}>Account credit</Text>
              </View>
            </View>

            <Pressable style={styles.linkRow} onPress={() => setPaymentSheetOpen(true)}>
              <Text style={styles.linkText}>Record payment</Text>
              <Ionicons name="chevron-forward" size={14} color={ios.brand} />
            </Pressable>

            {recentRows.length > 0 ? (
              <View style={styles.timeline}>
                <Text style={styles.timelineTitle}>Recent activity</Text>
                {recentRows.map((row, i) => (
                  <View
                    key={row.id}
                    style={[
                      styles.timelineRow,
                      i > 0 && {
                        borderTopWidth: StyleSheet.hairlineWidth,
                        borderTopColor: ios.separator,
                      },
                    ]}
                  >
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={styles.timelineLabel} numberOfLines={1}>
                        {row.description || STATEMENT_ROW_LABEL[row.type] || row.type}
                      </Text>
                      <Text style={styles.timelineDate}>
                        {new Date(row.date).toLocaleDateString()}
                      </Text>
                    </View>
                    <View style={{ alignItems: "flex-end" }}>
                      <Text
                        style={[
                          styles.timelineAmount,
                          row.type === "BILL" ? styles.red : styles.green,
                        ]}
                      >
                        {row.type === "BILL" ? "+" : "−"}
                        {fmt(Math.abs(row.amount))}
                      </Text>
                      <Text style={styles.timelineBalance}>Bal {fmt(row.balance)}</Text>
                    </View>
                  </View>
                ))}
              </View>
            ) : null}
          </View>
        </View>

        {supplier.phone || supplier.email ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Contact</Text>
            <View style={styles.card}>
              {supplier.phone ? (
                <Pressable onPress={() => Linking.openURL(`tel:${supplier.phone}`)}>
                  <DetailRow label="Phone" value={supplier.phone} tappable />
                </Pressable>
              ) : null}
              {supplier.email ? (
                <Pressable onPress={() => Linking.openURL(`mailto:${supplier.email}`)}>
                  <DetailRow label="Email" value={supplier.email} tappable />
                </Pressable>
              ) : null}
            </View>
          </View>
        ) : null}

        {supplier.notes ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Notes</Text>
            <View style={styles.card}>
              <Text style={styles.notes}>{supplier.notes}</Text>
            </View>
          </View>
        ) : null}

        <View style={{ height: 40 }} />
      </ScrollView>

      {paymentSheetOpen && id ? (
        <RecordSupplierPaymentSheet
          visible={paymentSheetOpen}
          supplierId={id}
          supplierName={supplier.name}
          onClose={() => setPaymentSheetOpen(false)}
        />
      ) : null}
    </SafeAreaView>
  );
}

function DetailRow({
  label,
  value,
  tappable,
}: {
  label: string;
  value: string;
  tappable?: boolean;
}) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <View
        style={{
          flex: 1,
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
          justifyContent: "flex-end",
        }}
      >
        <Text style={[styles.rowValue, tappable && { color: ios.brand }]} numberOfLines={1}>
          {value}
        </Text>
        {tappable ? <Ionicons name="chevron-forward" size={12} color={ios.brand} /> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  notFoundText: { fontSize: 16, fontFamily: "Inter_500Medium", color: ios.label },
  notFoundBtn: { paddingVertical: 8, paddingHorizontal: 16 },
  notFoundBtnText: { fontSize: 15, color: ios.brand },
  section: { paddingHorizontal: 16, paddingTop: 16 },
  sectionTitle: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    letterSpacing: 0.4,
    textTransform: "uppercase",
    marginBottom: 8,
  },
  card: { backgroundColor: ios.bgElev, borderRadius: 12, overflow: "hidden" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: ios.separator,
    gap: 12,
  },
  rowLabel: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.label2, flexShrink: 0 },
  rowValue: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label, textAlign: "right" },
  notes: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: ios.label,
    padding: 16,
    lineHeight: 20,
  },

  // ── Account standing (PR-E WP6) ──────────────────────────────────────────
  balanceCard: { backgroundColor: ios.bgElev, borderRadius: 12, padding: 14, gap: 6 },
  statGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginBottom: 4 },
  statBox: {
    flex: 1,
    minWidth: "40%",
    backgroundColor: ios.fill3,
    borderRadius: 10,
    padding: 10,
    alignItems: "center",
  },
  statValue: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  statLabel: { fontSize: 11, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  red: { color: ios.system.redInk },
  green: { color: ios.system.greenInk },
  linkRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
    marginTop: 4,
  },
  linkText: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.brand },
  timeline: {
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
    marginTop: 4,
  },
  timelineTitle: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    letterSpacing: 0.3,
    textTransform: "uppercase",
    marginBottom: 4,
  },
  timelineRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 8,
  },
  timelineLabel: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.label },
  timelineDate: { fontSize: 11, fontFamily: "Inter_400Regular", color: ios.label3, marginTop: 1 },
  timelineAmount: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    fontVariant: ["tabular-nums"],
  },
  timelineBalance: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: ios.label3,
    marginTop: 1,
    fontVariant: ["tabular-nums"],
  },
});
