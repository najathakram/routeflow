/**
 * The installed driver app's own login screen — the Expo mobile-web build.
 * `middleware.ts` used to proxy every phone UA here automatically; the owner
 * ruling that removed that proxy (mobile-web-proxy-redesign) is what makes a
 * DRIVER need an explicit link to it instead: `/login` (a small footer link)
 * and the operator dashboard (a banner for anyone signed in with the DRIVER
 * role) both point here. Same default `middleware.ts` used to fall back to.
 */
export const DRIVER_APP_LOGIN_URL = `${
  process.env.NEXT_PUBLIC_MOBILE_WEB_URL ?? "https://routeflowmobile-production.up.railway.app"
}/login`;
