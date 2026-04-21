import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { ios } from "@routeflow/ui/tokens";
import {
  NavBackButton,
  NavBar,
} from "@routeflow/ui/mobile/ios";
import {
  FormField,
  FormSection,
  FormTextInput,
} from "../../../components/FormSheet";
import {
  useBusinessSettings,
  useUpdateBusinessSettings,
} from "../../../lib/api/admin";
import { showToast } from "../../../lib/toast";

export default function SettingsScreen() {
  const router = useRouter();
  const { data, isLoading } = useBusinessSettings();
  const update = useUpdateBusinessSettings();

  const [phone, setPhone] = useState("");
  const [taxRate, setTaxRate] = useState("");
  const [city, setCity] = useState("");
  const [zip, setZip] = useState("");
  const [pushEnabled, setPushEnabled] = useState(false);

  useEffect(() => {
    if (data) {
      setPhone(data.phone ?? "");
      setTaxRate(data.taxRate != null ? String(data.taxRate) : "");
      setCity(data.city ?? "");
      setZip(data.zip ?? "");
    }
  }, [data]);

  if (isLoading) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar inlineTitle="Settings" leading={<NavBackButton onPress={() => router.back()} />} />
        <View style={styles.center}>
          <ActivityIndicator color={ios.brand} />
        </View>
      </SafeAreaView>
    );
  }

  const save = () => {
    update.mutate(
      {
        phone: phone.trim() || undefined,
        city: city.trim() || undefined,
        zip: zip.trim() || undefined,
        taxRate: taxRate.trim() ? Number(taxRate) : undefined,
      },
      {
        onSuccess: () => showToast("Settings saved"),
        onError: (e: any) =>
          Alert.alert("Couldn't save", e?.response?.data?.message ?? e?.message ?? "Try again."),
      },
    );
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        largeTitle="Settings"
        leading={<NavBackButton label="Back" onPress={() => router.back()} />}
      />
      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={{ padding: 16, gap: 18 }}>
          <View style={styles.identity}>
            <Text style={styles.identityName}>{data?.businessName ?? "Business"}</Text>
            <Text style={styles.identitySub}>{data?.email ?? ""}</Text>
          </View>

          <FormSection title="Contact">
            <FormField label="Phone">
              <FormTextInput value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
            </FormField>
          </FormSection>

          <FormSection title="Address">
            <FormField label="City">
              <FormTextInput value={city} onChangeText={setCity} />
            </FormField>
            <FormField label="ZIP">
              <FormTextInput value={zip} onChangeText={setZip} keyboardType="number-pad" />
            </FormField>
          </FormSection>

          <FormSection title="Invoicing">
            <FormField label="Default tax rate (e.g. 0.0875)">
              <FormTextInput value={taxRate} onChangeText={setTaxRate} keyboardType="decimal-pad" />
            </FormField>
          </FormSection>

          <FormSection title="Notifications">
            <View style={styles.switchRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.switchLabel}>Push notifications</Text>
                <Text style={styles.switchHint}>
                  Get alerted on new orders, exceptions, and route updates.
                </Text>
              </View>
              <Switch
                value={pushEnabled}
                onValueChange={(v) => {
                  setPushEnabled(v);
                  Alert.alert(
                    v ? "Push enabled" : "Push disabled",
                    v
                      ? "We'll register this device with the push service on your next launch."
                      : "Notifications won't be delivered to this device.",
                  );
                }}
                trackColor={{ true: ios.brand }}
              />
            </View>
          </FormSection>

          <Pressable
            style={[styles.saveBtn, update.isPending && { opacity: 0.5 }]}
            onPress={save}
            disabled={update.isPending}
          >
            <Ionicons name="save-outline" size={16} color="#fff" />
            <Text style={styles.saveBtnText}>{update.isPending ? "Saving…" : "Save changes"}</Text>
          </Pressable>
        </View>
        <View style={{ height: 24 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center" },
  identity: { backgroundColor: ios.bgElev, borderRadius: 14, padding: 16 },
  identityName: { fontSize: 18, fontFamily: "Inter_700Bold", color: ios.label },
  identitySub: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  switchRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  switchLabel: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },
  switchHint: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  saveBtn: {
    backgroundColor: ios.brand,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 14,
    borderRadius: 12,
  },
  saveBtnText: { color: "#fff", fontSize: 15, fontFamily: "Inter_600SemiBold" },
});
