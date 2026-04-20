import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { ios } from "@routeflow/ui/tokens";
import {
  ListGroup,
  ListRow,
  NavAction,
  NavBar,
  Pill,
} from "@routeflow/ui/mobile/ios";

// TODO: POST /driver/cash-up on submit. Van inventory could hook into
// existing inventory endpoints.
const DENOMS = [
  { d: "$100", n: 10, v: "$1,000" },
  { d: "$50", n: 6, v: "$300" },
  { d: "$20", n: 5, v: "$100" },
  { d: "$10", n: 2, v: "$20" },
  { d: "$5", n: 2, v: "$10" },
  { d: "Coins", n: "—", v: "$0" },
] as const;

export default function CashUpScreen() {
  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        largeTitle="Cash up"
        inlineTitle="End of day"
        trailing={<NavAction label="Submit" bold />}
      />

      <ScrollView showsVerticalScrollIndicator={false}>
        {/* Reconcile hero */}
        <View style={{ padding: 16, paddingTop: 12 }}>
          <View style={styles.card}>
            <View style={styles.row}>
              <View>
                <Text style={styles.eyebrow}>EXPECTED IN VAN</Text>
                <Text style={styles.hugeValue}>$2,184.00</Text>
              </View>
              <Pill variant="green" dot>Matched</Pill>
            </View>
            <View style={styles.divider} />
            <View style={styles.breakdown}>
              <Breakdown label="CASH" value="$1,430" />
              <Breakdown label="CHEQUE" value="$320" />
              <Breakdown label="CARD" value="$434" />
            </View>
          </View>
        </View>

        <SectionRow title="Cash count" rightText="Counted $1,430" />
        <ListGroup>
          {DENOMS.map((r) => (
            <ListRow
              key={r.d}
              icon={<Text style={styles.denomIconText}>{r.d}</Text>}
              iconBg={ios.fill3}
              title={`${r.d} notes`}
              trailing={
                <View style={styles.denomTrailing}>
                  <Text style={styles.denomCount}>× {r.n}</Text>
                  <Text style={styles.denomValue}>{r.v}</Text>
                </View>
              }
            />
          ))}
        </ListGroup>

        <SectionRow title="Van inventory" actionText="Scan all" />
        <ListGroup>
          <ListRow
            icon={<Ionicons name="checkmark" size={16} color={ios.system.greenInk} />}
            iconBg={ios.system.greenWash}
            title="Loaded stock delivered"
            subtitle="78 of 84 · 93%"
          />
          <ListRow
            icon={<Ionicons name="archive-outline" size={16} color={ios.system.orangeInk} />}
            iconBg={ios.system.orangeWash}
            title="Returns & undelivered"
            subtitle="4 items · Sourdough ×2, Butter ×2"
            chevron
          />
          <ListRow
            icon={<Ionicons name="cube-outline" size={16} color={ios.system.purpleInk} />}
            iconBg={ios.system.purpleWash}
            title="Empties & crates"
            subtitle="12 crates · 3 trolleys"
            chevron
          />
        </ListGroup>

        <View style={{ paddingHorizontal: 16, paddingBottom: 20, paddingTop: 8 }}>
          <Pressable style={styles.primaryBtn}>
            <Text style={styles.primaryBtnText}>Submit to warehouse</Text>
          </Pressable>
          <Text style={styles.footer}>Will sync when online · Van 07 · 19:12</Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function Breakdown({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flex: 1 }}>
      <Text style={styles.breakdownLabel}>{label}</Text>
      <Text style={styles.breakdownValue}>{value}</Text>
    </View>
  );
}

function SectionRow({
  title,
  rightText,
  actionText,
}: {
  title: string;
  rightText?: string;
  actionText?: string;
}) {
  return (
    <View style={styles.sectionRow}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {actionText ? (
        <Text style={styles.actionLink}>{actionText}</Text>
      ) : rightText ? (
        <Text style={styles.rightText}>{rightText}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  card: {
    backgroundColor: ios.bgElev,
    borderRadius: ios.cardRadius,
    padding: 16,
  },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  eyebrow: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    letterSpacing: 0.6,
  },
  hugeValue: {
    fontSize: 36,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    letterSpacing: -1,
    marginTop: 4,
    fontVariant: ["tabular-nums"],
  },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: ios.separator, marginVertical: 14 },
  breakdown: { flexDirection: "row", gap: 8 },
  breakdownLabel: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    letterSpacing: 0.6,
  },
  breakdownValue: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  sectionRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 8,
  },
  sectionTitle: { fontSize: 17, fontFamily: "Inter_700Bold", color: ios.label, letterSpacing: -0.3 },
  actionLink: { fontSize: 15, fontFamily: "Inter_400Regular", color: ios.brand },
  rightText: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2 },
  denomIconText: {
    fontSize: 13,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  denomTrailing: { flexDirection: "row", gap: 16, alignItems: "center" },
  denomCount: { fontSize: 15, color: ios.label2, fontVariant: ["tabular-nums"] },
  denomValue: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    minWidth: 56,
    textAlign: "right",
    fontVariant: ["tabular-nums"],
  },
  primaryBtn: {
    backgroundColor: ios.brand,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: "center",
  },
  primaryBtnText: { color: "#fff", fontSize: 17, fontFamily: "Inter_600SemiBold" },
  footer: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    textAlign: "center",
    marginTop: 8,
  },
});
