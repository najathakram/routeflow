import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { ios } from "@routeflow/ui/tokens";
import {
  orderAppliedCredits,
  requestedLabel,
  type OrderAppliedCreditsInput,
} from "@routeflow/types";
import { useUnapplyCreditNote } from "../lib/api/credit-notes";
import { confirm } from "../lib/confirm";
import { showToast } from "../lib/toast";

const money = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * #2404 (P0, epic #2400, SA-436 PR-3), mirroring web's AppliedCreditsPanel: EVERY credit actually
 * on the order's invoices (Automatic or Applied, each with its invoice) plus the picked credits
 * not yet applied, from the SAME shared rule (`orderAppliedCredits`). Remove un-applies an
 * applied credit from its invoice. The operator app is staff-only, like the invoice screen's
 * own Remove credit.
 */
export function OrderAppliedCredits({ order }: { order: OrderAppliedCreditsInput }) {
  const rows = orderAppliedCredits(order);
  const unapply = useUnapplyCreditNote();
  if (rows.length === 0) return null;

  return (
    <View style={styles.card}>
      <Text style={styles.title}>Applied credits</Text>
      {rows.map((row, i) => (
        <View key={row.key} style={[styles.row, i > 0 && styles.rowDivider]}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.number} numberOfLines={1}>
              {row.creditNoteNumber}
            </Text>
            {row.reason ? (
              <Text style={styles.sub} numberOfLines={2}>
                {row.reason}
              </Text>
            ) : null}
            {row.kind === "applied" ? (
              <View style={styles.metaRow}>
                <Text style={styles.sub}>on {row.invoiceNumber}</Text>
                <Text style={styles.chip}>
                  {row.source === "automatic" ? "Automatic" : "Applied"}
                </Text>
                <Pressable
                  onPress={() =>
                    confirm(
                      "Remove this credit?",
                      `This un-applies ${money(row.pairTotal)} of ${row.creditNoteNumber} from ${row.invoiceNumber} and restores it to the credit note's balance.`,
                      () =>
                        unapply.mutate(
                          { id: row.creditNoteId, invoiceId: row.invoiceId },
                          {
                            onSuccess: () => showToast("Credit removed"),
                            onError: (e: any) =>
                              showToast(
                                e?.response?.data?.message ?? "Couldn't remove the credit.",
                              ),
                          },
                        ),
                      { confirmText: "Remove credit", destructive: true },
                    )
                  }
                  hitSlop={6}
                  disabled={unapply.isPending}
                  style={[styles.remove, unapply.isPending && { opacity: 0.4 }]}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove credit ${row.creditNoteNumber} from ${row.invoiceNumber}`}
                >
                  <Ionicons name="arrow-undo-outline" size={13} color={ios.system.redInk} />
                  <Text style={styles.removeText}>Remove</Text>
                </Pressable>
              </View>
            ) : (
              <View style={styles.metaRow}>
                <Text style={styles.chip}>Not yet applied</Text>
                <Text style={styles.sub}>{requestedLabel(row, money)}</Text>
              </View>
            )}
          </View>
          {row.kind === "applied" ? <Text style={styles.amount}>{money(row.amount)}</Text> : null}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: ios.bgElev, borderRadius: 14, padding: 14, gap: 10 },
  title: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },
  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8 },
  rowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: ios.separator },
  number: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: ios.label },
  sub: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  metaRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8, marginTop: 2 },
  chip: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    backgroundColor: ios.fill3,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
    overflow: "hidden",
  },
  remove: { flexDirection: "row", alignItems: "center", gap: 3, minHeight: 24 },
  removeText: { fontSize: 12, fontFamily: "Inter_500Medium", color: ios.system.redInk },
  amount: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
});
