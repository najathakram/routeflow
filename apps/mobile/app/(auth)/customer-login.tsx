import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
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
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { BrandGlyph } from "@routeflow/ui/mobile/ios";
import { buyerLogin, getBuyerSellers, setActiveSeller, type BuyerSeller } from "../../lib/buyer-auth";
import { useBuyerSessionStore } from "../../lib/buyer-session-store";

export default function CustomerLoginScreen() {
  const router = useRouter();
  const { setBuyer, setActiveSeller: storeSetSeller } = useBuyerSessionStore();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onLogin = async () => {
    if (!email.trim()) { setError("Email is required."); return; }
    if (!password) { setError("Password is required."); return; }

    setError(null);
    setLoading(true);

    try {
      const res = await buyerLogin(email.trim().toLowerCase(), password);
      setBuyer(res.buyer);

      const sellers = await getBuyerSellers();

      if (sellers.length === 0) {
        setError("Your account is not connected to any supplier. Ask your supplier to send you a portal invite.");
        setLoading(false);
        return;
      }

      if (sellers.length === 1) {
        await storeSetSeller(sellers[0]!);
        router.replace("/(customer)/orders");
        return;
      }

      // Multiple sellers — show picker
      showSellerPicker(sellers);
    } catch (e: any) {
      const msg = e?.response?.data?.message ?? e?.message ?? "Login failed.";
      setError(typeof msg === "string" ? msg : "Login failed.");
    } finally {
      setLoading(false);
    }
  };

  const showSellerPicker = (sellers: BuyerSeller[]) => {
    Alert.alert(
      "Select supplier",
      "Choose which supplier to connect to:",
      [
        ...sellers.map((s) => ({
          text: s.tenant.name,
          onPress: async () => {
            await storeSetSeller(s);
            router.replace("/(customer)/orders");
          },
        })),
        { text: "Cancel", style: "cancel" },
      ],
      { cancelable: true },
    );
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
        </View>

        <View style={{ flex: 1 }} />

        <Text style={styles.footer}>
          Don't have an account?{" "}
          <Text style={styles.footerLink}>
            Ask your supplier for a portal invite.
          </Text>
        </Text>
      </ScrollView>
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
  signInLabel: { fontSize: 17, fontFamily: "Inter_600SemiBold", color: "#ffffff", letterSpacing: -0.2 },
  footer: { textAlign: "center", fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 24 },
  footerLink: { color: ios.brand, fontFamily: "Inter_500Medium" },
});
