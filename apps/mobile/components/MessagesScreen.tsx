import { StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { IosEmptyState, NavBackButton, NavBar } from "@routeflow/ui/mobile/ios";

// Dispatcher ↔ driver messaging isn't wired yet — no /messages endpoint or
// websocket feed. Show an honest empty state instead of the hi-fi mockup's
// demo threads from "Jamie" and "Luna Roastery".
export function MessagesScreen() {
  const router = useRouter();
  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Messages"
        leading={<NavBackButton onPress={() => router.back()} />}
      />
      <View style={{ flex: 1 }}>
        <IosEmptyState
          icon={<Ionicons name="chatbubbles-outline" size={40} color={ios.label2} />}
          title="Messaging is coming soon"
          subtitle="You'll coordinate with dispatch and other drivers from here once in-app messaging is enabled."
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
});
