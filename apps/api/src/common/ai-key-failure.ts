import { BadRequestException, ServiceUnavailableException } from "@nestjs/common";
import { API_ERROR_CODES } from "./api-error-codes";

/**
 * SA-1102 F-1102-T: what a business is told when the key behind an AI call fails. The text follows who can fix it.
 *
 *   - a business's OWN key that Anthropic refused (401/403): the business can, in Settings → AI & Integrations
 *     (`AI_KEY_INVALID`, 400);
 *   - RouteFlow's key refused, or no key set up at all: only RouteFlow can. The business is never told to configure a
 *     key, never shown an environment variable name, and the scan is "not available right now" (`AI_UNAVAILABLE`,
 *     503), with the same three words everywhere so a client can show one closed sentence.
 *
 * Every AI call site throws these and no other key text (pinned by `ai-sites.failure-text.spec.ts`).
 */
export const AI_BUSINESS_KEY_REFUSED_MESSAGE =
  "Your Claude key was refused. Update or remove it in Settings → AI & Integrations.";
export const AI_NOT_AVAILABLE_MESSAGE =
  "AI scanning isn't available right now. Please try again later.";

/** A key Anthropic refused (401/403): `source` is whose key it was (`prepareAiCall`'s own `source`). */
export function aiKeyRefusedException(source: "business" | "routeflow") {
  return source === "business"
    ? new BadRequestException({
        message: AI_BUSINESS_KEY_REFUSED_MESSAGE,
        code: API_ERROR_CODES.AI_KEY_INVALID,
      })
    : aiNotAvailableException();
}

/** No key to call with, or RouteFlow's own key refused: not something this business can fix. */
export function aiNotAvailableException() {
  return new ServiceUnavailableException({
    message: AI_NOT_AVAILABLE_MESSAGE,
    code: API_ERROR_CODES.AI_UNAVAILABLE,
  });
}
