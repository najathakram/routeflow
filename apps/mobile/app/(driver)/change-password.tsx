import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { router, Stack } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { MobileButton, MobileInput } from "@routeflow/ui/mobile";
import { changePassword } from "../../lib/auth";

const schema = z
  .object({
    currentPassword: z.string().min(1, "Current password is required"),
    newPassword: z
      .string()
      .min(8, "Must be at least 8 characters")
      .regex(/[A-Z]/, "Must contain an uppercase letter")
      .regex(/[0-9]/, "Must contain a number"),
    confirmPassword: z.string().min(1, "Please confirm your new password"),
  })
  .refine((d) => d.newPassword === d.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

type ChangePasswordForm = z.infer<typeof schema>;

export default function DriverChangePasswordScreen() {
  const [apiError, setApiError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const {
    control,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<ChangePasswordForm>({
    resolver: zodResolver(schema),
    defaultValues: {
      currentPassword: "",
      newPassword: "",
      confirmPassword: "",
    },
  });

  const onSubmit = async (data: ChangePasswordForm) => {
    setApiError(null);
    setSuccess(false);
    try {
      await changePassword(data.currentPassword, data.newPassword);
      reset();
      setSuccess(true);
      // Navigate back after a short delay so the user sees the confirmation
      setTimeout(() => router.back(), 1800);
    } catch (err: any) {
      const msg =
        err?.response?.data?.message ?? "Failed to change password.";
      setApiError(typeof msg === "string" ? msg : "Failed to change password.");
    }
  };

  return (
    <>
      <Stack.Screen
        options={{ title: "Change Password", headerBackTitle: "Profile" }}
      />
      <ScrollView
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.form}>
          {success && (
            <View style={styles.successBanner}>
              <Ionicons name="checkmark-circle" size={20} color="#065f46" />
              <Text style={styles.successText}>Password updated successfully!</Text>
            </View>
          )}
          {apiError && (
            <Text style={styles.apiError}>{apiError}</Text>
          )}
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
            Update Password
          </MobileButton>
        </View>
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    paddingHorizontal: 24,
    paddingTop: 24,
    paddingBottom: 40,
    backgroundColor: "#fff",
  },
  form: {
    gap: 16,
  },
  submitButton: {
    marginTop: 8,
  },
  apiError: {
    color: "#DC2626",
    fontSize: 14,
    textAlign: "center" as const,
    marginBottom: 4,
  },
  successBanner: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 8,
    backgroundColor: "#d1fae5",
    borderRadius: 10,
    padding: 14,
  },
  successText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: "#065f46",
    flex: 1,
  },
});
