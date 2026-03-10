import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { colors } from "../tokens";

export interface ScreenHeaderProps {
  title: string;
  rightIcon?: React.ReactNode;
  onRightPress?: () => void;
}

export function ScreenHeader({ title, rightIcon, onRightPress }: ScreenHeaderProps) {
  const navigation = useNavigation();
  const canGoBack = navigation.canGoBack();

  return (
    <View style={styles.container}>
      <View style={styles.left}>
        {canGoBack ? (
          <Pressable
            onPress={() => navigation.goBack()}
            hitSlop={12}
            style={styles.backButton}
            accessibilityLabel="Go back"
            accessibilityRole="button"
          >
            <Text style={styles.backArrow}>←</Text>
          </Pressable>
        ) : null}
      </View>

      <Text style={styles.title} numberOfLines={1}>
        {title}
      </Text>

      <View style={styles.right}>
        {rightIcon ? (
          <Pressable
            onPress={onRightPress}
            hitSlop={12}
            accessibilityRole="button"
          >
            {rightIcon}
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    height: 52,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    backgroundColor: "#fff",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.surface.border,
  },
  left: {
    width: 44,
    alignItems: "flex-start",
  },
  right: {
    width: 44,
    alignItems: "flex-end",
  },
  backButton: {
    padding: 4,
  },
  backArrow: {
    fontSize: 22,
    color: colors.navy.DEFAULT,
    lineHeight: 26,
  },
  title: {
    flex: 1,
    textAlign: "center",
    fontSize: 17,
    fontFamily: "Inter_600SemiBold",
    color: colors.navy.DEFAULT,
  },
});