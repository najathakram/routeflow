import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { BrandGlyph } from "@routeflow/ui/mobile/ios";

const FEATURES = [
  {
    icon: "clipboard-outline" as const,
    title: "Order Management",
    body: "Receive and manage orders from all your customers in one place.",
  },
  {
    icon: "git-branch-outline" as const,
    title: "Route Planning",
    body: "Build optimised delivery routes, assign drivers, and track every stop.",
  },
  {
    icon: "receipt-outline" as const,
    title: "Smart Invoicing",
    body: "Invoices generate automatically when a delivery is signed off.",
  },
  {
    icon: "car-outline" as const,
    title: "Delivery Tracking",
    body: "Live driver tracking, proof of delivery, and automatic notifications.",
  },
];

const STEPS = [
  {
    number: 1,
    title: "Set Up",
    body: "Add products, pricing, and invite customers to their portal.",
  },
  { number: 2, title: "Manage", body: "Receive orders, build routes, and dispatch drivers." },
  { number: 3, title: "Deliver", body: "Track runs live, capture proof of delivery, get paid." },
];

const STATS = [
  { label: "Efficient", sub: "Optimised routes save drivers hours every week" },
  { label: "Connected", sub: "Customers order from their portal, any time" },
  { label: "Scalable", sub: "From 10 customers to 10,000 — grows with you" },
];

