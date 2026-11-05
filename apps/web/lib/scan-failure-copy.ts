import { API_ERROR_CODES } from "@routeflow/types";
import { SCAN_FAILED_COPY, scanCapPausedCopy } from "./reason-copy";
import { SCAN_LOCK_BODY, SCAN_LOCK_TITLE } from "./scan-po-lock";

/**
 * What a failed bill scan says (the toast in the single flow, the row text in a batch). Closed sentences only, never
 * the server's text. Order: a closed plan gate, then the business's monthly allowance (SA-1102 A-4 M1: a pause, not a
 * bad photo, with the server's date), then a refused key, then the generic retry copy.
 */
export function scanFailureCopy(
  err: any,
  planLocked: boolean,
): { title: string; description: string; rowError: string } {
  const msg: string = err?.response?.data?.message ?? "";
  const isApiKeyError =
    err?.response?.data?.code === API_ERROR_CODES.AI_KEY_INVALID || /api key|anthropic/i.test(msg);
  const capPaused = scanCapPausedCopy(err);
  if (planLocked) {
    return { title: SCAN_LOCK_TITLE, description: SCAN_LOCK_BODY, rowError: SCAN_LOCK_BODY };
  }
  if (capPaused) {
    return { title: "Scanning is paused", description: capPaused, rowError: capPaused };
  }
  if (isApiKeyError) {
    return {
      title: "Anthropic API key not configured",
      description: "Go to Settings → AI & Integrations to add your Claude API key.",
      rowError: "Anthropic API key not configured — see Settings → AI & Integrations.",
    };
  }
  return {
    title: "Failed to scan invoice",
    description: SCAN_FAILED_COPY,
    rowError: SCAN_FAILED_COPY,
  };
}
