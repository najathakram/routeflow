import { useEffect, useMemo, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { MobileButton, MobileInput } from "@routeflow/ui/mobile";
import { changePassword, refreshTokens, setPassword } from "../../lib/auth";
import { apiClient } from "../../lib/api-client";
import { useAuthStore } from "../../lib/auth-store";
import { buildPasswordSchema, type PasswordFormValues } from "../../lib/password-form";

export default function ForceChangePasswordScreen() {
  const setUser = useAuthStore((s) => s.setUser);
  const logout = useAuthStore((s) => s.logout);
  const [apiError, setApiError] = useState<string | null>(null);
  // A temp-password account normally knows its current password, but if the
  // account somehow has NONE (Google-only), demanding one is an inescapable
  // trap — offer set mode instead. Change mode until /users/me answers.
  const [hasPassword, setHasPassword] = useState(true);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .get<{ hasPassword?: boolean }>("/users/me")
      .then(({ data }) => {
        if (!cancelled && typeof data.hasPassword === "boolean") setHasPassword(data.hasPassword);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const schema = useMemo(() => buildPasswordSchema(hasPassword ? "change" : "set"), [hasPassword]);
  const {
    control,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<PasswordFormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      currentPassword: "",
      newPassword: "",
      confirmPassword: "",
    },
  });

  const onSubmit = async (data: PasswordFormValues) => {
    setApiError(null);
    try {
      if (hasPassword) await changePassword(data.currentPassword, data.newPassword);
      else await setPassword(data.newPassword);
      // Refresh tokens to get a new JWT with forcePasswordChange: false
      const refreshed = await refreshTokens();
      if (refreshed) {
        // Updating store triggers _layout.tsx to route to the correct tab group
        setUser(refreshed.user);
      }
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
        "Failed to change password.";
      setApiError(typeof msg === "string" ? msg : "Failed to change password.");
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header}>
          <Text style={styles.title}>Set New Password</Text>
          <Text style={styles.subtitle}>You must change your password before continuing.</Text>
        </View>

        <View style={styles.form}>
          {apiError && (
            <View style={styles.errorBanner}>
              <Text style={styles.errorText}>{apiError}</Text>
            </View>
          )}

          {hasPassword && (
            <Controller
              control={control}
              name="currentPassword"
              render={({ field: { onChange, onBlur, value } }) => (
                <MobileInput
                  label="Current Password"
                  value={value}
                  onChangeText={onChange}
                  onBlur={onBlur}
                  secureTextEntry
                  error={errors.currentPassword?.message}
                />
              )}
            />
          )}

          <Controller
            control={control}
            name="newPassword"
            render={({ field: { onChange, onBlur, value } }) => (
              <MobileInput
                label="New Password"
                value={value}
                onChangeText={onChange}
                onBlur={onBlur}
                secureTextEntry
                error={errors.newPassword?.message}
              />
            )}
          />

          <Controller
            control={control}
            name="confirmPassword"
            render={({ field: { onChange, onBlur, value } }) => (
              <MobileInput
                label="Confirm New Password"
                value={value}
                onChangeText={onChange}
                onBlur={onBlur}
                secureTextEntry
                error={errors.confirmPassword?.message}
              />
            )}
          />

          <MobileButton
            onPress={handleSubmit(onSubmit)}
            loading={isSubmitting}
            size="lg"
            style={styles.submitButton}
          >
            Set New Password
          </MobileButton>

          {/* Escape hatch — never trap a user who can't produce the current
              password (e.g. an admin reset they never received). */}
          <TouchableOpacity onPress={() => void logout()} activeOpacity={0.7}>
            <Text style={styles.signOutText}>Sign out</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: "#fff",
  },
  container: {
    flexGrow: 1,
    justifyContent: "center",
    paddingHorizontal: 24,
    paddingVertical: 40,
  },
  header: {
    alignItems: "center",
    marginBottom: 40,
  },
  title: {
    fontSize: 26,
    fontFamily: "Inter_700Bold",
    color: "#1B3A5C",
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
    textAlign: "center",
  },
  form: {
    gap: 16,
  },
  errorBanner: {
    backgroundColor: "#fef2f2",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  errorText: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "#dc2626",
  },
  submitButton: {
    marginTop: 8,
  },
  signOutText: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: "#64748b",
    textAlign: "center",
    marginTop: 16,
    textDecorationLine: "underline",
  },
});
