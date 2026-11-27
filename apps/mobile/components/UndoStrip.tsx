import { Pressable, StyleSheet, Text, View } from "react-native";
import { ios } from "@routeflow/ui/tokens";

/**
 * B1395 (SA-1283 part 2): the "Removed <name>. Undo" strip a buyer screen shows after a line leaves the list by "-"
 * at one, a typed 0 or an emptied box. The caller keeps the removed row and puts it back on `onUndo`.
 */
export function UndoStrip({ name, onUndo }: { name: string; onUndo: () => void }) {
  return (
    <View style={styles.strip}>
      <Text style={styles.text} numberOfLines={1}>
        Removed {name}.
      </Text>
      <Pressable onPress={onUndo} hitSlop={8} accessibilityRole="button">
        <Text style={styles.undo}>Undo</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  strip: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    marginHorizontal: 16,
    marginTop: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: ios.fill,
  },
  text: { flex: 1, fontSize: 14, color: ios.label },
  undo: { fontSize: 14, fontWeight: "700", color: ios.brand },
});
