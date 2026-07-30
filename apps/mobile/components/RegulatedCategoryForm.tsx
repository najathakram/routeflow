import * as React from "react";
import { Pressable, StyleSheet, Switch, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { ios } from "@routeflow/ui/tokens";
import { FormField, FormSection, FormSheet, FormTextInput } from "./FormSheet";
import { OptionPickerSheet, type PickerOption } from "./OptionPickerSheet";
import type {
  InvoiceTreatment,
  ReportCadence,
  TrackedCategoryTaxType,
} from "../lib/api/tracked-categories";

export interface RegulatedCategoryFormValues {
  name: string;
  taxType: TrackedCategoryTaxType;
  rate: string;
  unitBasis: string;
  priceIncludesTax: boolean;
  invoiceTreatment: InvoiceTreatment;
  requiresLicense: boolean;
  reportTemplate: string;
  reportCadence: ReportCadence;
  active: boolean;
  /**
   * TX Comptroller (TX_COMPTROLLER template) config — optional so screens that don't yet
   * hydrate these three columns (e.g. an `initial` literal built before this field existed)
   * still satisfy this interface without every call site needing an update.
   */
  wholesalerLicenseNo?: string;
  /** "1" | "2" | "3" (Cigarettes/Cigars/Tobacco) as a picker id — cast to a number on submit. */
  txItemType?: string;
  txUom?: string;
}

export function emptyRegulatedCategoryForm(): RegulatedCategoryFormValues {
  return {
    name: "",
    taxType: "NONE",
    rate: "0",
    unitBasis: "",
    priceIncludesTax: false,
    invoiceTreatment: "SEPARATE_INVOICE",
    requiresLicense: false,
    reportTemplate: "GENERIC",
    reportCadence: "MONTHLY",
    active: true,
    wholesalerLicenseNo: "",
    txItemType: "",
    txUom: "",
  };
}

export interface RegulatedCategorySubmitPayload {
  name: string;
  taxType: TrackedCategoryTaxType;
  rate: number;
  unitBasis?: string;
  priceIncludesTax: boolean;
  invoiceTreatment: InvoiceTreatment;
  requiresLicense: boolean;
  reportTemplate: string;
  reportCadence: ReportCadence;
  active: boolean;
  /**
   * THIS tenant's own TX license/permit number (8 digits). `null` clears the column —
   * `undefined` would be dropped from the JSON body and leave the stale value in place.
   */
  wholesalerLicenseNo?: string | null;
  /** 1 = Cigarettes, 2 = Cigars, 3 = Tobacco. */
  txItemType?: number | null;
  txUom?: string | null;
}

const TAX_TYPES: PickerOption[] = [
  { id: "NONE", label: "None (track only, no auto tax)" },
  { id: "EXCISE_PER_UNIT", label: "Excise per unit" },
  { id: "PERCENT_OF_SALE", label: "Percent of sale" },
  { id: "PER_VOLUME", label: "Per volume" },
  { id: "DEPOSIT_PER_CONTAINER", label: "Deposit per container" },
];
const TREATMENTS: PickerOption[] = [
  { id: "SEPARATE_INVOICE", label: "Separate invoice (default)" },
  { id: "SEPARATE_SECTION", label: "Sectioned on the main invoice" },
  { id: "LINE_TAX", label: "Per-line tax" },
];
const TEMPLATES: PickerOption[] = [
  "GENERIC",
  "CA_CDTFA",
  "CA_ABC",
  "CALRECYCLE",
  "TX_COMPTROLLER",
].map((t) => ({ id: t, label: t }));
const CADENCES: PickerOption[] = ["MONTHLY", "QUARTERLY", "ANNUAL"].map((c) => ({
  id: c,
  label: c,
}));

// TX Comptroller item types + their allowed units of measure. Mirrors
// apps/api/src/regulated/tx-report.ts#TX_ITEM_TYPE_LABELS / TX_UOM_CODES (WP11) — kept as a
// local copy since mobile has no shared import path into the API package.
const TX_ITEM_TYPES: PickerOption[] = [
  { id: "1", label: "Cigarettes" },
  { id: "2", label: "Cigars" },
  { id: "3", label: "Tobacco" },
];
const TX_UOM_OPTIONS: Record<string, PickerOption[]> = {
  "1": [
    { id: "CP", label: "CP — Packs" },
    { id: "CS", label: "CS — Sticks" },
    { id: "CC", label: "CC — Cartons" },
  ],
  "2": [
    { id: "SB", label: "SB — Class B sticks" },
    { id: "SC", label: "SC — Class C sticks" },
    { id: "SD", label: "SD — Class D sticks" },
    { id: "SF", label: "SF — Class F sticks" },
  ],
  "3": [
    { id: "WO", label: "WO — Ounces" },
    { id: "WN", label: "WN — Number (cans/packages)" },
  ],
};

interface Props {
  title: string;
  submitLabel: string;
  submitting?: boolean;
  initial: RegulatedCategoryFormValues;
  onSubmit: (payload: RegulatedCategorySubmitPayload) => void;
}

export function RegulatedCategoryForm({
  title,
  submitLabel,
  submitting,
  initial,
  onSubmit,
}: Props) {
  const [form, setForm] = React.useState<RegulatedCategoryFormValues>(initial);
  const [error, setError] = React.useState<string | null>(null);
  const [taxTypeOpen, setTaxTypeOpen] = React.useState(false);
  const [treatmentOpen, setTreatmentOpen] = React.useState(false);
  const [templateOpen, setTemplateOpen] = React.useState(false);
  const [cadenceOpen, setCadenceOpen] = React.useState(false);
  const [txItemTypeOpen, setTxItemTypeOpen] = React.useState(false);
  const [txUomOpen, setTxUomOpen] = React.useState(false);

  const set = <K extends keyof RegulatedCategoryFormValues>(
    k: K,
    v: RegulatedCategoryFormValues[K],
  ) => setForm((f) => ({ ...f, [k]: v }));

  const hasTax = form.taxType !== "NONE";
  const isPercent = form.taxType === "PERCENT_OF_SALE";
  const isTx = form.reportTemplate === "TX_COMPTROLLER";
  const txUomOptions = form.txItemType ? (TX_UOM_OPTIONS[form.txItemType] ?? []) : [];

  const submit = () => {
    const name = form.name.trim();
    if (!name) {
      setError("Name is required.");
      return;
    }
    setError(null);
    onSubmit({
      name,
      taxType: form.taxType,
      rate: hasTax ? Number(form.rate) || 0 : 0,
      unitBasis: form.unitBasis.trim() || undefined,
      priceIncludesTax: form.priceIncludesTax,
      invoiceTreatment: form.invoiceTreatment,
      requiresLicense: form.requiresLicense,
      reportTemplate: form.reportTemplate,
      reportCadence: form.reportCadence,
      active: form.active,
      // null, NOT undefined: an undefined key is omitted from the JSON body, so a cleared
      // field (or a template switched away from TX) would never reach the DTO and Prisma
      // would leave the stale value in place. null clears the nullable column.
      wholesalerLicenseNo: isTx ? form.wholesalerLicenseNo?.trim() || null : null,
      txItemType: isTx && form.txItemType ? Number(form.txItemType) : null,
      txUom: isTx ? form.txUom || null : null,
    });
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
        <FormField label="Name">
          <FormTextInput
            value={form.name}
            onChangeText={(v) => set("name", v)}
            placeholder='e.g. "Alcohol", "CRV Beverage Deposits"'
            autoCapitalize="words"
          />
        </FormField>
        <FormField label="Tax type">
          <PickerRow
            label={TAX_TYPES.find((t) => t.id === form.taxType)?.label ?? form.taxType}
            onPress={() => setTaxTypeOpen(true)}
          />
        </FormField>
        <FormField label="Invoice treatment">
          <PickerRow
            label={
              TREATMENTS.find((t) => t.id === form.invoiceTreatment)?.label ?? form.invoiceTreatment
            }
            onPress={() => setTreatmentOpen(true)}
          />
        </FormField>
      </FormSection>

      {hasTax ? (
        <FormSection title="Tax">
          <FormField label={isPercent ? "Rate (fraction — 0.05 = 5%)" : "Rate ($ per unit)"}>
            <FormTextInput
              value={form.rate}
              onChangeText={(v) => set("rate", v)}
              keyboardType="decimal-pad"
              placeholder={isPercent ? "0.05" : "2.87"}
            />
          </FormField>
          {!isPercent ? (
            <FormField label="Unit basis (pack, oz…)">
              <FormTextInput
                value={form.unitBasis}
                onChangeText={(v) => set("unitBasis", v)}
                placeholder="pack"
              />
            </FormField>
          ) : null}
          <SwitchRow
            label="Price already includes this tax"
            value={form.priceIncludesTax}
            onValueChange={(v) => set("priceIncludesTax", v)}
          />
        </FormSection>
      ) : null}

      <FormSection title="Reporting">
        <FormField label="Report template">
          <PickerRow label={form.reportTemplate} onPress={() => setTemplateOpen(true)} />
        </FormField>
        <FormField label="Report cadence">
          <PickerRow label={form.reportCadence} onPress={() => setCadenceOpen(true)} />
        </FormField>
      </FormSection>

      {isTx ? (
        <FormSection title="TX Comptroller">
          <FormField
            label="Wholesaler license #"
            hint="Your 8-digit Texas license or permit number"
          >
            <FormTextInput
              value={form.wholesalerLicenseNo ?? ""}
              onChangeText={(v) => set("wholesalerLicenseNo", v)}
              placeholder="12345678"
              keyboardType="number-pad"
              maxLength={20}
            />
          </FormField>
          <FormField label="Item type">
            <PickerRow
              label={TX_ITEM_TYPES.find((t) => t.id === form.txItemType)?.label ?? "Choose one"}
              onPress={() => setTxItemTypeOpen(true)}
            />
          </FormField>
          <FormField label="Unit of measure">
            <PickerRow
              label={
                txUomOptions.find((u) => u.id === form.txUom)?.label ??
                (form.txItemType ? "Choose one" : "Choose an item type first")
              }
              onPress={() => setTxUomOpen(true)}
            />
          </FormField>
        </FormSection>
      ) : null}

      <FormSection>
        <SwitchRow
          label="Requires the customer to hold a license"
          value={form.requiresLicense}
          onValueChange={(v) => set("requiresLicense", v)}
        />
        <SwitchRow label="Active" value={form.active} onValueChange={(v) => set("active", v)} />
      </FormSection>

      <OptionPickerSheet
        visible={taxTypeOpen}
        title="Tax type"
        options={TAX_TYPES}
        selectedId={form.taxType}
        onClose={() => setTaxTypeOpen(false)}
        onSelect={(o) => {
          const taxType = o.id as TrackedCategoryTaxType;
          setForm((f) => ({
            ...f,
            taxType,
            unitBasis: taxType === "PERCENT_OF_SALE" || taxType === "NONE" ? "" : f.unitBasis,
          }));
          setTaxTypeOpen(false);
        }}
      />
      <OptionPickerSheet
        visible={treatmentOpen}
        title="Invoice treatment"
        options={TREATMENTS}
        selectedId={form.invoiceTreatment}
        onClose={() => setTreatmentOpen(false)}
        onSelect={(o) => {
          set("invoiceTreatment", o.id as InvoiceTreatment);
          setTreatmentOpen(false);
        }}
      />
      <OptionPickerSheet
        visible={templateOpen}
        title="Report template"
        options={TEMPLATES}
        selectedId={form.reportTemplate}
        onClose={() => setTemplateOpen(false)}
        onSelect={(o) => {
          set("reportTemplate", o.id);
          setTemplateOpen(false);
        }}
      />
      <OptionPickerSheet
        visible={cadenceOpen}
        title="Report cadence"
        options={CADENCES}
        selectedId={form.reportCadence}
        onClose={() => setCadenceOpen(false)}
        onSelect={(o) => {
          set("reportCadence", o.id as ReportCadence);
          setCadenceOpen(false);
        }}
      />
      <OptionPickerSheet
        visible={txItemTypeOpen}
        title="TX item type"
        options={TX_ITEM_TYPES}
        selectedId={form.txItemType}
        onClose={() => setTxItemTypeOpen(false)}
        onSelect={(o) => {
          setForm((f) => ({
            ...f,
            txItemType: o.id,
            // A UOM valid for the old item type may not be valid for the new one.
            txUom: (TX_UOM_OPTIONS[o.id] ?? []).some((u) => u.id === f.txUom) ? f.txUom : "",
          }));
          setTxItemTypeOpen(false);
        }}
      />
      <OptionPickerSheet
        visible={txUomOpen}
        title="Unit of measure"
        options={txUomOptions}
        selectedId={form.txUom}
        onClose={() => setTxUomOpen(false)}
        onSelect={(o) => {
          set("txUom", o.id);
          setTxUomOpen(false);
        }}
      />
    </FormSheet>
  );
}

function PickerRow({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable style={styles.picker} onPress={onPress}>
      <View style={styles.pickerInner}>
        <Text style={styles.pickerText} numberOfLines={1}>
          {label}
        </Text>
        <Ionicons name="chevron-down" size={14} color={ios.label3} />
      </View>
    </Pressable>
  );
}

function SwitchRow({
  label,
  value,
  onValueChange,
}: {
  label: string;
  value: boolean;
  onValueChange: (v: boolean) => void;
}) {
  return (
    <View style={styles.switchRow}>
      <Text style={styles.switchLabel}>{label}</Text>
      <Switch value={value} onValueChange={onValueChange} trackColor={{ true: ios.brand }} />
    </View>
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
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  switchLabel: { fontSize: 15, fontFamily: "Inter_500Medium", color: ios.label, flex: 1 },
});
