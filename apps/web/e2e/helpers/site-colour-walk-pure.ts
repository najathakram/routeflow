/**
 * The pure half of the T16 colour walk (SA-1203 A12, record S1-S15 and K1-K4): no browser, no Playwright
 * import, so the rules that judge a walk can be tested by Jest. The in-page reading (one reader,
 * `settleThenRead`) and the Tab driver live in site-colour-walk.ts.
 */

// ── budgets and caps (SA-1203 A12 S3, S13) ──────────────────────────────────────────────────────────
/** S3: the per-element settle cap, in milliseconds. */
export const SETTLE_CAP_MS = 1200;
/** S3: scrollY, the element and its ancestors, the ring and the backdrop stay equal for this many frames. */
export const SETTLE_STABLE_FRAMES = 3;
/** S2: the Tab cap is the DOM focusable count plus this many presses. */
export const TAB_CAP_EXTRA = 10;
/** S13: one page and size gets this long, then it is `budget-exceeded` (red). */
export const WALK_BUDGET_MS = 60_000;
/** S13: hard timeouts. The walk as a whole, one page and size, and one spec 96 test. */
export const WALK_RUN_HARD_MS = 15 * 60_000;
export const WALK_PAGE_HARD_MS = 4 * 60_000;
export const PLANTS_TEST_HARD_MS = 6 * 60_000;
/** S13: element-clip crops on red only. */
export const CROPS_PER_PAGE = 3;
export const CROPS_PER_RUN = 30;
/** K2: at least this many TEXT rows are walked on every page and size (there is no floor on rings). */
export const MIN_TEXT_ELEMENTS = 50;

// ── shapes ──────────────────────────────────────────────────────────────────────────────────────────
/** One focusable element, as the page reports it. */
export type FocusInfo = {
  /** A short readable name for messages. */
  el: string;
  tag: string;
  /** The resolved href of a link (origin, path, query, hash), or null for anything else. */
  href: string | null;
  /** The accessible name: aria-label, then its text, then title, then value. */
  name: string;
  /** The form, aria-controls and data-track targets, joined with "|" (empty parts kept). */
  target: string;
};

export type Part = "page" | "header" | "menu";
/** N2: a header state is its class list plus its computed background, as the page reports it (no fixed names). */
export type HeaderState = string;
/** N2: one distinct header state seen in the scroll-through, with one scroll position it was seen at. */
export type HeaderSeen = { state: HeaderState; scrollY: number; reproduced: boolean };
/** What a focus read ended as. `measured` is the only green one. */
export type ReadState = "measured" | "unsettled" | "obscured" | "focus-refused";

/** S1: what `settleThenRead` returns for one focus stop (plus the fields the report and the plants need). */
export type RingRead = {
  sel: string;
  part: Part;
  headerState: HeaderState;
  state: ReadState;
  /** The number of Tab presses so far (S9: within the menu pass), or null for a programmatic focus (S8). */
  tab: number | null;
  /** How the stop was reached, for the keyboard repro: "tab", "menu-tab", or "header-stop:<band>". */
  how: string;
  info: FocusInfo;
  /** The `data-t16-plant` of the element or its closest ancestor that carries one (S12), else null. */
  plant: string | null;
  ring: { style: string; width: number; color: string; offset: number };
  /** The opaque colour behind the ring as `rgb(...)`, or null when a picture or gradient sits behind it. */
  backdrop: string | null;
  /** The ring against the backdrop: 0 when no outline is drawn, null when the backdrop is unresolved. */
  ringContrast: number | null;
  /** S4: the backdrop equals a resolved panel or ink token. */
  bandDark: boolean;
  /** S4: the live --rf-focus on the element, and the resolved --rf-on-panel, both as `rgb(...)`. */
  focusTok: string;
  onPanel: string;
  scrollY0: number;
  scrollY1: number;
  settleFrames: number;
  settleMs: number;
  stillAnimating: number;
  inView: boolean;
  /** Which of the watched dark-band selectors (DARK_BAND_SELECTORS) the element sits inside. */
  inside: string[];
  /** S5: why the ring is not clear to a visitor ("out of viewport", or the element on top), else null. */
  obscuredBy: string | null;
  rect: { x: number; y: number; w: number; h: number };
  /** A T16_SIZE_ONLY entry exempts exactly this state of this element (C2, K3). */
  exempt: boolean;
  /** Wall time of the step in ms (the Tab press and the read). */
  stepMs: number;
};

