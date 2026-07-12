import { useEffect, useState } from "react";
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
  // Authoritative hasPassword read — false means this account was created via
  // Google sign-in and is setting its FIRST password (no current-password
  // field; the server independently re-verifies). Change mode until known.
  const [hasPassword, setHasPassword] = useState(true);

  useEffect(() => {
    let cancelled = false;
    buyerApiClient
      .get<{ hasPassword?: boolean }>("/buyer/auth/profile")
      .then(({ data }) => {
        if (!cancelled && typeof data.hasPassword === "boolean") setHasPassword(data.hasPassword);
      })
      .catch(() => {
        // Older API / transient failure → keep change mode (safe default).
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const onSave = async () => {
    if ((hasPassword && !current) || !next) {
      showToast(hasPassword ? "Both fields required" : "New password required");
      return;
    }
    if (next.length < 8) {
      showToast("New password must be at least 8 characters");
      return;
    }
    setLoading(true);
    try {
      if (hasPassword) {
        await buyerApiClient.post("/buyer/auth/change-password", {
          currentPassword: current,
          newPassword: next,
        });
        showToast("Password changed");
      } else {
        await buyerApiClient.post("/buyer/auth/set-password", { newPassword: next });
        showToast("Password set");
      }
      router.back();
    } catch (e: any) {
      showToast(e?.response?.data?.message ?? "Could not update password.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle={hasPassword ? "Change Password" : "Set Password"}
        leading={<NavBackButton label="Back" onPress={() => router.back()} />}
      />
      <View style={styles.section}>
        {!hasPassword ? (
          <Text style={styles.setModeHint}>
            You sign in with Google. Set a password to also sign in with your email.
          </Text>
        ) : null}
        <View style={styles.card}>
          {hasPassword ? (
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
          ) : null}
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
  setModeHint: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    lineHeight: 20,
  },
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
