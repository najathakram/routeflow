import { StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { IosEmptyState } from "@routeflow/ui/mobile/ios";

// Live driver GPS + route polyline isn't wired yet — no /routes/live endpoint.
// Show an honest empty state instead of the hi-fi mockup's fake roads + the
// "Harbor Café" destination card.
export default function DriverMapScreen() {
  const router = useRouter();
  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <View style={{ flex: 1 }}>
        <IosEmptyState
          icon={<Ionicons name="map-outline" size={44} color={ios.brand} />}
          title="Live map is coming soon"
          subtitle="Once GPS tracking is enabled for your fleet you'll see the active route, next stop, and traffic right here."
          actionLabel="Back to route"
          onActionPress={() => router.replace("/(driver)/route")}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
});