export type TextRow = {
  el: string;
  fg: string;
  bg: string | null;
  size: number;
  weight: number;
  part: Part;
  headerState: HeaderState;
  plant: string | null;
};
export type ButtonRow = {
  el: string;
  bg: string;
  fg: string;
  part: Part;
  headerState: HeaderState;
  plant: string | null;
};
export type LinkRow = {
  el: string;
  color: string;
  dark: boolean | null;
  part: Part;
  headerState: HeaderState;
  plant: string | null;
};
/** S7: a text the sweep scrolled to and could still not read. */
export type UnreadRow = { el: string; part: Part; plant: string | null; exempt: boolean };

/** A focusable element the walk never reached, and why. */
export type Skip = FocusInfo & {
  reason: string;
  part: Part;
  sizeOnly: boolean;
  plant: string | null;
};

// ── the exemption list (C2, K3, K4) ─────────────────────────────────────────────────────────────────
/** K3: the only states a T16_SIZE_ONLY entry may exempt, one per entry. */
export const EXEMPT_STATES = ["not-rendered", "obscured", "unsettled", "text-unread"] as const;
export type ExemptState = (typeof EXEMPT_STATES)[number];

/**
 * An element that legitimately exists at one size only, or legitimately never settles (a marquee), and has no
 * counterpart. One entry is page + size + selector + the ONE state it exempts + a one-line reason. The list
 * starts EMPTY, its length is pinned by a static test (site-colour-walk.static.test.ts, W13), and every new
 * entry is a reviewed diff. It is never filled from a run (SA-1203 A11 C2, A12 K3).
 */
export type SizeOnly = {
  page: string;
  size: string;
  selector: string;
  state: ExemptState;
  reason: string;
};
export const T16_SIZE_ONLY: readonly SizeOnly[] = [];

/** The reasons a focusable element may go unmeasured with no further condition. */
export const ALLOWED_SKIPS = ["disabled", "inert", "closed-dialog"] as const;

/** A focusable element the Tab walk, the header pass and the menu pass never reached. */
export const UNREACHED = "unreached";

/** The length pin on the exemption list: an entry is added only by a reviewed diff that changes this number. */
export const T16_SIZE_ONLY_LENGTH = 0;
export const sizeOnlyLengthOk = (list: readonly unknown[]): boolean =>
  list.length === T16_SIZE_ONLY_LENGTH;

/** K3: an entry whose `state` is missing or not one of EXEMPT_STATES is red. */
export function sizeOnlyEntryProblems(
  list: readonly { page?: string; selector?: string; state?: string }[],
): string[] {
  return list
    .filter((e) => !(EXEMPT_STATES as readonly string[]).includes(e.state ?? ""))
    .map(
      (e) =>
        `T16_SIZE_ONLY entry ${e.page ?? "?"} ${e.selector ?? "?"} has no valid state (one of ${EXEMPT_STATES.join(", ")})`,
    );
}

/** K3: an entry whose state was never seen on its page and size is red as `stale-exemption`. */
export function staleExemptions(
  label: string,
  entries: readonly { selector: string; state: string }[],
  hits: readonly number[],
  sha = "-",
): string[] {
  return entries
    .filter((_, i) => (hits[i] ?? 0) === 0)
    .map((e) =>
      redLine({
        label,
        part: "page",
        headerState: "-",
        tab: null,
        settle: "-",
        kind: "stale-exemption",
        detail: `${e.selector} (${e.state}): the state was not seen in this run`,
        raw: "-",
        repro: `open ${label} and look for ${e.selector}`,
        sha,
      }),
    );
}

// ── the equivalence rule (C1, S11) ──────────────────────────────────────────────────────────────────
/** origin + path of a resolved href, and the hash (empty when it has none). Null when it is not a URL. */
export function hrefParts(href: string): { base: string; hash: string } | null {
  try {
    const u = new URL(href);
    return { base: `${u.origin}${u.pathname}`, hash: u.hash === "#" ? "" : u.hash };
  } catch {
    return null;
  }
}

/** True when a joined target ("form|aria-controls|data-track") names something. */
export const hasTarget = (target: string): boolean => target.split("|").some((p) => p !== "");

/**
 * Two focusable elements are equivalent when:
 *   - both are links and their resolved hrefs match: origin and path, and the hash only if BOTH carry one; or
 *   - neither is a link, their accessible names match (and are not empty), and so do their form /
 *     aria-controls / data-track targets, which must NOT be empty (S11: empty against empty is no match).
 */
export function equivalent(a: FocusInfo, b: FocusInfo): boolean {
  if (a.href !== null || b.href !== null) {
    if (a.href === null || b.href === null) return false;
    const x = hrefParts(a.href);
    const y = hrefParts(b.href);
    if (!x || !y || x.base !== y.base) return false;
    return x.hash === "" || y.hash === "" || x.hash === y.hash;
  }
  return a.name !== "" && a.name === b.name && hasTarget(a.target) && a.target === b.target;
}

export type UnreachedVerdict = "allowed" | "listed" | "accepted" | "red";

