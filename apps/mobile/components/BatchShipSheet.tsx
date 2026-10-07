import { useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ios } from "@routeflow/ui/tokens";
import type { BatchShipResultRow } from "@routeflow/types";
import { useBatchShipOrders } from "../lib/api/orders";
import {
  BATCH_SHIP_COPY,
  batchShipDetail,
  buildBatchShipRows,
  shippedOrderIds,
} from "../lib/batch-ship-copy";
import { CARRIERS } from "../lib/shipping";

/**
 * "Mark shipped (n)" sheet on the operator orders list (#3168): optional carrier + tracking per selected
 * order, then a per-order result list with "Print packing slips" for the orders that shipped. Mirrors
 * web's BatchShipActions dialog; all outcome wording is `lib/batch-ship-copy.ts`.
 */
export type BatchShipOrderRow = { id: string; orderNumber: string; customerName?: string };

export function BatchShipSheet({
  visible,
  orders,
  onClose,
  onPrintSlips,
  printing,
}: {
  visible: boolean;
  orders: BatchShipOrderRow[];
  /** Called with the dismissal; `ran` is true once a batch was submitted (the screen clears selection). */
  onClose: (ran: boolean) => void;
  onPrintSlips: (orderIds: string[]) => void;
  printing: boolean;
}) {
  const batchShip = useBatchShipOrders();
  const [carriers, setCarriers] = useState<Record<string, string>>({});
  const [tracking, setTracking] = useState<Record<string, string>>({});
  const [results, setResults] = useState<BatchShipResultRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    const ran = results !== null;
    setResults(null);
    setCarriers({});
    setTracking({});
    setError(null);
    onClose(ran);
  };

  const submit = async () => {
    setError(null);
    try {
      const res = await batchShip.mutateAsync({
        orders: buildBatchShipRows(
          orders.map((o) => o.id),
          carriers,
          tracking,
          CARRIERS[0].id,
        ),
      });
      setResults(res.results);
    } catch {
      setError("Could not mark these orders shipped. Check your connection and try again.");
    }
  };

  const shipped = results ? shippedOrderIds(results) : [];
  const numberOf = (id: string) => orders.find((o) => o.id === id)?.orderNumber ?? "";

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={close}
    >
      <SafeAreaView style={styles.root} testID="batch-ship-sheet">
        <View style={styles.header}>
          <Text style={styles.title}>
            {results ? "Shipping results" : `Mark ${orders.length} shipped`}
          </Text>
          <Pressable
            onPress={close}
            accessibilityRole="button"
            testID="batch-ship-close"
            hitSlop={10}
          >
            <Text style={styles.link}>{results ? "Done" : "Cancel"}</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          {!results && (
            <Text style={styles.hint}>
              Carrier and tracking are optional. Customers get one shipped email per order.
            </Text>
          )}
          {results
            ? results.map((r) => {
                const copy = BATCH_SHIP_COPY[r.outcome];
                return (
                  <View
                    key={r.orderId}
                    style={styles.card}
                    testID={`batch-ship-result-${r.orderId}`}
                  >
                    <View style={styles.rowTop}>
                      <Text style={styles.num}>{r.orderNumber ?? numberOf(r.orderId)}</Text>
                      <Text
                        style={[
                          styles.badge,
                          copy.tone === "ok" && styles.ok,
                          copy.tone === "warn" && styles.warn,
                          copy.tone === "error" && styles.err,
                        ]}
                      >
                        {copy.label}
                      </Text>
                    </View>
                    <Text style={styles.detail}>{batchShipDetail(r)}</Text>
                  </View>
                );
              })
            : orders.map((o) => (
                <View key={o.id} style={styles.card} testID={`batch-ship-row-${o.id}`}>
                  <Text style={styles.num}>{o.orderNumber}</Text>
                  {o.customerName ? <Text style={styles.detail}>{o.customerName}</Text> : null}
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    style={styles.chips}
                  >
                    {CARRIERS.map((c) => {
                      const on = (carriers[o.id] ?? CARRIERS[0].id) === c.id;
                      return (
                        <Pressable
                          key={c.id}
                          onPress={() => setCarriers((p) => ({ ...p, [o.id]: c.id }))}
                          style={[styles.chip, on && styles.chipOn]}
                          accessibilityRole="button"
                          accessibilityState={{ selected: on }}
                          testID={`batch-ship-carrier-${o.id}-${c.id}`}
                        >
                          <Text style={[styles.chipText, on && styles.chipTextOn]}>{c.label}</Text>
                        </Pressable>
                      );
                    })}
                  </ScrollView>
                  <TextInput
                    style={styles.input}
                    value={tracking[o.id] ?? ""}
                    onChangeText={(v) => setTracking((p) => ({ ...p, [o.id]: v }))}
                    placeholder="Tracking number"
                    placeholderTextColor={ios.gray[3]}
                    autoCapitalize="characters"
                    autoCorrect={false}
                    maxLength={128}
                    testID={`batch-ship-tracking-${o.id}`}
                  />
                </View>
              ))}
          {error ? <Text style={[styles.detail, styles.err]}>{error}</Text> : null}
        </ScrollView>
        <View style={styles.footer}>
          {results ? (
            shipped.length > 0 ? (
              <Pressable
                style={[styles.btn, printing && styles.btnOff]}
                disabled={printing}
                onPress={() => onPrintSlips(shipped)}
                accessibilityRole="button"
                testID="batch-ship-print-slips"
              >
                {printing ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.btnText}>Print packing slips ({shipped.length})</Text>
                )}
              </Pressable>
            ) : null
          ) : (
            <Pressable
              style={[styles.btn, batchShip.isPending && styles.btnOff]}
              disabled={batchShip.isPending}
              onPress={() => void submit()}
              accessibilityRole="button"
              testID="batch-ship-submit"
            >
              {batchShip.isPending ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.btnText}>Mark shipped</Text>
              )}
            </Pressable>
          )}
        </View>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: ios.bgElev },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: ios.separator,
  },
  title: { fontSize: 17, fontFamily: "Inter_700Bold", color: ios.label },
  link: { fontSize: 16, fontFamily: "Inter_600SemiBold", color: ios.brand },
  body: { padding: 16, gap: 12 },
  hint: { fontSize: 13, color: ios.gray[1] },
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: ios.separator,
    borderRadius: 12,
    padding: 12,
    gap: 6,
  },
  rowTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
  num: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },
  detail: { fontSize: 13, color: ios.gray[1] },
  badge: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
    overflow: "hidden",
  },
  ok: { color: ios.system.greenInk, backgroundColor: ios.system.greenWash },
  warn: { color: ios.system.orangeInk, backgroundColor: ios.system.orangeWash },
  err: { color: ios.system.redInk, backgroundColor: ios.system.redWash },
  chips: { flexGrow: 0, marginVertical: 4 },
  chip: {
    minHeight: 36,
    paddingHorizontal: 12,
    justifyContent: "center",
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: ios.separator,
    marginRight: 8,
  },
  chipOn: { backgroundColor: ios.brand, borderColor: ios.brand },
  chipText: { fontSize: 13, color: ios.label },
  chipTextOn: { color: "#fff" },
  input: {
    minHeight: ios.rowMinH,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: ios.separator,
    borderRadius: 10,
    paddingHorizontal: 12,
    fontSize: 15,
    color: ios.label,
  },
  footer: {
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
  },
  btn: {
    minHeight: ios.rowMinH,
    backgroundColor: ios.brand,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 14,
  },
  btnOff: { opacity: 0.5 },
  btnText: { color: "#fff", fontSize: 15, fontFamily: "Inter_600SemiBold" },
});
