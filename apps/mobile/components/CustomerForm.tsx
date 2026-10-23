import * as React from "react";
import { Pressable, StyleSheet, Switch, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { ios } from "@routeflow/ui/tokens";
import { FormField, FormSection, FormSheet, FormTextInput } from "./FormSheet";
import { AddressAutocompleteInput } from "./AddressAutocompleteInput";
import { isInternalEmail } from "../lib/internal-email";
import { buildPayload } from "../lib/customer-payload";
import { useTierLabels } from "../lib/api/tier-labels";
import { tierLabel } from "../lib/tier-label";
import { shouldConfirmDiscard } from "../lib/discard-guard";
import { formFulfillPath } from "../lib/customer-fulfill-path";
import type { FulfillPath } from "@routeflow/types";

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
  /**
   * The DEFAULT fulfillment mode new orders for this customer seed from
   * (`NewOrderScreen`'s fulfillment row reads it) — not a constraint on the
   * customer's own orders, which can still be overridden per-order. ROUTE
   * (delivery route) is the default; SHIP = ships via carrier, never routed.
   */
  fulfillPath: FulfillPath;
  // Create-only: bundled into the create payload as the customer's first
  // address (mirrors web's CustomerFormModal). Editing an existing
  // customer's address(es) happens on the dedicated Addresses screen
  // (app/(operator)/customers/[id]/addresses.tsx), which already supports
  // add/update — so these stay empty and unused in edit mode.
  street: string;
  city: string;
  state: string;
  zip: string;
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
    fulfillPath: "ROUTE",
    street: "",
    city: "",
    state: "",
    zip: "",
  };
}

export function customerFormFromValues(c: Record<string, any>): CustomerFormValues {
  return {
    businessName: c.businessName ?? "",
    contactName: c.contactName ?? "",
    // Don't surface the import sentinel (`…@imported.local` / `…@placeholder.local`)
    // — it isn't a real inbox. Saving with the field left blank then scrubs it
    // (edit mode sends "", which the API clears to null). Mirrors web
    // CustomerFormModal.
    email: c.email && !isInternalEmail(c.email) ? c.email : "",
    phone: c.phone ?? "",
    creditLimit: c.creditLimit != null ? String(c.creditLimit) : "",
    pricingTier: c.pricingTier ?? 1,
    currency: c.currency ?? "",
    notes: c.notes ?? "",
    deliveryWindowStart: c.deliveryWindowStart ?? "",
    deliveryWindowEnd: c.deliveryWindowEnd ?? "",
    isTaxExempt: c.isTaxExempt ?? false,
    taxId: c.taxId ?? "",
    fulfillPath: formFulfillPath(c.fulfillPath),
    // Edit mode never renders or submits the address section (see comment on
    // CustomerFormValues) — leave blank rather than prefill fields the form
    // can't save.
    street: "",
    city: "",
    state: "",
    zip: "",
  };
}

export interface CustomerPayload {
  businessName: string;
  // Create-only. CreateCustomerDto REQUIRES `username` (the API mints the
  // customer's linked User record from it) and the global ValidationPipe runs
  // with `whitelist + forbidNonWhitelisted`, so omitting it 400s the whole
  // create — address bundle included. Derived client-side, same as web's
  // CustomerFormModal.
  username?: string;
  contactName?: string;
  email?: string;
  phone?: string | null;
  creditLimit?: number;
  pricingTier?: number;
  currency?: string;
  notes?: string | null;
  deliveryWindowStart?: string | null;
  deliveryWindowEnd?: string | null;
  isTaxExempt?: boolean;
  taxId?: string | null;
  /**
   * The customer's default fulfillment mode — seeds new orders' fulfillment
   * row (mobile `NewOrderScreen`, web `CreateOrderModal`). Accepted on both
   * create and edit (`CreateCustomerDto.fulfillPath` in lib/api/customers.ts,
   * and the server's create/update DTOs since launch).
   */
  fulfillPath?: "ROUTE" | "SHIP";
  // Create-only bundle for the customer's first address — the mobile create
  // payload didn't carry an address at all before this; the API's
  // CreateCustomerDto already accepts it (see customers.service.ts create()).
  // `label` is required by CreateAddressDto (not just the /addresses
  // sub-resource endpoint, which is more lenient) — mirrors web's "Main".
  addresses?: Array<{
    label: string;
    line1: string;
    city: string;
    state: string;
    zip: string;
    isDefault?: boolean;
  }>;
}

interface Props {
  title: string;
  submitLabel: string;
  initial: CustomerFormValues;
  submitting?: boolean;
  /** "edit" lets a blanked email field clear the stored address; default "create". */
  mode?: "create" | "edit";
  onSubmit: (payload: CustomerPayload) => void | Promise<void>;
}

