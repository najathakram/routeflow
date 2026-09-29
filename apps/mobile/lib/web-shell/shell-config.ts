/**
 * #2653 — hybrid shell configuration (owner 2026-09-28: "Hybrid now, native as we go"). Pure;
 * Jest-pinned. Buyers, operators and tenant admins get the NEW web inside the app; drivers keep
 * the native app. The native screens for the web roles stay in the tree, reachable again by
 * turning the shell off (EXPO_PUBLIC_WEB_SHELL=off, an OTA-flippable env) — nothing is deleted.
 */
import { allowedOrigins } from "./url-policy";

export type ShellRole = "operator" | "buyer" | "driver";

/**
 * Where a buyer lands in the shell. Until the SA's sign-in handoff (#2653 Q1) exists, this is the
 * web's own buyer login — the zero-API-change fallback. When the handoff ships, this ONE constant
 * becomes the handoff route.
 */
export const BUYER_SHELL_ENTRY = "/buyer/login";
/**
 * Staff land on the web's own login. NOT "/": the web redirects "/" into the app only for a
 * signed-in WEB session, so a natively signed-in operator (no web session yet, until the Q1
 * handoff) got the marketing page (sim proof F1, #2554).
 */
export const STAFF_SHELL_ENTRY = "/login";

export interface ShellConfig {
  /** Absolute base URL of the web, without a trailing slash. */
  webBaseUrl: string;
  /** Origins the WebView may load in-app (see url-policy). */
  allowed: string[];
}

/**
 * The shell's config from the build env, or null when the shell must stay OFF:
 * `EXPO_PUBLIC_WEB_SHELL` is "off"/"0"/"false", or `EXPO_PUBLIC_WEB_URL` is unset/unusable.
 * There is NO hardcoded fallback URL: a build missing the env ships the old native screens
 * (eas.json defines both on every profile — pinned by web-shell-eas-env.test.ts).
 */
export function readShellConfig(env: {
  EXPO_PUBLIC_WEB_URL?: string;
  EXPO_PUBLIC_WEB_SHELL?: string;
}): ShellConfig | null {
  const flag = (env.EXPO_PUBLIC_WEB_SHELL ?? "").trim().toLowerCase();
  if (flag === "off" || flag === "0" || flag === "false") return null;
  const raw = (env.EXPO_PUBLIC_WEB_URL ?? "").trim();
  if (!raw) return null;
  const allowed = allowedOrigins(raw);
  if (allowed.length === 0) return null;
  return { webBaseUrl: allowed[0]!, allowed };
}

/** Whether a signed-in role is served by the shell. Drivers are never shelled (native app). */
export function usesShell(config: ShellConfig | null, role: ShellRole): boolean {
  return config !== null && role !== "driver";
}

/** The first URL the shell loads for a role. */
export function shellEntryUrl(config: ShellConfig, role: Exclude<ShellRole, "driver">): string {
  return config.webBaseUrl + (role === "buyer" ? BUYER_SHELL_ENTRY : STAFF_SHELL_ENTRY);
}
