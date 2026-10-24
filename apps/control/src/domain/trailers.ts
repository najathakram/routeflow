/** PR link and lane extraction (spec 5.4): trailers beat branch tokens; the first occurrence wins. */

export interface Links {
  task: string | null;
  bug: string | null;
  feature: string | null;
  defers: string | null;
  lane: string | null;
  /** GitHub issue number from `Closes: #n` / `Closes #n`. */
  issue: number | null;
}

// Line-anchored; `[ \t]` (never `\s`) so a value cannot be pulled from the next line; `\r` tolerated.
const TRAILER = /^(Task|Bug|Feature|Defers|Lane|Closes):[ \t]*(#?[A-Za-z0-9.-]+)[ \t\r]*$/gm;
const CLOSES_KEYWORD = /^Closes[ \t]+#(\d+)[ \t\r]*$/gm;
const BOOKKEEPING = /^Bookkeeping-Follow-Up:[ \t]*pending[ \t\r]*$/im;

const issueOf = (v: string): number | null => {
  const m = /^#?(\d{1,9})$/.exec(v);
  return m ? Number(m[1]) : null;
};

export function links(body: string, branch: string): Links {
  const out: Links = {
    task: null,
    bug: null,
    feature: null,
    defers: null,
    lane: null,
    issue: null,
  };
  const text = typeof body === "string" ? body : "";
  for (const m of text.matchAll(TRAILER)) {
    const key = m[1];
    const val = m[2];
    if (key === "Closes") {
      if (out.issue === null) out.issue = issueOf(val);
    } else if (key === "Task") out.task ??= val;
    else if (key === "Bug") out.bug ??= val;
    else if (key === "Feature") out.feature ??= val;
    else if (key === "Defers") out.defers ??= val;
    else if (key === "Lane") out.lane ??= val;
  }
  if (out.issue === null) {
    for (const m of text.matchAll(CLOSES_KEYWORD)) {
      out.issue = issueOf(m[1]);
      break;
    }
  }
  const br = typeof branch === "string" ? branch : "";
  if (!out.task) out.task = br.match(/\bRF-\d+\b/)?.[0] ?? null;
  if (!out.bug) out.bug = br.match(/\bB\d{1,4}\b/)?.[0] ?? null;
  if (!out.feature) out.feature = br.match(/\bF-\d+\b/)?.[0] ?? null;
  return out;
}

/** True when a body or commit message carries `Bookkeeping-Follow-Up: pending` (only). */
export function bookkeepingPending(...texts: string[]): boolean {
  return texts.some((t) => typeof t === "string" && BOOKKEEPING.test(t));
}
