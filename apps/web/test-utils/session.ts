import { OP_KEYS } from "@/lib/auth-keys";
import type { AuthUser } from "@/lib/auth";

/**
 * Seed the operator-portal session the REAL `AuthProvider` restores on mount, so a page under test
 * reads its role through `useAuth()` exactly as in the browser. The token is an unsigned fake: the
 * client only decodes its payload (`getStoredUser`), the server is never asked. Call from a
 * `beforeEach`; `null` leaves the browser logged out (an unknown role).
 */
export function seedSession(role: AuthUser["role"] | null): void {
  localStorage.removeItem(OP_KEYS.accessToken);
  localStorage.removeItem(OP_KEYS.refreshToken);
  if (!role) return;
  const part = (o: object) => btoa(JSON.stringify(o));
  const payload = {
    sub: `user-${role.toLowerCase()}`,
    username: `${role.toLowerCase()}1`,
    role,
    status: "ACTIVE",
    forcePasswordChange: false,
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
  localStorage.setItem(OP_KEYS.accessToken, `${part({ alg: "none" })}.${part(payload)}.sig`);
}
