import { StyleSheet, Text, View } from "react-native";
import { ios } from "@routeflow/ui/tokens";
import { styles } from "./styles";

// Moved verbatim out of NewOrderScreen.tsx (size ratchet).
export function RowSpacer() {
  return <View style={styles.rowSpacer} />;
}

/** Separator label between the on-this-order section and the catalogue. */
export function CatalogSectionLabel({ label }: { label: string }) {
  return (
    <View style={sectionStyles.wrap}>
      <Text style={sectionStyles.text}>{label.toUpperCase()}</Text>
      <View style={sectionStyles.rule} />
    </View>
  );
}

const sectionStyles = StyleSheet.create({
  wrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingTop: 6,
    paddingBottom: 2,
  },
  text: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    letterSpacing: 0.6,
  },
  rule: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: ios.separator },
});
