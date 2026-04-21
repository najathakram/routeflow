import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { BrandGlyph } from "@routeflow/ui/mobile/ios";

const FEATURES = [
  {
    icon: "git-branch-outline" as const,
    title: "Route management",
    body: "Plan, dispatch, and track deliveries in real time.",
  },
  {
    icon: "storefront-outline" as const,
    title: "Customer portal",
    body: "Buyers can browse your catalog and place orders 24/7.",
  },
  {
    icon: "receipt-outline" as const,
    title: "Invoicing & finance",
    body: "AI-scanned vendor bills, expenses, and instant PDF invoices.",
  },
  {
    icon: "wifi-outline" as const,
    title: "Works offline",
    body: "Drivers can complete stops without a signal. Syncs automatically.",
  },
];

export default function LandingScreen() {
  const router = useRouter();

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        {/* Hero */}
        <View style={styles.hero}>
          <LinearGradient
            colors={[ios.brandGradient[0]!, ios.brandGradient[1]!, ios.brandGradient[2]!]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.logoBox}
          >
            <BrandGlyph />
          </LinearGradient>

          <Text style={styles.wordmark}>RouteFlow</Text>
          <Text style={styles.tagline}>
            Delivery management,{"\n"}built for the modern fleet.
          </Text>
        </View>

        {/* Feature list */}
        <View style={styles.features}>
          {FEATURES.map((f) => (
            <View key={f.icon} style={styles.featureRow}>
              <View style={styles.featureIcon}>
                <Ionicons name={f.icon} size={20} color={ios.brand} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.featureTitle}>{f.title}</Text>
                <Text style={styles.featureBody}>{f.body}</Text>
              </View>
            </View>
          ))}
        </View>

        {/* CTA */}
        <View style={styles.actions}>
          <Pressable
            style={styles.primaryBtn}
            onPress={() => router.push("/(auth)/sign-in")}
          >
            <LinearGradient
              colors={[ios.brandGradient[0]!, ios.brandGradient[1]!, ios.brandGradient[2]!]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={styles.primaryBtnGradient}
            >
              <Text style={styles.primaryBtnText}>Sign in</Text>
              <Ionicons name="arrow-forward" size={17} color="#fff" />
            </LinearGradient>
          </Pressable>

          <Text style={styles.footerNote}>
            RouteFlow · Fleet & delivery platform
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  scroll: { flexGrow: 1, paddingHorizontal: 28, paddingTop: 40, paddingBottom: 32 },

  hero: { alignItems: "center", paddingTop: 20, paddingBottom: 40 },
  logoBox: {
    width: 88,
    height: 88,
    borderRadius: 26,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: ios.brand,
    shadowOffset: { width: 0, height: 16 },
    shadowOpacity: 0.4,
    shadowRadius: 28,
    elevation: 14,
    marginBottom: 24,
  },
  wordmark: {
    fontSize: 38,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    letterSpacing: -1.4,
  },
  tagline: {
    marginTop: 10,
    fontSize: 17,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    textAlign: "center",
    lineHeight: 25,
    letterSpacing: -0.2,
  },

  features: { gap: 20, marginBottom: 48 },
  featureRow: { flexDirection: "row", gap: 14, alignItems: "flex-start" },
  featureIcon: {
    width: 44,
    height: 44,
    borderRadius: 13,
    backgroundColor: ios.brandWash,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  featureTitle: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    letterSpacing: -0.2,
  },
  featureBody: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    marginTop: 3,
    lineHeight: 18,
  },

  actions: { gap: 16, alignItems: "center" },
  primaryBtn: {
    width: "100%",
    borderRadius: 16,
    overflow: "hidden",
    shadowColor: ios.brand,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.35,
    shadowRadius: 16,
    elevation: 8,
  },
  primaryBtnGradient: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 17,
    paddingHorizontal: 24,
  },
  primaryBtnText: {
    fontSize: 17,
    fontFamily: "Inter_600SemiBold",
    color: "#fff",
    letterSpacing: -0.2,
  },
  footerNote: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: ios.label3,
    marginTop: 8,
  },
});
