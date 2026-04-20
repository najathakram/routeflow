import { StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import {
  IosEmptyState,
  NavBackButton,
  NavBar,
} from "@routeflow/ui/mobile/ios";

// Exceptions queue has no backing endpoint yet (/exceptions TBD). Show an
// honest empty state instead of the hi-fi mockup's demo incidents.
export default function ExceptionsScreen() {
  const router = useRouter();
  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        largeTitle="Exceptions"
        inlineTitle="Needs attention"
        leading={<NavBackButton label="More" onPress={() => router.back()} />}
      />
      <View style={{ flex: 1 }}>
        <IosEmptyState
          icon={<Ionicons name="checkmark-circle-outline" size={40} color={ios.label2} />}
          title="No exceptions"
          subtitle="When late routes, refused deliveries, or short-picks need your attention they'll appear here."
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
});
