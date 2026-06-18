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
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import axios from "axios";

const BASE_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:3000";

export default function ForgotPasswordScreen() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async () => {
    const trimmed = email.trim().toLowerCase();
    if (!trimmed) {
      setError("Please enter your email address.");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      await axios.post(`${BASE_URL}/api/v1/auth/request-password-reset`, { email: trimmed });
      setDone(true);
    } catch {
      // Always show success to prevent enumeration
      setDone(true);
    } finally {
      setLoading(false);
    }
  };

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

        <Text style={styles.title}>Reset password</Text>
        <Text style={styles.subtitle}>
          Enter the email address for your account and we'll send a reset link.
        </Text>

        {done ? (
          <View style={styles.successBox}>
            <Ionicons name="checkmark-circle" size={36} color={ios.system?.greenInk ?? "#16a34a"} />
            <Text style={styles.successTitle}>Check your email</Text>
            <Text style={styles.successBody}>
              If that address is registered, you'll receive a password reset link shortly.
            </Text>
            <TouchableOpacity style={styles.backToLoginBtn} onPress={() => router.back()}>
              <Text style={styles.backToLoginText}>Back to sign in</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.form}>
            {error ? (
              <View style={styles.errorBanner}>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ) : null}

            <View style={styles.fieldBlock}>
              <Text style={styles.fieldLabel}>EMAIL</Text>
              <TextInput
                value={email}
                onChangeText={setEmail}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                style={styles.input}
                placeholder="you@example.com"
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
                <Text style={styles.submitLabel}>Send reset link</Text>
              )}
            </TouchableOpacity>
          </View>
        )}
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
  submitLabel: {
    fontSize: 17,
    fontFamily: "Inter_600SemiBold",
    color: "#ffffff",
    letterSpacing: -0.2,
  },
  successBox: { alignItems: "center", paddingTop: 24, gap: 16 },
  successTitle: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    letterSpacing: -0.5,
  },
  successBody: {
    fontSize: 16,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    textAlign: "center",
    lineHeight: 22,
  },
  backToLoginBtn: {
    marginTop: 8,
    backgroundColor: ios.brand,
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 32,
  },
  backToLoginText: { fontSize: 16, fontFamily: "Inter_600SemiBold", color: "#ffffff" },
});
