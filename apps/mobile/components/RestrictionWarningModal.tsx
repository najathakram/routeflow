import * as React from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { ios } from "@routeflow/ui/tokens";
import {
  RESTRICTION_OVERRIDE_REASON_MAX,
  type BlockedLine,
  type RestrictionAck,
  type RestrictionWarningError,
  type RestrictionWarningLine,
} from "@routeflow/types";
import { FormField, FormTextInput } from "./FormSheet";
import { restrictionReasonText } from "../lib/selling-restricted";
import {
  RESTRICTION_COPY as COPY,
  buildAck,
  checkOverrideReason,
  driverBlockRows,
  ruleText,
} from "../lib/restriction-warning";

export type RestrictionModalView =
  | { kind: "warning"; warning: RestrictionWarningError }
  | {
      kind: "blocked";
      message: string;
      lines: BlockedLine[];
      /** Per-rule lines the server adds to the driver body: the same text and badge staff see. */
      ruleLines?: RestrictionWarningLine[];
    };

interface Props {
  /** null = closed. */
  view: RestrictionModalView | null;
  /** A reason typed on an earlier attempt of the same save (a fresh 409 re-shows the modal with it). */
  initialReason?: string;
  /** "Sell anyway": the ack to resubmit with, and the trimmed reason (kept for a second 409). */
  onConfirm: (ack: RestrictionAck, reason: string) => void;
  /** "Go back": nothing is sent, and the form and cart stay as they were. */
  onCancel: () => void;
}

/**
 * Row 510: the ONE staff warning, mobile twin of web's RestrictionWarningDialog. Lists the breached lines (name, rules,
 * a "Legal ban" badge), asks for ONE reason (3-200 characters, sent for every listed line) and resolves the ack. A
 * DRIVER, who may not override, gets the same modal in its "blocked" form: "Ask the office to approve this sale", no
 * reason field and no override. Mount it with a `key` per warning (the hook does) so a re-show starts from the kept reason.
 */
export function RestrictionWarningModal({ view, initialReason = "", onConfirm, onCancel }: Props) {
  const [reason, setReason] = React.useState(initialReason);
  if (!view) return null;
  const check = checkOverrideReason(reason);
  const showError = reason.length > 0 && !check.ok;
  const blocked = view.kind === "blocked";

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onCancel}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.overlay}
      >
        <View style={styles.card}>
          <View style={styles.header}>
            <Ionicons name="alert-circle-outline" size={20} color={ios.system.red} />
            <Text style={styles.title}>{blocked ? COPY.blockedTitle : COPY.title}</Text>
          </View>
          <Text style={styles.message}>{blocked ? COPY.blockedBody : COPY.body}</Text>
          <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
            {view.kind === "blocked" && (view.ruleLines ?? []).length > 0
              ? driverBlockRows(view.ruleLines ?? []).map((row) => (
                  <View key={row.key} style={styles.row}>
                    <Text style={styles.name}>{row.name}</Text>
                    {row.items.map((it, i) => (
                      <View key={i} style={styles.ruleRow}>
                        <Text style={styles.reason}>{it.text}</Text>
                        {it.legal ? <Text style={styles.badge}>{COPY.legalBadge}</Text> : null}
                      </View>
                    ))}
                  </View>
                ))
              : view.kind === "blocked"
                ? view.lines.map((l) => (
                    <View key={`${l.productId}:${l.ruleId ?? l.reason}`} style={styles.row}>
                      <Text style={styles.name}>{l.productName}</Text>
                      <Text style={styles.reason}>{restrictionReasonText(l)}</Text>
                    </View>
                  ))
                : view.warning.lines.map((l) => (
                    <View key={l.lineKey} style={styles.row}>
                      <Text style={styles.name}>{l.displayName}</Text>
                      {l.rules.length === 0 ? (
                        <Text style={styles.reason}>{COPY.unchecked}</Text>
                      ) : (
                        l.rules.map((r) => (
                          <View key={r.id} style={styles.ruleRow}>
                            <Text style={styles.reason}>{ruleText(r)}</Text>
                            {r.legal ? <Text style={styles.badge}>{COPY.legalBadge}</Text> : null}
                          </View>
                        ))
                      )}
                    </View>
                  ))}
          </ScrollView>
          {view.kind === "warning" ? (
            <FormField
              label={COPY.reasonLabel}
              error={showError ? (check.error ?? undefined) : undefined}
              hint={`${check.length}/${RESTRICTION_OVERRIDE_REASON_MAX}`}
            >
              <FormTextInput
                value={reason}
                onChangeText={setReason}
                placeholder={COPY.reasonPlaceholder}
                autoCapitalize="sentences"
                multiline
                style={styles.input}
              />
            </FormField>
          ) : null}
          <View style={styles.buttons}>
            {view.kind === "warning" ? (
              <>
                <Pressable
                  style={[styles.btn, styles.btnGhost]}
                  onPress={onCancel}
                  accessibilityRole="button"
                >
                  <Text style={styles.btnGhostText}>{COPY.goBack}</Text>
                </Pressable>
                <Pressable
                  style={[styles.btn, styles.btnFill, !check.ok && styles.btnDisabled]}
                  disabled={!check.ok}
                  onPress={() => check.ok && onConfirm(buildAck(view.warning, reason), check.value)}
                  accessibilityRole="button"
                >
                  <Text style={styles.btnFillText}>{COPY.sellAnyway}</Text>
                </Pressable>
              </>
            ) : (
              <Pressable
                style={[styles.btn, styles.btnFill]}
                onPress={onCancel}
                accessibilityRole="button"
              >
                <Text style={styles.btnFillText}>{COPY.ok}</Text>
              </Pressable>
            )}
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "center", padding: 20 },
  card: { backgroundColor: ios.bgElev, borderRadius: 18, padding: 18, gap: 12, maxHeight: "88%" },
  header: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { flex: 1, fontSize: 17, fontFamily: "Inter_700Bold", color: ios.label },
  message: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label2, lineHeight: 20 },
  list: { flexGrow: 0 },
  row: { backgroundColor: ios.fill3, borderRadius: 12, padding: 12, marginBottom: 8, gap: 2 },
  name: { fontSize: 15, fontFamily: "Inter_700Bold", color: ios.label },
  ruleRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  reason: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.system.red },
  badge: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: ios.system.red,
    borderWidth: 1,
    borderColor: ios.system.red,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  input: { minHeight: 72, paddingTop: 10, textAlignVertical: "top" },
  buttons: { flexDirection: "row", gap: 10 },
  btn: { flex: 1, paddingVertical: 13, borderRadius: 12, alignItems: "center" },
  btnGhost: { backgroundColor: ios.fill3 },
  btnGhostText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },
  btnFill: { backgroundColor: ios.brand },
  btnFillText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: "#fff" },
  btnDisabled: { opacity: 0.4 },
});
