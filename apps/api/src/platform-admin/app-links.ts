import type { AppLinkField } from "@routeflow/types";

/**
 * The API cannot value-import `@routeflow/types` at runtime (its dist runs that package's TypeScript
 * source through node), so it keeps a literal copy of the shared keys and URL rule. They are pinned
 * to `packages/types/api/app-links.ts` by `platform-config.app-links.spec.ts` (the L-072 pattern).
 */
export const APP_LINK_KEYS = {
  androidApkUrl: "app.android.apkUrl",
  playStoreUrl: "app.android.playUrl",
  iosUrl: "app.ios.url",
} as const satisfies Record<AppLinkField, string>;

export const APP_LINK_FIELDS = Object.keys(APP_LINK_KEYS) as AppLinkField[];

export const APP_LINK_MAX_LENGTH = 2048;

export function isValidAppLinkUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > APP_LINK_MAX_LENGTH) {
    return false;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.length > 0;
  } catch {
    return false;
  }
}
