/**
 * #2337 (plan §3, "Rollout mechanism for every phase"): which UI generation each role sees while
 * the native parity rebuild lands. Screens are rebuilt IN PLACE at the same route paths; a screen
 * renders its new body only when `useNewUi(role)` is true, and the old body stays until that role's
 * phase passes proof and its default flips here (then the old bodies are deleted).
 *
 * Every role defaults to OLD, so new code lands dark on master and nobody's app changes until a
 * deliberate flip. Drivers in particular keep the old UI on their installed build until
 * `driver` flips (plan §4).
 *
 * The one override is for development and the proof harness: `EXPO_PUBLIC_NEW_UI` ("all" or a
 * comma list like "customer,operator") is honoured ONLY in a `__DEV__` build. A release build
 * ignores it entirely, so a stray env value can never flip a real user's UI.
 */

export const UI_ROLES = ["customer", "driver", "operator"] as const;
export type UiRole = (typeof UI_ROLES)[number];
export type UiGeneration = "old" | "new";

/** The shipped defaults. Flip a role here only in its own reviewed PR, after its phase's proof. */
export const UI_GENERATION_DEFAULTS: Readonly<Record<UiRole, UiGeneration>> = {
  customer: "old",
  driver: "old",
  operator: "old",
};

/** Parse the dev override: "all", or a comma list of role names. Unknown names are ignored. */
export function parseNewUiOverride(raw: string | undefined | null): ReadonlySet<UiRole> {
  const out = new Set<UiRole>();
  if (!raw) return out;
  for (const part of raw.split(",")) {
    const name = part.trim().toLowerCase();
    if (name === "all") return new Set(UI_ROLES);
    if ((UI_ROLES as readonly string[]).includes(name)) out.add(name as UiRole);
  }
  return out;
}

/** Pure resolver behind `useNewUi`, so the rules are pinned in jest without Expo. */
export function resolveUiGeneration(
  role: UiRole,
  opts: {
    isDev: boolean;
    override?: string | null;
    defaults?: Readonly<Record<UiRole, UiGeneration>>;
  },
): UiGeneration {
  const defaults = opts.defaults ?? UI_GENERATION_DEFAULTS;
  if (opts.isDev && parseNewUiOverride(opts.override).has(role)) return "new";
  return defaults[role];
}

declare const __DEV__: boolean | undefined;

/**
 * Whether `role` renders the new (Ledger kit) screen bodies. Static per build: it reads no state,
 * so calling it anywhere in render is safe.
 */
export function useNewUi(role: UiRole): boolean {
  const isDev = typeof __DEV__ !== "undefined" && __DEV__ === true;
  return resolveUiGeneration(role, { isDev, override: process.env.EXPO_PUBLIC_NEW_UI }) === "new";
}
