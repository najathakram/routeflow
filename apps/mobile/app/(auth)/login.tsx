import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { MobileButton, MobileInput } from "@routeflow/ui/mobile";
import { useAuthStore } from "../../lib/auth-store";

const schema = z.object({
  username: z.string().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
});

type LoginForm = z.infer<typeof schema>;

export default function LoginScreen() {
  const login = useAuthStore((s) => s.login);
  const [apiError, setApiError] = useState<string | null>(null);

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
      >
        <View style={styles.logoContainer}>
          <Text style={styles.logoText}>RouteFlow</Text>
          <Text style={styles.tagline}>Delivery management, simplified.</Text>
        </View>

        <View style={styles.form}>
          {apiError && (
            <View style={styles.errorBanner}>
              <Text style={styles.errorText}>{apiError}</Text>
            </View>
          )}

          <Controller
            control={control}
            name="username"
            render={({ field: { onChange, onBlur, value } }) => (
              <MobileInput
                label="Username"
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

          <Controller
            control={control}
            name="password"
            render={({ field: { onChange, onBlur, value } }) => (
              <MobileInput
                label="Password"
                value={value}
                onChangeText={onChange}
                onBlur={onBlur}
                secureTextEntry
                error={errors.password?.message}
              />
            )}
          />

          <MobileButton
            onPress={handleSubmit(onSubmit)}
            loading={isSubmitting}
            size="lg"
            style={styles.submitButton}
          >
            Sign In
          </MobileButton>
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
  logoContainer: {
    alignItems: "center",
    marginBottom: 48,
  },
  logoText: {
    fontSize: 32,
    fontFamily: "Inter_700Bold",
    color: "#1B3A5C",
    letterSpacing: -0.5,
  },
  tagline: {
    marginTop: 6,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
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
});
