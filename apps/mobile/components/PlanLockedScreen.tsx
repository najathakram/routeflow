import { StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { MobileButton } from "@routeflow/ui/mobile";

/**
 * Lite-L2 (WP11): rendered in place of a gated operator route-group's `<Stack>` when
 * `planLockedSection` (lib/plan-flags.ts) denies the section — a structural clone of
 * `app/(auth)/operator-blocked.tsx` (same anatomy, new copy): SafeAreaView -> centered
 * column, 64px Ionicons icon, title, message, one MobileButton. Colors are the same
 * literals operator-blocked.tsx already uses — no new tokens introduced.
 *
 * `onBack` defaults to `router.back()` (billing is web-only, so there is no "See plans"
 * equivalent here — just a way out); pass it explicitly only where a caller needs to
 * override or test that navigation.
 */
export function PlanLockedScreen({ planName, onBack }: { planName: string; onBack?: () => void }) {
  const router = useRouter();
  const back = onBack ?? (() => router.back());

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.container}>
        <Ionicons name="lock-closed-outline" size={64} color="#94a3b8" />
        <Text style={styles.title}>Not on your plan</Text>
        <Text style={styles.message}>This feature isn't included in the {planName} plan.</Text>
        <Text style={styles.secondary}>Manage your plan on the web dashboard.</Text>
        <MobileButton onPress={back} variant="secondary" size="lg" style={styles.button}>
          Go back
        </MobileButton>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: "#fff",
  },
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
    gap: 16,
  },
  title: {
    fontSize: 24,
    fontFamily: "Inter_700Bold",
    color: "#1B3A5C",
    marginTop: 8,
  },
  message: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
    textAlign: "center",
    lineHeight: 22,
  },
  secondary: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
    textAlign: "center",
  },
  button: {
    marginTop: 16,
    alignSelf: "stretch",
  },
});
