import * as React from "react";
import { usePreventRemove } from "@react-navigation/native";
import { canLeaveInlineReturn, type InlineReturnScreenState } from "./inline-return-screen";

export interface InlineReturnRemoveGuardOptions {
  /** True when the staff session is gone (the session-expired handler cleared the user). */
  signedOut: boolean;
  /** Re-issues the login redirect from the CONTAINER (router.replace("/(auth)/login")). */
  onSignedOutRedirect: () => void;
}

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
 * Every blocked action is DROPPED — a user back press, and a tab tap (an untargeted POP_TO from
 * OperatorTabBar) must NOT replay after the capture settles, or it would close the result screen
 * before the operator sees it (and invite a second capture with a fresh key). The one exception is
 * a sign-out: the session-expired handler's root-targeted REPLACE cannot be replayed through this
 * screen's navigation (the router adds this screen as `source`, which the root stack cannot find),
 * so while signed out we only REMEMBER that a redirect is owed and re-issue the login redirect
 * from the container once the capture settles.
 */
export function useInlineReturnRemoveGuard(
  state: InlineReturnScreenState,
  { signedOut, onSignedOutRedirect }: InlineReturnRemoveGuardOptions,
): void {
  const locked = !canLeaveInlineReturn(state);
  const redirectOwed = React.useRef(false);
  const signedOutRef = React.useRef(signedOut);
  signedOutRef.current = signedOut;

  usePreventRemove(locked, () => {
    if (signedOutRef.current) redirectOwed.current = true;
  });

  React.useEffect(() => {
    if (locked || !redirectOwed.current) return;
    redirectOwed.current = false;
    onSignedOutRedirect();
  }, [locked, onSignedOutRedirect]);
}
