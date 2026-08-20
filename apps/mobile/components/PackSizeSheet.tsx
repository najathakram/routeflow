import * as React from "react";
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { ios } from "@routeflow/ui/tokens";
import { FormField, FormTextInput } from "./FormSheet";
import { parsePackSize, type PackSizePrompt } from "../lib/pack-size-logic";

interface PackSizeSheetProps {
  visible: boolean;
  /**
   * Prompt copy + initial value, already computed by `packSizePromptFor`
   * (`lib/pack-size-logic.ts`) from the parser's `PackSizeSuggestion`
   * (`@routeflow/types`). `null` means "nothing to ask" — callers should keep
   * `visible` false in that case; this component also no-ops defensively.
   */
  prompt: PackSizePrompt | null;
  submitting?: boolean;
  /** Operator dismissed without setting a pack size — save proceeds unchanged. */
  onSkip: () => void;
  /** Operator confirmed a pack size — caller merges it into the save. */
  onConfirm: (unitsPerBox: number) => void;
}

/**
 * Prompt-on-save sheet for the mobile product create/edit screens: when the
 * name/unit suggests a box packaging that the product doesn't have recorded
 * yet, ask before finishing the save rather than silently leaving the field
 * blank forever. Mirrors the web `PackSizePrompt` copy rules using the
 * FormSheet field primitives (FormField/FormTextInput) for a consistent look.
 *
 * Never guesses: AMBIGUOUS and LOW prompts arrive with an empty
 * `prompt.initialValue`, and Confirm stays disabled until the operator types
 * a valid count themselves.
 */
export function PackSizeSheet({
  visible,
  prompt,
  submitting,
  onSkip,
  onConfirm,
}: PackSizeSheetProps) {
  const [value, setValue] = React.useState(prompt?.initialValue ?? "");

  // Re-seed the input whenever a fresh prompt opens — never carry a stale
  // typed value from a previous product into this one. Depends on the
  // primitive `initialValue`, not the `prompt` object, so an unrelated parent
  // re-render (e.g. a background query refetch while the sheet is open)
  // can't hand us a new object reference and wipe what the operator is mid-
  // typing.
  React.useEffect(() => {
    if (visible) setValue(prompt?.initialValue ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, prompt?.initialValue]);

  if (!prompt) return null;

  const parsed = parsePackSize(value);
  const confirmDisabled = !!submitting || parsed == null;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onSkip}>
      <Pressable style={styles.backdrop} onPress={onSkip} />
      <View style={styles.sheet}>
        <View style={styles.handle} />
        <Text style={styles.title}>Pack size</Text>
        <Text style={styles.message}>{prompt.message}</Text>

        <FormField label="Units per case">
          <FormTextInput
            value={value}
            onChangeText={setValue}
            placeholder="e.g. 12"
            keyboardType="number-pad"
            autoFocus
          />
        </FormField>

        <View style={styles.footer}>
          <Pressable
            onPress={onSkip}
            style={[styles.btn, styles.btnSecondary]}
            disabled={submitting}
          >
            <Text style={styles.btnSecondaryText}>Skip</Text>
          </Pressable>
          <Pressable
            onPress={() => {
              if (parsed != null) onConfirm(parsed);
            }}
            style={[styles.btn, styles.btnPrimary, confirmDisabled && styles.btnDisabled]}
            disabled={confirmDisabled}
          >
            {submitting ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.btnPrimaryText}>Set pack size</Text>
            )}
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.35)",
  },
  sheet: {
    backgroundColor: ios.bgElev,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 20,
    paddingTop: 10,
    paddingBottom: 20,
    maxWidth: 480,
    width: "100%",
    alignSelf: "center",
    gap: 14,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: ios.separator,
    alignSelf: "center",
    marginBottom: 4,
  },
  title: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    letterSpacing: 0.3,
    textTransform: "uppercase",
  },
  message: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: ios.label,
    lineHeight: 20,
  },
  footer: {
    flexDirection: "row",
    gap: 10,
    marginTop: 4,
  },
  btn: {
    flex: 1,
    height: 46,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  btnPrimary: { backgroundColor: ios.brand },
  btnPrimaryText: { color: "#fff", fontSize: 15, fontFamily: "Inter_600SemiBold" },
  btnSecondary: { backgroundColor: ios.fill3 },
  btnSecondaryText: { color: ios.label, fontSize: 15, fontFamily: "Inter_600SemiBold" },
  btnDisabled: { opacity: 0.4 },
});
