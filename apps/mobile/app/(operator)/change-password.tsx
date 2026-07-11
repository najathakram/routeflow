import { useEffect, useMemo, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { MobileButton, MobileInput } from "@routeflow/ui/mobile";
import { NavBackButton, NavBar } from "@routeflow/ui/mobile/ios";
import { ios } from "@routeflow/ui/tokens";
import { changePassword, setPassword } from "../../lib/auth";
import { apiClient } from "../../lib/api-client";
import { buildPasswordSchema, type PasswordFormValues } from "../../lib/password-form";

export default function OperatorChangePasswordScreen() {
  const [apiError, setApiError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  // Authoritative hasPassword read — false means a Google-only account setting
  // its FIRST password (no current-password field). Defaults to change mode
  // until /users/me answers; the server independently re-verifies either way.
  const [hasPassword, setHasPassword] = useState(true);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .get<{ hasPassword?: boolean }>("/users/me")
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

  const schema = useMemo(() => buildPasswordSchema(hasPassword ? "change" : "set"), [hasPassword]);
  const {
    control,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<PasswordFormValues>({
    resolver: zodResolver(schema),
    defaultValues: { currentPassword: "", newPassword: "", confirmPassword: "" },
  });

  const onSubmit = async (data: PasswordFormValues) => {
    setApiError(null);
    setSuccess(false);
    try {
      if (hasPassword) await changePassword(data.currentPassword, data.newPassword);
      else await setPassword(data.newPassword);
      reset();
      setSuccess(true);
      setHasPassword(true);
      setTimeout(() => router.back(), 1800);
    } catch (err: any) {
      const msg =
        err?.response?.data?.message ??
        (hasPassword ? "Failed to change password." : "Failed to set password.");
      setApiError(typeof msg === "string" ? msg : "Failed to update password.");
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: ios.bgElev }} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle={hasPassword ? "Change password" : "Set password"}
        leading={<NavBackButton label="Back" onPress={() => router.back()} />}
      />
      <ScrollView
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.form}>
          {!hasPassword ? (
            <Text style={styles.setModeHint}>
              You sign in with Google. Set a password to also sign in with your username.
            </Text>
          ) : null}
          {success ? (
            <View style={styles.successBanner}>
              <Ionicons name="checkmark-circle" size={20} color={ios.system.greenInk} />
              <Text style={styles.successText}>Password updated successfully!</Text>
            </View>
          ) : null}
          {apiError ? <Text style={styles.apiError}>{apiError}</Text> : null}

          {hasPassword ? (
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
          ) : null}
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
          <MobileButton onPress={handleSubmit(onSubmit)} loading={isSubmitting} size="lg">
            {hasPassword ? "Update Password" : "Set Password"}
          </MobileButton>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    paddingHorizontal: 24,
    paddingTop: 24,
    paddingBottom: 40,
  },
  form: { gap: 16 },
  setModeHint: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    lineHeight: 20,
  },
  apiError: {
    color: ios.system.redInk,
    fontSize: 14,
    textAlign: "center",
    marginBottom: 4,
  },
  successBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: ios.system.greenWash,
    borderRadius: 10,
    padding: 14,
  },
  successText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.system.greenInk,
    flex: 1,
  },
});
