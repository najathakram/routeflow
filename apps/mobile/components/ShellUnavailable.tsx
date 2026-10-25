import { StyleSheet, Text, View } from "react-native";
import { ios } from "@routeflow/ui/tokens";

/**
 * W-830 runtime fail-closed: a store build whose web URL is missing or unusable cannot load the
 * new web screens. It shows this instead of falling back to the old native buyer and staff
 * screens. Drivers and the sign-in screens are not affected (lib/web-shell shellBlocksRoute).
 */
export const SHELL_UNAVAILABLE_TITLE = "Update RouteFlow";
export const SHELL_UNAVAILABLE_BODY =
  "This version of the app can't open your account. Update RouteFlow from the App Store or Google Play, then open it again.";

export function ShellUnavailable() {
  return (
    <View style={styles.root} accessibilityRole="alert">
      <Text style={styles.title}>{SHELL_UNAVAILABLE_TITLE}</Text>
      <Text style={styles.body}>{SHELL_UNAVAILABLE_BODY}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
    backgroundColor: ios.bg,
  },
  title: {
    fontSize: 22,
    fontWeight: "700",
    color: ios.label,
    marginBottom: 8,
    textAlign: "center",
  },
  body: { fontSize: 16, color: ios.label2, textAlign: "center", lineHeight: 22 },
});
