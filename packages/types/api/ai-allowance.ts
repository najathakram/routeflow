/**
 * SA-1102 / AI limits: one business's monthly allowance on RouteFlow's Claude key, in USD, when the platform setting
 * `ai.monthlyCapUsd` is unset or unreadable (owner 2026-11-07: $10). The API's cap check and the super admin settings
 * screen both read this, so the screen never shows a number the server does not enforce.
 */
export const DEFAULT_MONTHLY_AI_CAP_USD = 10;
