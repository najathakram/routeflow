import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { Ionicons } from "@expo/vector-icons";
import {
  ADJUSTMENT_REASON_LABELS,
  ADJUSTMENT_REASON_NOTE_MAX,
  type AdjustmentReason,
} from "@routeflow/types";
import { FormField, FormSection, FormSheet, FormTextInput } from "../../../../components/FormSheet";
import { useProduct, useProductCount } from "../../../../lib/api/products";
import { useProductUnits, useUnitsEnabled } from "../../../../lib/api/product-units";
import {
  buildCountRequest,
  countUnitOptions,
  previewLine,
  validateCount,
  type CountForm,
} from "../../../../lib/product-count";
import { showToast } from "../../../../lib/toast";

/** SA-828 (row 657): count the stock, or adjust it by an amount, in any of the product's units. */
export default function AdjustStockScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: product } = useProduct(id ?? "");
  const unitsEnabled = useUnitsEnabled();
  const ladder = useProductUnits(id ?? "", unitsEnabled);
  const mut = useProductCount(id ?? "");
  const [form, setForm] = useState<CountForm>({
    mode: "SET",
    sign: "-",
    quantity: "",
    unit: "",
    reason: "",
    note: "",
    date: "",
  });
  const [serverError, setServerError] = useState<string | null>(null);

  const currentStock = Number(product?.currentStock ?? 0);
  const options = countUnitOptions(
    { unit: product?.unit, unitsPerBox: product?.unitsPerBox },
    unitsEnabled ? ladder.data : null,
  );
  const unit = options.some((o) => o.label === form.unit) ? form.unit : (options[0]?.label ?? "");
  const f: CountForm = { ...form, unit };
  const patch = (p: Partial<CountForm>) => {
    setServerError(null);
    setForm((prev) => ({ ...prev, ...p }));
  };

  const problem = validateCount(f, options);
  // About the quantity only (reason and note are marked required); quiet until typed.
  const inlineError =
    f.quantity.trim() === ""
      ? null
      : validateCount({ ...f, reason: "COUNT_CORRECTION", note: "" }, options);
  const preview = previewLine(f, options, currentStock);

  const submit = () => {
    if (!id || problem) {
      if (problem) showToast(problem);
      return;
    }
    setServerError(null);
    mut.mutate(buildCountRequest(f), {
      onSuccess: (res) => {
        showToast(`Stock updated to ${Number(res.stockAfter).toLocaleString("en-US")} pcs`);
        router.back();
      },
      onError: (e: any) => setServerError(e?.response?.data?.message ?? e?.message ?? "Try again."),
    });
  };

  return (
    <FormSheet
      title="Count / Adjust"
      subtitle={product?.name}
      submitLabel={mut.isPending ? "Saving…" : "Save"}
      onSubmit={submit}
      submitting={mut.isPending}
    >
      <FormSection title="Quantity">
        {product && (
          <View style={styles.currentRow}>
            <Text style={styles.currentLabel}>Current stock</Text>
            <Text style={styles.currentValue}>{currentStock.toLocaleString("en-US")} pcs</Text>
          </View>
        )}
        <View style={styles.chips}>
          {(["SET", "ADJUST"] as const).map((m) => (
            <Chip
              key={m}
              label={m === "SET" ? "Set count" : "Adjust"}
              active={f.mode === m}
              onPress={() => patch({ mode: m })}
            />
          ))}
        </View>
        <FormField label={f.mode === "SET" ? "Counted" : "Amount"}>
          <View style={styles.row}>
            {f.mode === "ADJUST" && (
              <Pressable
                style={styles.stepBtn}
                accessibilityLabel={f.sign === "+" ? "Adding stock" : "Removing stock"}
                onPress={() => patch({ sign: f.sign === "+" ? "-" : "+" })}
              >
                <Text style={styles.stepText}>{f.sign === "+" ? "+" : "−"}</Text>
              </Pressable>
            )}
            <FormTextInput
              value={f.quantity}
              onChangeText={(quantity) => patch({ quantity })}
              placeholder="0"
              keyboardType="decimal-pad"
              style={{ flex: 1, textAlign: "center" }}
            />
          </View>
        </FormField>
        {options.length > 1 && (
          <View style={styles.chips}>
            {options.map((o) => (
              <Chip
                key={o.label}
                label={o.label}
                active={unit === o.label}
                onPress={() => patch({ unit: o.label })}
              />
            ))}
          </View>
        )}
        {inlineError ? <Text style={styles.error}>{inlineError}</Text> : null}
        {preview && !inlineError ? <Text style={styles.preview}>{preview}</Text> : null}
      </FormSection>

      <FormSection title="Reason">
        <View style={styles.chips}>
          {(Object.keys(ADJUSTMENT_REASON_LABELS) as AdjustmentReason[]).map((r) => (
            <Chip
              key={r}
              label={ADJUSTMENT_REASON_LABELS[r]}
              active={f.reason === r}
              onPress={() => patch({ reason: r })}
            />
          ))}
        </View>
      </FormSection>

      <FormSection title="Note">
        <FormField label={f.reason === "OTHER" ? "Note (required)" : "Note"}>
          <FormTextInput
            value={f.note}
            onChangeText={(note) => patch({ note })}
            placeholder={f.reason === "OTHER" ? "What happened?" : "Optional"}
            maxLength={ADJUSTMENT_REASON_NOTE_MAX}
            multiline
            numberOfLines={3}
            textAlignVertical="top"
            style={{ minHeight: 80 }}
          />
        </FormField>
      </FormSection>

      {serverError ? <Text style={styles.error}>{serverError}</Text> : null}

      <View style={styles.helpRow}>
        <Ionicons name="information-circle-outline" size={14} color={ios.label2} />
        <Text style={styles.help}>Changes are logged as stock movements.</Text>
      </View>
    </FormSheet>
  );
}

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      style={[styles.chip, active ? styles.chipActive : styles.chipInactive]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
    >
      <Text style={[styles.chipText, active ? styles.chipTextActive : styles.chipTextInactive]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  currentRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 10,
    paddingHorizontal: 2,
    marginBottom: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: ios.separator,
  },
  currentLabel: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label2 },
  currentValue: { fontSize: 16, fontFamily: "Inter_700Bold", color: ios.label },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  stepBtn: {
    width: 46,
    height: 46,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: ios.brandWash,
  },
  stepText: { color: ios.brand, fontSize: 22, fontFamily: "Inter_700Bold" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999 },
  chipActive: { backgroundColor: ios.brand },
  chipInactive: { backgroundColor: ios.fill3 },
  chipText: { fontSize: 13, fontFamily: "Inter_500Medium" },
  chipTextActive: { color: "#fff" },
  chipTextInactive: { color: ios.label },
  helpRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  error: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.system.redInk },
  preview: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.label },
  help: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2 },
});
