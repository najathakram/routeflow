import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { BrandGlyph } from "@routeflow/ui/mobile/ios";

export default function SignInScreen() {
  const router = useRouter();

  return (
    <SafeAreaView style={styles.safe}>
      <Pressable style={styles.backBtn} onPress={() => router.back()} hitSlop={8}>
        <Ionicons name="chevron-back" size={22} color={ios.brand} />
        <Text style={styles.backText}>Back</Text>
      </Pressable>

      <View style={styles.container}>
        <LinearGradient
          colors={[ios.brandGradient[0]!, ios.brandGradient[1]!, ios.brandGradient[2]!]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.logoBox}
        >
          <BrandGlyph />
        </LinearGradient>

        <Text style={styles.title}>Sign in</Text>
        <Text style={styles.subtitle}>Choose how you'd like to continue.</Text>

        <View style={styles.cards}>
          {/* Staff / Driver */}
          <Pressable
            style={styles.card}
            onPress={() => router.push("/(auth)/company-code")}
          >
            <View style={[styles.cardIcon, { backgroundColor: ios.brandWash }]}>
              <Ionicons name="business-outline" size={22} color={ios.brand} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.cardTitle}>Staff & Drivers</Text>
              <Text style={styles.cardBody}>
                Sign in with your company code and username.
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={ios.gray[3]} />
          </Pressable>

          {/* Customer Portal */}
          <Pressable
            style={styles.card}
            onPress={() => router.push("/(auth)/customer-login")}
          >
            <View style={[styles.cardIcon, { backgroundColor: ios.system.purpleWash }]}>
              <Ionicons name="storefront-outline" size={22} color={ios.system.purpleInk} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.cardTitle}>Customer Portal</Text>
              <Text style={styles.cardBody}>
                Sign in with your buyer account email.
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={ios.gray[3]} />
          </Pressable>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  backBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    paddingHorizontal: 20,
    paddingTop: 12,
  },
  backText: { fontSize: 17, fontFamily: "Inter_400Regular", color: ios.brand },
  container: {
    flex: 1,
    paddingHorizontal: 28,
    paddingTop: 32,
  },
  logoBox: {
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
    marginBottom: 24,
  },
  title: {
    fontSize: 34,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    letterSpacing: -1.2,
  },
  subtitle: {
    fontSize: 17,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    marginTop: 6,
    marginBottom: 36,
    letterSpacing: -0.2,
  },
  cards: { gap: 12 },
  card: {
    backgroundColor: ios.bgElev,
    borderRadius: 16,
    padding: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
  },
  cardIcon: {
    width: 48,
    height: 48,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  cardTitle: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    letterSpacing: -0.2,
  },
  cardBody: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    marginTop: 3,
    lineHeight: 18,
  },
});
