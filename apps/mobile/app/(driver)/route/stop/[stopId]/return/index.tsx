import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import {
  ListGroup,
  NavAction,
  NavBackButton,
  NavBar,
} from "@routeflow/ui/mobile/ios";

const RETURNED = [
  { name: "Sourdough Loaf", qty: 2, reason: "Damaged in transit", amt: "$13.60" },
  { name: "Butter (500g)", qty: 1, reason: "Wrong SKU", amt: "$9.20" },
];

const REASONS = ["Damaged", "Expired", "Wrong SKU", "Short-dated", "Customer refused", "Quality"];

export default function ReturnScreen() {
  const router = useRouter();
  const [activeReason, setActiveReason] = useState<string | null>(null);

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Return & credit"
        leading={<NavBackButton label="Stop" onPress={() => router.back()} />}
        trailing={<NavAction label="Issue" bold />}
      />

      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <View style={styles.iconBlock}>
            <Ionicons name="arrow-undo-outline" size={20} color={ios.system.red} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.custName}>Harbor Café</Text>
            <Text style={styles.custSub}>Invoice #1042 · $184 originally</Text>
          </View>
        </View>

        <SectionRow title="Returned items" action="+ Add" />
        <ListGroup>
          {RETURNED.map((r) => (
            <View key={r.name} style={styles.returnRow}>
              <View style={styles.returnIcon}>
                <Ionicons name="trash-outline" size={16} color={ios.system.red} />
              </View>
              <View style={{ flex: 1 }}>
                <View style={styles.returnTopRow}>
                  <Text style={styles.returnName}>{r.name}</Text>
                  <Text style={styles.returnAmt}>−{r.amt}</Text>
                </View>
                <Text style={styles.returnSub}>
                  × {r.qty} · {r.reason}
                </Text>
              </View>
            </View>
          ))}
        </ListGroup>

        <SectionRow title="Add reason" />
        <View style={styles.reasons}>
          {REASONS.map((r) => {
            const active = r === activeReason;
            return (
              <Pressable
                key={r}
                onPress={() => setActiveReason(r)}
                style={[styles.reasonChip, active && styles.reasonChipActive]}
              >
                <Text style={[styles.reasonText, active && styles.reasonTextActive]}>{r}</Text>
              </Pressable>
            );
          })}
        </View>

        <View style={{ padding: 16, paddingTop: 20 }}>
          <LinearGradient
            colors={[ios.brandGradient[0]!, ios.brandGradient[1]!, ios.brandGradient[2]!]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.creditCard}
          >
            <Text style={styles.creditEyebrow}>CREDIT NOTE CN-0882</Text>
            <Text style={styles.creditValue}>−$22.80</Text>
            <Text style={styles.creditSub}>Applied to next invoice · Harbor Café</Text>
          </LinearGradient>
        </View>

        <View style={{ padding: 16, gap: 8 }}>
          {/* TODO: POST /returns + POST /credit-notes */}
          <Pressable style={styles.primaryBtn}>
            <Text style={styles.primaryBtnText}>Issue credit & email</Text>
          </Pressable>
          <Pressable style={styles.secondaryBtn}>
            <Text style={styles.secondaryBtnText}>Save as draft</Text>
          </Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function SectionRow({ title, action }: { title: string; action?: string }) {
  return (
    <View style={styles.sectionRow}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {action ? <Text style={styles.sectionLink}>{action}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bgElev },
  header: {
    backgroundColor: ios.bgElev,
    paddingHorizontal: 16,
    paddingVertical: 14,
    flexDirection: "row",
    gap: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: ios.separator,
    alignItems: "center",
  },
  iconBlock: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: ios.system.redWash,
    alignItems: "center",
    justifyContent: "center",
  },
  custName: { fontSize: 18, fontFamily: "Inter_700Bold", color: ios.label },
  custSub: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2 },
  sectionRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 8,
  },
  sectionTitle: { fontSize: 17, fontFamily: "Inter_700Bold", color: ios.label, letterSpacing: -0.3 },
  sectionLink: { fontSize: 15, fontFamily: "Inter_400Regular", color: ios.brand },
  returnRow: {
    flexDirection: "row",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: ios.bgElev,
  },
  returnIcon: {
    width: 30,
    height: 30,
    borderRadius: 7,
    backgroundColor: ios.system.redWash,
    alignItems: "center",
    justifyContent: "center",
  },
  returnTopRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
  },
  returnName: { fontSize: 16, fontFamily: "Inter_600SemiBold", color: ios.label },
  returnAmt: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  returnSub: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  reasons: {
    paddingHorizontal: 16,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  reasonChip: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: ios.fill3,
  },
  reasonChipActive: { backgroundColor: ios.brand },
  reasonText: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.label },
  reasonTextActive: { color: "#fff" },
  creditCard: { borderRadius: 20, padding: 16 },
  creditEyebrow: {
    fontSize: 12,
    fontFamily: "Inter_700Bold",
    color: "rgba(255,255,255,0.8)",
    letterSpacing: 1,
  },
  creditValue: {
    fontSize: 38,
    fontFamily: "Inter_700Bold",
    color: "#fff",
    letterSpacing: -1,
    marginTop: 6,
    fontVariant: ["tabular-nums"],
  },
  creditSub: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "rgba(255,255,255,0.85)",
    marginTop: 2,
  },
  primaryBtn: {
    backgroundColor: ios.brand,
    borderRadius: 14,
    paddingVertical: 15,
    alignItems: "center",
  },
  primaryBtnText: { color: "#fff", fontSize: 17, fontFamily: "Inter_600SemiBold" },
  secondaryBtn: {
    backgroundColor: ios.fill2,
    borderRadius: 14,
    paddingVertical: 15,
    alignItems: "center",
  },
  secondaryBtnText: { color: ios.brand, fontSize: 17, fontFamily: "Inter_600SemiBold" },
});
