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

// Pick & load verification is not wired to a backend yet — no /routes/:id/picks
// endpoint exists and the barcode-scan flow hasn't been implemented. Show an
// honest empty state so tenants don't see the design's demo route.
export default function PickScreen() {
  const router = useRouter();
  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Pick & load"
        leading={<NavBackButton label="More" onPress={() => router.back()} />}
      />
      <View style={{ flex: 1 }}>
        <IosEmptyState
          icon={<Ionicons name="barcode-outline" size={40} color={ios.label2} />}
          title="Pick & load isn't live yet"
          subtitle="You'll verify items against the route manifest here once warehouse scanning is enabled for your team."
          actionLabel="Back to more"
          onActionPress={() => router.back()}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
});
