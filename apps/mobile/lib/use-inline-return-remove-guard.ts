import { usePreventRemove } from "@react-navigation/native";
import { canLeaveInlineReturn, type InlineReturnScreenState } from "./inline-return-screen";

/**
 * Locks EVERY removal path while an inline-return capture is in flight: Android system back, this
 * stack's swipe, and a parent-stack swipe/dismiss. A capture that already landed must never be
 * dropped — the next confirm would mint a fresh key and book a second Return and credit.
 *
 * Uses `usePreventRemove`, not a raw `beforeRemove` listener: native-stack only sets
 * `preventNativeDismiss` (the iOS swipe/dismiss gesture) from routes registered through
 * usePreventRemove's context (react-navigation core 7.x + the native-stack that ships with
 * expo-router 55), so a bare listener runs after the native pop has already happened.
 */
export function useInlineReturnRemoveGuard(state: InlineReturnScreenState): void {
  usePreventRemove(!canLeaveInlineReturn(state), () => {
    // Nothing to do: the screen simply stays until the capture settles.
  });
}
