/**
 * "Get the app" install links (register row 559). Three global PlatformConfig rows hold them; the
 * super admin edits them, every signed-in role reads them. A new build is a config change only —
 * no store or APK URL lives in source code.
 */

/** PlatformConfig keys, one per link. A fourth link is one key here plus one field on AppLinks. */
export const APP_LINK_KEYS = {
  androidApkUrl: "app.android.apkUrl",
  playStoreUrl: "app.android.playUrl",
  iosUrl: "app.ios.url",
} as const;

export type AppLinkField = keyof typeof APP_LINK_KEYS;

/** The links as the signed-in read returns them: `null` = not ready, so the UI hides that option. */
export type AppLinks = {
  androidApkUrl: string | null;
  playStoreUrl: string | null;
  iosUrl: string | null;
};

/** The PUT /platform-admin/app-links body: a string sets, `""` or `null` clears, absent leaves alone. */
export type AppLinksPatch = Partial<Record<AppLinkField, string | null>>;

export const APP_LINK_MAX_LENGTH = 2048;

/** One rule for write AND read: `https:` only, with a host, at most 2048 characters. */
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

/** True when at least one install option is ready. */
export function hasAnyAppLink(links: AppLinks | null | undefined): boolean {
  return !!links && (!!links.androidApkUrl || !!links.playStoreUrl || !!links.iosUrl);
}
