import { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavBackButton, NavBar } from "@routeflow/ui/mobile/ios";
import { FormField, FormSection, FormTextInput } from "../../../../components/FormSheet";
import {
  useAddCustomerAddress,
  useCustomer,
  useDeleteCustomerAddress,
  useUpdateCustomerAddress,
  type CustomerDetail,
} from "../../../../lib/api/customers";
import { confirm } from "../../../../lib/confirm";
import { showToast } from "../../../../lib/toast";

type AddressRecord = CustomerDetail["addresses"][number];

const ADDRESS_TYPES = [
  { value: "BILLING", label: "Billing" },
  { value: "SHIPPING", label: "Shipping" },
  { value: "DELIVERY", label: "Delivery" },
] as const;

function addressTypeLabel(type?: string) {
  return ADDRESS_TYPES.find((t) => t.value === type)?.label ?? "Billing";
}

export default function ManageAddressesScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: customer, isLoading, refetch } = useCustomer(id ?? "");
  const addMut = useAddCustomerAddress();
  const updateMut = useUpdateCustomerAddress();
  const deleteMut = useDeleteCustomerAddress();
  // "add" opens a blank form; an address record opens that address prefilled
  // for edit; null hides the form entirely.
  const [formTarget, setFormTarget] = useState<"add" | AddressRecord | null>(null);

  if (isLoading || !customer) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar inlineTitle="Addresses" leading={<NavBackButton onPress={() => router.back()} />} />
        <View style={styles.center}>
          <ActivityIndicator color={ios.brand} />
        </View>
      </SafeAreaView>
    );
  }

  const setDefault = (addressId: string) => {
    if (!id) return;
    updateMut.mutate(
      { customerId: id, addressId, isDefault: true },
      {
        onSuccess: () => {
          showToast("Default updated");
          refetch();
        },
        onError: (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
      },
    );
  };

  const handleDelete = (address: AddressRecord) => {
    if (!id) return;
    confirm(
      "Delete address?",
      `${address.line1}, ${address.city} will be removed.`,
      () =>
        deleteMut.mutate(
          { customerId: id, addressId: address.id },
          {
            onSuccess: () => {
              showToast("Address deleted");
              refetch();
            },
            // Server 409s with a specific reason when a route stop still
            // references this address — surface it verbatim, not a generic message.
            onError: (e: any) =>
              showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
          },
        ),
      { confirmText: "Delete", destructive: true },
    );
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Addresses"
        leading={<NavBackButton label={customer.businessName} onPress={() => router.back()} />}
      />
      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={{ padding: 16, gap: 10 }}>
          {customer.addresses?.length === 0 ? (
            <Text style={styles.empty}>No addresses yet.</Text>
          ) : (
            customer.addresses?.map((a) => (
              <View key={a.id} style={styles.addressCard}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.addressLine}>{a.line1}</Text>
                  {a.line2 ? <Text style={styles.addressLine}>{a.line2}</Text> : null}
                  <Text style={styles.addressMeta}>
                    {a.city}, {a.state} {a.zip}
                  </Text>
                  <Text style={styles.addressTypeMeta}>
                    {[a.label, addressTypeLabel(a.addressType)].filter(Boolean).join(" · ")}
                  </Text>
                </View>
                <View style={styles.addressActions}>
                  {a.isDefault ? (
                    <Text style={styles.defaultText}>Default</Text>
                  ) : (
                    <Pressable hitSlop={10} onPress={() => setDefault(a.id)}>
                      <Text style={styles.linkText}>Set default</Text>
                    </Pressable>
                  )}
                  <View style={styles.iconRow}>
                    <Pressable
                      hitSlop={10}
                      style={({ pressed }) => [styles.iconBtn, pressed && styles.iconBtnPressed]}
                      onPress={() => setFormTarget(a)}
                      accessibilityRole="button"
                      accessibilityLabel="Edit address"
                    >
                      <Ionicons name="pencil-outline" size={17} color={ios.label2} />
                    </Pressable>
                    <Pressable
                      hitSlop={10}
                      style={({ pressed }) => [styles.iconBtn, pressed && styles.iconBtnPressed]}
                      onPress={() => handleDelete(a)}
                      accessibilityRole="button"
                      accessibilityLabel="Delete address"
                    >
                      <Ionicons name="trash-outline" size={17} color={ios.system.red} />
                    </Pressable>
                  </View>
                </View>
              </View>
            ))
          )}

          {formTarget ? (
            <AddressForm
              // The cards above stay tappable while the form is open, so the edit
              // target can change under a mounted form. The field state is seeded
              // in useState initializers — remount on target change or the next
              // Save writes the previous address's values onto the new one.
              key={formTarget === "add" ? "add" : formTarget.id}
              mode={formTarget === "add" ? "add" : "edit"}
              initial={formTarget === "add" ? undefined : formTarget}
              onSubmit={(payload) => {
                if (!id) return;
                if (formTarget === "add") {
                  addMut.mutate(
                    { customerId: id, ...payload },
                    {
                      onSuccess: () => {
                        showToast("Address added");
                        setFormTarget(null);
                        refetch();
                      },
                      onError: (e: any) =>
                        showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
                    },
                  );
                } else {
                  updateMut.mutate(
                    { customerId: id, addressId: formTarget.id, ...payload },
                    {
                      onSuccess: () => {
                        showToast("Address updated");
                        setFormTarget(null);
                        refetch();
                      },
                      onError: (e: any) =>
                        showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
                    },
                  );
                }
              }}
              onCancel={() => setFormTarget(null)}
              submitting={addMut.isPending || updateMut.isPending}
            />
          ) : (
            <Pressable style={styles.addBtn} onPress={() => setFormTarget("add")}>
              <Ionicons name="add-circle-outline" size={18} color={ios.brand} />
              <Text style={styles.addBtnText}>Add address</Text>
            </Pressable>
          )}
        </View>
        <View style={{ height: 24 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

function AddressForm({
  mode,
  initial,
  onSubmit,
  onCancel,
  submitting,
}: {
  mode: "add" | "edit";
  initial?: {
    label?: string;
    line1: string;
    line2?: string;
    city: string;
    state: string;
    zip: string;
    isDefault?: boolean;
    addressType?: string;
  };
  onSubmit: (v: {
    label: string;
    line1: string;
    line2?: string;
    city: string;
    state: string;
    zip: string;
    isDefault?: boolean;
    addressType?: string;
  }) => void;
  onCancel: () => void;
  submitting?: boolean;
}) {
  const [label, setLabel] = useState(initial?.label ?? "");
  const [addressType, setAddressType] = useState(initial?.addressType ?? "BILLING");
  const [line1, setLine1] = useState(initial?.line1 ?? "");
  const [line2, setLine2] = useState(initial?.line2 ?? "");
  const [city, setCity] = useState(initial?.city ?? "");
  const [state, setState] = useState(initial?.state ?? "");
  const [zip, setZip] = useState(initial?.zip ?? "");
  const [defaultAddr, setDefault] = useState(initial?.isDefault ?? false);
  const [error, setError] = useState<string | null>(null);

  // No coordinate inputs: the server owns lat/lng (it geocodes on add and clears
  // + re-geocodes on update), and neither Create/UpdateAddressDto whitelists them
  // — the global ValidationPipe runs forbidNonWhitelisted, so sending them 400s.
  const submit = () => {
    if (!line1.trim() || !city.trim() || !state.trim() || !zip.trim()) {
      setError("Street, city, state, and ZIP are required.");
      return;
    }
    setError(null);
    onSubmit({
      label: label.trim(),
      addressType,
      line1: line1.trim(),
      line2: line2.trim() || undefined,
      city: city.trim(),
      state: state.trim(),
      zip: zip.trim(),
      isDefault: defaultAddr,
    });
  };

  return (
    <View style={styles.formWrap}>
      <FormSection title={mode === "edit" ? "Edit address" : "New address"}>
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
        <FormField label="Label">
          <FormTextInput
            value={label}
            onChangeText={setLabel}
            placeholder="Main Office, Warehouse…"
          />
        </FormField>
        <FormField label="Address type">
          <View style={styles.typeRow}>
            {ADDRESS_TYPES.map((t) => (
              <Pressable
                key={t.value}
                style={[styles.typeBtn, addressType === t.value && styles.typeBtnActive]}
                onPress={() => setAddressType(t.value)}
                accessibilityRole="button"
                accessibilityLabel={t.label}
                accessibilityState={{ selected: addressType === t.value }}
              >
                <Text
                  style={[styles.typeBtnText, addressType === t.value && styles.typeBtnTextActive]}
                >
                  {t.label}
                </Text>
              </Pressable>
            ))}
          </View>
        </FormField>
        <FormField label="Street">
          <FormTextInput value={line1} onChangeText={setLine1} placeholder="123 Harbor Way" />
        </FormField>
        <FormField label="Line 2">
          <FormTextInput value={line2} onChangeText={setLine2} placeholder="Unit, suite…" />
        </FormField>
        <FormField label="City">
          <FormTextInput value={city} onChangeText={setCity} />
        </FormField>
        <View style={{ flexDirection: "row", gap: 10 }}>
          <View style={{ flex: 1 }}>
            <FormField label="State">
              <FormTextInput value={state} onChangeText={setState} autoCapitalize="characters" />
            </FormField>
          </View>
          <View style={{ flex: 1 }}>
            <FormField label="ZIP">
              <FormTextInput value={zip} onChangeText={setZip} keyboardType="number-pad" />
            </FormField>
          </View>
        </View>
        <Pressable
          style={styles.checkbox}
          onPress={() => setDefault((d) => !d)}
          hitSlop={8}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: defaultAddr }}
        >
          <Ionicons
            name={defaultAddr ? "checkbox" : "square-outline"}
            size={20}
            color={defaultAddr ? ios.brand : ios.label2}
          />
          <Text style={styles.checkboxLabel}>Set as default delivery address</Text>
        </Pressable>
      </FormSection>

      <View style={styles.formActions}>
        <Pressable style={[styles.btn, styles.btnSecondary]} onPress={onCancel}>
          <Text style={styles.btnSecondaryText}>Cancel</Text>
        </Pressable>
        <Pressable
          style={[styles.btn, styles.btnPrimary, submitting && { opacity: 0.5 }]}
          onPress={submit}
          disabled={submitting}
        >
          <Text style={styles.btnPrimaryText}>{submitting ? "Saving…" : "Save"}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center" },
  empty: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    padding: 20,
    textAlign: "center",
  },
  addressCard: {
    backgroundColor: ios.bgElev,
    borderRadius: 12,
    padding: 14,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
  },
  addressLine: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.label },
  addressMeta: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  addressTypeMeta: { fontSize: 11, fontFamily: "Inter_500Medium", color: ios.label3, marginTop: 4 },
  addressActions: { alignItems: "flex-end", gap: 8 },
  defaultText: { fontSize: 12, fontFamily: "Inter_600SemiBold", color: ios.brand },
  linkText: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.brand },
  iconRow: { flexDirection: "row", gap: 4 },
  iconBtn: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: ios.fill3,
  },
  iconBtnPressed: { opacity: 0.6 },
  addBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: ios.brandWash,
    borderRadius: 12,
    paddingVertical: 14,
  },
  addBtnText: { color: ios.brand, fontSize: 15, fontFamily: "Inter_600SemiBold" },
  formWrap: { gap: 12 },
  formActions: { flexDirection: "row", gap: 10 },
  btn: { flex: 1, borderRadius: 12, paddingVertical: 12, alignItems: "center" },
  btnPrimary: { backgroundColor: ios.brand },
  btnPrimaryText: { color: "#fff", fontSize: 15, fontFamily: "Inter_600SemiBold" },
  btnSecondary: { backgroundColor: ios.fill3 },
  btnSecondaryText: { color: ios.label, fontSize: 15, fontFamily: "Inter_600SemiBold" },
  checkbox: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 6 },
  checkboxLabel: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.label },
  errorText: { fontSize: 12, fontFamily: "Inter_500Medium", color: ios.system.redInk },
  typeRow: { flexDirection: "row", gap: 8 },
  typeBtn: {
    flex: 1,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
    paddingHorizontal: 8,
    backgroundColor: ios.fill3,
  },
  typeBtnActive: { backgroundColor: ios.brand },
  typeBtnText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    textAlign: "center",
  },
  typeBtnTextActive: { color: "#fff" },
});
