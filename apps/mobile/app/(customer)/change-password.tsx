import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavBackButton, NavBar } from "@routeflow/ui/mobile/ios";
import { buyerApiClient } from "../../lib/buyer-auth";
import { showToast } from "../../lib/toast";

export default function CustomerChangePasswordScreen() {
  const router = useRouter();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [loading, setLoading] = useState(false);

  const onSave = async () => {
    if (!current || !next) {
      showToast("Both fields required");
      return;
    }
    if (next.length < 8) {
      showToast("New password must be at least 8 characters");
      return;
    }
    setLoading(true);
    try {
      await buyerApiClient.post("/buyer/auth/change-password", {
        currentPassword: current,
        newPassword: next,
      });
      showToast("Password changed");
      router.back();
    } catch (e: any) {
      showToast(e?.response?.data?.message ?? "Could not change password.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Change Password"
        leading={<NavBackButton label="Back" onPress={() => router.back()} />}
      />
      <View style={styles.section}>
        <View style={styles.card}>
          <View style={styles.field}>
            <Text style={styles.label}>Current password</Text>
            <TextInput
              value={current}
              onChangeText={setCurrent}
              secureTextEntry
              style={styles.input}
              placeholderTextColor={ios.label3}
              placeholder="••••••••"
            />
          </View>
          <View style={[styles.field, { borderBottomWidth: 0 }]}>
            <Text style={styles.label}>New password</Text>
            <TextInput
              value={next}
              onChangeText={setNext}
              secureTextEntry
              style={styles.input}
              placeholderTextColor={ios.label3}
              placeholder="Min 8 characters"
            />
          </View>
        </View>
        <Pressable
          style={[styles.saveBtn, loading && { opacity: 0.6 }]}
          onPress={onSave}
          disabled={loading}
        >
          <Text style={styles.saveBtnText}>{loading ? "Saving…" : "Save password"}</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  section: { padding: 16, gap: 12 },
  card: { backgroundColor: ios.bgElev, borderRadius: 12, overflow: "hidden" },
  field: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: ios.separator,
    gap: 4,
  },
  label: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    letterSpacing: 0.3,
    textTransform: "uppercase",
  },
  input: { fontSize: 15, fontFamily: "Inter_400Regular", color: ios.label, paddingVertical: 4 },
  saveBtn: {
    backgroundColor: ios.brand,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: "center",
  },
  saveBtnText: { color: "#fff", fontSize: 15, fontFamily: "Inter_600SemiBold" },
});
