import { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavBackButton, NavBar } from "@routeflow/ui/mobile/ios";
import {
  FormField,
  FormSection,
  FormTextInput,
} from "../../../../components/FormSheet";
import {
  useAddCustomerAddress,
  useCustomer,
  useUpdateCustomerAddress,
} from "../../../../lib/api/customers";
import { showToast } from "../../../../lib/toast";

export default function ManageAddressesScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: customer, isLoading, refetch } = useCustomer(id ?? "");
  const addMut = useAddCustomerAddress();
  const updateMut = useUpdateCustomerAddress();
  const [showAdd, setShowAdd] = useState(false);

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
        onError: (e: any) =>
          showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
      },
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
                <View style={{ flex: 1 }}>
                  <Text style={styles.addressLine}>{a.line1}</Text>
                  {a.line2 ? <Text style={styles.addressLine}>{a.line2}</Text> : null}
                  <Text style={styles.addressMeta}>
                    {a.city}, {a.state} {a.zip}
                  </Text>
                </View>
                {a.isDefault ? (
                  <Text style={styles.defaultText}>Default</Text>
                ) : (
                  <Pressable onPress={() => setDefault(a.id)}>
                    <Text style={styles.linkText}>Set default</Text>
                  </Pressable>
                )}
              </View>
            ))
          )}

          {showAdd ? (
            <AddAddressForm
              onSubmit={(payload) => {
                if (!id) return;
                addMut.mutate(
                  { customerId: id, ...payload },
                  {
                    onSuccess: () => {
                      showToast("Address added");
                      setShowAdd(false);
                      refetch();
                    },
                    onError: (e: any) =>
                      showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
                  },
                );
              }}
              onCancel={() => setShowAdd(false)}
              submitting={addMut.isPending}
            />
          ) : (
            <Pressable style={styles.addBtn} onPress={() => setShowAdd(true)}>
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

function AddAddressForm({
  onSubmit,
  onCancel,
  submitting,
}: {
  onSubmit: (v: { line1: string; line2?: string; city: string; state: string; zip: string; lat?: number; lng?: number; isDefault?: boolean }) => void;
  onCancel: () => void;
  submitting?: boolean;
}) {
  const [line1, setLine1] = useState("");
  const [line2, setLine2] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [zip, setZip] = useState("");
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");
  const [defaultAddr, setDefault] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    if (!line1.trim() || !city.trim() || !state.trim() || !zip.trim()) {
      setError("Street, city, state, and ZIP are required.");
      return;
    }
    const latN = lat.trim() ? Number(lat) : undefined;
    const lngN = lng.trim() ? Number(lng) : undefined;
    if ((lat.trim() && !Number.isFinite(latN)) || (lng.trim() && !Number.isFinite(lngN))) {
      setError("Coordinates must be numeric.");
      return;
    }
    setError(null);
    onSubmit({
      line1: line1.trim(),
      line2: line2.trim() || undefined,
      city: city.trim(),
      state: state.trim(),
      zip: zip.trim(),
      lat: latN,
      lng: lngN,
      isDefault: defaultAddr,
    });
  };

  return (
    <View style={styles.formWrap}>
      <FormSection title="New address">
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
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
        <View style={{ flexDirection: "row", gap: 10 }}>
          <View style={{ flex: 1 }}>
            <FormField label="Latitude">
              <FormTextInput value={lat} onChangeText={setLat} keyboardType="numbers-and-punctuation" placeholder="37.7749" />
            </FormField>
          </View>
          <View style={{ flex: 1 }}>
            <FormField label="Longitude">
              <FormTextInput value={lng} onChangeText={setLng} keyboardType="numbers-and-punctuation" placeholder="-122.4194" />
            </FormField>
          </View>
        </View>
        <Pressable style={styles.checkbox} onPress={() => setDefault((d) => !d)}>
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
  empty: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label2, padding: 20, textAlign: "center" },
  addressCard: {
    backgroundColor: ios.bgElev,
    borderRadius: 12,
    padding: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  addressLine: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.label },
  addressMeta: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  defaultText: { fontSize: 12, fontFamily: "Inter_600SemiBold", color: ios.brand },
  linkText: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.brand },
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
});
