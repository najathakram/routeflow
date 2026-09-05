/**
 * Portal routing decisions shared by the Next.js middleware and the operator
 * sign-in page. Pure functions of (path, query, cookie presence) so they can be
 * unit-tested; the middleware only wires them to NextResponse.
 *
 * Two portals live in one app with two independent sessions (presence cookies
 * rf-op-auth / rf-buyer-auth). A person can hold both; these rules make sure a
 * URL they asked for wins over whichever cookie happens to exist.
 */
import type { Portal } from "@/lib/presence-cookies";

export type { Portal };

/** Operator surfaces the buyer-only guard protects. Moved verbatim from middleware.ts. */
export const OPERATOR_PATH_PREFIXES = [
  "/dashboard",
  "/settings",
  "/invoices",
  "/customers",
  "/products",
  "/routes",
  "/orders",
  "/finance",
  "/credit-notes",
  "/estimates",
  "/inventory",
  "/suppliers",
  "/purchases",
  "/vendor-bills",
  "/returns",
  "/analytics",
  "/bookkeeping",
  "/drivers",
] as const;

export function isOperatorPath(pathname: string): boolean {
  return OPERATOR_PATH_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export interface Presence {
  opAuthed: boolean;
  buyerAuthed: boolean;
}

/**
 * Buyer-only guard: a browser with a buyer session and no operator session that
 * asks for an operator path is sent to the operator sign-in, destination kept.
 * Returns null when the request must pass through untouched.
 */
export function resolveOperatorPathGuard(
  input: Presence & { pathname: string; search: string },
): string | null {
  if (!isOperatorPath(input.pathname)) return null;
  if (input.opAuthed || !input.buyerAuthed) return null;
  return `/login?redirect=${encodeURIComponent(input.pathname + input.search)}`;
}

function parsePortal(value: string | null | undefined): Portal | null {
  return value === "op" || value === "buyer" ? value : null;
}

/**
 * Landing page ("/") target. One session → that portal. Both → the portal used
 * last (rf-last-portal), seller dashboard by default. A preference never
 * overrides a missing session. No session → null (render the marketing page).
 */
export function resolveLandingTarget(
  input: Presence & { lastPortal: string | null | undefined },
): "/dashboard" | "/buyer/portal" | null {
  if (input.opAuthed && input.buyerAuthed) {
    return parsePortal(input.lastPortal) === "buyer" ? "/buyer/portal" : "/dashboard";
  }
  if (input.opAuthed) return "/dashboard";
  if (input.buyerAuthed) return "/buyer/portal";
  return null;
}

export const DEFAULT_OPERATOR_LANDING = "/dashboard";

/**
 * Validates the `redirect` query parameter of the operator sign-in page. Only a
 * same-origin operator path survives; anything else (absolute URLs, protocol-
 * relative `//host`, backslashes, `..`, non-operator surfaces) falls back to the
 * dashboard. Open-redirect guard — keep it strict.
 */
export function safeOperatorRedirect(raw: string | null | undefined): string {
  if (!raw) return DEFAULT_OPERATOR_LANDING;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) {
    return DEFAULT_OPERATOR_LANDING;
  }
  if (/\.\.|:\/\/|\/\/|\\/.test(raw)) return DEFAULT_OPERATOR_LANDING;
  const pathname = raw.split(/[?#]/, 1)[0];
  return isOperatorPath(pathname) ? raw : DEFAULT_OPERATOR_LANDING;
}

export type SwitchVariant = "switch" | "signIn";

/** English defaults; the dashboard passes localized labels from lib/i18n. */
export const PORTAL_SWITCH_LABELS: Record<Portal, Record<SwitchVariant, string>> = {
  buyer: { switch: "Switch to buyer portal", signIn: "Buyer portal sign-in" },
  op: { switch: "Switch to seller dashboard", signIn: "Seller dashboard sign-in" },
};

/** Where a "go to the other portal" link should point, given what this browser holds. */
export function portalSwitchTarget(
  to: Portal,
  presence: { op: boolean; buyer: boolean },
): { href: string; variant: SwitchVariant } {
  if (to === "buyer") {
    return presence.buyer
      ? { href: "/buyer/portal", variant: "switch" }
      : { href: "/buyer/login", variant: "signIn" };
  }
  return presence.op
    ? { href: "/dashboard", variant: "switch" }
    : { href: "/login", variant: "signIn" };
}
