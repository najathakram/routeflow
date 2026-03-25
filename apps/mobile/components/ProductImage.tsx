import { Image } from "expo-image";
import { View, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { ShimmerBox } from "./Shimmer";
import { useState } from "react";

interface Props {
  uri?: string | null;
  size?: "sm" | "md" | "lg";
  style?: object;
}

const SIZES = { sm: 80, md: 110, lg: 240 };

export function ProductImage({ uri, size = "md", style }: Props) {
  const [loading, setLoading] = useState(!!uri);
  const [error, setError] = useState(false);
  const height = SIZES[size];

  if (!uri || error) {
    return (
      <View style={[styles.placeholder, { height }, style]}>
        <Ionicons name="image-outline" size={size === "lg" ? 56 : 32} color="#cbd5e1" />
      </View>
    );
  }

  return (
    <View style={[{ height }, style]}>
      {loading && <ShimmerBox style={StyleSheet.flatten([StyleSheet.absoluteFill, styles.shimmer])} />}
      <Image
        source={{ uri }}
        style={{ width: "100%", height }}
        contentFit="cover"
        onLoadEnd={() => setLoading(false)}
        onError={() => { setLoading(false); setError(true); }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  placeholder: {
    backgroundColor: "#f1f5f9",
    alignItems: "center",
    justifyContent: "center",
  },
  shimmer: {
    borderRadius: 0,
  },
});
