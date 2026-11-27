/**
 * SA-1547 M1 (W-1464): the ONE sentence for the live-payments wall's `LIVE_PAYMENTS_OFF` refusal, shared by web
 * (`generic-toast-copy.ts`) and mobile (`lib/live-payments-off-copy.ts`) so the two cannot drift. Pure; no name,
 * amount or key. The API keeps its own literal in `live-payments-wall.ts` and its spec pins it byte-equal.
 */
export const LIVE_PAYMENTS_OFF_SENTENCE = "This is a test business. Payments are switched off.";
