import * as React from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { ios } from "@routeflow/ui/tokens";
import type { PickupCompleteRequest } from "@routeflow/types";
import {
  POS_COPY,
  POS_TENDER_METHODS,
  POS_TENDER_PROBLEM_COPY,
  planPosTender,
  posMayHandOverUnpaid,
  type PosTenderMethod,
} from "../lib/pos-mode";

/**
 * POS "Hand over" tender step: method (Cash / Card / Check), amount defaulting to the balance, a check
 * number for a check. Optional for a named customer (an open invoice on account), required for a walk-in.
 */
export function PosHandOverSheet({
  visible,
  isWalkIn,
  balanceDue,
  submitting,
  loading,
  error,
  onCancel,
  onSubmit,
}: {
  visible: boolean;
  /** Unknown / loading counts as not known-named: a tender is required. */
  isWalkIn: boolean | null | undefined;
  balanceDue: number;
  submitting?: boolean;
  /** The invoices' balances are still being read: the tender cannot be judged yet. */
  loading?: boolean;
  /** Fixed copy for the last failed attempt (never a server message). */
  error?: string | null;
  onCancel: () => void;
  onSubmit: (body: PickupCompleteRequest) => void;
}) {
  const [method, setMethod] = React.useState<PosTenderMethod>("CASH");
  const [amount, setAmount] = React.useState("");
  const [reference, setReference] = React.useState("");
  const [problem, setProblem] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (visible) {
      setMethod("CASH");
      setAmount(balanceDue > 0 ? balanceDue.toFixed(2) : "");
      setReference("");
      setProblem(null);
    }
  }, [visible, balanceDue]);

  // A hand-over in flight must not be abandoned: the outcome is unknown until it answers.
  const cancel = () => {
    if (!submitting) onCancel();
  };
  const nothingOwed = !loading && balanceDue <= 0;

  const submit = (skip: boolean) => {
    const plan = planPosTender({
      isWalkIn,
      skip,
      method,
      amountRaw: amount,
      reference,
      balanceDue,
    });
    if (!plan.ok) {
      setProblem(POS_TENDER_PROBLEM_COPY[plan.problem]);
      return;
    }
    setProblem(null);
    onSubmit(plan.body);
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={cancel}>
      <Pressable style={styles.backdrop} onPress={cancel} />
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.sheetWrap}
      >
        <View style={styles.sheet}>
          <Text style={styles.title}>{POS_COPY.handOver}</Text>
          <Text style={styles.hint}>
            {posMayHandOverUnpaid(isWalkIn)
              ? "Take payment now, or hand over and leave the invoice open."
              : "Take payment to hand the order over."}
          </Text>
          {nothingOwed ? (
            <Text style={styles.hint}>Nothing is owed on this order.</Text>
          ) : (
            <>
              <View style={styles.chips}>
                {POS_TENDER_METHODS.map((m) => (
                  <Pressable
                    key={m.method}
                    onPress={() => setMethod(m.method)}
                    style={[styles.chip, method === m.method && styles.chipActive]}
                    accessibilityRole="button"
                    accessibilityState={{ selected: method === m.method }}
                  >
                    <Text style={[styles.chipText, method === m.method && styles.chipTextActive]}>
                      {m.label}
                    </Text>
                  </Pressable>
                ))}
              </View>
              {method === "CASH" ? (
                <>
                  <Text style={styles.label}>Amount ($)</Text>
                  <TextInput
                    value={amount}
                    accessibilityLabel="Amount"
                    onChangeText={setAmount}
                    keyboardType="decimal-pad"
                    placeholder={balanceDue.toFixed(2)}
                    placeholderTextColor={ios.label3}
                    style={styles.input}
                  />
                </>
              ) : (
                <Text style={styles.hint}>Pays the balance: ${balanceDue.toFixed(2)}</Text>
              )}
              {method === "CHECK" ? (
                <>
                  <Text style={styles.label}>Check number</Text>
                  <TextInput
                    value={reference}
                    accessibilityLabel="Check number"
                    onChangeText={setReference}
                    placeholderTextColor={ios.label3}
                    style={styles.input}
                  />
                </>
              ) : null}
            </>
          )}
          {problem || error ? <Text style={styles.error}>{problem ?? error}</Text> : null}
          <Pressable
            style={[styles.primary, submitting && { opacity: 0.5 }]}
            disabled={submitting || loading}
            onPress={() => submit(false)}
            accessibilityRole="button"
          >
            <Text style={styles.primaryText}>
              {submitting
                ? "Saving…"
                : loading
                  ? "Loading balance…"
                  : nothingOwed
                    ? POS_COPY.handOver
                    : `${POS_COPY.handOver} and take payment`}
            </Text>
          </Pressable>
          {posMayHandOverUnpaid(isWalkIn) && !nothingOwed ? (
            <Pressable
              style={styles.secondary}
              disabled={submitting}
              onPress={() => submit(true)}
              accessibilityRole="button"
            >
              <Text style={styles.secondaryText}>{POS_COPY.handOver}, no payment</Text>
            </Pressable>
          ) : null}
          <Pressable
            style={[styles.secondary, submitting && { opacity: 0.5 }]}
            disabled={submitting}
            onPress={cancel}
            accessibilityRole="button"
          >
            <Text style={styles.secondaryText}>Cancel</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)" },
  sheetWrap: { position: "absolute", left: 0, right: 0, bottom: 0 },
  sheet: {
    backgroundColor: "#fff",
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 16,
    gap: 8,
  },
  title: { fontSize: 17, fontFamily: "Inter_600SemiBold", color: ios.label },
  hint: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2 },
  chips: { flexDirection: "row", gap: 8, marginVertical: 4 },
  chip: {
    flex: 1,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 10,
    backgroundColor: ios.brandWash,
  },
  chipActive: { backgroundColor: ios.brand },
  chipText: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: ios.brand },
  chipTextActive: { color: "#fff" },
  label: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: ios.label },
  input: {
    minHeight: 44,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: ios.separator,
    paddingHorizontal: 12,
    fontSize: 16,
    color: ios.label,
  },
  error: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.system.red },
  primary: {
    minHeight: 48,
    borderRadius: 12,
    backgroundColor: ios.brand,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 4,
  },
  primaryText: { fontSize: 16, fontFamily: "Inter_600SemiBold", color: "#fff" },
  secondary: { minHeight: 44, alignItems: "center", justifyContent: "center" },
  secondaryText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.brand },
});
