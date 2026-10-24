/**
 * #2653 — where the root gate sends a user when the hybrid shell is ON. Pure; Jest-pinned.
 * `handled: false` means "not a shell decision": fall through to the existing native gate
 * unchanged (drivers, the shell off, forced password change, etc.).
 *
 * W-830 (owner 2026-10-24: "not the old native UIs"): with the shell ON no buyer and no staff user
 * reaches the old native `(customer)` screens. A buyer with a native session, a signed-out user on
 * a `(customer)` route, and anyone (buyer or staff) on native customer-login all land in the shell
 * as a buyer. The shell takes no path, so a deep link to a buyer page (BUG-B2-5 returnTo) lands on
 * the shell home: the web's own buyer login and portal.
 */
export const SHELL_ROUTE = "/(shell)/web";
/** The shell as a buyer: the web's own buyer login and portal. */
export const SHELL_BUYER_ROUTE = `${SHELL_ROUTE}?role=buyer`;

const NATIVE_CUSTOMER_LOGIN = "/(auth)/customer-login";

export interface ShellGateInput {
  shellOn: boolean;
  segments: string[];
  /** A native staff session exists (operator / driver login). */
  hasStaffUser: boolean;
  /** The staff user's active surface ("operator" | "driver"), when signed in. */
  activeRole?: string | null;
  /** A native buyer session exists (W-830). */
  hasBuyerSession?: boolean;
}

/** Whether the segments are a native buyer screen: the `(customer)` group or customer-login. */
export function isNativeBuyerRoute(segments: string[]): boolean {
  return (
    segments[0] === "(customer)" || (segments[0] === "(auth)" && segments[1] === "customer-login")
  );
}

export function shellGate(s: ShellGateInput): { handled: boolean; to: string | null } {
  if (!s.shellOn) return { handled: false, to: null };
  const inShell = s.segments[0] === "(shell)";

  if (!s.hasStaffUser) {
    // In the shell: stay (the web's own buyer login, #2653 Q1).
    if (inShell) return { handled: true, to: null };
    // W-830: a native buyer session, or a buyer who reached a native buyer screen, is the old
    // native UI. Everything else signed out is the native gate's call (landing, staff login).
    if (s.hasBuyerSession || isNativeBuyerRoute(s.segments)) {
      return { handled: true, to: SHELL_BUYER_ROUTE };
    }
    return { handled: false, to: null };
  }

  // Staff: operators / tenant admins get the web; drivers keep the native app.
  if (s.activeRole === "operator") {
    if (inShell) return { handled: true, to: null };
    // RF-087 let staff reach native customer-login to sign in to the buyer portal. That portal is
    // the web now, so the same intent lands in the shell as a buyer (W-830).
    const onCustomerLogin = s.segments[0] === "(auth)" && s.segments[1] === "customer-login";
    return {
      handled: true,
      to: onCustomerLogin ? SHELL_BUYER_ROUTE : `${SHELL_ROUTE}?role=operator`,
    };
  }
  // A driver (or an unresolved role) is the native gate's call — its driver branch moves anyone
  // off a non-driver route, the shell included.
  return { handled: false, to: null };
}

/**
 * W-830: a native buyer session is dead weight once the shell is on (the web holds its own buyer
 * session). Clear it locally so no token lingers for a later shell-off build to reuse. The local
 * clear does NOT call the server's buyer logout: that revokes every refresh token of the account,
 * including the web session the shell is about to use.
 */
export function shouldClearNativeBuyer(s: { shellOn: boolean; hasBuyer: boolean }): boolean {
  return s.shellOn && s.hasBuyer;
}

/** Where a "buyer" entry button goes: the shell when it is on, native customer-login otherwise. */
export function buyerEntryRoute(shellOn: boolean): string {
  return shellOn ? SHELL_BUYER_ROUTE : NATIVE_CUSTOMER_LOGIN;
}

/**
 * The offline-drain "Open order" action (hooks/useNetworkSync). With the shell on there is no
 * operator route to open: the shell takes no path and the root gate would bounce
 * `/(operator)/orders/<id>` (or `/(driver)/route` for a driver) anyway, stacking a second
 * WebView. Null = offer no action; the notice itself already names the order.
 */
export function creditsPendingOpenRoute(s: {
  shellOn: boolean;
  orderId: string;
  activeRole?: string | null;
}): string | null {
  if (s.shellOn) return null;
  return `/(operator)/orders/${s.orderId}`;
}
