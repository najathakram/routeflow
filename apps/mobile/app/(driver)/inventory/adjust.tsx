import {
  ActivityIndicator,
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useState } from "react";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors, borderRadius, shadows } from "@routeflow/ui/tokens";
import { useRecordAdjustment, useStockOverview, type StockItem } from "../../../lib/api/inventory";

type Mode = "count" | "add" | "remove";

const MODES: { key: Mode; label: string; icon: string; color: string }[] = [
  { key: "count",  label: "Stock Count",  icon: "clipboard-outline",     color: colors.brand[500] },
  { key: "add",    label: "Add Stock",    icon: "add-circle-outline",     color: colors.success.DEFAULT },
  { key: "remove", label: "Remove Stock", icon: "remove-circle-outline",  color: colors.danger.DEFAULT },
];

// ─── Single-product panel ─────────────────────────────────────────────────────

function AdjustPanel({
  productId,
  productName,
  unit,
  currentStock,
  onDone,
}: {
  productId: string;
  productName: string;
  unit: string;
  currentStock: number;
  onDone?: () => void;
}) {
  const { mutate: recordAdjustment, isPending } = useRecordAdjustment();
  const [mode, setMode] = useState<Mode>("count");
  const [qty, setQty] = useState("");
  const [notes, setNotes] = useState("");

  const parsedQty = parseInt(qty, 10);
  const isValid = !isNaN(parsedQty) && parsedQty >= 0;
  const delta = (() => {
    if (!isValid) return null;
    if (mode === "count") return parsedQty - currentStock;
    if (mode === "add") return parsedQty;
    return -parsedQty;
  })();
  const newStock = delta !== null ? currentStock + delta : null;
  const wouldGoNegative = mode === "remove" && isValid && parsedQty > currentStock;

  const handleSubmit = () => {
    if (!productId || delta === null || delta === 0 || wouldGoNegative) return;
    Keyboard.dismiss();
    recordAdjustment(
      {
        productId,
        quantity: delta,
        notes:
          notes ||
          (mode === "count"
            ? "Stock count via driver app"
            : mode === "add"
            ? "Stock added via driver app"
            : "Stock removed via driver app"),
      },
      {
        onSuccess: () => {
          if (onDone) {
            // List mode: reset and collapse
            setQty("");
            setNotes("");
            setMode("count");
            onDone();
          } else {
            Alert.alert("Done", "Stock updated successfully.", [
              { text: "OK", onPress: () => router.back() },
            ]);
          }
        },
        onError: (err) => {
          Alert.alert("Error", "Failed to update stock.\n" + (err.message || ""));
        },
      },
    );
  };

  return (
    <View style={panelStyles.container}>
      {/* Current stock */}
      <View style={panelStyles.stockRow}>
        <Text style={panelStyles.stockLabel}>Current:</Text>
        <Text style={panelStyles.stockValue}>
          {currentStock} {unit}
        </Text>
      </View>

      {/* Mode tabs */}
      <View style={panelStyles.modeRow}>
        {MODES.map(({ key, label, icon, color }) => (
          <Pressable
            key={key}
            style={[
              panelStyles.modeBtn,
              mode === key && { borderColor: color, backgroundColor: color + "18" },
            ]}
            onPress={() => {
              setMode(key);
              setQty("");
            }}
          >
            <Ionicons
              name={icon as any}
              size={16}
              color={mode === key ? color : "#94a3b8"}
            />
            <Text
              style={[panelStyles.modeBtnText, mode === key && { color }]}
            >
              {label}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* Qty input */}
      <View style={panelStyles.qtyRow}>
        <Pressable
          style={panelStyles.qtyStepBtn}
          onPress={() => {
            const n = parseInt(qty || "0", 10);
            if (n > 0) setQty(String(n - 1));
          }}
        >
          <Text style={panelStyles.qtyStepText}>−</Text>
        </Pressable>
        <TextInput
          style={panelStyles.qtyInput}
          value={qty}
          onChangeText={setQty}
          keyboardType="number-pad"
          placeholder="0"
          placeholderTextColor="#94a3b8"
          textAlign="center"
        />
        <Pressable
          style={panelStyles.qtyStepBtn}
          onPress={() => {
            const n = parseInt(qty || "0", 10);
            setQty(String(n + 1));
          }}
        >
          <Text style={panelStyles.qtyStepText}>+</Text>
        </Pressable>
      </View>

      {/* Preview / warning */}
      {isValid && delta !== null && (
        <Text style={[
          panelStyles.preview,
          { color: delta > 0 ? colors.success.DEFAULT : delta < 0 ? colors.danger.DEFAULT : "#64748b" },
        ]}>
          {currentStock} → {newStock}
          {delta !== 0 ? ` (${delta > 0 ? "+" : ""}${delta})` : " (no change)"}
        </Text>
      )}
      {wouldGoNegative && (
        <Text style={panelStyles.warning}>
          Cannot remove more than current stock ({currentStock})
        </Text>
      )}

      {/* Notes */}
      <TextInput
        style={panelStyles.notesInput}
        placeholder="Notes (optional)…"
        placeholderTextColor="#94a3b8"
        value={notes}
        onChangeText={setNotes}
        multiline
        numberOfLines={2}
        textAlignVertical="top"
      />

      {/* Submit */}
      <Pressable
        style={[
          panelStyles.submitBtn,
          (!isValid || delta === 0 || isPending || wouldGoNegative) && panelStyles.submitBtnDisabled,
        ]}
        onPress={handleSubmit}
        disabled={!isValid || delta === 0 || isPending || wouldGoNegative}
      >
        {isPending ? (
          <ActivityIndicator size="small" color="#fff" style={{ marginRight: 8 }} />
        ) : (
          <Ionicons name="checkmark-circle-outline" size={20} color="#fff" style={{ marginRight: 8 }} />
        )}
        <Text style={panelStyles.submitBtnText}>
          {isPending ? "Saving…" : "Save Adjustment"}
        </Text>
      </Pressable>
    </View>
  );
}

// ─── Product list row (expandable) ───────────────────────────────────────────

function ProductListRow({ item }: { item: StockItem }) {
  const [expanded, setExpanded] = useState(false);
  const isLow =
    item.reorderPoint != null && item.currentStock <= item.reorderPoint;

  return (
    <View style={listStyles.rowWrap}>
      <Pressable
        style={listStyles.row}
        onPress={() => setExpanded((v) => !v)}
        accessibilityRole="button"
        accessibilityLabel={`${item.productName} — tap to adjust`}
      >
        <View style={listStyles.rowLeft}>
          <Text style={listStyles.productName}>{item.productName}</Text>
          <Text style={listStyles.unit}>{item.unit}</Text>
        </View>
        <View style={listStyles.rowRight}>
          <Text style={[listStyles.stock, isLow && listStyles.stockLow]}>
            {item.currentStock}
          </Text>
          {isLow && (
            <View style={listStyles.lowBadge}>
              <Text style={listStyles.lowBadgeText}>Low</Text>
            </View>
          )}
          <Ionicons
            name={expanded ? "chevron-up" : "chevron-down"}
            size={18}
            color="#94a3b8"
            style={{ marginLeft: 4 }}
          />
        </View>
      </Pressable>

      {expanded && (
        <View style={listStyles.panel}>
          <AdjustPanel
            productId={item.productId}
            productName={item.productName}
            unit={item.unit}
            currentStock={item.currentStock}
            onDone={() => setExpanded(false)}
          />
        </View>
      )}
    </View>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function AdjustStockScreen() {
  const { productId, productName, unit, currentStock } =
    useLocalSearchParams<{
      productId?: string;
      productName?: string;
      unit?: string;
      currentStock?: string;
    }>();

  const hasSingleProduct = !!productId;

  // Product list mode — fetch overview when no productId
  const { data: overview, isLoading } = useStockOverview();

  if (hasSingleProduct) {
    // Single-product mode (navigated from barcode scan or stock list)
    const current = parseInt(currentStock ?? "0", 10);
    return (
      <>
        <Stack.Screen
          options={{
            title: decodeURIComponent(productName ?? "Adjust Stock"),
            headerLeft: () => (
              <Pressable
                onPress={() => router.back()}
                style={{ paddingLeft: 4, paddingRight: 12, paddingVertical: 8 }}
                accessibilityRole="button"
                accessibilityLabel="Go back"
              >
                <Ionicons name="arrow-back" size={24} color={colors.navy.DEFAULT} />
              </Pressable>
            ),
          }}
        />
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          keyboardVerticalOffset={88}
        >
          <ScrollView style={{ flex: 1, backgroundColor: colors.surface.raised }} contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
            {/* Current stock card */}
            <View style={singleStyles.currentCard}>
              <Text style={singleStyles.currentLabel}>Current Stock</Text>
              <Text style={singleStyles.currentQty}>{current}</Text>
              <Text style={singleStyles.currentUnit}>{decodeURIComponent(unit ?? "")}</Text>
            </View>
            <AdjustPanel
              productId={productId}
              productName={decodeURIComponent(productName ?? "")}
              unit={decodeURIComponent(unit ?? "")}
              currentStock={current}
            />
          </ScrollView>
        </KeyboardAvoidingView>
      </>
    );
  }

  // Product-list mode (navigated from dashboard tile without productId)
  return (
    <>
      <Stack.Screen
        options={{
          title: "Adjust Stock",
          headerLeft: () => (
            <Pressable
              onPress={() => router.back()}
              style={{ paddingLeft: 4, paddingRight: 12, paddingVertical: 8 }}
              accessibilityRole="button"
              accessibilityLabel="Go back"
            >
              <Ionicons name="arrow-back" size={24} color={colors.navy.DEFAULT} />
            </Pressable>
          ),
        }}
      />
      {isLoading ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator size="large" color={colors.brand[500]} />
        </View>
      ) : !overview || overview.length === 0 ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 8 }}>
          <Ionicons name="cube-outline" size={48} color="#cbd5e1" />
          <Text style={{ fontSize: 16, fontFamily: "Inter_500Medium", color: "#94a3b8" }}>
            No products found
          </Text>
        </View>
      ) : (
        <ScrollView
          style={{ flex: 1, backgroundColor: colors.surface.raised }}
          contentContainerStyle={{ padding: 16, gap: 8, paddingBottom: 40 }}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={listStyles.hint}>
            Tap a product to expand the adjustment panel
          </Text>
          {overview.map((item) => (
            <ProductListRow key={item.productId} item={item} />
          ))}
        </ScrollView>
      )}
    </>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const panelStyles = StyleSheet.create({
  container: {
    gap: 10,
  },
  stockRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  stockLabel: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: "#94a3b8",
  },
  stockValue: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  modeRow: {
    flexDirection: "row",
    gap: 6,
  },
  modeBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    paddingVertical: 8,
    borderRadius: borderRadius.DEFAULT,
    borderWidth: 1.5,
    borderColor: colors.surface.border,
    backgroundColor: "#fff",
  },
  modeBtnText: {
    fontSize: 10,
    fontFamily: "Inter_600SemiBold",
    color: "#94a3b8",
  },
  qtyRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  qtyStepBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1.5,
    borderColor: colors.surface.border,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface.raised,
  },
  qtyStepText: {
    fontSize: 22,
    fontFamily: "Inter_400Regular",
    color: colors.navy.DEFAULT,
    lineHeight: 26,
  },
  qtyInput: {
    flex: 1,
    height: 52,
    fontSize: 32,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
    borderWidth: 1.5,
    borderColor: colors.surface.border,
    borderRadius: borderRadius.DEFAULT,
    backgroundColor: colors.surface.raised,
  },
  preview: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
  },
  warning: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    color: colors.danger.DEFAULT,
  },
  notesInput: {
    borderWidth: 1,
    borderColor: colors.surface.border,
    borderRadius: borderRadius.DEFAULT,
    padding: 10,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: colors.navy.DEFAULT,
    minHeight: 60,
    backgroundColor: colors.surface.raised,
    textAlignVertical: "top",
  },
  submitBtn: {
    height: 48,
    backgroundColor: colors.brand[500],
    borderRadius: borderRadius.DEFAULT,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },
  submitBtnDisabled: { opacity: 0.4 },
  submitBtnText: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    color: "#fff",
  },
});

const singleStyles = StyleSheet.create({
  currentCard: {
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    padding: 20,
    alignItems: "center",
    gap: 4,
    marginBottom: 16,
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
});

const listStyles = StyleSheet.create({
  hint: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
    marginBottom: 4,
    paddingHorizontal: 4,
  },
  rowWrap: {
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    overflow: "hidden",
    ...shadows.card,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 12,
  },
  rowLeft: {
    flex: 1,
    gap: 2,
  },
  productName: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: colors.navy.DEFAULT,
  },
  unit: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },
  rowRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  stock: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  stockLow: {
    color: colors.danger.DEFAULT,
  },
  lowBadge: {
    backgroundColor: "#fee2e2",
    borderRadius: 8,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  lowBadgeText: {
    fontSize: 10,
    fontFamily: "Inter_600SemiBold",
    color: "#991b1b",
  },
  panel: {
    padding: 16,
    paddingTop: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.surface.border,
    backgroundColor: colors.surface.raised,
  },
});
