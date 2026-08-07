import * as React from "react";
import { AccessibilityInfo, Animated, Easing, StyleSheet, Text } from "react-native";

const VISIBLE_MS = 2400;
const FADE_MS = 180;

export interface InlineToastState {
  /** Bumped per show so repeating the same message re-arms the timer. */
  id: number;
  message: string;
}

/**
 * `lib/toast.ts` is a NO-OP on iOS, so draft-saved / credit-created /
 * line-removed events land silently there. This is the in-screen replacement.
 */
export function useInlineToast(): {
  toast: InlineToastState | null;
  show: (message: string) => void;
  dismiss: () => void;
} {
  const [toast, setToast] = React.useState<InlineToastState | null>(null);
  const seq = React.useRef(0);
  const show = React.useCallback((message: string) => {
    seq.current += 1;
    setToast({ id: seq.current, message });
  }, []);
  const dismiss = React.useCallback(() => setToast(null), []);
  return { toast, show, dismiss };
}

export interface InlineToastProps {
  toast: InlineToastState | null;
  onDismiss: () => void;
  /** Clearance above a pinned footer. */
  bottom?: number;
}

/** Auto-dismissing snackbar pinned above the footer. Never blocks touches. */
export function InlineToast({ toast, onDismiss, bottom = 16 }: InlineToastProps) {
  const anim = React.useRef(new Animated.Value(0)).current;
  const onDismissRef = React.useRef(onDismiss);
  onDismissRef.current = onDismiss;
  const id = toast?.id ?? null;
  const message = toast?.message ?? "";

  React.useEffect(() => {
    if (id == null) return;
    // VoiceOver/TalkBack: accessibilityLiveRegion is Android-only, so announce
    // explicitly as well.
    AccessibilityInfo.announceForAccessibility(message);
    Animated.timing(anim, {
      toValue: 1,
      duration: FADE_MS,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();
    const timer = setTimeout(() => {
      Animated.timing(anim, {
        toValue: 0,
        duration: FADE_MS,
        easing: Easing.in(Easing.quad),
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) onDismissRef.current();
      });
    }, VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [id, message, anim]);

  if (id == null) return null;

  return (
    <Animated.View
      style={[
        styles.toast,
        {
          bottom,
          opacity: anim,
          transform: [
            { translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) },
          ],
        },
      ]}
      pointerEvents="none"
      accessibilityLiveRegion="polite"
    >
      <Text style={styles.text} numberOfLines={2}>
        {message}
      </Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  toast: {
    position: "absolute",
    left: 16,
    right: 16,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 14,
    backgroundColor: "rgba(28,28,30,0.92)",
    zIndex: 10,
  },
  text: { color: "#fff", fontSize: 14, fontFamily: "Inter_400Regular" },
});
