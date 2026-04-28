import * as React from "react";
import { Platform, Pressable, StyleSheet, Switch, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { FormField, FormSection, FormSheet, FormTextInput } from "./FormSheet";

export interface ProductFormValues {
  name: string;
  sku: string;
  barcode: string;
  category: string;
  unit: string;
  description: string;
  pricePerUnit: string;
  standardCost: string;
  currentStock: string;
  reorderPoint: string;
  reorderQty: string;
  isActive: boolean;
}

export function emptyProductForm(): ProductFormValues {
  return {
    name: "",
    sku: "",
    barcode: "",
    category: "",
    unit: "ea",
    description: "",
    pricePerUnit: "",
    standardCost: "",
    currentStock: "",
    reorderPoint: "",
    reorderQty: "",
    isActive: true,
  };
}

export function productFormFromValues(
  p: Partial<Record<keyof ProductFormValues | "pricePerUnit" | "currentStock", any>> & Record<string, any>,
): ProductFormValues {
  return {
    name: p.name ?? "",
    sku: p.sku ?? "",
    barcode: p.barcode ?? "",
    category: p.category ?? "",
    unit: p.unit ?? "ea",
    description: p.description ?? "",
    pricePerUnit: p.pricePerUnit != null ? String(p.pricePerUnit) : "",
    standardCost: (p.standardCost ?? p.costPerUnit) != null ? String(p.standardCost ?? p.costPerUnit) : "",
    currentStock: p.currentStock != null ? String(p.currentStock) : "",
    reorderPoint: p.reorderPoint != null ? String(p.reorderPoint) : "",
    reorderQty: p.reorderQty != null ? String(p.reorderQty) : "",
    isActive: p.isActive ?? true,
  };
}

function parseOptionalNumber(v: string): number | undefined {
  const t = v.trim();
  if (!t) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

export interface SubmitPayload {
  name: string;
  sku?: string;
  barcode?: string;
  category?: string;
  unit?: string;
  description?: string;
  pricePerUnit: number;
  standardCost?: number;
  currentStock?: number;
  reorderPoint?: number;
  reorderQty?: number;
  isActive: boolean;
}

export function buildProductPayload(form: ProductFormValues): SubmitPayload | { error: string } {
  const name = form.name.trim();
  if (!name) return { error: "Name is required." };
  const price = parseOptionalNumber(form.pricePerUnit);
  if (price == null || price < 0) return { error: "Enter a valid price." };
  return {
    name,
    sku: form.sku.trim() || undefined,
    barcode: form.barcode.trim() || undefined,
    category: form.category.trim() || undefined,
    unit: form.unit.trim() || undefined,
    description: form.description.trim() || undefined,
    pricePerUnit: price,
    standardCost: parseOptionalNumber(form.standardCost),
    currentStock: parseOptionalNumber(form.currentStock),
    reorderPoint: parseOptionalNumber(form.reorderPoint),
    reorderQty: parseOptionalNumber(form.reorderQty),
    isActive: form.isActive,
  };
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

  const set = <K extends keyof ProductFormValues>(key: K, value: ProductFormValues[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

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
    <FormSheet
      title={title}
      submitLabel={submitLabel}
      onSubmit={submit}
      submitting={submitting}
    >
      {error ? (
        <View style={styles.errorBanner}>
          <Ionicons name="warning-outline" size={16} color={ios.system.redInk} />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      <FormSection title="Basics">
        <FormField label="Name">
          <FormTextInput
            value={form.name}
            onChangeText={(v) => set("name", v)}
            placeholder="e.g. Sourdough loaf"
            autoCapitalize="sentences"
          />
        </FormField>
        <FormField label="Category">
          <FormTextInput
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
          hint={Platform.OS === "web" ? "Scan via device camera on the native app." : "Tap the scan icon to auto-fill from camera."}
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
      </FormSection>

      <FormSection title="Pricing">
        <FormField label="Price per unit">
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
            <Text style={styles.switchHint}>
              Inactive products are hidden from order entry.
            </Text>
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
});
