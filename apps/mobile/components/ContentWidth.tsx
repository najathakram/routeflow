import type { ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { CONTENT_MAX_WIDTH, WIDE_CONTENT_MAX_WIDTH } from "../lib/tablet-layout";

/**
 * #2311: centres a screen's content and caps its width on a tablet (lib/tablet-layout.ts). On a
 * phone the cap is wider than the window, so this is a no-op — wrapping a screen never changes
 * its phone layout. `variant="wide"` is for multi-column lists and dashboards.
 */
export function ContentWidth({
  children,
  variant = "column",
  style,
}: {
  children: ReactNode;
  variant?: "column" | "wide";
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View
      style={[
        {
          width: "100%",
          maxWidth: variant === "wide" ? WIDE_CONTENT_MAX_WIDTH : CONTENT_MAX_WIDTH,
          alignSelf: "center",
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}
