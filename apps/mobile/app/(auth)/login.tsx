import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { MobileButton, MobileInput } from "@routeflow/ui/mobile";
import { useAuthStore } from "../../lib/auth-store";

const TEAL = "#0b6e6b";

const schema = z.object({
  username: z.string().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
});

type LoginForm = z.infer<typeof schema>;

export default function LoginScreen() {
  const login = useAuthStore((s) => s.login);
  const [apiError, setApiError] = useState<string | null>(null);
  const [rememberMe, setRememberMe] = useState(true);

  const {
    control,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginForm>({
    resolver: zodResolver(schema),
    defaultValues: { username: "", password: "" },
  });

  const onSubmit = async (data: LoginForm) => {
    setApiError(null);
    try {
      await login(data.username, data.password);
      // _layout.tsx handles routing based on role / forcePasswordChange
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { message?: string } } })?.response?.data
          ?.message ?? "Invalid username or password.";
      setApiError(typeof msg === "string" ? msg : "Login failed.");
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Brand mark */}
        <View style={styles.brandMark}>
          <Text style={styles.brandInitials}>RF</Text>
        </View>

        <Text style={styles.title}>Welcome back</Text>
        <Text style={styles.subtitle}>Sign in to RouteFlow</Text>

        <View style={styles.form}>
          {apiError && (
            <View style={styles.errorBanner}>
              <Text style={styles.errorText}>{apiError}</Text>
            </View>
          )}

          <View style={styles.fieldBlock}>
            <Text style={styles.fieldLabel}>USERNAME</Text>
            <Controller
              control={control}
              name="username"
              render={({ field: { onChange, onBlur, value } }) => (
                <MobileInput
                  value={value}
                  onChangeText={onChange}
                  onBlur={onBlur}
                  keyboardType="default"
                  autoCapitalize="none"
                  autoCorrect={false}
                  error={errors.username?.message}
                />
              )}
            />
          </View>

          <View style={styles.fieldBlock}>
            <Text style={styles.fieldLabel}>PASSWORD</Text>
            <Controller
              control={control}
              name="password"
              render={({ field: { onChange, onBlur, value } }) => (
                <MobileInput
                  value={value}
                  onChangeText={onChange}
                  onBlur={onBlur}
                  secureTextEntry
                  error={errors.password?.message}
                />
              )}
            />
          </View>

          <View style={styles.optionsRow}>
            <TouchableOpacity
              style={styles.rememberRow}
              onPress={() => setRememberMe((v) => !v)}
              activeOpacity={0.7}
            >
              <View style={[styles.checkbox, rememberMe && styles.checkboxOn]}>
                {rememberMe && (
                  <Text style={styles.checkmark}>✓</Text>
                )}
              </View>
              <Text style={styles.rememberText}>Remember me</Text>
            </TouchableOpacity>
            <Text style={styles.forgotText}>Forgot?</Text>
          </View>

          <MobileButton
            onPress={handleSubmit(onSubmit)}
            loading={isSubmitting}
            size="lg"
            style={styles.signInBtn}
          >
            Sign in
          </MobileButton>

          <View style={styles.orRow}>
            <View style={styles.orLine} />
            <Text style={styles.orText}>or</Text>
            <View style={styles.orLine} />
          </View>

          <TouchableOpacity style={styles.googleBtn} activeOpacity={0.85}>
            <View style={styles.googleLogoWrap}>
              <Text style={styles.googleLogoG}>G</Text>
            </View>
            <Text style={styles.googleBtnText}>Sign in with Google</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.footer}>
          New driver?{" "}
          <Text style={styles.footerLink}>Get setup code</Text>
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: "#ffffff",
  },
  container: {
    flexGrow: 1,
    paddingHorizontal: 28,
    paddingTop: 48,
    paddingBottom: 32,
  },
  brandMark: {
    width: 72,
    height: 72,
    borderRadius: 22,
    backgroundColor: TEAL,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: TEAL,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.35,
    shadowRadius: 16,
    elevation: 8,
    marginBottom: 20,
  },
  brandInitials: {
    fontSize: 26,
    fontFamily: "Inter_700Bold",
    color: "#ffffff",
    letterSpacing: -0.5,
  },
  title: {
    fontSize: 34,
    fontFamily: "Inter_700Bold",
    color: "#000000",
    letterSpacing: -1.2,
    lineHeight: 40,
  },
  subtitle: {
    fontSize: 17,
    fontFamily: "Inter_400Regular",
    color: "#636366",
    marginTop: 6,
    letterSpacing: -0.2,
    marginBottom: 32,
  },
  form: {
    gap: 12,
  },
  errorBanner: {
    backgroundColor: "#fee2e2",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  errorText: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "#dc2626",
  },
  fieldBlock: {
    gap: 6,
  },
  fieldLabel: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: "#636366",
    letterSpacing: 0.8,
    textTransform: "uppercase",
    paddingLeft: 2,
  },
  optionsRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 2,
    marginTop: 2,
  },
  rememberRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: "#c7c7cc",
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxOn: {
    backgroundColor: TEAL,
    borderColor: TEAL,
  },
  checkmark: {
    color: "#ffffff",
    fontSize: 11,
    fontFamily: "Inter_700Bold",
    lineHeight: 14,
  },
  rememberText: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "#000000",
  },
  forgotText: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: TEAL,
  },
  signInBtn: {
    marginTop: 4,
  },
  orRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginVertical: 4,
  },
  orLine: {
    flex: 1,
    height: 0.5,
    backgroundColor: "#c7c7cc",
  },
  orText: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: "#8e8e93",
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  googleBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#dadce0",
    borderRadius: 12,
    paddingVertical: 14,
    shadowColor: "#000000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 3,
    elevation: 1,
  },
  googleLogoWrap: {
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  googleLogoG: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: "#4285F4",
    lineHeight: 20,
  },
  googleBtnText: {
    fontSize: 16,
    fontFamily: "Inter_500Medium",
    color: "#3c4043",
  },
  footer: {
    textAlign: "center",
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "#8e8e93",
    marginTop: 36,
  },
  footerLink: {
    color: TEAL,
    fontFamily: "Inter_500Medium",
  },
});
