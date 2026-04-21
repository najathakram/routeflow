import { useMemo, useState } from "react";
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
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import {
  NavAction,
  NavBackButton,
  NavBar,
  SegmentedControl,
} from "@routeflow/ui/mobile/ios";
import {
  useActiveRouteRun,
  useCompleteStop,
  useRouteRun,
  type RouteRunStop,
} from "../../../../../lib/api/routes";
import { useRecordInvoicePayment } from "../../../../../lib/api/invoices";
import { usePodStore } from "../../../../../store/podStore";
import { showToast } from "../../../../../lib/toast";

const METHODS = ["Cash", "Card", "Cheque", "On account"] as const;
const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "·", "0", "⌫"];

function totalForStop(stop: RouteRunStop): number {
  return (stop.orders ?? []).reduce(
    (sum, o) =>
      sum +
      (o.lineItems ?? []).reduce(
        (s, li) => s + Number(li.qty ?? 0) * Number(li.unitPrice ?? 0),
        0,
      ),
    0,
  );
}

export default function PaymentScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ stopId: string; runId?: string }>();
  const stopId = params.stopId;

  const { data: activeData } = useActiveRouteRun();
  const runId = params.runId ?? activeData?.data?.[0]?.id;
  const { data: run, isLoading } = useRouteRun(runId ?? "");
  const stop = useMemo(
    () => run?.stops?.find((s) => s.id === stopId),
    [run, stopId],
  );

  const invoiceTotal = stop ? totalForStop(stop) : 0;
  const invoiceLabel = stop?.orders?.[0]?.orderNumber
    ? `ORDER ${stop.orders[0].orderNumber} · ${(stop.customer?.businessName ?? "Customer").toUpperCase()}`
    : "PAYMENT";

  const [method, setMethod] = useState<string>("Cash");
  const [received, setReceived] = useState<string>("0");
  const receivedNum = Number(received);
  const change = Math.max(0, receivedNum - invoiceTotal);

  const completeMut = useCompleteStop();
  const paymentMut = useRecordInvoicePayment();
  const pod = usePodStore((s) => (stopId ? s.pods[stopId] : undefined));
  const clearPod = usePodStore((s) => s.clear);

  const submitting = completeMut.isPending || paymentMut.isPending;

  const closeStop = async () => {
    if (!stopId || !runId || !stop) return;

    // 1. Complete the stop with all delivered items + POD
    const items = (stop.orders ?? []).flatMap((o) =>
      (o.lineItems ?? []).map((li) => ({
        orderItemId: li.id,
        productId: li.productId,
        type: "DELIVERED" as const,
        qty: Number(li.qty ?? 0),
      })),
    );
    try {
      await completeMut.mutateAsync({
        runId,
        stopId,
        items,
        podPhotoUrls: pod?.photoUrls,
        signatureUrl: pod?.signatureUri,
        driverNote: pod?.note,
      });
    } catch (e: any) {
      Alert.alert(
        "Couldn't complete stop",
        e?.response?.data?.message ?? e?.message ?? "Try again.",
      );
      return;
    }

    // 2. Record payment if there's an invoice and the driver collected something
    const invoiceId = stop.orders?.[0]?.invoiceId;
    const apiMethod = ({
      Cash: "CASH",
      Card: "CREDIT_CARD",
      Cheque: "CHECK",
      "On account": "ADVANCE",
    }[method] ?? "OTHER") as "CASH" | "CHECK" | "CREDIT_CARD" | "ADVANCE" | "OTHER";
    const collected = method === "On account" ? 0 : Math.min(receivedNum, invoiceTotal);

    if (invoiceId && collected > 0) {
      try {
        await paymentMut.mutateAsync({
          invoiceId,
          amount: collected,
          method: apiMethod,
        });
      } catch (e: any) {
        // Stop is already completed at this point, so warn but don't roll back
        Alert.alert(
          "Stop completed but payment failed",
          e?.response?.data?.message ?? e?.message ?? "Record payment from invoices later.",
        );
      }
    }

    clearPod(stopId);
    showToast("Stop completed");
    router.replace("/(driver)/route");
  };

  const press = (k: string) => {
    setReceived((prev) => {
      if (k === "⌫") return prev.slice(0, -1) || "0";
      if (k === "·") return prev.includes(".") ? prev : prev + ".";
      if (prev === "0" || prev === "0.00") return k;
      return prev + k;
    });
  };

  const whole = Math.floor(invoiceTotal);
  const fraction = invoiceTotal.toFixed(2).split(".")[1] ?? "00";

  if (isLoading) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar
          tint="light"
          inlineTitle="Collect payment"
          leading={<NavBackButton label="Stop" onPress={() => router.back()} />}
        />
        <View style={styles.center}>
          <ActivityIndicator color={ios.brand} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        tint="light"
        inlineTitle="Collect payment"
        leading={<NavBackButton label="Stop" onPress={() => router.back()} />}
        trailing={<NavAction label="Skip" onPress={() => router.back()} />}
      />

      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={styles.totalBlock}>
          <Text style={styles.eyebrow}>{invoiceLabel}</Text>
          <View style={styles.totalRow}>
            <Text style={styles.currency}>$</Text>
            <Text style={styles.totalWhole}>{whole}</Text>
            <Text style={styles.totalFraction}>.{fraction}</Text>
          </View>
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
          {[
            Math.max(20, Math.round(invoiceTotal * 0.5)),
            Math.round(invoiceTotal),
            Math.round(invoiceTotal) + 20,
            Math.round(invoiceTotal) + 50,
          ]
            .filter((n) => n > 0)
            .map((n) => (
              <Pressable
                key={n}
                style={styles.quickCell}
                onPress={() => setReceived(`${n}`)}
              >
                <Text style={styles.quickText}>${n}</Text>
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
          <Pressable
            style={[styles.greenBtn, submitting && styles.greenBtnDisabled]}
            onPress={submitting ? undefined : closeStop}
            disabled={submitting}
          >
            <Text style={styles.greenBtnText}>
              {submitting
                ? "Closing…"
                : method === "On account"
                  ? "Mark on account & close"
                  : "Receive payment & close"}
            </Text>
          </Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bgElev },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
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
    textAlign: "center",
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
  greenBtnDisabled: {
    opacity: 0.55,
  },
  greenBtnText: {
    color: "#fff",
    fontSize: 17,
    fontFamily: "Inter_600SemiBold",
  },
});
