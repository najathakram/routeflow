import * as React from "react";
import { useNavigation, usePreventRemove } from "@react-navigation/native";
import {
  canLeaveInlineReturn,
  isDeferrableRemoval,
  type InlineReturnScreenState,
} from "./inline-return-screen";

/**
 * Locks EVERY removal path while an inline-return capture is in flight: Android system back, this
 * stack's swipe, and a parent-stack swipe/dismiss. A capture that already landed must never be
 * dropped — the next confirm would mint a fresh key and book a second Return and credit.
 *
 * Uses `usePreventRemove`, not a raw `beforeRemove` listener: native-stack only sets
 * `preventNativeDismiss` (the iOS swipe/dismiss gesture) from routes registered through
 * usePreventRemove's context (react-navigation core 7.x + the native-stack that ships with
 * expo-router 55), so a bare listener runs after the native pop has already happened.
 *
 * A FORCED redirect blocked mid-capture (reset / replace, e.g. the session-expired handler) is
 * deferred and re-dispatched once the capture settles; a user back press is dropped so the
 * result stays on screen.
 */
export function useInlineReturnRemoveGuard(state: InlineReturnScreenState): void {
  const navigation = useNavigation();
  const locked = !canLeaveInlineReturn(state);
  const deferred = React.useRef<{ type: string } | null>(null);

  usePreventRemove(locked, ({ data }) => {
    if (isDeferrableRemoval(data.action)) deferred.current = data.action;
  });

  React.useEffect(() => {
    if (locked || !deferred.current) return;
    const action = deferred.current;
    deferred.current = null;
    (navigation as unknown as { dispatch: (a: unknown) => void }).dispatch(action);
  }, [locked, navigation]);
}
