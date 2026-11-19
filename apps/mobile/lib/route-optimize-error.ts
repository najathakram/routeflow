import { API_ERROR_CODES } from "@routeflow/types";
import {
  routeStopsNotPlacedFromBody,
  routeStopsNotPlacedSentence,
} from "@routeflow/types/route-stops-not-placed";

/**
 * UXG B14 (mirrors web `codedToastCopy`): the sentence for an optimize refused with `ROUTE_STOPS_NOT_PLACED`, built from the
 * STRUCTURED `count` and `names` (never the server `message`); null for any other error, so the caller keeps its own line.
 */
export function optimizeUnplacedCopy(err: unknown): string | null {
  const data = (err as { response?: { data?: unknown } } | null | undefined)?.response?.data;
  const body = routeStopsNotPlacedFromBody(data, API_ERROR_CODES.ROUTE_STOPS_NOT_PLACED);
  return body ? routeStopsNotPlacedSentence(body.count, body.names) : null;
}
