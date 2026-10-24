import type { StyleProp, TextStyle } from "react-native";
import { Pressable, Text } from "react-native";
import type { PriceLayerGate } from "../lib/price-layer-gate";

/**
 * The unconfirmed-prices marker under an order footer (S19b, D-5): the gate's message, tappable as Retry when the read failed.
 * Renders nothing while prices are final. Extracted verbatim from NewOrderScreen and edit-items.tsx (size-ratchet).
 */
export function PriceLayerGateNotice({
  gate,
  onRetry,
  textStyle,
}: {
  gate: PriceLayerGate;
  onRetry: () => void;
  textStyle: StyleProp<TextStyle>;
}) {
  if (!gate.message) return null;
  return (
    <Pressable
      onPress={gate.canRetry ? onRetry : undefined}
      disabled={!gate.canRetry}
      accessibilityRole={gate.canRetry ? "button" : "text"}
      accessibilityLabel={gate.message}
      hitSlop={6}
    >
      <Text style={textStyle}>{gate.message}</Text>
    </Pressable>
  );
}
