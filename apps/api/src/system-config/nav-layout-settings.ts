import { BadRequestException } from "@nestjs/common";
import type { NavLayout } from "@routeflow/types";

/**
 * The per-tenant sidebar layout (SA-1209): the key, the limit, the tolerant reader and the shape check.
 *
 * The API never value-imports `@routeflow/types` (L-261), so the two constants are literals here, pinned equal to
 * `packages/types/api/nav-layout.ts` by `nav-layout-settings.spec.ts`. Display only: nothing here is a permission.
 */
export const NAV_LAYOUT_CONFIG_KEY = "settings.navLayout";
export const NAV_LAYOUT_MAX_PINNED = 5;
/** The Settings leaf is never hidden: the reader drops it from `hidden` (SA-1209 section 2). */
const NEVER_HIDDEN = "/settings";

export function defaultNavLayout(): NavLayout {
  return { pinned: [], order: [], hidden: [] };
}

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

/** One leading "/", not "//" (a protocol-relative or empty path is not a menu href). */
const isHref = (v: string): boolean => v.startsWith("/") && !v.startsWith("//");

function shapeOf(v: unknown): NavLayout | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const { pinned, order, hidden } = v as Record<string, unknown>;
  if (!isStringArray(pinned) || !isStringArray(order) || !isStringArray(hidden)) return null;
  return { pinned, order, hidden };
}

/** Never throws: a missing, corrupt or wrong-shaped value is the default layout. Duplicates collapse; `/settings` is not hideable. */
export function parseNavLayoutSettings(raw: string | null | undefined): NavLayout {
  if (!raw) return defaultNavLayout();
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return defaultNavLayout();
  }
  const v = shapeOf(json);
  if (!v) return defaultNavLayout();
  return {
    pinned: [...new Set(v.pinned.filter(isHref))].slice(0, NAV_LAYOUT_MAX_PINNED),
    order: [...new Set(v.order)],
    hidden: [...new Set(v.hidden.filter(isHref))].filter((h) => h !== NEVER_HIDDEN),
  };
}

/** The writer's shape check, and only the shape: three arrays of strings, `pinned` at most 5, every href one leading "/". Else 400. */
export function validateNavLayoutInput(raw: unknown): NavLayout {
  const v = shapeOf(raw);
  if (!v) {
    throw new BadRequestException(
      "navLayout must be an object with three lists of text: pinned, order and hidden",
    );
  }
  if (v.pinned.length > NAV_LAYOUT_MAX_PINNED) {
    throw new BadRequestException(`navLayout.pinned holds at most ${NAV_LAYOUT_MAX_PINNED} pages`);
  }
  if (![...v.pinned, ...v.hidden].every(isHref)) {
    throw new BadRequestException(
      "navLayout pinned and hidden entries must be page paths such as /invoices",
    );
  }
  return v;
}
