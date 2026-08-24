import * as React from "react";
import { Pressable, StyleSheet, Switch, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { ios } from "@routeflow/ui/tokens";
import { FormField, FormSection, FormSheet, FormTextInput } from "./FormSheet";
import { AddressAutocompleteInput } from "./AddressAutocompleteInput";
import { isInternalEmail } from "../lib/internal-email";
import { useTierLabels } from "../lib/api/tier-labels";
import { tierLabel } from "../lib/tier-label";

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
  phone?: string;
  creditLimit?: number;
  pricingTier?: number;
  currency?: string;
  notes?: string;
  deliveryWindowStart?: string;
  deliveryWindowEnd?: string;
  isTaxExempt?: boolean;
  taxId?: string;
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

function parseOptionalNumber(v: string): number | undefined {
  const t = v.trim();
  if (!t) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Mirrors web's CustomerFormModal: the username no longer depends on the (now
 * optional) email — take the email local-part when there is one, else the
 * business or contact name, slugified, with a short suffix so it stays unique.
 */
function deriveUsername(email: string, businessName: string, contactName: string): string {
  const base =
    (email ? email.split("@")[0] : businessName || contactName)
      .replace(/[^a-z0-9]/gi, "")
      .toLowerCase()
      .slice(0, 24) || "customer";
  return `${base}_${Date.now().toString(36)}`;
}

function buildPayload(
  form: CustomerFormValues,
  mode: "create" | "edit",
): CustomerPayload | { error: string } {
  const businessName = form.businessName.trim();
  if (!businessName) return { error: "Business name is required." };

  // Address is optional on create (you can always add one later from the
  // Addresses screen) — but once the operator starts filling it in, require
  // the full set, same rule AddAddressForm uses on the Addresses screen.
  const street = form.street.trim();
  const city = form.city.trim();
  const state = form.state.trim();
  const zip = form.zip.trim();
  const hasAnyAddressInput = mode === "create" && !!(street || city || state || zip);
  const hasFullAddress = !!(street && city && state && zip);
  if (hasAnyAddressInput && !hasFullAddress) {
    return { error: "Street, city, state, and ZIP are all required to add an address." };
  }

  const contactName = form.contactName.trim();
  const email = form.email.trim();

  return {
    businessName,
    // Create-only — see CustomerPayload.username.
    username: mode === "create" ? deriveUsername(email, businessName, contactName) : undefined,
    // CreateCustomerDto declares contactName as a REQUIRED @IsString, so create
    // must always send a string ("" is accepted, and is what web sends when the
    // field is blank); edit keeps `undefined` = leave as-is.
    contactName: mode === "create" ? contactName : contactName || undefined,
    // Edit sends "" so a blanked field CLEARS the stored email server-side
    // (UpdateCustomerDto emptyToNull) — `|| undefined` made clearing a silent
    // no-op, so a sentinel could never be removed. Create keeps `undefined`:
    // CreateCustomerDto's @IsEmail rejects "" and the service mints its own
    // placeholder for an absent email.
    email: mode === "edit" ? email : email || undefined,
    phone: form.phone.trim() || undefined,
    creditLimit: parseOptionalNumber(form.creditLimit),
    pricingTier: form.pricingTier,
    currency: form.currency.trim() || undefined,
    notes: form.notes.trim() || undefined,
    // Edit-only: CreateCustomerDto has no delivery-window fields, and
    // `forbidNonWhitelisted` rejects the ENTIRE create payload over one unknown
    // property — a filled window would take the address bundle down with it.
    // The window is set from the edit screen instead (section below matches).
    deliveryWindowStart: mode === "edit" ? form.deliveryWindowStart.trim() || undefined : undefined,
    deliveryWindowEnd: mode === "edit" ? form.deliveryWindowEnd.trim() || undefined : undefined,
    isTaxExempt: form.isTaxExempt,
    taxId: form.taxId.trim() || undefined,
    addresses:
      mode === "create" && hasFullAddress
        ? [{ label: "Main", line1: street, city, state, zip, isDefault: true }]
        : undefined,
  };
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
    const res = buildPayload(form, mode);
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
