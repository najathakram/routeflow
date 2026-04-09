import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { MobileButton, MobileInput } from "@routeflow/ui/mobile";
import { useTenantStore } from "../../lib/tenant-store";

const API_BASE =
  (process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:3000").replace(/\/$/, "") + "/api/v1";

const schema = z.object({
  companyCode: z
    .string()
    .min(3, "Company code must be at least 3 characters")
    .max(30, "Company code is too long")
    .regex(/^[a-z0-9][a-z0-9-]*$/, "Company code may only contain lowercase letters, numbers, and hyphens"),
});

type CompanyCodeForm = z.infer<typeof schema>;

export default function CompanyCodeScreen() {
  const router = useRouter();
  const setSlug = useTenantStore((s) => s.setSlug);
  const [apiError, setApiError] = useState<string | null>(null);

  const {
    control,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<CompanyCodeForm>({
    resolver: zodResolver(schema),
    defaultValues: { companyCode: "" },
  });

  const onSubmit = async ({ companyCode }: CompanyCodeForm) => {
    setApiError(null);
    const slug = companyCode.toLowerCase().trim();

    try {
      const res = await fetch(
        `${API_BASE}/public/tenants/${encodeURIComponent(slug)}/branding`,
      );

      if (!res.ok) {
        if (res.status === 404) {
          setApiError("Company code not found. Check with your administrator.");
        } else {
          setApiError("Unable to verify company code. Please try again.");
        }
        return;
      }

      const branding = await res.json();
      await setSlug(slug, branding);
      // Navigate to login; _layout.tsx will allow it now that slug is set
      router.replace("/(auth)/login");
    } catch {
      setApiError("Network error. Please check your connection and try again.");
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
          <Text style={styles.tagline}>Enter your company code to continue.</Text>
        </View>

        <View style={styles.form}>
          {apiError && (
            <View style={styles.errorBanner}>
              <Text style={styles.errorText}>{apiError}</Text>
            </View>
          )}

          <Controller
            control={control}
            name="companyCode"
            render={({ field: { onChange, onBlur, value } }) => (
              <MobileInput
                label="Company Code"
                placeholder="e.g. acme-logistics"
                value={value}
                onChangeText={(v) => onChange(v.toLowerCase())}
                onBlur={onBlur}
                keyboardType="default"
                autoCapitalize="none"
                autoCorrect={false}
                error={errors.companyCode?.message}
              />
            )}
          />

          <MobileButton
            onPress={handleSubmit(onSubmit)}
            loading={isSubmitting}
            size="lg"
            style={styles.submitButton}
          >
            {isSubmitting ? (
              <ActivityIndicator color="#fff" />
            ) : (
              "Continue"
            )}
          </MobileButton>
        </View>

        <Text style={styles.hint}>
          {"Don't know your company code? Contact your RouteFlow administrator."}
        </Text>
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
  hint: {
    marginTop: 32,
    textAlign: "center",
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
  },
});
