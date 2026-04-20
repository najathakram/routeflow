import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { ios } from "@routeflow/ui/tokens";
import { BrandGlyph, GoogleButton } from "@routeflow/ui/mobile/ios";
import { useAuthStore } from "../../lib/auth-store";
import { useTenantStore } from "../../lib/tenant-store";

const schema = z.object({
  username: z.string().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
});

type LoginForm = z.infer<typeof schema>;

function BrandMark() {
  return (
    <LinearGradient
      colors={[ios.brandGradient[0]!, ios.brandGradient[1]!, ios.brandGradient[2]!]}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={styles.brandMark}
    >
      <BrandGlyph />
    </LinearGradient>
  );
}

export default function LoginScreen() {
  const login = useAuthStore((s) => s.login);
  const loginWithGoogle = useAuthStore((s) => s.loginWithGoogle);
  const tenantSlug = useTenantStore((s) => s.slug);
  const tenantBranding = useTenantStore((s) => s.branding);
  const [apiError, setApiError] = useState<string | null>(null);
  const [rememberMe, setRememberMe] = useState(true);
  const [googleLoading, setGoogleLoading] = useState(false);

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
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
        "Invalid username or password.";
      setApiError(typeof msg === "string" ? msg : "Login failed.");
    }
  };

  const onGoogle = async () => {
    if (!tenantSlug) {
      setApiError("Company code required before Google sign-in.");
      return;
    }
    setApiError(null);
    setGoogleLoading(true);
    try {
      await loginWithGoogle(tenantSlug);
    } catch (err: unknown) {
      const code = (err as Error)?.message ?? "unknown_error";
      if (code === "cancelled") {
        // user dismissed — no banner
      } else if (code === "unauthorized" || code === "google_email_is_staff") {
        setApiError("This Google account is not authorised for this company.");
      } else if (code === "google_unavailable") {
        setApiError("Google sign-in is not available for this company.");
      } else {
        setApiError("Google sign-in failed. Try again or use your username and password.");
      }
    } finally {
      setGoogleLoading(false);
    }
  };

  const subtitle = tenantBranding?.businessName
    ? `Sign in to RouteFlow · ${tenantBranding.businessName}`
    : "Sign in to RouteFlow";

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <BrandMark />

        <Text style={styles.title}>Welcome back</Text>
        <Text style={styles.subtitle}>{subtitle}</Text>

        <View style={styles.form}>
          {apiError ? (
            <View style={styles.errorBanner}>
              <Text style={styles.errorText}>{apiError}</Text>
            </View>
          ) : null}

          <View style={styles.fieldBlock}>
            <Text style={styles.fieldLabel}>USERNAME</Text>
            <Controller
              control={control}
              name="username"
              render={({ field: { onChange, onBlur, value } }) => (
                <TextInput
                  value={value}
                  onChangeText={onChange}
                  onBlur={onBlur}
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={[styles.input, errors.username && styles.inputError]}
                  placeholder="jordan.m"
                  placeholderTextColor={ios.gray[1]}
                />
              )}
            />
            {errors.username ? <Text style={styles.fieldError}>{errors.username.message}</Text> : null}
          </View>

          <View style={styles.fieldBlock}>
            <Text style={styles.fieldLabel}>PASSWORD</Text>
            <Controller
              control={control}
              name="password"
              render={({ field: { onChange, onBlur, value } }) => (
                <TextInput
                  value={value}
                  onChangeText={onChange}
                  onBlur={onBlur}
                  secureTextEntry
                  style={[styles.input, errors.password && styles.inputError]}
                  placeholder="••••••••"
                  placeholderTextColor={ios.gray[1]}
                />
              )}
            />
            {errors.password ? <Text style={styles.fieldError}>{errors.password.message}</Text> : null}
          </View>

          <View style={styles.optionsRow}>
            <TouchableOpacity
              style={styles.rememberRow}
              onPress={() => setRememberMe((v) => !v)}
              activeOpacity={0.7}
            >
              <View style={[styles.checkbox, rememberMe && styles.checkboxOn]}>
                {rememberMe ? <Text style={styles.checkmark}>✓</Text> : null}
              </View>
              <Text style={styles.rememberText}>Remember me</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() =>
                Alert.alert(
                  "Reset your password",
                  "Please contact your dispatcher to reset your password. Self-serve reset is coming soon.",
                )
              }
              activeOpacity={0.7}
            >
              <Text style={styles.forgotText}>Forgot?</Text>
            </TouchableOpacity>
          </View>

          <TouchableOpacity
            style={[styles.signInBtn, isSubmitting && styles.signInBtnBusy]}
            onPress={handleSubmit(onSubmit)}
            activeOpacity={0.85}
            disabled={isSubmitting}
          >
            <Text style={styles.signInLabel}>{isSubmitting ? "Signing in…" : "Sign in"}</Text>
          </TouchableOpacity>

          <View style={styles.orRow}>
            <View style={styles.orLine} />
            <Text style={styles.orText}>or</Text>
            <View style={styles.orLine} />
          </View>

          <GoogleButton onPress={onGoogle} loading={googleLoading} />
        </View>

        <View style={{ flex: 1 }} />

        <TouchableOpacity
          onPress={() =>
            Alert.alert(
              "New to RouteFlow?",
              "Your dispatcher can set up your account and give you your company code. Self-serve onboarding is coming soon.",
            )
          }
          activeOpacity={0.7}
        >
          <Text style={styles.footer}>
            New driver? <Text style={styles.footerLink}>Get setup code</Text>
          </Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: ios.bgElev,
  },
  container: {
    flexGrow: 1,
    paddingHorizontal: 28,
    paddingTop: 48,
    paddingBottom: 20,
  },
  brandMark: {
    width: 72,
    height: 72,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: ios.brand,
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.35,
    shadowRadius: 24,
    elevation: 12,
  },
  title: {
    fontSize: 34,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    letterSpacing: -1.2,
    lineHeight: 40,
    marginTop: 20,
  },
  subtitle: {
    fontSize: 17,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    marginTop: 6,
    letterSpacing: -0.2,
  },
  form: {
    marginTop: 32,
    gap: 10,
  },
  errorBanner: {
    backgroundColor: ios.system.redWash,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  errorText: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: ios.system.redInk,
  },
  fieldBlock: {
    gap: 6,
  },
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
  inputError: {
    backgroundColor: ios.system.redWash,
  },
  fieldError: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: ios.system.redInk,
    paddingLeft: 4,
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
    borderColor: ios.gray[3],
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxOn: {
    backgroundColor: ios.brand,
    borderColor: ios.brand,
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
    color: ios.label,
  },
  forgotText: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: ios.brand,
  },
  signInBtn: {
    backgroundColor: ios.brand,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 14,
  },
  signInBtnBusy: {
    opacity: 0.7,
  },
  signInLabel: {
    fontSize: 17,
    fontFamily: "Inter_600SemiBold",
    color: "#ffffff",
    letterSpacing: -0.2,
  },
  orRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginVertical: 12,
  },
  orLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: ios.separator,
  },
  orText: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  footer: {
    textAlign: "center",
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    marginTop: 24,
  },
  footerLink: {
    color: ios.brand,
    fontFamily: "Inter_500Medium",
  },
});
