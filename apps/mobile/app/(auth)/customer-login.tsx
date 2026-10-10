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
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { BrandGlyph } from "@routeflow/ui/mobile/ios";
import { OptionPickerSheet } from "../../components/OptionPickerSheet";
import {
  buyerLogin,
  buyerLoginWithGoogle,
  getBuyerSellers,
  type BuyerSeller,
  type BuyerUser,
} from "../../lib/buyer-auth";
import { useBuyerSessionStore } from "../../lib/buyer-session-store";
import { PENDING_LANDING, SELLERLESS_LANDING, postSignInStep } from "../../lib/buyer-route-guard";
import { GoogleButton } from "@routeflow/ui/mobile/ios";

export default function CustomerLoginScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ returnTo?: string }>();
  const { setBuyer, setActiveSeller: storeSetSeller } = useBuyerSessionStore();

  // BUG-B2-5: if a deep-link sent the user here, return them to that page
  // post-login. Only allow same-origin paths under /(customer) to prevent
  // open-redirect via crafted returnTo values.
  const safeReturnTo = (() => {
    const raw = typeof params.returnTo === "string" ? params.returnTo : "";
    if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return null;
    return raw;
  })();
  const postLoginTarget: any = safeReturnTo ?? "/(customer)/(tabs)/home";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingSellers, setPendingSellers] = useState<BuyerSeller[]>([]);
  const [pendingBuyer, setPendingBuyer] = useState<BuyerUser | null>(null);
  const [sellerPickerOpen, setSellerPickerOpen] = useState(false);

  const onLogin = async () => {
    if (!email.trim()) {
      setError("Email is required.");
      return;
    }
    if (!password) {
      setError("Password is required.");
      return;
    }

    setError(null);
    setLoading(true);

    try {
      const res = await buyerLogin(email.trim().toLowerCase(), password);
      await finishSignIn(res.buyer, await getBuyerSellers());
    } catch (e: any) {
      // BUG-OPS1-5: friendly message for the 429 throttle response.
      if (e?.response?.status === 429) {
        const retryAfter = e?.response?.data?.retryAfter;
        const minutes = retryAfter ? Math.max(1, Math.round(retryAfter / 60)) : 5;
        setError(
          `Too many login attempts. Please try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
        );
        setLoading(false);
        return;
      }
      const msg = e?.response?.data?.message ?? e?.message ?? "Login failed.";
      setError(typeof msg === "string" ? msg : "Login failed.");
    } finally {
      setLoading(false);
    }
  };

  const onGoogleLogin = async () => {
    setError(null);
    setGoogleLoading(true);
    try {
      // #2546: always read the links — the server's sellerCount counts ACTIVE links
      // only, and a pending-only buyer must land on the seller list, not connect.
      const { buyer } = await buyerLoginWithGoogle();
      await finishSignIn(buyer, await getBuyerSellers());
    } catch (e: any) {
      const code = (e as Error)?.message ?? "";
      if (code === "cancelled") return;
      if (code === "google_unavailable") {
        setError("Google sign-in is not available right now. Try email and password.");
      } else if (code === "unauthorized") {
        setError("No buyer account found for this Google address.");
      } else {
        setError("Google sign-in failed. Try again or use email and password.");
      }
    } finally {
      setGoogleLoading(false);
    }
  };

  // #2341: publish the buyer to the session store only once the seller outcome
  // is known. The route guards read "buyer set, no seller" as the 0-seller
  // state and send it to sellers/connect, so setting the buyer before the
  // seller would bounce a 1-seller login or a mid-pick picker to connect.
  // #2546: only an ACTIVE link may become the active seller (postSignInStep).
  const finishSignIn = async (buyer: BuyerUser, sellers: BuyerSeller[]) => {
    const step = postSignInStep(sellers);
    switch (step.kind) {
      case "connect":
      case "list":
        // Mirrors web's /buyer/portal: no usable seller yet — connect one, or
        // wait on the seller list while a request is pending.
        setBuyer(buyer);
        router.replace((step.kind === "connect" ? SELLERLESS_LANDING : PENDING_LANDING) as any);
        return;
      case "open":
        await storeSetSeller(step.seller);
        setBuyer(buyer);
        router.replace(postLoginTarget);
        return;
      case "pick":
        // Several ACTIVE sellers — hold the buyer until one is picked.
        setPendingBuyer(buyer);
        setPendingSellers(step.sellers);
        setSellerPickerOpen(true);
        return;
    }
  };

  const onSelectSeller = async (sellerId: string) => {
    const seller = pendingSellers.find((s) => s.linkId === sellerId);
    if (!seller) return;
    setSellerPickerOpen(false);
    await storeSetSeller(seller);
    if (pendingBuyer) setBuyer(pendingBuyer);
    router.replace("/(customer)/(tabs)/home");
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

        <LinearGradient
          colors={[ios.brandGradient[0]!, ios.brandGradient[1]!, ios.brandGradient[2]!]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.brandMark}
        >
          <BrandGlyph />
        </LinearGradient>

        <Text style={styles.title}>Customer Portal</Text>
        <Text style={styles.subtitle}>Sign in with your buyer account</Text>

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
            />
          </View>

          <View style={styles.fieldBlock}>
            <Text style={styles.fieldLabel}>PASSWORD</Text>
            <TextInput
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              style={styles.input}
              placeholder="••••••••"
              placeholderTextColor={ios.gray[1]}
            />
          </View>

          <TouchableOpacity
            style={[styles.signInBtn, loading && styles.signInBtnBusy]}
            onPress={onLogin}
            activeOpacity={0.85}
            disabled={loading}
          >
            {loading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.signInLabel}>Sign in</Text>
            )}
          </TouchableOpacity>

          {/* BUG-B2-7: Forgot Password? link — /forgot-password route already
              exists, was simply missing the entry point on this screen.
              audience=buyer targets the buyer reset endpoints (this is also
              how Google-created buyers claim a first password). */}
          <TouchableOpacity
            onPress={() =>
              router.push({ pathname: "/(auth)/forgot-password", params: { audience: "buyer" } })
            }
            style={{ marginTop: 14, alignSelf: "center" }}
            hitSlop={8}
          >
            <Text style={{ color: ios.brand, fontSize: 14, fontFamily: "Inter_500Medium" }}>
              Forgot password?
            </Text>
          </TouchableOpacity>

          <View style={styles.orRow}>
            <View style={styles.orLine} />
            <Text style={styles.orText}>or</Text>
            <View style={styles.orLine} />
          </View>

          <GoogleButton onPress={onGoogleLogin} loading={googleLoading} />
        </View>

        <View style={{ flex: 1 }} />

        <Text style={styles.footer}>
          Don&apos;t have an account?{" "}
          <Text style={styles.footerLink}>Ask your supplier for a portal invite.</Text>
        </Text>
      </ScrollView>

      <OptionPickerSheet
        visible={sellerPickerOpen}
        title="Select supplier"
        options={pendingSellers.map((s) => ({ id: s.linkId, label: s.tenant.name }))}
        onClose={() => setSellerPickerOpen(false)}
        onSelect={(opt) => onSelectSeller(opt.id)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bgElev },
  container: { flexGrow: 1, paddingHorizontal: 28, paddingTop: 20, paddingBottom: 20 },
  backBtn: { flexDirection: "row", alignItems: "center", gap: 2, marginBottom: 24 },
  backText: { fontSize: 17, fontFamily: "Inter_400Regular", color: ios.brand },
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
  form: { marginTop: 32, gap: 10 },
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
  signInBtn: {
    backgroundColor: ios.brand,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 14,
  },
  signInBtnBusy: { opacity: 0.7 },
  signInLabel: {
    fontSize: 17,
    fontFamily: "Inter_600SemiBold",
    color: "#ffffff",
    letterSpacing: -0.2,
  },
  footer: {
    textAlign: "center",
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    marginTop: 24,
  },
  footerLink: { color: ios.brand, fontFamily: "Inter_500Medium" },
  orRow: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 6 },
  orLine: { flex: 1, height: 1, backgroundColor: ios.separator },
  orText: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label3 },
});
