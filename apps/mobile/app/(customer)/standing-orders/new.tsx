import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { router, Stack } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors, borderRadius, shadows } from "@routeflow/ui/tokens";
import { apiClient } from "../../../lib/api-client";
import { useOrderStore } from "../../../store/orderStore";

const DAYS = [
  { label: "Mon", value: 1 },
  { label: "Tue", value: 2 },
  { label: "Wed", value: 3 },
  { label: "Thu", value: 4 },
  { label: "Fri", value: 5 },
  { label: "Sat", value: 6 },
  { label: "Sun", value: 0 },
];

const PRESETS = [
  { label: "Weekdays", days: [1, 2, 3, 4, 5] },
  { label: "Daily",    days: [0, 1, 2, 3, 4, 5, 6] },
  { label: "Custom",   days: null },
] as const;

export default function NewStandingOrderScreen() {
  const [name, setName] = useState("");
  const [selectedDays, setSelectedDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [notes, setNotes] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const items = useOrderStore((s) => s.items);

  const toggleDay = (day: number) => {
    setSelectedDays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day],
    );
  };

  const applyPreset = (days: number[] | null) => {
    if (days) setSelectedDays(days);
  };

  const handleSubmit = async () => {
    if (!name.trim()) {
      Alert.alert("Validation", "Please enter a name for this standing order.");
      return;
    }
    if (selectedDays.length === 0) {
      Alert.alert("Validation", "Please select at least one delivery day.");
      return;
    }
    if (items.length === 0) {
      Alert.alert("Validation", "Your cart is empty. Add items before creating a standing order.");
      return;
    }

    setIsSubmitting(true);
    try {
      await apiClient.post("/order-templates", {
        name: name.trim(),
        daysOfWeek: selectedDays,
        notes: notes.trim() || undefined,
        items: items.map((i) => ({
          productId: i.productId,
          qty: i.quantity,
        })),
      });
      Alert.alert(
        "Standing Order Created",
        "Your standing order has been set up successfully.",
        [{ text: "OK", onPress: () => router.replace("/(customer)/standing-orders" as any) }],
      );
    } catch (err: any) {
      Alert.alert(
        "Error",
        "Failed to create standing order. Please try again.\n" + (err?.message ?? ""),
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const activePreset = PRESETS.find(
    (p) =>
      p.days &&
      p.days.length === selectedDays.length &&
      p.days.every((d) => selectedDays.includes(d)),
  )?.label ?? "Custom";

  return (
    <>
      <Stack.Screen
        options={{
          title: "New Standing Order",
          headerLeft: () => (
            <Pressable
              onPress={() => router.back()}
              hitSlop={10}
              style={{ paddingLeft: 4 }}
              accessibilityLabel="Cancel"
              accessibilityRole="button"
            >
              <Ionicons name="arrow-back" size={24} color={colors.navy.DEFAULT} />
            </Pressable>
          ),
        }}
      />
      <View style={styles.container}>
        <ScrollView
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {/* Name */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Name</Text>
            <TextInput
              style={styles.input}
              placeholder="e.g. Weekly Supplies"
              placeholderTextColor="#94a3b8"
              value={name}
              onChangeText={setName}
              returnKeyType="next"
              accessibilityLabel="Standing order name"
            />
          </View>

          {/* Frequency presets */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Frequency</Text>
            <View style={styles.chipsRow}>
              {PRESETS.map((p) => {
                const isActive = activePreset === p.label;
                return (
                  <Pressable
                    key={p.label}
                    style={[styles.chip, isActive && styles.chipActive]}
                    onPress={() => applyPreset(p.days ?? null)}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: isActive }}
                  >
                    <Text style={[styles.chipText, isActive && styles.chipTextActive]}>
                      {p.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>

          {/* Day picker */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Delivery Days</Text>
            <View style={styles.daysRow}>
              {DAYS.map((d) => {
                const isSelected = selectedDays.includes(d.value);
                return (
                  <Pressable
                    key={d.value}
                    style={[styles.dayChip, isSelected && styles.dayChipActive]}
                    onPress={() => toggleDay(d.value)}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: isSelected }}
                    accessibilityLabel={d.label}
                  >
                    <Text style={[styles.dayChipText, isSelected && styles.dayChipTextActive]}>
                      {d.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>

          {/* Notes */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Notes (optional)</Text>
            <TextInput
              style={[styles.input, styles.textArea]}
              placeholder="Any notes for your recurring order…"
              placeholderTextColor="#94a3b8"
              value={notes}
              onChangeText={setNotes}
              multiline
              numberOfLines={3}
              textAlignVertical="top"
            />
          </View>

          {/* Cart items */}
          {items.length > 0 ? (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>
                Order Items ({items.length} product{items.length !== 1 ? "s" : ""})
              </Text>
              {items.map((item) => (
                <View key={item.productId} style={styles.itemRow}>
                  <Text style={styles.itemName} numberOfLines={1}>{item.name}</Text>
                  <Text style={styles.itemQty}>×{item.quantity}</Text>
                </View>
              ))}
            </View>
          ) : (
            <View style={styles.emptyCartBanner}>
              <Ionicons name="warning-outline" size={16} color={colors.warning.DEFAULT} />
              <Text style={styles.emptyCartText}>
                Your cart is empty. Add items to your cart before creating a standing order.
              </Text>
            </View>
          )}
        </ScrollView>

        <View style={styles.footer}>
          <Pressable
            style={[styles.submitBtn, (isSubmitting || items.length === 0) && { opacity: 0.6 }]}
            onPress={handleSubmit}
            disabled={isSubmitting || items.length === 0}
            accessibilityRole="button"
          >
            {isSubmitting ? (
              <ActivityIndicator size="small" color="#fff" style={{ marginRight: 8 }} />
            ) : (
              <Ionicons name="checkmark-circle-outline" size={22} color="#fff" style={{ marginRight: 8 }} />
            )}
            <Text style={styles.submitBtnText}>
              {isSubmitting ? "Creating…" : "Create Standing Order"}
            </Text>
          </Pressable>
        </View>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surface.raised },
  scroll: { padding: 16, gap: 12, paddingBottom: 24 },
  section: {
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    padding: 16,
    gap: 10,
    ...shadows.card,
  },
  sectionTitle: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: "#94a3b8",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  chipsRow: { flexDirection: "row", gap: 10, flexWrap: "wrap" },
  chip: {
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: borderRadius.full,
    borderWidth: 1.5,
    borderColor: colors.surface.border,
    backgroundColor: colors.surface.raised,
  },
  chipActive: { borderColor: colors.brand[500], backgroundColor: colors.brand[50] },
  chipText: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: "#64748b" },
  chipTextActive: { color: colors.brand[500] },
  daysRow: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  dayChip: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1.5,
    borderColor: colors.surface.border,
    backgroundColor: colors.surface.raised,
    alignItems: "center",
    justifyContent: "center",
  },
  dayChipActive: { borderColor: colors.brand[500], backgroundColor: colors.brand[500] },
  dayChipText: { fontSize: 12, fontFamily: "Inter_600SemiBold", color: "#64748b" },
  dayChipTextActive: { color: "#fff" },
  input: {
    borderWidth: 1,
    borderColor: colors.surface.border,
    borderRadius: borderRadius.DEFAULT,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: colors.navy.DEFAULT,
    backgroundColor: colors.surface.raised,
  },
  textArea: { minHeight: 80, textAlignVertical: "top" },
  itemRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.surface.border,
  },
  itemName: {
    flex: 1,
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: colors.navy.DEFAULT,
    paddingRight: 12,
  },
  itemQty: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: "#64748b" },
  emptyCartBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    backgroundColor: colors.warning.bg,
    borderRadius: borderRadius.DEFAULT,
    padding: 14,
  },
  emptyCartText: {
    flex: 1,
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: colors.warning.DEFAULT,
    lineHeight: 18,
  },
  footer: {
    paddingHorizontal: 16,
    paddingBottom: 28,
    paddingTop: 12,
    backgroundColor: "#fff",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.surface.border,
  },
  submitBtn: {
    height: 56,
    backgroundColor: colors.brand[500],
    borderRadius: borderRadius.DEFAULT,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },
  submitBtnText: { fontSize: 16, fontFamily: "Inter_700Bold", color: "#fff" },
});