export default function LandingScreen() {
  const router = useRouter();

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {/* ── Hero ──────────────────────────────────────────────────────── */}
        <LinearGradient
          colors={["#0f1b2d", "#152238", "#1a2d4a"]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.hero}
        >
          {/* Badge */}
          <View style={styles.badge}>
            <Ionicons name="flash-outline" size={12} color="#93c5fd" />
            <Text style={styles.badgeText}>Built for wholesale distributors and jobbers</Text>
          </View>

          {/* Logo */}
          <LinearGradient
            colors={[ios.brandGradient[0]!, ios.brandGradient[1]!, ios.brandGradient[2]!]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.logoBox}
          >
            <BrandGlyph />
          </LinearGradient>

          <Text style={styles.wordmark}>RouteFlow</Text>

          <Text style={styles.heroHeadline}>
            Deliver smarter.{"\n"}
            <Text style={styles.heroAccent}>Scale faster.</Text>
          </Text>

          <Text style={styles.heroSub}>
            Orders, routes, drivers, invoices, and customers — all in one place. Less chasing, less
            guessing, more delivering.
          </Text>

          {/* CTAs */}
          <View style={styles.heroActions}>
            <Pressable style={styles.primaryBtn} onPress={() => router.push("/(auth)/sign-in")}>
              <LinearGradient
                colors={[ios.brandGradient[0]!, ios.brandGradient[1]!, ios.brandGradient[2]!]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
                style={styles.primaryBtnGradient}
              >
                <Text style={styles.primaryBtnText}>Get Started</Text>
                <Ionicons name="arrow-forward" size={16} color="#fff" />
              </LinearGradient>
            </Pressable>

            <Pressable
              style={styles.ghostBtn}
              onPress={() => router.push("/(auth)/customer-login")}
            >
              <Text style={styles.ghostBtnText}>I'm a Buyer</Text>
            </Pressable>
          </View>

          <View style={styles.trustRow}>
            {["Built for delivery teams", "No setup fees", "Cancel anytime"].map((t) => (
              <View key={t} style={styles.trustItem}>
                <Ionicons name="checkmark-circle" size={13} color={ios.brandGradient[1]} />
                <Text style={styles.trustText}>{t}</Text>
              </View>
            ))}
          </View>
        </LinearGradient>

        {/* ── Features ──────────────────────────────────────────────────── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Everything you need, in one place</Text>
          <Text style={styles.sectionSub}>
            From taking an order to getting paid, RouteFlow handles the whole cycle.
          </Text>

          <View style={styles.featureGrid}>
            {FEATURES.map((f) => (
              <View key={f.icon} style={styles.featureCard}>
                <View style={styles.featureIcon}>
                  <Ionicons name={f.icon} size={20} color={ios.brand} />
                </View>
                <Text style={styles.featureTitle}>{f.title}</Text>
                <Text style={styles.featureBody}>{f.body}</Text>
              </View>
            ))}
          </View>
        </View>

        {/* ── How it works ──────────────────────────────────────────────── */}
        <View style={[styles.section, styles.sectionAlt]}>
          <Text style={styles.sectionTitle}>Up and running in 3 steps</Text>

          <View style={styles.steps}>
            {STEPS.map((s, i) => (
              <View key={s.number} style={styles.stepRow}>
                <View style={styles.stepLeft}>
                  <View style={styles.stepNumber}>
                    <Text style={styles.stepNumberText}>{s.number}</Text>
                  </View>
                  {i < STEPS.length - 1 && <View style={styles.stepConnector} />}
                </View>
                <View style={styles.stepContent}>
                  <Text style={styles.stepTitle}>{s.title}</Text>
                  <Text style={styles.stepBody}>{s.body}</Text>
                </View>
              </View>
            ))}
          </View>
        </View>

        {/* ── Stats ─────────────────────────────────────────────────────── */}
        <LinearGradient
          colors={["#eff6ff", "#dbeafe"]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.statsSection}
        >
          {STATS.map((s) => (
            <View key={s.label} style={styles.statItem}>
              <Text style={styles.statLabel}>{s.label}</Text>
              <Text style={styles.statSub}>{s.sub}</Text>
            </View>
          ))}
        </LinearGradient>

        {/* ── Footer CTA ────────────────────────────────────────────────── */}
        <LinearGradient colors={["#0f1b2d", "#152238"]} style={styles.footerCta}>
          <Text style={styles.footerCtaTitle}>
            Ready to run your rounds like the best in the business?
          </Text>
          <Text style={styles.footerCtaSub}>
            Talk to us about a tenant for your delivery business. No setup fees.
          </Text>
          <Pressable
            style={styles.footerCtaBtn}
            onPress={() =>
              Linking.openURL("mailto:hello@routeflow.info?subject=RouteFlow%20demo%20request")
            }
          >
            <Text style={styles.footerCtaBtnText}>Request a demo</Text>
          </Pressable>
        </LinearGradient>

        {/* ── Footer note ───────────────────────────────────────────────── */}
        <View style={styles.footer}>
          <Text style={styles.footerNote}>RouteFlow · Fleet & delivery platform</Text>
          <Text style={styles.footerNote}>
            © {new Date().getFullYear()} RouteFlow. All rights reserved.
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#0f1b2d" },
  scroll: { flexGrow: 1 },

  // ── Hero
  hero: {
    paddingHorizontal: 24,
    paddingTop: 36,
    paddingBottom: 48,
    alignItems: "center",
  },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderColor: "rgba(147,197,253,0.25)",
    backgroundColor: "rgba(255,255,255,0.06)",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 100,
    marginBottom: 28,
  },
  badgeText: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: "#93c5fd",
  },
  logoBox: {
    width: 80,
    height: 80,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: ios.brand,
    shadowOffset: { width: 0, height: 14 },
    shadowOpacity: 0.45,
    shadowRadius: 24,
    elevation: 14,
    marginBottom: 20,
  },
  wordmark: {
    fontSize: 28,
    fontFamily: "Inter_700Bold",
    color: "#fff",
    letterSpacing: -1,
    marginBottom: 16,
  },
  heroHeadline: {
    fontSize: 36,
    fontFamily: "Inter_700Bold",
    color: "#fff",
    letterSpacing: -1.2,
    textAlign: "center",
    lineHeight: 44,
  },
  heroAccent: {
    color: ios.brand,
  },
  heroSub: {
    marginTop: 16,
    fontSize: 16,
    fontFamily: "Inter_400Regular",
    color: "rgba(191,219,254,0.8)",
    textAlign: "center",
    lineHeight: 24,
    letterSpacing: -0.2,
    paddingHorizontal: 8,
  },
  heroActions: {
    width: "100%",
    gap: 12,
    marginTop: 32,
  },
  primaryBtn: {
    width: "100%",
    borderRadius: 16,
    overflow: "hidden",
    shadowColor: ios.brand,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.4,
    shadowRadius: 16,
    elevation: 8,
  },
  primaryBtnGradient: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 17,
  },
  primaryBtnText: {
    fontSize: 17,
    fontFamily: "Inter_600SemiBold",
    color: "#fff",
    letterSpacing: -0.2,
  },
  ghostBtn: {
    width: "100%",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.18)",
    backgroundColor: "rgba(255,255,255,0.06)",
    paddingVertical: 16,
    alignItems: "center",
  },
  ghostBtnText: {
    fontSize: 17,
    fontFamily: "Inter_500Medium",
    color: "#fff",
    letterSpacing: -0.2,
  },
  trustRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
    marginTop: 24,
    justifyContent: "center",
  },
  trustItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  trustText: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: "rgba(191,219,254,0.7)",
  },

  // ── Sections
  section: {
    paddingHorizontal: 24,
    paddingVertical: 40,
    backgroundColor: ios.bg,
  },
  sectionAlt: {
    backgroundColor: ios.bgElev,
  },
  sectionTitle: {
    fontSize: 24,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    letterSpacing: -0.8,
    textAlign: "center",
    marginBottom: 8,
  },
  sectionSub: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    textAlign: "center",
    lineHeight: 21,
    marginBottom: 28,
  },

  // ── Features grid (2 columns)
  featureGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
  },
  featureCard: {
    width: "48%",
    backgroundColor: ios.bgElev,
    borderRadius: 16,
    padding: 16,
    gap: 8,
  },
  featureIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: ios.brandWash,
    alignItems: "center",
    justifyContent: "center",
  },
  featureTitle: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    letterSpacing: -0.2,
  },
  featureBody: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    lineHeight: 17,
  },

  // ── Steps
  steps: {
    marginTop: 8,
    gap: 0,
  },
  stepRow: {
    flexDirection: "row",
    gap: 16,
  },
  stepLeft: {
    alignItems: "center",
    width: 40,
  },
  stepNumber: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: ios.brand,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: ios.brand,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },
  stepNumberText: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: "#fff",
  },
  stepConnector: {
    width: 2,
    flex: 1,
    backgroundColor: ios.brandWash,
    marginVertical: 4,
    minHeight: 24,
  },
  stepContent: {
    flex: 1,
    paddingBottom: 28,
  },
  stepTitle: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    letterSpacing: -0.2,
    marginTop: 8,
  },
  stepBody: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    marginTop: 4,
    lineHeight: 19,
  },

  // ── Stats
  statsSection: {
    paddingHorizontal: 24,
    paddingVertical: 36,
    gap: 24,
  },
  statItem: {
    alignItems: "center",
  },
  statLabel: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    color: ios.brand,
    letterSpacing: -0.6,
  },
  statSub: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    textAlign: "center",
    marginTop: 4,
    lineHeight: 18,
  },

  // ── Footer CTA
  footerCta: {
    paddingHorizontal: 24,
    paddingVertical: 48,
    alignItems: "center",
    gap: 12,
  },
  footerCtaTitle: {
    fontSize: 24,
    fontFamily: "Inter_700Bold",
    color: "#fff",
    letterSpacing: -0.8,
    textAlign: "center",
    lineHeight: 32,
  },
  footerCtaSub: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "rgba(191,219,254,0.75)",
    textAlign: "center",
    lineHeight: 21,
  },
  footerCtaBtn: {
    marginTop: 8,
    backgroundColor: "#fff",
    borderRadius: 16,
    paddingVertical: 16,
    paddingHorizontal: 40,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.2,
    shadowRadius: 12,
    elevation: 6,
  },
  footerCtaBtnText: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    color: "#0f1b2d",
    letterSpacing: -0.2,
  },

  // ── Footer
  footer: {
    paddingHorizontal: 24,
    paddingVertical: 24,
    backgroundColor: ios.bg,
    alignItems: "center",
    gap: 4,
  },
  footerNote: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: ios.label3,
  },
});
