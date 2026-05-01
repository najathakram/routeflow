import { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter, useLocalSearchParams } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import axios from "axios";

const BASE_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:3000";

export default function ResetPasswordScreen() {
  const router = useRouter();
  const { token } = useLocalSearchParams<{ token?: string }>();

  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async () => {
    if (!token) {
      setError("Reset link is missing or invalid. Please request a new one.");
      return;
    }
    if (newPassword.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (newPassword !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      await axios.post(`${BASE_URL}/api/v1/auth/reset-password`, {
        token,
        newPassword,
      });
      setDone(true);
    } catch (e: any) {
      const msg =
        e?.response?.data?.message ??
        "Reset failed. The link may have expired — please request a new one.";
      setError(typeof msg === "string" ? msg : "Reset failed.");
    } finally {
      setLoading(false);
    }
  };

  if (done) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.doneContainer}>
          <Ionicons name="checkmark-circle" size={56} color={ios.system?.greenInk ?? "#16a34a"} />
          <Text style={styles.doneTitle}>Password reset</Text>
          <Text style={styles.doneBody}>
            Your password has been updated. Please log in with your new password.
          </Text>
          <TouchableOpacity
            style={styles.loginBtn}
            onPress={() => router.replace("/(auth)/login")}
            activeOpacity={0.85}
          >
            <Text style={styles.loginBtnText}>Go to sign in</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Pressable style={styles.backBtn} onPress={() => router.back()} hitSlop={8}>
          <Ionicons name="chevron-back" size={22} color={ios.brand} />
          <Text style={styles.backText}>Back</Text>
        </Pressable>

        <Text style={styles.title}>New password</Text>
        <Text style={styles.subtitle}>
          Choose a strong password — at least 8 characters with uppercase, lowercase, and a number
          or symbol.
        </Text>

        <View style={styles.form}>
          {error ? (
            <View style={styles.errorBanner}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          <View style={styles.fieldBlock}>
            <Text style={styles.fieldLabel}>NEW PASSWORD</Text>
            <TextInput
              value={newPassword}
              onChangeText={setNewPassword}
              secureTextEntry
              style={styles.input}
              placeholder="••••••••"
              placeholderTextColor={ios.gray[1]}
              editable={!loading}
            />
          </View>

          <View style={styles.fieldBlock}>
            <Text style={styles.fieldLabel}>CONFIRM PASSWORD</Text>
            <TextInput
              value={confirm}
              onChangeText={setConfirm}
              secureTextEntry
              style={styles.input}
              placeholder="••••••••"
              placeholderTextColor={ios.gray[1]}
              editable={!loading}
            />
          </View>

          <TouchableOpacity
            style={[styles.submitBtn, loading && styles.submitBtnBusy]}
            onPress={onSubmit}
            activeOpacity={0.85}
            disabled={loading}
          >
            {loading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.submitLabel}>Reset password</Text>
            )}
          </TouchableOpacity>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bgElev },
  container: { flexGrow: 1, paddingHorizontal: 28, paddingTop: 20, paddingBottom: 40 },
  backBtn: { flexDirection: "row", alignItems: "center", gap: 2, marginBottom: 32 },
  backText: { fontSize: 17, fontFamily: "Inter_400Regular", color: ios.brand },
  title: {
    fontSize: 34,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    letterSpacing: -1.2,
    lineHeight: 40,
  },
  subtitle: {
    fontSize: 16,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    marginTop: 8,
    marginBottom: 36,
    lineHeight: 22,
  },
  form: { gap: 12 },
  errorBanner: {
    backgroundColor: ios.system.redWash,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  errorText: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.system.redInk },
  fieldBlock: { gap: 6 },
  fieldLabel: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    letterSpacing: 0.8,
    textTransform: "uppercase",
    paddingLeft: 2,
  },
  input: {
    backgroundColor: ios.fill3,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 14,
    fontSize: 17,
    fontFamily: "Inter_400Regular",
    color: ios.label,
  },
  submitBtn: {
    backgroundColor: ios.brand,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 8,
  },
  submitBtnBusy: { opacity: 0.7 },
  submitLabel: { fontSize: 17, fontFamily: "Inter_600SemiBold", color: "#ffffff", letterSpacing: -0.2 },
  doneContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
    gap: 16,
  },
  doneTitle: { fontSize: 28, fontFamily: "Inter_700Bold", color: ios.label, letterSpacing: -0.8 },
  doneBody: {
    fontSize: 16,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    textAlign: "center",
    lineHeight: 22,
  },
  loginBtn: {
    marginTop: 8,
    backgroundColor: ios.brand,
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 40,
  },
  loginBtnText: { fontSize: 17, fontFamily: "Inter_600SemiBold", color: "#ffffff" },
});
