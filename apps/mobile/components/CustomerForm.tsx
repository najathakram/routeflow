import * as React from "react";
import { Pressable, StyleSheet, Switch, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { ios } from "@routeflow/ui/tokens";
import { FormField, FormSection, FormSheet, FormTextInput } from "./FormSheet";

export interface CustomerFormValues {
  businessName: string;
  contactName: string;
  email: string;
  phone: string;
  creditLimit: string;
  pricingTier: number;
  currency: string;
  notes: string;
  deliveryWindowStart: string;
  deliveryWindowEnd: string;
  isTaxExempt: boolean;
  taxId: string;
}

export function emptyCustomerForm(): CustomerFormValues {
  return {
    businessName: "",
    contactName: "",
    email: "",
    phone: "",
    creditLimit: "",
    pricingTier: 1,
    currency: "",
    notes: "",
    deliveryWindowStart: "",
    deliveryWindowEnd: "",
    isTaxExempt: false,
    taxId: "",
  };
}

export function customerFormFromValues(c: Record<string, any>): CustomerFormValues {
  return {
    businessName: c.businessName ?? "",
    contactName: c.contactName ?? "",
    email: c.email ?? "",
    phone: c.phone ?? "",
    creditLimit: c.creditLimit != null ? String(c.creditLimit) : "",
    pricingTier: c.pricingTier ?? 1,
    currency: c.currency ?? "",
    notes: c.notes ?? "",
    deliveryWindowStart: c.deliveryWindowStart ?? "",
    deliveryWindowEnd: c.deliveryWindowEnd ?? "",
    isTaxExempt: c.isTaxExempt ?? false,
    taxId: c.taxId ?? "",
  };
}

export interface CustomerPayload {
  businessName: string;
  contactName?: string;
  email?: string;
  phone?: string;
  creditLimit?: number;
  pricingTier?: number;
  currency?: string;
  notes?: string;
  deliveryWindowStart?: string;
  deliveryWindowEnd?: string;
  isTaxExempt?: boolean;
  taxId?: string;
}

function parseOptionalNumber(v: string): number | undefined {
  const t = v.trim();
  if (!t) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

function buildPayload(form: CustomerFormValues): CustomerPayload | { error: string } {
  const businessName = form.businessName.trim();
  if (!businessName) return { error: "Business name is required." };
  return {
    businessName,
    contactName: form.contactName.trim() || undefined,
    email: form.email.trim() || undefined,
    phone: form.phone.trim() || undefined,
    creditLimit: parseOptionalNumber(form.creditLimit),
    pricingTier: form.pricingTier,
    currency: form.currency.trim() || undefined,
    notes: form.notes.trim() || undefined,
    deliveryWindowStart: form.deliveryWindowStart.trim() || undefined,
    deliveryWindowEnd: form.deliveryWindowEnd.trim() || undefined,
    isTaxExempt: form.isTaxExempt,
    taxId: form.taxId.trim() || undefined,
  };
}

interface Props {
  title: string;
  submitLabel: string;
  initial: CustomerFormValues;
  submitting?: boolean;
  onSubmit: (payload: CustomerPayload) => void | Promise<void>;
}

export function CustomerForm({ title, submitLabel, initial, submitting, onSubmit }: Props) {
  const [form, setForm] = React.useState<CustomerFormValues>(initial);
  const [error, setError] = React.useState<string | null>(null);
  const set = <K extends keyof CustomerFormValues>(k: K, v: CustomerFormValues[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  // BUG-XR2-5: warn on tab close / refresh / nav-away while the form is dirty.
  const isDirty = React.useMemo(() => {
    return (Object.keys(form) as Array<keyof CustomerFormValues>).some(
      (k) => form[k] !== initial[k],
    );
  }, [form, initial]);

  const submit = () => {
    const res = buildPayload(form);
    if ("error" in res) {
      setError(res.error);
      return;
    }
    setError(null);
    onSubmit(res);
  };

  return (
    <FormSheet
      title={title}
      submitLabel={submitLabel}
      submitting={submitting}
      onSubmit={submit}
      warnIfDirty={isDirty && !submitting}
    >
      {error ? (
        <View style={styles.errorBanner}>
          <Ionicons name="warning-outline" size={16} color={ios.system.redInk} />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      <FormSection title="Business">
        <FormField label="Business name">
          <FormTextInput
            value={form.businessName}
            onChangeText={(v) => set("businessName", v)}
            placeholder="Harbor Café"
            autoCapitalize="words"
          />
        </FormField>
        <FormField label="Contact person">
          <FormTextInput
            value={form.contactName}
            onChangeText={(v) => set("contactName", v)}
            placeholder="Jane Doe"
            autoCapitalize="words"
          />
        </FormField>
        <FormField label="Notes">
          <FormTextInput
            value={form.notes}
            onChangeText={(v) => set("notes", v)}
            placeholder="Any delivery instructions or notes…"
            multiline
            numberOfLines={3}
            style={{ minHeight: 72, textAlignVertical: "top" }}
          />
        </FormField>
      </FormSection>

      <FormSection title="Contact">
        <FormField label="Email">
          <FormTextInput
            value={form.email}
            onChangeText={(v) => set("email", v)}
            placeholder="ops@business.com"
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
          />
        </FormField>
        <FormField label="Phone">
          <FormTextInput
            value={form.phone}
            onChangeText={(v) => set("phone", v)}
            placeholder="+1 555 555 1234"
            keyboardType="phone-pad"
          />
        </FormField>
      </FormSection>

      <FormSection title="Billing">
        <FormField label="Credit limit">
          <FormTextInput
            value={form.creditLimit}
            onChangeText={(v) => set("creditLimit", v)}
            placeholder="0.00"
            keyboardType="decimal-pad"
          />
        </FormField>
        <FormField label="Pricing tier">
          <View style={styles.tierRow}>
            {([1, 2, 3, 4, 5] as const).map((t) => (
              <Pressable
                key={t}
                style={[styles.tierBtn, form.pricingTier === t && styles.tierBtnActive]}
                onPress={() => set("pricingTier", t)}
              >
                <Text
                  style={[styles.tierBtnText, form.pricingTier === t && styles.tierBtnTextActive]}
                >
                  {t}
                </Text>
              </Pressable>
            ))}
          </View>
        </FormField>
        <FormField label="Currency">
          <FormTextInput
            value={form.currency}
            onChangeText={(v) => set("currency", v)}
            placeholder="USD"
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={3}
          />
        </FormField>
        <View style={styles.switchRow}>
          <Text style={styles.switchLabel}>Tax exempt</Text>
          <Switch
            value={form.isTaxExempt}
            onValueChange={(v) => set("isTaxExempt", v)}
            trackColor={{ true: ios.brand }}
          />
        </View>
        {form.isTaxExempt ? (
          <FormField label="Tax ID / exemption number">
            <FormTextInput
              value={form.taxId}
              onChangeText={(v) => set("taxId", v)}
              placeholder="EIN or exemption #"
              autoCapitalize="characters"
            />
          </FormField>
        ) : null}
      </FormSection>

      <FormSection title="Delivery window">
        <View style={styles.windowRow}>
          <View style={{ flex: 1, gap: 6 }}>
            <Text style={styles.windowLabel}>FROM (HH:MM)</Text>
            <FormTextInput
              value={form.deliveryWindowStart}
              onChangeText={(v) => set("deliveryWindowStart", v)}
              placeholder="08:00"
              keyboardType="numbers-and-punctuation"
              maxLength={5}
            />
          </View>
          <View style={{ flex: 1, gap: 6 }}>
            <Text style={styles.windowLabel}>TO (HH:MM)</Text>
            <FormTextInput
              value={form.deliveryWindowEnd}
              onChangeText={(v) => set("deliveryWindowEnd", v)}
              placeholder="17:00"
              keyboardType="numbers-and-punctuation"
              maxLength={5}
            />
          </View>
        </View>
      </FormSection>
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
  tierRow: { flexDirection: "row", gap: 8 },
  tierBtn: {
    flex: 1,
    height: 38,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
    backgroundColor: ios.fill3,
  },
  tierBtnActive: { backgroundColor: ios.brand },
  tierBtnText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label2 },
  tierBtnTextActive: { color: "#fff" },
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: 38,
  },
  switchLabel: { fontSize: 15, fontFamily: "Inter_400Regular", color: ios.label },
  windowRow: { flexDirection: "row", gap: 12 },
  windowLabel: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    letterSpacing: 0.3,
    textTransform: "uppercase",
  },
});
