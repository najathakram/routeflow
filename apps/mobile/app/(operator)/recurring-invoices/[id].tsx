import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavBackButton, NavBar, Pill } from "@routeflow/ui/mobile/ios";
import { useRecurringInvoice, useRunRecurringInvoice } from "../../../lib/api/recurring-invoices";
import { freqLabel, recurringPillFor } from "../../../lib/recurring-invoices-logic";
import { showToast } from "../../../lib/toast";

function fmtCurrency(n: number | string | undefined): string {
  const v = typeof n === "string" ? Number(n) : (n ?? 0);
  return `$${(Number.isFinite(v) ? v : 0).toFixed(2)}`;
}

const onErr = (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again.");

export default function RecurringInvoiceDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  const { data: template, isLoading } = useRecurringInvoice(id ?? "");
  const runMut = useRunRecurringInvoice();

  if (isLoading || !template) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar inlineTitle="Recurring" leading={<NavBackButton onPress={() => router.back()} />} />
        <View style={styles.center}>
          <ActivityIndicator color={ios.brand} />
        </View>
      </SafeAreaView>
    );
  }

  const s = recurringPillFor(template.isActive);
  const fmtDate = (d?: string) => (d ? new Date(d).toLocaleDateString() : "—");

  const handleRunNow = () => {
    if (!id) return;
    runMut.mutate(id, {
      onSuccess: (inv) => {
        showToast("Invoice generated");
        // run returns the created INVOICE (keyed `id`), not the template.
        router.push(`/(operator)/invoices/${inv.id}`);
      },
      onError: onErr,
    });
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle={template.customer?.businessName ?? "Recurring"}
        leading={<NavBackButton label="Recurring" onPress={() => router.back()} />}
      />

      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={{ padding: 16, gap: 14 }}>
          {/* Header / schedule */}
          <View style={styles.card}>
            <Pill variant={s.variant} dot>
              {s.label}
            </Pill>
            <Text style={styles.customer}>{template.customer?.businessName ?? "Customer"}</Text>
            <Text style={styles.schedule}>
              {freqLabel(template.frequency, template.dayOfWeek, template.dayOfMonth)}
            </Text>
            <Text style={styles.dates}>
              Next run {fmtDate(template.nextRunAt)}
              {template.lastRunAt ? ` · Last run ${fmtDate(template.lastRunAt)}` : ""}
              {template.autoSend ? " · Auto-send" : ""}
            </Text>
          </View>

          {/* Generate now — always available; server runs regardless of active state */}
          <View style={styles.actionsGrid}>
            <ActionTile
              icon="flash-outline"
              label={runMut.isPending ? "Generating…" : "Generate now"}
              onPress={handleRunNow}
            />
          </View>

          {/* Template line items (raw — the real invoice total is computed on generation) */}
          {template.items && template.items.length > 0 ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Bills each run</Text>
              {template.items.map((it, i) => (
                <View
                  key={it.id}
                  style={[
                    styles.itemRow,
                    i > 0 && {
                      borderTopWidth: StyleSheet.hairlineWidth,
                      borderTopColor: ios.separator,
                    },
                  ]}
                >
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.itemName} numberOfLines={1}>
                      {it.description}
                    </Text>
                  </View>
                  <Text style={styles.itemSub}>
                    {it.qty} × {fmtCurrency(it.unitPrice)}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}

          {/* Notes / terms */}
          {template.notes ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Notes</Text>
              <Text style={styles.notes}>{template.notes}</Text>
            </View>
          ) : null}
          {template.terms ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Terms</Text>
              <Text style={styles.notes}>{template.terms}</Text>
            </View>
          ) : null}
        </View>
        <View style={{ height: 24 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

function ActionTile({
  icon,
  label,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable style={styles.tile} onPress={onPress}>
      <Ionicons name={icon} size={22} color={ios.brand} />
      <Text style={styles.tileLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center" },
  card: { backgroundColor: ios.bgElev, borderRadius: 14, padding: 14 },
  cardTitle: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label, marginBottom: 8 },
  customer: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label, marginTop: 8 },
  schedule: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    marginTop: 6,
    letterSpacing: -0.4,
  },
  dates: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 4 },
  notes: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label2, lineHeight: 20 },
  actionsGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  tile: {
    flexBasis: "47%",
    flexGrow: 1,
    backgroundColor: ios.bgElev,
    borderRadius: 14,
    padding: 18,
    alignItems: "center",
    gap: 8,
  },
  tileLabel: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    textAlign: "center",
  },
  itemRow: { flexDirection: "row", alignItems: "center", paddingVertical: 8, gap: 10 },
  itemName: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.label },
  itemSub: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: ios.label2,
    fontVariant: ["tabular-nums"],
  },
});
