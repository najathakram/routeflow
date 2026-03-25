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
import { useMyCustomerProfile } from "../../../lib/api/customers";

const FREQUENCIES = [
  { label: "Weekly", value: "WEEKLY" },
  { label: "Bi-weekly", value: "BIWEEKLY" },
  { label: "Monthly", value: "MONTHLY" },
] as const;

type Frequency = typeof FREQUENCIES[number]["value"];

export default function NewStandingOrderScreen() {
  const [frequency, setFrequency] = useState<Frequency>("WEEKLY");
  const [nextDeliveryDate, setNextDeliveryDate] = useState("");
  const [notes, setNotes] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const { data: profile } = useMyCustomerProfile();
  const items = useOrderStore((s) => s.items);

  const handleSubmit = async () => {
    if (!nextDeliveryDate.trim()) {
      Alert.alert("Validation", "Please enter a next delivery date (YYYY-MM-DD).");
      return;
    }
    // Basic date format check
    if (!/^\d{4}-\d{2}-\d{2}$/.test(nextDeliveryDate.trim())) {
      Alert.alert("Validation", "Date must be in YYYY-MM-DD format.");
      return;
    }

    setIsSubmitting(true);
    try {
      await apiClient.post("/standing-orders", {
        customerId: profile?.id,
        frequency,
        nextDeliveryDate: nextDeliveryDate.trim(),
        notes: notes.trim() || undefined,
        items: items.map((i) => ({
          productId: i.productId,
          qty: i.quantity,
        })),
      });
      Alert.alert(
        "Standing Order Created",
        "Your standing order has been set up successfully.",
        [
          {
            text: "OK",
            onPress: () => router.replace("/(customer)/standing-orders" as any),
          },
        ],
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
          {/* Cart notice */}
          <View style={styles.noticeBanner}>
            <Ionicons name="information-circle-outline" size={18} color={colors.brand[500]} />
            <Text style={styles.noticeText}>
              Your current cart items ({items.length} product{items.length !== 1 ? "s" : ""}) will be used for this standing order.
            </Text>
          </View>

          {/* Frequency */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Frequency</Text>
            <View style={styles.chipsRow}>
              {FREQUENCIES.map((f) => {
                const isActive = frequency === f.value;
                return (
                  <Pressable
                    key={f.value}
                    style={[styles.chip, isActive && styles.chipActive]}
                    onPress={() => setFrequency(f.value)}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: isActive }}
                  >
                    <Text style={[styles.chipText, isActive && styles.chipTextActive]}>
                      {f.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>

          {/* Next Delivery Date */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Next Delivery Date</Text>
            <TextInput
              style={styles.input}
              placeholder="YYYY-MM-DD"
              placeholderTextColor="#94a3b8"
              value={nextDeliveryDate}
              onChangeText={setNextDeliveryDate}
              keyboardType="numeric"
              maxLength={10}
              returnKeyType="next"
              accessibilityLabel="Next delivery date"
            />
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

          {/* Cart items preview */}
          {items.length > 0 ? (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Order Items</Text>
              {items.map((item) => (
                <View key={item.productId} style={styles.itemRow}>
                  <Text style={styles.itemName} numberOfLines={1}>{item.name}</Text>
                  <Text style={styles.itemQty}>x{item.quantity}</Text>
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

        {/* Submit footer */}
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
  container: {
    flex: 1,
    backgroundColor: colors.surface.raised,
  },
  scroll: {
    padding: 16,
    gap: 12,
    paddingBottom: 24,
  },
  noticeBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    backgroundColor: colors.brand[50],
    borderRadius: borderRadius.DEFAULT,
    borderWidth: 1,
    borderColor: colors.brand[200] ?? colors.brand[500] + "33",
    padding: 14,
  },
  noticeText: {
    flex: 1,
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: colors.brand[700],
    lineHeight: 18,
  },
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
  chipsRow: {
    flexDirection: "row",
    gap: 10,
    flexWrap: "wrap",
  },
  chip: {
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: borderRadius.full,
    borderWidth: 1.5,
    borderColor: colors.surface.border,
    backgroundColor: colors.surface.raised,
  },
  chipActive: {
    borderColor: colors.brand[500],
    backgroundColor: colors.brand[50],
  },
  chipText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: "#64748b",
  },
  chipTextActive: {
    color: colors.brand[500],
  },
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
  textArea: {
    minHeight: 80,
    textAlignVertical: "top",
  },
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
  itemQty: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: "#64748b",
  },
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
  submitBtnText: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: "#fff",
  },
});
