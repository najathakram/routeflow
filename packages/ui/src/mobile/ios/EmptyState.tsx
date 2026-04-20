import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { ios } from "../../tokens";

export interface IosEmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  subtitle?: string;
  actionLabel?: string;
  onActionPress?: () => void;
}

/** iOS-styled empty state — used for screens whose backend isn't wired yet
 *  and for genuinely-empty lists (no routes, no exceptions, etc.). */
export function IosEmptyState({
  icon,
  title,
  subtitle,
  actionLabel,
  onActionPress,
}: IosEmptyStateProps) {
  return (
    <View style={styles.container}>
      {icon ? <View style={styles.iconWrap}>{icon}</View> : null}
      <Text style={styles.title}>{title}</Text>
      {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
      {actionLabel ? (
        <Pressable onPress={onActionPress} style={styles.button}>
          <Text style={styles.buttonText}>{actionLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
    paddingVertical: 48,
    gap: 8,
  },
  iconWrap: {
    marginBottom: 8,
    opacity: 0.55,
  },
  title: {
    fontSize: 17,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    textAlign: "center",
    letterSpacing: -0.2,
  },
  subtitle: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    textAlign: "center",
    lineHeight: 20,
    maxWidth: 320,
  },
  button: {
    backgroundColor: ios.brand,
    borderRadius: 14,
    paddingHorizontal: 20,
    paddingVertical: 12,
    marginTop: 12,
  },
  buttonText: {
    color: "#fff",
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
  },
});
