// Tester intake (team board part 3). A tester files a bug as a DRAFT item; the lead or coordinator
// (the one bug minter) promotes it into the in-repo bug registry or rejects it. Pure: no IO.
import { makeMasker } from "./mask.mjs";

export const TRIAGE_STATUS = "draft";
/** Tags the triage commands put on a draft they closed. */
export const PROMOTED_TAG = "promoted";
export const REJECTED_TAG = "rejected";
/** Longest --symptom handed to scripts/campaign/bugs.mjs. */
export const SYMPTOM_MAX = 1000;

const toMs = (t) => (typeof t === "number" ? t : Date.parse(t ?? "") || 0);

/** Draft items waiting for triage, oldest first. */
export function draftsOf(state) {
  return [...state.items.values()]
    .filter((it) => it.status === TRIAGE_STATUS)
    .sort((a, b) => toMs(a.createdAt) - toMs(b.createdAt) || (a.id < b.id ? -1 : 1));
}

/**
 * The registry bug's symptom line: the tester's steps, screen and evidence link, and where it came
 * from. The registry lives in the product repo, which goes public during deploy windows, so client
 * names are masked here, before the text leaves the private specs repo.
 */
export function promotionSymptom(it, clientNames) {
  const mask = makeMasker(clientNames);
  const parts = [];
  if (it.steps) parts.push(String(it.steps).replace(/\s+/g, " ").trim());
  if (it.screen) parts.push(`screen ${it.screen}`);
  if (it.evidence) parts.push(`evidence ${it.evidence}`);
  const tail = `(reported by ${it.reportedBy ?? "unknown"} on ${it.id})`;
  const body = mask(parts.join("; "));
  const room = SYMPTOM_MAX - tail.length - 1;
  const clipped = body.length > room ? `${body.slice(0, room - 1).trimEnd()}…` : body;
  return mask(clipped ? `${clipped} ${tail}` : tail);
}

/** The bug id `bugs.mjs file` printed ("filed B123 — title"), or null. */
export function filedBugId(stdout) {
  return /\bfiled (B\d{1,5})\b/.exec(String(stdout ?? ""))?.[1] ?? null;
}
