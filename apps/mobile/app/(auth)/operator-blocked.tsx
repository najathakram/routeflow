import { StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { MobileButton } from "@routeflow/ui/mobile";
import { useAuthStore } from "../../lib/auth-store";

export default function OperatorBlockedScreen() {
  const logout = useAuthStore((s) => s.logout);

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.container}>
        <Ionicons name="desktop-outline" size={64} color="#94a3b8" />
        <Text style={styles.title}>Desktop Only</Text>
        <Text style={styles.message}>
          Operator access is not available on mobile. Please sign in on the web
          dashboard to manage routes and deliveries.
        </Text>
        <MobileButton
          onPress={logout}
          variant="secondary"
          size="lg"
          style={styles.button}
        >
          Sign Out
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
  button: {
    marginTop: 16,
    alignSelf: "stretch",
  },
});
