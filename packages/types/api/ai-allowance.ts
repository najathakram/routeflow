/**
 * SA-1102 / AI limits: one business's monthly allowance on RouteFlow's Claude key, in USD, when the platform setting
 * `ai.monthlyCapUsd` is unset or unreadable (owner 2026-11-07: $10). The super admin settings screen reads this. The API
 * cannot import a runtime value from here (no-runtime-types-import.spec.ts), so it keeps an equal copy
 * (`DEFAULT_MONTHLY_AI_CAP_USD` in platform-config.service.ts) and `ai-allowance-default.pin.spec.ts` holds the two
 * equal: the screen never shows a number the server does not enforce.
 */
export const DEFAULT_MONTHLY_AI_CAP_USD = 10;
