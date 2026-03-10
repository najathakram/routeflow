import { useEffect, useRef } from "react";
import { Animated, StyleSheet, type ViewStyle } from "react-native";

interface ShimmerBoxProps {
  style?: ViewStyle;
}

export function ShimmerBox({ style }: ShimmerBoxProps) {
  const opacity = useRef(new Animated.Value(0.35)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 1,
          duration: 650,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 0.35,
          duration: 650,
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);

  return <Animated.View style={[styles.box, { opacity }, style]} />;
}

const styles = StyleSheet.create({
  box: {
    backgroundColor: "#e2e8f0",
    borderRadius: 8,
  },
});
