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
import { FormField, FormTextInput } from "./FormSheet";

/** Common demote reasons, tappable so an operator mid-route need not type. */
const DEFAULT_PRESETS = [
  "Customer changed the order",
  "Stock unavailable",
  "Delivery rescheduled",
  "Entered by mistake",
];

/**
 * Collects the free-text `reason` the server demands before it will demote an
 * order (`PATCH /orders/:id/status` 400s with "A reason is required when
 * demoting an order" otherwise — see `lib/order-status-flow.ts`).
 *
 * Submit stays disabled until the text is non-empty, because a blank reason is
 * exactly the request the server rejects; the presets exist so the common cases
 * cost one tap rather than a sentence typed on a handset.
 */
export function ReasonSheet({
  visible,
  title,
  message,
  submitLabel = "Confirm",
  submitting,
  presets = DEFAULT_PRESETS,
  onCancel,
  onSubmit,
}: {
  visible: boolean;
  title: string;
  message?: string;
  submitLabel?: string;
  submitting?: boolean;
  presets?: string[];
  onCancel: () => void;
  onSubmit: (reason: string) => void;
}) {
  const [reason, setReason] = React.useState("");

  // Clear between openings so a previous reason is never silently reused.
  React.useEffect(() => {
    if (visible) setReason("");
  }, [visible]);

  const trimmed = reason.trim();
  const canSubmit = trimmed.length > 0 && !submitting;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      <Pressable style={styles.backdrop} onPress={onCancel} />
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.sheetWrap}
      >
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>{title}</Text>
            <Pressable onPress={onCancel} hitSlop={10} accessibilityLabel="Close">
              <Ionicons name="close" size={20} color={ios.label2} />
            </Pressable>
          </View>

          <ScrollView
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ paddingBottom: 8 }}
          >
            {message ? <Text style={styles.message}>{message}</Text> : null}

            {presets.length > 0 ? (
              <View style={styles.presets}>
                {presets.map((p) => {
                  const active = trimmed === p;
                  return (
                    <Pressable
                      key={p}
                      onPress={() => setReason(p)}
                      style={[styles.chip, active && styles.chipActive]}
                    >
                      <Text style={[styles.chipText, active && styles.chipTextActive]}>{p}</Text>
                    </Pressable>
                  );
                })}
              </View>
            ) : null}

            <FormField label="Reason" hint="Saved to the order's notes.">
              <FormTextInput
                value={reason}
                onChangeText={setReason}
                placeholder="Why is this going back?"
                autoCapitalize="sentences"
                multiline
                style={styles.input}
              />
            </FormField>

            <Pressable
              onPress={() => canSubmit && onSubmit(trimmed)}
              disabled={!canSubmit}
              style={[styles.submitBtn, !canSubmit && styles.submitBtnDisabled]}
            >
              <Text style={styles.submitText}>{submitting ? "Saving…" : submitLabel}</Text>
            </Pressable>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)" },
  sheetWrap: { position: "absolute", left: 0, right: 0, bottom: 0 },
  sheet: {
    maxHeight: "88%",
    backgroundColor: ios.bg,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 16,
    paddingTop: 6,
    paddingBottom: 16,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 10,
  },
  title: { fontSize: 16, fontFamily: "Inter_700Bold", color: ios.label },
  message: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    marginBottom: 12,
    lineHeight: 18,
  },
  presets: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 12 },
  chip: {
    backgroundColor: ios.fill3,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  chipActive: { backgroundColor: ios.brand },
  chipText: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.label },
  chipTextActive: { color: "#fff" },
  input: { minHeight: 72, paddingTop: 10, textAlignVertical: "top" },
  submitBtn: {
    marginTop: 10,
    backgroundColor: ios.brand,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  submitBtnDisabled: { opacity: 0.4 },
  submitText: { fontSize: 16, fontFamily: "Inter_600SemiBold", color: "#fff" },
});
