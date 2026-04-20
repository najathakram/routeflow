import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import {
  NavAction,
  NavBackButton,
  NavBar,
  SegmentedControl,
} from "@routeflow/ui/mobile/ios";

const METHODS = ["Cash", "Card", "Cheque", "On account"] as const;
const QUICK = ["$50", "$100", "$164", "$200"];
const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "·", "0", "⌫"];
const INVOICE_TOTAL = 164;

export default function PaymentScreen() {
  const router = useRouter();
  const [method, setMethod] = useState<string>("Cash");
  // TODO: POST /payments/{invoiceId} on "Receive cash & close".
  const [received, setReceived] = useState("200.00");
  const change = Math.max(0, Number(received) - INVOICE_TOTAL);

  const press = (k: string) => {
    setReceived((prev) => {
      if (k === "⌫") return prev.slice(0, -1) || "0";
      if (k === "·") return prev.includes(".") ? prev : prev + ".";
      if (prev === "0" || prev === "0.00") return k;
      return prev + k;
    });
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        tint="light"
        inlineTitle="Collect payment"
        leading={<NavBackButton label="Stop" onPress={() => router.back()} />}
        trailing={<NavAction label="Skip" />}
      />

      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={styles.totalBlock}>
          <Text style={styles.eyebrow}>INVOICE #1042 · HARBOR CAFÉ</Text>
          <View style={styles.totalRow}>
            <Text style={styles.currency}>$</Text>
            <Text style={styles.totalWhole}>164</Text>
            <Text style={styles.totalFraction}>.00</Text>
          </View>
          <Text style={styles.totalSub}>Was $184 · $20 credit applied</Text>
        </View>

        <View style={{ paddingHorizontal: 16, paddingTop: 14 }}>
          <SegmentedControl
            items={METHODS as unknown as string[]}
            value={method}
            onChange={setMethod}
          />
        </View>

        <View style={styles.receivedBlock}>
          <View>
            <Text style={styles.eyebrowSmall}>CASH RECEIVED</Text>
            <Text style={styles.receivedValue}>${received}</Text>
          </View>
          <View style={styles.changeBlock}>
            <Text style={styles.changeEyebrow}>CHANGE</Text>
            <Text style={styles.changeValue}>${change.toFixed(2)}</Text>
          </View>
        </View>

        <View style={styles.quickGrid}>
          {QUICK.map((q) => (
            <Pressable
              key={q}
              style={styles.quickCell}
              onPress={() => setReceived(q.replace("$", "") + ".00")}
            >
              <Text style={styles.quickText}>{q}</Text>
            </Pressable>
          ))}
        </View>

        <View style={styles.keypad}>
          {KEYS.map((k) => (
            <Pressable key={k} style={styles.key} onPress={() => press(k)}>
              <Text style={styles.keyText}>{k}</Text>
            </Pressable>
          ))}
        </View>

        <View style={{ padding: 16 }}>
          <Pressable style={styles.greenBtn} onPress={() => router.back()}>
            <Text style={styles.greenBtnText}>Receive cash & close</Text>
          </Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bgElev },
  totalBlock: {
    backgroundColor: ios.bgElev,
    paddingHorizontal: 16,
    paddingTop: 18,
    paddingBottom: 20,
    alignItems: "center",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: ios.separator,
  },
  eyebrow: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    letterSpacing: 0.6,
  },
  totalRow: { flexDirection: "row", alignItems: "flex-end", marginTop: 12 },
  currency: {
    fontSize: 28,
    fontFamily: "Inter_700Bold",
    color: ios.label2,
    marginBottom: 8,
    marginRight: 2,
  },
  totalWhole: {
    fontSize: 52,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    letterSpacing: -2.2,
    lineHeight: 52,
    fontVariant: ["tabular-nums"],
  },
  totalFraction: {
    fontSize: 28,
    fontFamily: "Inter_700Bold",
    color: ios.gray[3],
    marginBottom: 4,
    fontVariant: ["tabular-nums"],
  },
  totalSub: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 4 },
  receivedBlock: {
    marginHorizontal: 16,
    marginTop: 14,
    backgroundColor: ios.bg,
    borderRadius: 14,
    padding: 14,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  eyebrowSmall: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    letterSpacing: 0.9,
  },
  receivedValue: {
    fontSize: 30,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    letterSpacing: -0.8,
    fontVariant: ["tabular-nums"],
    marginTop: 2,
  },
  changeBlock: {
    backgroundColor: ios.system.greenWash,
    padding: 10,
    paddingHorizontal: 14,
    borderRadius: 12,
    alignItems: "flex-end",
  },
  changeEyebrow: {
    fontSize: 10,
    fontFamily: "Inter_700Bold",
    color: ios.system.greenInk,
    letterSpacing: 0.9,
  },
  changeValue: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    color: ios.system.greenInk,
    fontVariant: ["tabular-nums"],
  },
  quickGrid: {
    flexDirection: "row",
    paddingHorizontal: 16,
    paddingTop: 12,
    gap: 8,
  },
  quickCell: {
    flex: 1,
    backgroundColor: ios.fill3,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: "center",
  },
  quickText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  keypad: {
    marginHorizontal: 16,
    marginTop: 14,
    backgroundColor: ios.bg,
    borderRadius: 14,
    overflow: "hidden",
    flexDirection: "row",
    flexWrap: "wrap",
  },
  key: {
    width: "33.333%",
    height: 56,
    backgroundColor: ios.bgElev,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: ios.bg,
  },
  keyText: {
    fontSize: 22,
    fontFamily: "Inter_500Medium",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  greenBtn: {
    backgroundColor: ios.system.green,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: "center",
  },
  greenBtnText: {
    color: "#fff",
    fontSize: 17,
    fontFamily: "Inter_600SemiBold",
  },
});
