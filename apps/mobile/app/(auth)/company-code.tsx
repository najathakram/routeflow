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
import { LinearGradient } from "expo-linear-gradient";
import { useRouter } from "expo-router";
import { MobileButton, MobileInput } from "@routeflow/ui/mobile";
import { BrandGlyph } from "@routeflow/ui/mobile/ios";
import { ios } from "@routeflow/ui/tokens";
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
        <LinearGradient
          colors={[ios.brandGradient[0]!, ios.brandGradient[1]!, ios.brandGradient[2]!]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.brandMark}
        >
          <BrandGlyph />
        </LinearGradient>
        <Text style={styles.title}>RouteFlow</Text>
        <Text style={styles.tagline}>Enter your company code to continue.</Text>

        <View style={styles.form}>
          {apiError ? (
            <View style={styles.errorBanner}>
              <Text style={styles.errorText}>{apiError}</Text>
            </View>
          ) : null}

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
            {isSubmitting ? <ActivityIndicator color="#fff" /> : "Continue"}
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
  safe: { flex: 1, backgroundColor: ios.bgElev },
  container: {
    flexGrow: 1,
    justifyContent: "center",
    paddingHorizontal: 28,
    paddingVertical: 40,
  },
  brandMark: {
    width: 72,
    height: 72,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "center",
    marginBottom: 20,
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
    textAlign: "center",
  },
  tagline: {
    marginTop: 6,
    fontSize: 17,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    textAlign: "center",
    marginBottom: 32,
  },
  form: { gap: 16 },
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
  submitButton: { marginTop: 8 },
  hint: {
    marginTop: 32,
    textAlign: "center",
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
  },
});
