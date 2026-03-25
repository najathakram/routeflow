import {
  ActivityIndicator,
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useState } from "react";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors, borderRadius, shadows } from "@routeflow/ui/tokens";
import { useRecordAdjustment } from "../../../lib/api/inventory";

type Mode = "count" | "add" | "remove";

const MODES: { key: Mode; label: string; icon: string; color: string }[] = [
  { key: "count", label: "Stock Count", icon: "clipboard-outline", color: colors.brand[500] },
  { key: "add",   label: "Add Stock",   icon: "add-circle-outline", color: colors.success.DEFAULT },
  { key: "remove",label: "Remove Stock",icon: "remove-circle-outline", color: colors.danger.DEFAULT },
];

export default function AdjustStockScreen() {
  const { productId, productName, unit, currentStock } =
    useLocalSearchParams<{
      productId: string;
      productName: string;
      unit: string;
      currentStock: string;
    }>();

  const current = parseInt(currentStock ?? "0", 10);
  const { mutate: recordAdjustment, isPending } = useRecordAdjustment();

  const [mode, setMode] = useState<Mode>("count");
  const [qty, setQty] = useState("");
  const [notes, setNotes] = useState("");

  const parsedQty = parseInt(qty, 10);
  const isValid = !isNaN(parsedQty) && parsedQty >= 0;

  // Calculate the adjustment delta based on mode
  const delta = (() => {
    if (!isValid) return null;
    if (mode === "count") return parsedQty - current;
    if (mode === "add") return parsedQty;
    return -parsedQty;
  })();

  const newStock = delta !== null ? current + delta : null;

  const handleSubmit = () => {
    if (!productId || delta === null || delta === 0) return;
    Keyboard.dismiss();

    recordAdjustment(
      {
        productId,
        quantity: delta,
        notes: notes || `${mode === "count" ? "Stock count" : mode === "add" ? "Stock added" : "Stock removed"} via driver app`,
      },
      {
        onSuccess: () => {
          Alert.alert("Done", "Stock updated successfully.", [
            { text: "OK", onPress: () => router.back() },
          ]);
        },
        onError: (err) => {
          Alert.alert("Error", "Failed to update stock.\n" + (err.message || ""));
        },
      },
    );
  };

  return (
    <>
      <Stack.Screen
        options={{ title: decodeURIComponent(productName ?? "Adjust Stock"), headerBackTitle: "Stock" }}
      />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={88}
      >
        <View style={styles.container}>
          {/* Current stock card */}
          <View style={styles.currentCard}>
            <Text style={styles.currentLabel}>Current Stock</Text>
            <Text style={styles.currentQty}>{current}</Text>
            <Text style={styles.currentUnit}>{decodeURIComponent(unit ?? "")}</Text>
          </View>

          {/* Mode selector */}
          <View style={styles.modeRow}>
            {MODES.map(({ key, label, icon, color }) => (
              <Pressable
                key={key}
                style={[styles.modeBtn, mode === key && { borderColor: color, backgroundColor: color + "18" }]}
                onPress={() => { setMode(key); setQty(""); }}
              >
                <Ionicons name={icon as any} size={20} color={mode === key ? color : "#94a3b8"} />
                <Text style={[styles.modeBtnText, mode === key && { color }]}>
                  {label}
                </Text>
              </Pressable>
            ))}
          </View>

          {/* Quantity input */}
          <View style={styles.section}>
            <Text style={styles.inputLabel}>
              {mode === "count"
                ? "New total quantity"
                : mode === "add"
                ? "Quantity to add"
                : "Quantity to remove"}
            </Text>
            <View style={styles.qtyRow}>
              <Pressable
                style={styles.qtyStepBtn}
                onPress={() => {
                  const n = parseInt(qty || "0", 10);
                  if (n > 0) setQty(String(n - 1));
                }}
              >
                <Text style={styles.qtyStepText}>−</Text>
              </Pressable>
              <TextInput
                style={styles.qtyInput}
                value={qty}
                onChangeText={setQty}
                keyboardType="number-pad"
                placeholder="0"
                placeholderTextColor="#94a3b8"
                textAlign="center"
              />
              <Pressable
                style={styles.qtyStepBtn}
                onPress={() => {
                  const n = parseInt(qty || "0", 10);
                  setQty(String(n + 1));
                }}
              >
                <Text style={styles.qtyStepText}>+</Text>
              </Pressable>
            </View>

            {/* Delta preview */}
            {isValid && delta !== null && (
              <View style={styles.deltaRow}>
                <Text style={styles.deltaLabel}>Result: </Text>
                <Text style={[
                  styles.deltaValue,
                  { color: delta > 0 ? colors.success.DEFAULT : delta < 0 ? colors.danger.DEFAULT : "#64748b" },
                ]}>
                  {current} → {newStock}
                  {delta !== 0 ? ` (${delta > 0 ? "+" : ""}${delta})` : " (no change)"}
                </Text>
              </View>
            )}
          </View>

          {/* Notes */}
          <View style={styles.section}>
            <Text style={styles.inputLabel}>Notes (optional)</Text>
            <TextInput
              style={styles.notesInput}
              placeholder="Reason for adjustment…"
              placeholderTextColor="#94a3b8"
              value={notes}
              onChangeText={setNotes}
              multiline
              numberOfLines={2}
              textAlignVertical="top"
            />
          </View>

          {/* Submit */}
          <View style={styles.footer}>
            <Pressable
              style={[
                styles.submitBtn,
                (!isValid || delta === 0 || isPending) && styles.submitBtnDisabled,
              ]}
              onPress={handleSubmit}
              disabled={!isValid || delta === 0 || isPending}
            >
              {isPending ? (
                <ActivityIndicator size="small" color="#fff" style={{ marginRight: 8 }} />
              ) : (
                <Ionicons name="checkmark-circle-outline" size={22} color="#fff" style={{ marginRight: 8 }} />
              )}
              <Text style={styles.submitBtnText}>
                {isPending ? "Saving…" : "Save Adjustment"}
              </Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surface.raised },
  currentCard: {
    margin: 16,
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    padding: 20,
    alignItems: "center",
    gap: 4,
    ...shadows.card,
  },
  currentLabel: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: "#94a3b8",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  currentQty: {
    fontSize: 52,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
    lineHeight: 60,
  },
  currentUnit: {
    fontSize: 15,
    fontFamily: "Inter_500Medium",
    color: "#64748b",
  },
  modeRow: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 16,
    marginBottom: 8,
  },
  modeBtn: {
    flex: 1,
    alignItems: "center",
    gap: 4,
    paddingVertical: 10,
    borderRadius: borderRadius.lg,
    borderWidth: 1.5,
    borderColor: colors.surface.border,
    backgroundColor: "#fff",
  },
  modeBtnText: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: "#94a3b8",
    textAlign: "center",
  },
  section: {
    backgroundColor: "#fff",
    marginHorizontal: 16,
    marginBottom: 10,
    borderRadius: borderRadius.lg,
    padding: 16,
    gap: 10,
    ...shadows.card,
  },
  inputLabel: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: "#94a3b8",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  qtyRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  qtyStepBtn: {
    width: 52,
    height: 52,
    borderRadius: 26,
    borderWidth: 1.5,
    borderColor: colors.surface.border,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface.raised,
  },
  qtyStepText: {
    fontSize: 24,
    fontFamily: "Inter_400Regular",
    color: colors.navy.DEFAULT,
    lineHeight: 28,
  },
  qtyInput: {
    flex: 1,
    height: 64,
    fontSize: 40,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
    borderWidth: 1.5,
    borderColor: colors.surface.border,
    borderRadius: borderRadius.DEFAULT,
    backgroundColor: colors.surface.raised,
  },
  deltaRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  deltaLabel: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },
  deltaValue: {
    fontSize: 14,
    fontFamily: "Inter_700Bold",
  },
  notesInput: {
    borderWidth: 1,
    borderColor: colors.surface.border,
    borderRadius: borderRadius.DEFAULT,
    padding: 12,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: colors.navy.DEFAULT,
    minHeight: 72,
    backgroundColor: colors.surface.raised,
    textAlignVertical: "top",
  },
  footer: {
    paddingHorizontal: 16,
    paddingBottom: 28,
    paddingTop: 8,
    marginTop: "auto",
  },
  submitBtn: {
    height: 56,
    backgroundColor: colors.brand[500],
    borderRadius: borderRadius.DEFAULT,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },
  submitBtnDisabled: { opacity: 0.4 },
  submitBtnText: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: "#fff",
  },
});