/** S10: how one skip is judged. Only an unreached element goes through C1 or C2; everything else is red or allowed. */
export function unreachedVerdict(s: Skip, measured: readonly FocusInfo[]): UnreachedVerdict {
  if ((ALLOWED_SKIPS as readonly string[]).includes(s.reason)) return "allowed";
  if (s.reason !== UNREACHED) return "red";
  if (s.sizeOnly) return "listed";
  return measured.some((m) => equivalent(s, m)) ? "accepted" : "red";
}

// ── lines for the report (S14) ──────────────────────────────────────────────────────────────────────
export type RedParts = {
  label: string;
  part: string;
  headerState: string;
  tab: number | null;
  settle: string;
  kind: string;
  detail: string;
  raw: string;
  repro: string;
  sha: string;
};

/** One grep-able line per red: page, size, part, header state, tab number, settle record, raw values, repro, sha. */
export const redLine = (p: RedParts): string =>
  `T16 RED ${p.label} part=${p.part} header=${p.headerState} tab=${p.tab ?? "-"} kind=${p.kind} ${p.detail} settle=[${p.settle}] raw=[${p.raw}] repro="${p.repro}" walk=${p.sha}`;

export const settleRecord = (r: {
  settleFrames: number;
  settleMs: number;
  stillAnimating: number;
  scrollY0: number;
  scrollY1: number;
}): string =>
  `frames=${r.settleFrames} ms=${Math.round(r.settleMs)} animating=${r.stillAnimating} scrollY=${r.scrollY0}->${r.scrollY1} drift=${r.scrollY1 - r.scrollY0}`;

/** The keyboard repro for one read, from the page and size. */
export function reproOf(
  route: string,
  size: string,
  r: { how: string; tab: number | null; sel: string },
): string {
  const open = `open ${route} at ${size}, scroll to the top`;
  if (r.how === "menu-tab")
    return `${open}, open the menu with Enter on its button, press Tab ${r.tab ?? "?"} times`;
  if (r.how.startsWith("header-stop:"))
    return `${open}, scroll ${r.how.slice("header-stop:".length)} so its top is under the header, focus ${r.sel}`;
  if (r.how === "sweep") return `${open}, scroll to ${r.sel}`;
  return `${open}, press Tab ${r.tab ?? "?"} times`;
}

export type Problem = { kind: string; detail: string; raw: string };

/** What is red about one focus read (S4, S5, S10); an empty list is green. The row's own C2 exemption is `exempt`. */
export function readProblems(r: RingRead): Problem[] {
  const raw = `ring=${r.ring.style} ${r.ring.width}px ${r.ring.color}, backdrop=${r.backdrop ?? "unresolved"}, --rf-focus=${r.focusTok}, on-panel=${r.onPanel}`;
  if (r.state === "unsettled")
    return r.exempt
      ? []
      : [{ kind: "unsettled", detail: `${r.sel} still changing at the cap`, raw }];
  if (r.state === "obscured")
    return r.exempt
      ? []
      : [
          {
            kind: "obscured",
            detail: `${r.sel} is obscured (WCAG 2.4.11): ${r.obscuredBy ?? "unknown"}`,
            raw,
          },
        ];
  if (r.state === "focus-refused")
    return [{ kind: "focus-refused", detail: `${r.sel} refused focus`, raw }];
  const out: Problem[] = [];
  if (r.ring.style === "none" || r.ring.width <= 0)
    out.push({ kind: "no-outline", detail: `${r.sel}: no outline when focused`, raw });
  else if (r.backdrop === null)
    out.push({
      kind: "backdrop-unresolved",
      detail: `${r.sel}: band behind it unresolved (picture)`,
      raw,
    });
  else if ((r.ringContrast ?? 0) < 3)
    out.push({
      kind: "ring-contrast",
      detail: `${r.sel}: ${(r.ringContrast ?? 0).toFixed(2)} < 3`,
      raw,
    });
  if (r.bandDark && r.focusTok !== r.onPanel)
    out.push({
      kind: "band-token",
      detail: `${r.sel} is on a dark band but its --rf-focus is not the on-panel token`,
      raw,
    });
  return out;
}

/**
 * N2 (SA-1203 A13): the header states a page owes are the ones the scroll-through SAW, not a list. A state seen
 * and not reproduced at measure time is a walk failure; so is a reproduced state with no header row read in it.
 */
