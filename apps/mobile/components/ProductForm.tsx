import * as React from "react";
import { Platform, Pressable, StyleSheet, Switch, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { FormField, FormSection, FormSheet, FormTextInput } from "./FormSheet";
import { CategoryInput } from "./CategoryInput";
import { ProductPickerSheet } from "./ProductPickerSheet";
import {
  buildProductPayload,
  emptyProductForm,
  productFormFromValues,
  type ProductFormValues,
  type SubmitPayload,
} from "../lib/product-form";

// Re-export the pure form logic so existing importers keep their import site,
// while the logic itself lives in a React-Native-free module that mobile Jest
// can unit-test directly (see __tests__/operator-create-forms.test.ts).
export {
  buildProductPayload,
  emptyProductForm,
  productFormFromValues,
  type ProductFormValues,
  type SubmitPayload,
};

function parseOptionalNumber(v: string): number | undefined {
  const t = v.trim();
  if (!t) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

interface ProductFormProps {
  title: string;
  submitLabel: string;
  initial: ProductFormValues;
  submitting?: boolean;
  onSubmit: (payload: SubmitPayload) => void | Promise<void>;
}

export function ProductForm({
  title,
  submitLabel,
  initial,
  submitting,
  onSubmit,
}: ProductFormProps) {
  const router = useRouter();
  const [form, setForm] = React.useState<ProductFormValues>(initial);
  const [error, setError] = React.useState<string | null>(null);
  const [parentPickerOpen, setParentPickerOpen] = React.useState(false);

  const set = <K extends keyof ProductFormValues>(key: K, value: ProductFormValues[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const isVariant = !!form.parentProductId;

  const submit = () => {
    const result = buildProductPayload(form);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setError(null);
    onSubmit(result);
  };

  return (
    <FormSheet title={title} submitLabel={submitLabel} onSubmit={submit} submitting={submitting}>
      {error ? (
        <View style={styles.errorBanner}>
          <Ionicons name="warning-outline" size={16} color={ios.system.redInk} />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      <FormSection title="Basics">
        <FormField
          label="Variant of (optional)"
          hint="Link this as a flavor/variety of an existing product. Variants inherit the parent's price tiers, box size, and category unless you override them."
        >
          <Pressable style={styles.picker} onPress={() => setParentPickerOpen(true)}>
            <View style={styles.pickerInner}>
              <Text style={[styles.pickerText, !isVariant && styles.pickerPlaceholder]}>
                {isVariant ? (form.parentName ?? "Selected product") : "Standalone product"}
              </Text>
              {isVariant ? (
                <Pressable
                  onPress={() => {
                    set("parentProductId", "");
                    set("variantName", "");
                    setForm((f) => ({ ...f, parentName: undefined }));
                  }}
                  hitSlop={10}
                >
                  <Ionicons name="close-circle" size={18} color={ios.label3} />
                </Pressable>
              ) : (
                <Ionicons name="chevron-down" size={14} color={ios.label3} />
              )}
            </View>
          </Pressable>
        </FormField>
        {isVariant ? (
          <FormField label="Variant name (flavor)">
            <FormTextInput
              value={form.variantName}
              onChangeText={(v) => set("variantName", v)}
              placeholder="e.g. Strawberry"
              autoCapitalize="sentences"
            />
          </FormField>
        ) : (
          <FormField label="Name">
            <FormTextInput
              value={form.name}
              onChangeText={(v) => set("name", v)}
              placeholder="e.g. Sourdough loaf"
              autoCapitalize="sentences"
            />
          </FormField>
        )}
        <FormField label="Category">
          <CategoryInput
            value={form.category}
            onChangeText={(v) => set("category", v)}
            placeholder="Bakery"
          />
        </FormField>
        <FormField label="Description">
          <FormTextInput
            value={form.description}
            onChangeText={(v) => set("description", v)}
            placeholder="Optional"
            multiline
            numberOfLines={3}
            textAlignVertical="top"
            style={{ minHeight: 88 }}
          />
        </FormField>
      </FormSection>

      <FormSection title="Identifiers">
        <FormField label="SKU">
          <FormTextInput
            value={form.sku}
            onChangeText={(v) => set("sku", v)}
            placeholder="SKU-0001"
            autoCapitalize="characters"
          />
        </FormField>
        <FormField
          label="Barcode"
          hint={
            Platform.OS === "web"
              ? "Scan via device camera on the native app."
              : "Tap the scan icon to auto-fill from camera."
          }
        >
          <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
            <View style={{ flex: 1 }}>
              <FormTextInput
                value={form.barcode}
                onChangeText={(v) => set("barcode", v)}
                placeholder="EAN-13, UPC-A, etc."
                keyboardType="number-pad"
              />
            </View>
            {Platform.OS !== "web" ? (
              <Pressable
                onPress={() => router.push("/(operator)/products/scan" as any)}
                style={styles.scanBtn}
                hitSlop={8}
              >
                <Ionicons name="barcode-outline" size={20} color={ios.brand} />
              </Pressable>
            ) : null}
          </View>
        </FormField>
        <FormField label="Unit">
          <FormTextInput
            value={form.unit}
            onChangeText={(v) => set("unit", v)}
            placeholder="ea, kg, box"
          />
        </FormField>
        <FormField
          label="Pieces per box (optional)"
          hint="Leave blank for products sold individually. Set to N if 1 box contains N loose pieces — orders can then be issued as boxes + loose units."
        >
          <FormTextInput
            value={form.unitsPerBox}
            onChangeText={(v) => set("unitsPerBox", v)}
            placeholder="e.g. 12"
            keyboardType="number-pad"
          />
        </FormField>
      </FormSection>

      <FormSection title="Pricing">
        <FormField
          label="Price per unit"
          hint={
            parseOptionalNumber(form.unitsPerBox) && parseOptionalNumber(form.unitsPerBox)! > 1
              ? "This is the BOX price. A loose piece costs price ÷ pieces-per-box."
              : undefined
          }
        >
          <FormTextInput
            value={form.pricePerUnit}
            onChangeText={(v) => set("pricePerUnit", v)}
            placeholder="0.00"
            keyboardType="decimal-pad"
          />
        </FormField>
        <FormField label="Standard cost (optional)">
          <FormTextInput
            value={form.standardCost}
            onChangeText={(v) => set("standardCost", v)}
            placeholder="0.00"
            keyboardType="decimal-pad"
          />
        </FormField>
      </FormSection>

      <FormSection title="Stock">
        <FormField label="On-hand quantity">
          <FormTextInput
            value={form.currentStock}
            onChangeText={(v) => set("currentStock", v)}
            placeholder="0"
            keyboardType="number-pad"
          />
        </FormField>
        <FormField label="Reorder at">
          <FormTextInput
            value={form.reorderPoint}
            onChangeText={(v) => set("reorderPoint", v)}
            placeholder="5"
            keyboardType="number-pad"
          />
        </FormField>
        <FormField label="Reorder quantity">
          <FormTextInput
            value={form.reorderQty}
            onChangeText={(v) => set("reorderQty", v)}
            placeholder="20"
            keyboardType="number-pad"
          />
        </FormField>
      </FormSection>

      <FormSection>
        <View style={styles.switchRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.switchLabel}>Active</Text>
            <Text style={styles.switchHint}>Inactive products are hidden from order entry.</Text>
          </View>
          <Switch
            value={form.isActive}
            onValueChange={(v) => set("isActive", v)}
            trackColor={{ true: ios.brand }}
          />
        </View>
      </FormSection>

      {/* Filler for router prop */}
      <Pressable
        onPress={() => router.back()}
        style={{ position: "absolute", width: 0, height: 0, opacity: 0 }}
      />

      <ProductPickerSheet
        visible={parentPickerOpen}
        title="Variant of…"
        standaloneOnly
        selectedId={form.parentProductId || undefined}
        onClose={() => setParentPickerOpen(false)}
        onSelect={(p) => {
          setForm((f) => ({
            ...f,
            parentProductId: p.id,
            parentName: p.name,
            // Seed the flavor from any typed standalone name so the operator
            // doesn't retype; they can edit it.
            variantName: f.variantName || f.name,
          }));
          setParentPickerOpen(false);
        }}
      />
    </FormSheet>
  );
}

const styles = StyleSheet.create({
  errorBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: ios.system.redWash,
    padding: 10,
    borderRadius: 10,
  },
  errorText: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.system.redInk, flex: 1 },
  scanBtn: {
    width: 44,
    height: 44,
    borderRadius: 10,
    backgroundColor: ios.brandWash,
    alignItems: "center",
    justifyContent: "center",
  },
  switchRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  switchLabel: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },
  switchHint: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  picker: {
    backgroundColor: ios.fill3,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 11,
    minHeight: 44,
    justifyContent: "center",
  },
  pickerInner: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  pickerText: { fontSize: 15, fontFamily: "Inter_400Regular", color: ios.label, flex: 1 },
  pickerPlaceholder: { color: ios.label3 },
});
