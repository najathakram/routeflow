import * as React from "react";
import { Platform, Pressable, StyleSheet, Switch, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { FormField, FormSection, FormSheet, FormTextInput } from "./FormSheet";
import { CategoryInput } from "./CategoryInput";
import { ProductPickerSheet } from "./ProductPickerSheet";
import { OptionPickerSheet } from "./OptionPickerSheet";
import { SubcategoryPickerSheet } from "./SubcategoryPickerSheet";
import {
  useTrackedCategories,
  useTrackedSubcategories,
  useRegulatedTemplates,
} from "../lib/api/tracked-categories";
import { sectionPickerOptions, subcategoryPickerOptions } from "../lib/regulated-format";
import { cascadeTierPrices, perUnitPrice, type TierField } from "../lib/pricing";
import {
  buildProductPayload,
  emptyProductForm,
  productFormFromValues,
  type ProductFormValues,
  type SubmitPayload,
} from "../lib/product-form";
import { useTierLabels } from "../lib/api/tier-labels";
import { tierLabel } from "../lib/tier-label";

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
  /** REG-3: create omits blank tracked-category fields, edit sends explicit null to clear. */
  mode: "create" | "edit";
  onSubmit: (payload: SubmitPayload) => void | Promise<void>;
}

export function ProductForm({
  title,
  submitLabel,
  initial,
  submitting,
  mode,
  onSubmit,
}: ProductFormProps) {
  const router = useRouter();
  const { data: tierLabels } = useTierLabels();
  const [form, setForm] = React.useState<ProductFormValues>(initial);
  const [error, setError] = React.useState<string | null>(null);
  const [parentPickerOpen, setParentPickerOpen] = React.useState(false);
  const [sectionPickerOpen, setSectionPickerOpen] = React.useState(false);
  const [subcategoryPickerOpen, setSubcategoryPickerOpen] = React.useState(false);
  const [itemTypePickerOpen, setItemTypePickerOpen] = React.useState(false);
  const [uomUnitPickerOpen, setUomUnitPickerOpen] = React.useState(false);
  const [uomCasePickerOpen, setUomCasePickerOpen] = React.useState(false);

  const set = <K extends keyof ProductFormValues>(key: K, value: ProductFormValues[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const isVariant = !!form.parentProductId;

  // Tier-price cascade: fires on COMMIT (onEndEditing), never per keystroke —
  // mirrors the web DecimalInput onCommit contract (WP2/WP3), React Native
  // style. Snapshot the value at focus time so a focus/blur with no real edit
  // doesn't re-cascade. Tier 1 / pricePerUnit deliberately keeps its own
  // behavior and is never wired here.
  const tierFocusRef = React.useRef<Partial<Record<TierField, string>>>({});
  const onTierFocus = (field: TierField) => {
    tierFocusRef.current[field] = form[field];
  };
  const onTierEndEditing = (field: TierField, text: string) => {
    const before = parseOptionalNumber(tierFocusRef.current[field] ?? "");
    const after = parseOptionalNumber(text);
    if (after == null) return; // cleared/invalid — nothing to cascade
    const changed = before == null || Math.abs(after - before) >= 1e-9;
    if (!changed) return;
    setForm((f) => ({ ...f, ...cascadeTierPrices(field, after) }));
  };

  const unitsPerBoxNum = parseOptionalNumber(form.unitsPerBox);
  const isBoxed = unitsPerBoxNum != null && unitsPerBoxNum > 1;
  const priceNum = parseOptionalNumber(form.pricePerUnit);
  const perUnitPreview =
    isBoxed && priceNum != null ? perUnitPrice(priceNum, unitsPerBoxNum) : null;

  // Regulated section + subcategory pickers (both optional). The subcategory
  // list is scoped to the section currently chosen in the form; `current` uses
  // the ORIGINAL initial value (not the live form) so re-selecting a section
  // doesn't change what counts as "the tag this product started with" — mirrors
  // web's product?.trackedCategory (stable across the edit session).
  const { data: sections = [] } = useTrackedCategories({ active: true });
  const { data: subcategories = [] } = useTrackedSubcategories(form.trackedCategoryId || undefined);
  const sectionOptions = sectionPickerOptions(
    sections,
    initial.trackedCategoryId
      ? { id: initial.trackedCategoryId, name: initial.trackedCategoryName ?? "Unknown type" }
      : null,
  );
  const subcategoryOptions = subcategoryPickerOptions(subcategories, form.trackedSubcategoryId);

  // Regulatory reporting config (Item type / Unit of measure / Case unit of
  // measure) — driven by the selected section's reportTemplate. The block only
  // renders when that template resolves to one with a productConfig (mirrors
  // web's ProductCreateModal / product detail page, WP9).
  const { data: templates = [] } = useRegulatedTemplates();
  const selectedSection = sections.find((s) => s.id === form.trackedCategoryId);
  const templateDef = selectedSection
    ? templates.find((t) => t.key === selectedSection.reportTemplate)
    : undefined;
  const productConfig = templateDef?.productConfig ?? null;
  const itemTypeOptions = productConfig?.itemTypes ?? [];
  const selectedItemTypeUoms = itemTypeOptions.find((t) => t.code === form.regItemType)?.uoms ?? [];
  const showCaseUom = !!productConfig?.caseUomSupported && isBoxed;

  const submit = () => {
    const result = buildProductPayload(form, mode);
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
          hint="Link this as a flavor/variety of an existing product. Variants inherit the parent's price tiers, case size, and category unless you override them."
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
          {form.trackedCategoryId ? (
            <Pressable style={styles.picker} onPress={() => setSubcategoryPickerOpen(true)}>
              <View style={styles.pickerInner}>
                <Text
                  style={[
                    styles.pickerText,
                    !form.trackedSubcategoryId && styles.pickerPlaceholder,
                  ]}
                  numberOfLines={1}
                >
                  {form.trackedSubcategoryId
                    ? (subcategoryOptions.find((s) => s.id === form.trackedSubcategoryId)?.name ??
                      "—")
                    : "None"}
                </Text>
                <Ionicons name="chevron-down" size={14} color={ios.label3} />
              </View>
            </Pressable>
          ) : (
            <CategoryInput
              value={form.category}
              onChangeText={(v) => set("category", v)}
              placeholder="Bakery"
            />
          )}
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
        <FormField label="SKU (case code)">
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
        <FormField
          label="Unit code"
          hint="Code on the individual unit — printed on customer invoices. Leave blank if it matches the case code."
        >
          <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
            <View style={{ flex: 1 }}>
              <FormTextInput
                value={form.unitSku}
                onChangeText={(v) => set("unitSku", v)}
                placeholder="Same as case code"
                autoCapitalize="characters"
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
          label="Units per case (optional)"
          hint="Leave blank for products sold individually. Set to N if 1 case contains N loose units — orders can then be issued as cases + loose units."
        >
          <FormTextInput
            value={form.unitsPerBox}
            onChangeText={(v) => set("unitsPerBox", v)}
            placeholder="e.g. 12"
            keyboardType="number-pad"
          />
        </FormField>
      </FormSection>

      {sectionOptions.length > 0 ? (
        <FormSection title="Regulated (optional)">
          <FormField label="Regulated type">
            <Pressable style={styles.picker} onPress={() => setSectionPickerOpen(true)}>
              <View style={styles.pickerInner}>
                <Text style={styles.pickerText} numberOfLines={1}>
                  {form.trackedCategoryId
                    ? (sectionOptions.find((s) => s.id === form.trackedCategoryId)?.name ?? "—")
                    : "None (not regulated)"}
                </Text>
                <Ionicons name="chevron-down" size={14} color={ios.label3} />
              </View>
            </Pressable>
          </FormField>
          {productConfig ? (
            <>
              <FormField label="Item type">
                <Pressable style={styles.picker} onPress={() => setItemTypePickerOpen(true)}>
                  <View style={styles.pickerInner}>
                    <Text
                      style={[styles.pickerText, !form.regItemType && styles.pickerPlaceholder]}
                      numberOfLines={1}
                    >
                      {itemTypeOptions.find((t) => t.code === form.regItemType)?.label ?? "Not set"}
                    </Text>
                    <Ionicons name="chevron-down" size={14} color={ios.label3} />
                  </View>
                </Pressable>
              </FormField>
              <FormField label="Unit of measure (per piece)">
                <Pressable
                  style={[styles.picker, !form.regItemType && styles.pickerDisabled]}
                  onPress={() => setUomUnitPickerOpen(true)}
                  disabled={!form.regItemType}
                >
                  <View style={styles.pickerInner}>
                    <Text
                      style={[styles.pickerText, !form.regUomUnit && styles.pickerPlaceholder]}
                      numberOfLines={1}
                    >
                      {form.regItemType
                        ? (selectedItemTypeUoms.find((u) => u.code === form.regUomUnit)?.label ??
                          "Not set")
                        : "Select an item type first"}
                    </Text>
                    <Ionicons name="chevron-down" size={14} color={ios.label3} />
                  </View>
                </Pressable>
              </FormField>
              {showCaseUom ? (
                <FormField
                  label="Case unit of measure"
                  hint="Used when this product is sold by the case. Leave blank to report every quantity in pieces."
                >
                  <Pressable
                    style={[styles.picker, !form.regItemType && styles.pickerDisabled]}
                    onPress={() => setUomCasePickerOpen(true)}
                    disabled={!form.regItemType}
                  >
                    <View style={styles.pickerInner}>
                      <Text
                        style={[styles.pickerText, !form.regUomCase && styles.pickerPlaceholder]}
                        numberOfLines={1}
                      >
                        {form.regItemType
                          ? (selectedItemTypeUoms.find((u) => u.code === form.regUomCase)?.label ??
                            "None (report in pieces)")
                          : "Select an item type first"}
                      </Text>
                      <Ionicons name="chevron-down" size={14} color={ios.label3} />
                    </View>
                  </Pressable>
                </FormField>
              ) : null}
            </>
          ) : null}
        </FormSection>
      ) : null}

      <FormSection title="Pricing">
        <FormField
          label="Price per unit"
          hint={
            isBoxed
              ? `This is the CASE price. A loose unit costs price ÷ units-per-case.${
                  perUnitPreview != null ? ` ≈ $${perUnitPreview.toFixed(2)} / unit` : ""
                }`
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
        <FormField label={`${tierLabel(tierLabels, 2)} price`}>
          <FormTextInput
            value={form.priceTier2}
            onChangeText={(v) => set("priceTier2", v)}
            onFocus={() => onTierFocus("priceTier2")}
            onEndEditing={(e) => onTierEndEditing("priceTier2", e.nativeEvent.text)}
            placeholder="0.00"
            keyboardType="decimal-pad"
          />
        </FormField>
        <FormField label={`${tierLabel(tierLabels, 3)} price`}>
          <FormTextInput
            value={form.priceTier3}
            onChangeText={(v) => set("priceTier3", v)}
            onFocus={() => onTierFocus("priceTier3")}
            onEndEditing={(e) => onTierEndEditing("priceTier3", e.nativeEvent.text)}
            placeholder="0.00"
            keyboardType="decimal-pad"
          />
        </FormField>
        <FormField label={`${tierLabel(tierLabels, 4)} price`}>
          <FormTextInput
            value={form.priceTier4}
            onChangeText={(v) => set("priceTier4", v)}
            onFocus={() => onTierFocus("priceTier4")}
            onEndEditing={(e) => onTierEndEditing("priceTier4", e.nativeEvent.text)}
            placeholder="0.00"
            keyboardType="decimal-pad"
          />
        </FormField>
        <FormField label={`${tierLabel(tierLabels, 5)} price`}>
          <FormTextInput
            value={form.priceTier5}
            onChangeText={(v) => set("priceTier5", v)}
            onFocus={() => onTierFocus("priceTier5")}
            onEndEditing={(e) => onTierEndEditing("priceTier5", e.nativeEvent.text)}
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
        {/* No on-hand quantity input: currentStock is not on the product
            create/update DTOs (forbidNonWhitelisted 400'd EVERY save that
            filled it), and stock changes must go through the audited
            Adjust-stock / Quick-receive flows so a movement is recorded. */}
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

      <OptionPickerSheet
        visible={sectionPickerOpen}
        title="Regulated type"
        options={sectionOptions.map((s) => ({
          id: s.id,
          label: s.name + (s.inactive ? " (inactive)" : ""),
        }))}
        selectedId={form.trackedCategoryId}
        nullable
        nullLabel="None (not regulated)"
        onClose={() => setSectionPickerOpen(false)}
        onSelect={(opt) => {
          // The sheet fires on EVERY row press, including the already-checked one, so
          // re-tapping the current type must be a pure dismiss — otherwise just opening
          // the sheet to look wipes the product's saved item type / units of measure.
          if ((opt.id || "") === (form.trackedCategoryId || "")) {
            setSectionPickerOpen(false);
            return;
          }
          set("trackedCategoryId", opt.id);
          set("trackedSubcategoryId", "");
          // The regulatory vocabulary is template-scoped, so codes chosen under the
          // previous regulated type are meaningless (and rejected) under a new one.
          set("regItemType", "");
          set("regUomCase", "");
          set("regUomUnit", "");
          // Category becomes ONE axis when a regulated type is picked: the free-text
          // value is cleared so buildProductPayload naturally omits `category` — the
          // server syncs it from the structured category the user picks next.
          if (opt.id) set("category", "");
          setSectionPickerOpen(false);
        }}
      />
      <SubcategoryPickerSheet
        visible={subcategoryPickerOpen}
        sectionId={form.trackedCategoryId || null}
        selectedId={form.trackedSubcategoryId}
        onClose={() => setSubcategoryPickerOpen(false)}
        onSelect={(id) => {
          set("trackedSubcategoryId", id);
        }}
      />

      <OptionPickerSheet
        visible={itemTypePickerOpen}
        title="Item type"
        options={itemTypeOptions.map((t) => ({ id: t.code, label: t.label }))}
        selectedId={form.regItemType}
        nullable
        nullLabel="Not set"
        onClose={() => setItemTypePickerOpen(false)}
        onSelect={(opt) => {
          // Same re-tap guard: keep the saved UoMs untouched when nothing actually changed.
          if ((opt.id || "") === (form.regItemType || "")) {
            setItemTypePickerOpen(false);
            return;
          }
          setForm((f) => {
            // A UoM valid for the old item type may not be valid for the new one.
            const newUoms = itemTypeOptions.find((t) => t.code === opt.id)?.uoms ?? [];
            const stillValid = (v: string) => !v || newUoms.some((u) => u.code === v);
            return {
              ...f,
              regItemType: opt.id,
              regUomUnit: stillValid(f.regUomUnit) ? f.regUomUnit : "",
              regUomCase: stillValid(f.regUomCase) ? f.regUomCase : "",
            };
          });
          setItemTypePickerOpen(false);
        }}
      />
      <OptionPickerSheet
        visible={uomUnitPickerOpen}
        title="Unit of measure"
        options={selectedItemTypeUoms.map((u) => ({ id: u.code, label: u.label }))}
        selectedId={form.regUomUnit}
        nullable
        nullLabel="Not set"
        onClose={() => setUomUnitPickerOpen(false)}
        onSelect={(opt) => {
          set("regUomUnit", opt.id);
          setUomUnitPickerOpen(false);
        }}
      />
      {showCaseUom ? (
        <OptionPickerSheet
          visible={uomCasePickerOpen}
          title="Case unit of measure"
          options={selectedItemTypeUoms.map((u) => ({ id: u.code, label: u.label }))}
          selectedId={form.regUomCase}
          nullable
          nullLabel="None (report in pieces)"
          onClose={() => setUomCasePickerOpen(false)}
          onSelect={(opt) => {
            set("regUomCase", opt.id);
            setUomCasePickerOpen(false);
          }}
        />
      ) : null}
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
  pickerDisabled: { opacity: 0.5 },
});
