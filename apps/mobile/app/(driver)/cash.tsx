import { StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { ios } from "@routeflow/ui/tokens";
import { IosEmptyState, NavBar } from "@routeflow/ui/mobile/ios";

// End-of-day cash-up isn't live yet — no /driver/cash-up endpoint, no
// denomination tracking in the schema. Show an honest empty state instead
// of the hi-fi mockup's $2,184 demo reconciliation.
export default function CashUpScreen() {
  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar largeTitle="Cash up" inlineTitle="End of day" />
      <View style={{ flex: 1 }}>
        <IosEmptyState
          icon={<Ionicons name="wallet-outline" size={40} color={ios.label2} />}
          title="End-of-day cash-up is coming soon"
          subtitle="You'll reconcile cash, cheques and card totals against your manifest here once dispatch turns it on for your depot."
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
});
