import { API_ERROR_CODES } from "@routeflow/types";
import { SCAN_FAILED_COPY, scanCapPausedCopy } from "./reason-copy";
import { SCAN_LOCK_BODY, SCAN_LOCK_TITLE } from "./scan-po-lock";

/**
 * What a failed bill scan says (the toast in the single flow, the row text in a batch). Closed sentences only, never
 * the server's text. Order: a closed plan gate, then the business's monthly allowance (SA-1102 A-4 M1: a pause, not a
 * bad photo, with the server's date), then a refused business key, then "not available", then the generic retry copy.
 */
export function scanFailureCopy(
  err: any,
  planLocked: boolean,
): { title: string; description: string; rowError: string } {
  const code: string | undefined = err?.response?.data?.code;
  const capPaused = scanCapPausedCopy(err);
  if (planLocked) {
    return { title: SCAN_LOCK_TITLE, description: SCAN_LOCK_BODY, rowError: SCAN_LOCK_BODY };
  }
  if (capPaused) {
    return { title: "Scanning is paused", description: capPaused, rowError: capPaused };
  }
  // F-1102-T: only the business's OWN refused key is the business's to fix; no key behind the scan (or RouteFlow's own
  // refused) is "not available", never a key to configure. Chosen by code, never by sniffing the server's words.
  if (code === API_ERROR_CODES.AI_KEY_INVALID) {
    return {
      title: "Your Claude key was refused",
      description: "Update or remove it in Settings → AI & Integrations.",
      rowError: "Your Claude key was refused. Update or remove it in Settings → AI & Integrations.",
    };
  }
  if (code === API_ERROR_CODES.AI_UNAVAILABLE) {
    return {
      title: "Scanning isn't available right now",
      description: "Please try again later. You can still enter the bill by hand.",
      rowError: "Scanning isn't available right now. You can still enter the bill by hand.",
    };
  }
  return {
    title: "Failed to scan invoice",
    description: SCAN_FAILED_COPY,
    rowError: SCAN_FAILED_COPY,
  };
}
