import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { ios } from "../../tokens";

export interface MessageBubbleProps {
  side: "left" | "right";
  text: string;
  meta?: string;
}

/** Chat bubble for driver↔dispatcher threads. */
export function MessageBubble({ side, text, meta }: MessageBubbleProps) {
  const isRight = side === "right";
  return (
    <View style={[styles.wrap, isRight && styles.wrapRight]}>
      <View style={[styles.bubble, isRight ? styles.bubbleRight : styles.bubbleLeft]}>
        <Text style={[styles.text, isRight && styles.textRight]}>{text}</Text>
      </View>
      {meta ? <Text style={[styles.meta, isRight && styles.metaRight]}>{meta}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: "flex-start", marginBottom: 2 },
  wrapRight: { alignItems: "flex-end" },
  bubble: {
    maxWidth: "78%",
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  bubbleLeft: {
    backgroundColor: ios.fill3,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderBottomRightRadius: 16,
    borderBottomLeftRadius: 4,
  },
  bubbleRight: {
    backgroundColor: ios.brand,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderBottomRightRadius: 4,
    borderBottomLeftRadius: 16,
  },
  text: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: ios.label,
    lineHeight: 20,
  },
  textRight: { color: "#fff" },
  meta: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    marginTop: 2,
    marginHorizontal: 8,
  },
  metaRight: { marginLeft: 0 },
});
