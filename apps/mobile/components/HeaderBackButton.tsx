import { Pressable } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { colors } from "@routeflow/ui/tokens";

/**
 * Consistent left-arrow back button used across all stack navigators.
 * Calls router.back() which pops back to wherever the user came from.
 */
export function HeaderBackButton() {
  return (
    <Pressable
      onPress={() => router.back()}
      style={{ paddingLeft: 4, paddingRight: 12, paddingVertical: 8 }}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel="Go back"
    >
      <Ionicons name="arrow-back" size={24} color={colors.navy.DEFAULT} />
    </Pressable>
  );
}
