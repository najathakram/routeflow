/**
 * #2653 — where the root gate sends a user when the hybrid shell is ON. Pure; Jest-pinned.
 * `handled: false` means "not a shell decision": fall through to the existing native gate
 * unchanged (drivers, the shell off, a native buyer session, forced password change, etc.).
 */
export const SHELL_ROUTE = "/(shell)/web";

export interface ShellGateInput {
  shellOn: boolean;
  segments: string[];
  /** A native staff session exists (operator / driver login). */
  hasStaffUser: boolean;
  /** The staff user's active surface ("operator" | "driver"), when signed in. */
  activeRole?: string | null;
}

export function shellGate(s: ShellGateInput): { handled: boolean; to: string | null } {
  if (!s.shellOn) return { handled: false, to: null };
  const inShell = s.segments[0] === "(shell)";

  // Signed out: the shell is reachable ONLY for the buyer fallback (the web's own buyer login,
  // #2653 Q1) — the landing opens it. Stay there; everything else is the native gate's call.
  if (!s.hasStaffUser) return inShell ? { handled: true, to: null } : { handled: false, to: null };

  // Staff: operators / tenant admins get the web; drivers keep the native app.
  if (s.activeRole === "operator") {
    return { handled: true, to: inShell ? null : `${SHELL_ROUTE}?role=operator` };
  }
  // A driver (or an unresolved role) is the native gate's call — its driver branch moves anyone
  // off a non-driver route, the shell included.
  return { handled: false, to: null };
}