export function CustomerForm({
  title,
  submitLabel,
  initial,
  submitting,
  mode = "create",
  onSubmit,
}: Props) {
  const [form, setForm] = React.useState<CustomerFormValues>(initial);
  const [error, setError] = React.useState<string | null>(null);
  const { data: tierLabels } = useTierLabels();
  const set = <K extends keyof CustomerFormValues>(k: K, v: CustomerFormValues[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  // BUG-XR2-5: warn on tab close / refresh / nav-away while the form is dirty.
  const isDirty = React.useMemo(() => {
    return (Object.keys(form) as Array<keyof CustomerFormValues>).some(
      (k) => form[k] !== initial[k],
    );
  }, [form, initial]);

  const submit = () => {
    const res = buildPayload(form, initial, mode);
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
      confirmDiscardIfDirty={shouldConfirmDiscard(isDirty, !!submitting)}
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

      <FormSection title="Fulfillment">
        <FormField
          label="Default fulfillment"
          hint={
            form.fulfillPath === "SHIP"
              ? "Ships via carrier — won't appear on delivery routes."
              : undefined
          }
        >
          <View style={styles.fulfillRow}>
            <Pressable
              style={[styles.fulfillBtn, form.fulfillPath === "ROUTE" && styles.fulfillBtnActive]}
              onPress={() => set("fulfillPath", "ROUTE")}
              accessibilityRole="button"
              accessibilityLabel="Delivery route"
              accessibilityState={{ selected: form.fulfillPath === "ROUTE" }}
            >
              <Text
                style={[
                  styles.fulfillBtnText,
                  form.fulfillPath === "ROUTE" && styles.fulfillBtnTextActive,
                ]}
              >
                Delivery route
              </Text>
            </Pressable>
            <Pressable
              style={[styles.fulfillBtn, form.fulfillPath === "SHIP" && styles.fulfillBtnActive]}
              onPress={() => set("fulfillPath", "SHIP")}
              accessibilityRole="button"
              accessibilityLabel="Ship via carrier"
              accessibilityState={{ selected: form.fulfillPath === "SHIP" }}
            >
              <Text
                style={[
                  styles.fulfillBtnText,
                  form.fulfillPath === "SHIP" && styles.fulfillBtnTextActive,
                ]}
              >
                Ship via carrier
              </Text>
            </Pressable>
          </View>
        </FormField>
      </FormSection>

      {/* Lifted above the sections that follow it: the street field's suggestion
          list overflows this card, and only a zIndex on the section itself
          out-ranks the later section cards. */}
      {mode === "create" ? (
        <FormSection title="Address (optional)" style={{ zIndex: 20 }}>
          <AddressAutocompleteInput
            label="Street"
            value={form.street}
            onChangeText={(v) => set("street", v)}
            onAddressSelect={(parts) =>
              setForm((f) => ({
                ...f,
                street: parts.street || f.street,
                city: parts.city || f.city,
                state: parts.state || f.state,
                zip: parts.zip || f.zip,
              }))
            }
            placeholder="123 Harbor Way"
          />
          <FormField label="City">
            <FormTextInput
              value={form.city}
              onChangeText={(v) => set("city", v)}
              placeholder="Austin"
              autoCapitalize="words"
            />
          </FormField>
          <View style={{ flexDirection: "row", gap: 10 }}>
            <View style={{ flex: 1 }}>
              <FormField label="State">
                <FormTextInput
                  value={form.state}
                  onChangeText={(v) => set("state", v)}
                  placeholder="TX"
                  autoCapitalize="characters"
                  maxLength={2}
                />
              </FormField>
            </View>
            <View style={{ flex: 1 }}>
              <FormField label="ZIP">
                <FormTextInput
                  value={form.zip}
                  onChangeText={(v) => set("zip", v)}
                  placeholder="78701"
                  keyboardType="number-pad"
                />
              </FormField>
            </View>
          </View>
        </FormSection>
      ) : null}

      <FormSection title="Billing">
        <FormField label="Credit limit">
          <FormTextInput
            value={form.creditLimit}
            onChangeText={(v) => set("creditLimit", v)}
            placeholder="0.00"
            keyboardType="decimal-pad"
          />
        </FormField>
        <FormField
          label="Pricing tier"
          // Buttons stay compact digits (1-5) so the row always fits — only
          // the selected tier's resolved name is surfaced, as a hint, and
          // only when the tenant has actually configured one (tierLabel()
          // falls back to "Tier N" otherwise, which would just repeat the
          // digit already shown above).
          hint={
            tierLabels?.[String(form.pricingTier)]?.trim()
              ? tierLabel(tierLabels, form.pricingTier)
              : undefined
          }
        >
          <View style={styles.tierRow}>
            {([1, 2, 3, 4, 5] as const).map((t) => (
              <Pressable
                key={t}
                style={[styles.tierBtn, form.pricingTier === t && styles.tierBtnActive]}
                onPress={() => set("pricingTier", t)}
                accessibilityRole="button"
                accessibilityLabel={tierLabel(tierLabels, t)}
                accessibilityState={{ selected: form.pricingTier === t }}
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

      {/* Edit-only — the create endpoint rejects these fields (see buildPayload). */}
      {mode === "edit" ? (
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
  fulfillRow: { flexDirection: "row", gap: 8 },
  fulfillBtn: {
    flex: 1,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
    paddingHorizontal: 10,
    backgroundColor: ios.fill3,
  },
  fulfillBtnActive: { backgroundColor: ios.brand },
  fulfillBtnText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    textAlign: "center",
  },
  fulfillBtnTextActive: { color: "#fff" },
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
