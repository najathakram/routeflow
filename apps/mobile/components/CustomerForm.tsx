import * as React from "react";
import { StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { ios } from "@routeflow/ui/tokens";
import { FormField, FormSection, FormSheet, FormTextInput } from "./FormSheet";

export interface CustomerFormValues {
  businessName: string;
  contactName: string;
  email: string;
  phone: string;
  creditLimit: string;
}

export function emptyCustomerForm(): CustomerFormValues {
  return {
    businessName: "",
    contactName: "",
    email: "",
    phone: "",
    creditLimit: "",
  };
}

export function customerFormFromValues(c: Record<string, any>): CustomerFormValues {
  return {
    businessName: c.businessName ?? "",
    contactName: c.contactName ?? "",
    email: c.email ?? "",
    phone: c.phone ?? "",
    creditLimit: c.creditLimit != null ? String(c.creditLimit) : "",
  };
}

export interface CustomerPayload {
  businessName: string;
  contactName?: string;
  email?: string;
  phone?: string;
  creditLimit?: number;
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
    <FormSheet title={title} submitLabel={submitLabel} submitting={submitting} onSubmit={submit}>
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
});
