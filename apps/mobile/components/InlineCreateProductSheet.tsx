import * as React from "react";
import {
  ActivityIndicator,
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
import { CategoryInput } from "./CategoryInput";
import { ProductPickerSheet } from "./ProductPickerSheet";
import { emptyProductForm, buildProductPayload, type ProductFormValues } from "../lib/product-form";
import { useCreateProduct, type CreatedProduct } from "../lib/api/products";

/** Only prefill units-per-box from a whole number greater than 1 — never guess/round. */
function validUnitsPerBoxPrefill(v: number | undefined): boolean {
  return v != null && Number.isInteger(v) && v > 1;
}

/**
 * Compact create-product sheet shown when a scan (or typed search) finds no
 * product WHILE the operator is building an order/invoice. Unlike navigating to
 * the full product screen, this overlays the cart so the in-progress order is
 * never lost, and it offers the same "new product OR variant of an existing
 * product" choice as web's InlineCreateProductModal.
 *
 * On success it hands the freshly-created product back to the caller so the
 * line can be added to the cart immediately (no refetch round-trip).
 */
export function InlineCreateProductSheet({
  visible,
  initialName,
  initialCode,
  initialPrice,
  initialCost,
  initialUnitsPerBox,
  onClose,
  onCreated,
}: {
  visible: boolean;
  /** Prefill the name from a typed search term or an extracted invoice line. */
  initialName?: string;
  /** Prefill the barcode from the scanned code. */
  initialCode?: string;
  /** Prefill the sell price (e.g. invoice cost + 30% from a vendor-bill line). */
  initialPrice?: number;
  /** Prefill the standard cost (e.g. the invoice unit cost). */
  initialCost?: number;
  /** Prefill pieces-per-box from an OCR-extracted pack size (e.g. "12x330ml" -> 12). */
  initialUnitsPerBox?: number;
  onClose: () => void;
  onCreated: (product: CreatedProduct) => void;
}) {
  const createMut = useCreateProduct();
  const [form, setForm] = React.useState<ProductFormValues>(emptyProductForm);
  const [error, setError] = React.useState<string | null>(null);
  const [parentPickerOpen, setParentPickerOpen] = React.useState(false);

  // Re-seed each time the sheet opens (the scanned code / typed name changes).
  React.useEffect(() => {
    if (visible) {
      setForm({
        ...emptyProductForm(),
        name: initialName ?? "",
        barcode: initialCode ?? "",
        pricePerUnit: initialPrice != null ? initialPrice.toFixed(2) : "",
        standardCost: initialCost != null ? String(initialCost) : "",
        unitsPerBox: validUnitsPerBoxPrefill(initialUnitsPerBox) ? String(initialUnitsPerBox) : "",
      });
      setError(null);
    }
  }, [visible, initialName, initialCode, initialPrice, initialCost, initialUnitsPerBox]);

  const set = <K extends keyof ProductFormValues>(key: K, value: ProductFormValues[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const isVariant = !!form.parentProductId;
  const boxed = (() => {
    const n = Number(form.unitsPerBox);
    return Number.isFinite(n) && n > 1;
  })();

  const submit = () => {
    const result = buildProductPayload(form);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setError(null);
    createMut.mutate(result, {
      onSuccess: (product) => onCreated(product),
      onError: (e: unknown) => {
        const err = e as { response?: { data?: { message?: string } }; message?: string };
        setError(err?.response?.data?.message ?? err?.message ?? "Couldn't create product.");
      },
    });
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.sheetWrap}
      >
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>New product</Text>
            <Pressable onPress={onClose} hitSlop={10}>
              <Ionicons name="close" size={20} color={ios.label2} />
            </Pressable>
          </View>

          <ScrollView
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ paddingBottom: 8 }}
          >
            {error ? (
              <View style={styles.errorBanner}>
                <Ionicons name="warning-outline" size={16} color={ios.system.redInk} />
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ) : null}

            <FormField
              label="Variant of (optional)"
              hint="Pick an existing product to add this as a flavor/variety — it inherits the parent's price, case size, and category."
            >
              <Pressable style={styles.picker} onPress={() => setParentPickerOpen(true)}>
                <View style={styles.pickerInner}>
                  <Text style={[styles.pickerText, !isVariant && styles.pickerPlaceholder]}>
                    {isVariant ? (form.parentName ?? "Selected product") : "Standalone product"}
                  </Text>
                  {isVariant ? (
                    <Pressable
                      onPress={() =>
                        setForm((f) => ({
                          ...f,
                          parentProductId: "",
                          variantName: "",
                          parentName: undefined,
                        }))
                      }
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
                  placeholder="Product name"
                  autoCapitalize="sentences"
                />
              </FormField>
            )}

            <FormField label="Barcode / SKU">
              <FormTextInput
                value={form.barcode}
                onChangeText={(v) => set("barcode", v)}
                placeholder="Scanned code"
                keyboardType="number-pad"
              />
            </FormField>

            <View style={styles.row2}>
              <View style={{ flex: 1 }}>
                <FormField label={boxed ? "Case price" : "Price"}>
                  <FormTextInput
                    value={form.pricePerUnit}
                    onChangeText={(v) => set("pricePerUnit", v)}
                    placeholder="0.00"
                    keyboardType="decimal-pad"
                  />
                </FormField>
              </View>
              <View style={{ flex: 1 }}>
                <FormField label="Unit">
                  <FormTextInput
                    value={form.unit}
                    onChangeText={(v) => set("unit", v)}
                    placeholder="ea, box"
                  />
                </FormField>
              </View>
            </View>

            {isVariant ? null : (
              <FormField label="Category">
                <CategoryInput
                  value={form.category}
                  onChangeText={(v) => set("category", v)}
                  placeholder="e.g. Bakery"
                />
              </FormField>
            )}

            <FormField
              label="Units per case (optional)"
              hint={
                validUnitsPerBoxPrefill(initialUnitsPerBox) &&
                form.unitsPerBox === String(initialUnitsPerBox)
                  ? "From the invoice line — verify."
                  : "Set if 1 case holds N loose units — the price above is then the CASE price."
              }
            >
              <FormTextInput
                value={form.unitsPerBox}
                onChangeText={(v) => set("unitsPerBox", v)}
                placeholder="e.g. 12"
                keyboardType="number-pad"
              />
            </FormField>
          </ScrollView>

          <Pressable
            style={[styles.submitBtn, createMut.isPending && { opacity: 0.6 }]}
            onPress={submit}
            disabled={createMut.isPending}
          >
            {createMut.isPending ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.submitText}>Create & add to order</Text>
            )}
          </Pressable>
        </View>
      </KeyboardAvoidingView>

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
            variantName: f.variantName || f.name,
          }));
          setParentPickerOpen(false);
        }}
      />
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
  row2: { flexDirection: "row", gap: 12 },
  errorBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: ios.system.redWash,
    padding: 10,
    borderRadius: 10,
    marginBottom: 8,
  },
  errorText: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.system.redInk, flex: 1 },
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
  submitBtn: {
    marginTop: 10,
    backgroundColor: ios.brand,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  submitText: { fontSize: 16, fontFamily: "Inter_600SemiBold", color: "#fff" },
});