export function headerStateProblems(
  label: string,
  sha: string,
  o: { hasHeader: boolean; states: readonly HeaderSeen[]; headerRows: readonly RingRead[] },
): string[] {
  const out: string[] = [];
  const line = (headerState: string, detail: string) =>
    redLine({
      label,
      part: "header",
      headerState,
      tab: null,
      settle: "-",
      kind: "state-not-reached",
      detail,
      raw: `states=${o.states.length} headerRows=${o.headerRows.length}`,
      repro: `open ${label}, scroll from the top to the end and watch the header`,
      sha,
    });
  if (o.hasHeader && o.states.length === 0)
    out.push(line("-", "the scroll-through recorded no header state"));
  for (const st of o.states) {
    if (!st.reproduced)
      out.push(
        line(
          st.state,
          `header state ${st.state} was seen at scrollY ${st.scrollY} and could not be reproduced`,
        ),
      );
    else if (!o.headerRows.some((r) => r.headerState === st.state))
      out.push(line(st.state, `no header focusable was read in header state ${st.state}`));
  }
  return out;
}

/** S10: the problems of every unreached focusable, the count C1 accepted, and the unlisted ones. */
export function unreachedProblems(
  label: string,
  skipped: readonly Skip[],
  measured: readonly FocusInfo[],
  sha = "-",
): { problems: string[]; accepted: number; listed: number; unlisted: number } {
  const problems: string[] = [];
  let accepted = 0;
  let listed = 0;
  let unlisted = 0;
  for (const s of skipped) {
    const v = unreachedVerdict(s, measured);
    if (v === "accepted") accepted++;
    else if (v === "listed") listed++;
    else if (v === "red") {
      unlisted++;
      problems.push(
        redLine({
          label,
          part: s.part,
          headerState: "-",
          tab: null,
          settle: "-",
          kind: s.reason === UNREACHED ? UNREACHED : "not-measured",
          detail:
            s.reason === UNREACHED
              ? `${s.el} unreached and no equivalent measured`
              : `${s.el} not measured: ${s.reason}`,
          raw: `tag=${s.tag} href=${s.href ?? "-"} name=${s.name} target=${s.target}`,
          repro: `open ${label}, press Tab until the end: ${s.el} is never focused`,
          sha,
        }),
      );
    }
  }
  return { problems, accepted, listed, unlisted };
}

// ── clean / planted / clean comparison (S12) ────────────────────────────────────────────────────────
/** N1: the rows a plant may change, as one predicate per kind of row. A kind with no predicate may change nothing. */
export type RowSet = {
  ring?: (r: RingRead) => boolean;
  text?: (t: TextRow) => boolean;
  unreached?: (s: Skip) => boolean;
};
/** The default declared set: the rows that carry a plant key. */
export const KEYED_ROWS: RowSet = {
  ring: (r) => r.plant !== null,
  text: (t) => t.plant !== null,
  unreached: (s) => s.plant !== null,
};
/** Nothing may differ: two clean runs. */
export const NO_ROWS: RowSet = {};
/** How many rows of a walk a declared set covers (a set that covers none proves nothing). */
export function countInSet(w: Comparable, set: RowSet): number {
  return (
    w.rows.filter((r) => set.ring?.(r)).length +
    w.texts.filter((t) => set.text?.(t)).length +
    w.unreached.filter((u) => set.unreached?.(u)).length
  );
}
type Comparable = {
  rows: readonly RingRead[];
  texts: readonly TextRow[];
  unreached: readonly Skip[];
};

/**
 * One signature per row, keyed by part, header state, name and the occurrence of that name. Rows inside the
 * declared set are left out of BOTH runs, so a planted run may differ from a clean one inside that set only
 * (N1). Scroll and settle numbers are left out too: they are timing, not a verdict.
 */
export function signatures(w: Comparable, set: RowSet = NO_ROWS): Map<string, string> {
  const out = new Map<string, string>();
  const nth = new Map<string, number>();
  const put = (key: string, sig: string) => {
    const n = (nth.get(key) ?? 0) + 1;
    nth.set(key, n);
    out.set(`${key}#${n}`, sig);
  };
  for (const r of w.rows)
    if (!set.ring?.(r))
      put(
        `ring|${r.part}|${r.headerState}|${r.sel}`,
        [
          r.state,
          r.ring.style,
          r.ring.width,
          r.ring.color,
          r.backdrop,
          r.bandDark,
          r.focusTok,
        ].join("|"),
      );
  for (const t of w.texts)
    if (!set.text?.(t)) put(`text|${t.part}|${t.headerState}|${t.el}`, `${t.fg}|${t.bg}`);
  for (const s of w.unreached)
    if (!set.unreached?.(s)) put(`unreached|${s.part}|${s.el}`, `${s.reason}|${s.sizeOnly}`);
  return out;
}

/** The keys that differ, or exist on one side only. Empty means the two runs agree. */
export function diffSignatures(a: Map<string, string>, b: Map<string, string>): string[] {
  const keys = new Set([...a.keys(), ...b.keys()]);
  return [...keys].filter((k) => a.get(k) !== b.get(k)).sort();
}
