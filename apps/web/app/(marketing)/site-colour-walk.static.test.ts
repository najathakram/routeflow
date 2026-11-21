/**
 * @jest-environment node
 */
// SA-1203 A12, the static half of the T16 walk: the exemption list and its pins (C2, K3, W13), the equivalence
// rule (C1, S11), the verdicts the walk reaches (S4, S5, S8, S10), the report lines (S14), and what the walk's
// source may and may not do (S1, S3, S5, S13). The browser half runs in the slot (spec 85, plants in spec 96).
import * as fs from "node:fs";
import * as path from "node:path";
import {
  ALLOWED_SKIPS,
  CROPS_PER_PAGE,
  CROPS_PER_RUN,
  EXEMPT_STATES,
  MIN_TEXT_ELEMENTS,
  PLANTS_TEST_HARD_MS,
  SETTLE_CAP_MS,
  SETTLE_STABLE_FRAMES,
  T16_SIZE_ONLY,
  T16_SIZE_ONLY_LENGTH,
  WALK_BUDGET_MS,
  WALK_RUN_HARD_MS,
  diffSignatures,
  equivalent,
  headerStateProblems,
  hrefParts,
  readProblems,
  redLine,
  reproOf,
  settleRecord,
  signatures,
  sizeOnlyEntryProblems,
  sizeOnlyLengthOk,
  staleExemptions,
  unreachedProblems,
  unreachedVerdict,
  type FocusInfo,
  type RingRead,
  type Skip,
  type TextRow,
} from "../../e2e/helpers/site-colour-walk-pure";

const link = (href: string, el = "a.x"): FocusInfo => ({
  el,
  tag: "a",
  href,
  name: "Sign up",
  target: "||",
});
const button = (name: string, target = "||", el = "button.x"): FocusInfo => ({
  el,
  tag: "button",
  href: null,
  name,
  target,
});
const skipped = (i: FocusInfo, reason = "unreached", sizeOnly = false): Skip => ({
  ...i,
  reason,
  part: "page",
  sizeOnly,
  plant: null,
});
const read = (over: Partial<RingRead> = {}): RingRead => ({
  sel: 'a.x "Go"',
  part: "page",
  headerState: "light",
  state: "measured",
  tab: 3,
  how: "tab",
  info: link("https://a.test/go", 'a.x "Go"'),
  plant: null,
  ring: { style: "solid", width: 3, color: "rgb(17, 17, 17)", offset: 2 },
  backdrop: "rgb(255, 255, 255)",
  ringContrast: 18,
  bandDark: false,
  focusTok: "rgb(17, 17, 17)",
  onPanel: "rgb(255, 255, 255)",
  scrollY0: 100,
  scrollY1: 100,
  settleFrames: 3,
  settleMs: 50,
  stillAnimating: 0,
  inView: true,
  obscuredBy: null,
  rect: { x: 10, y: 20, w: 80, h: 24 },
  exempt: false,
  stepMs: 90,
  ...over,
});

const WEB = path.resolve(__dirname, "..", "..");
const source = (rel: string): string => fs.readFileSync(path.join(WEB, rel), "utf8");
/** The source without comments, so a rule about code is not tripped by a sentence about it. */
const stripComments = (s: string): string =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s\/\/[^\n]*$/gm, "");
/** The text of the `{ ... }` that opens first after `from`, by brace matching. */
const blockAfter = (s: string, from: number): string => {
  const open = s.indexOf("{", from);
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}" && --depth === 0) return s.slice(open, i + 1);
  }
  return "";
};

describe("W13 (SA-1203 A12 K4): the T16_SIZE_ONLY exemption list starts empty and its length is pinned", () => {
  it("is empty", () => {
    expect(T16_SIZE_ONLY).toHaveLength(0);
    expect(T16_SIZE_ONLY_LENGTH).toBe(0);
    expect(sizeOnlyLengthOk(T16_SIZE_ONLY)).toBe(true);
    expect(sizeOnlyEntryProblems(T16_SIZE_ONLY)).toEqual([]);
  });

  it("W13: a list with one added entry turns the length pin red", () => {
    const planted = [
      {
        page: "/",
        size: "1440x900",
        selector: "a.desktop-only",
        state: "not-rendered",
        reason: "a desktop-only link",
      },
    ];
    expect(sizeOnlyLengthOk(planted)).toBe(false);
    expect(sizeOnlyEntryProblems(planted)).toEqual([]);
  });

  it("W13 (K3): an entry with no state, or a state outside the four, is red", () => {
    expect(EXEMPT_STATES).toEqual(["not-rendered", "obscured", "unsettled", "text-unread"]);
    const noState = [{ page: "/", size: "1440x900", selector: "a.x", reason: "no state" }];
    expect(sizeOnlyEntryProblems(noState)).toHaveLength(1);
    expect(sizeOnlyEntryProblems(noState)[0]).toContain("has no valid state");
    expect(
      sizeOnlyEntryProblems([{ page: "/", selector: "a.x", state: "everything" }]),
    ).toHaveLength(1);
  });

  it("K3: an entry whose state was not seen in the run is red as stale-exemption", () => {
    const entries = [
      { selector: "a.marquee", state: "unsettled" },
      { selector: "a.desktop", state: "not-rendered" },
    ];
    expect(staleExemptions("/ 1440x900", entries, [2, 0])).toEqual([
      "T16 / 1440x900: stale-exemption a.desktop (not-rendered): the state was not seen in this run",
    ]);
    expect(staleExemptions("/ 1440x900", entries, [1, 1])).toEqual([]);
    expect(staleExemptions("/ 1440x900", [], [])).toEqual([]);
  });
});

describe("C1 + S11: an unreached focusable passes only through an equivalent measured element", () => {
  it("links: the same origin and path match; a different path or origin does not", () => {
    expect(equivalent(link("https://a.test/signup"), link("https://a.test/signup"))).toBe(true);
    expect(equivalent(link("https://a.test/signup?x=1"), link("https://a.test/signup"))).toBe(true);
    expect(equivalent(link("https://a.test/signup"), link("https://a.test/login"))).toBe(false);
    expect(equivalent(link("https://a.test/signup"), link("https://b.test/signup"))).toBe(false);
  });

  it("links: the hash counts only when both carry one", () => {
    expect(equivalent(link("https://a.test/p#one"), link("https://a.test/p"))).toBe(true);
    expect(equivalent(link("https://a.test/p"), link("https://a.test/p#one"))).toBe(true);
    expect(equivalent(link("https://a.test/p#one"), link("https://a.test/p#one"))).toBe(true);
    expect(equivalent(link("https://a.test/p#one"), link("https://a.test/p#two"))).toBe(false);
    expect(hrefParts("https://a.test/p#")?.hash).toBe("");
    expect(hrefParts("not a url")).toBeNull();
  });

  it("buttons: the name AND a non-empty, equal form / aria-controls / data-track target must match", () => {
    expect(equivalent(button("Menu", "|nav|"), button("Menu", "|nav|"))).toBe(true);
    expect(equivalent(button("Menu", "|nav|"), button("Menu", "|other|"))).toBe(false);
    expect(equivalent(button("Menu", "|nav|"), button("Close", "|nav|"))).toBe(false);
    expect(equivalent(button("", "||"), button("", "||"))).toBe(false);
  });

  it('S11 (the L1 fix): empty against empty is no match, so a target of "||" never makes two buttons equivalent', () => {
    expect(equivalent(button("Send", "||"), button("Send", "||"))).toBe(false);
    expect(equivalent(button("Send", ""), button("Send", ""))).toBe(false);
    expect(equivalent(button("Send", "||data-x"), button("Send", "||data-x"))).toBe(true);
  });

  it("a link is never equivalent to a button", () => {
    expect(equivalent(link("https://a.test/x"), button("Sign up"))).toBe(false);
  });
});

describe("S10: the verdict on every focusable nothing reached", () => {
  const measured = [link("https://a.test/signup", "a.header")];

  it("W2: with no equivalent measured and no entry, the skip is red with the exact line", () => {
    const s = skipped(link("https://a.test/only", 'a.nav "Only"'));
    expect(unreachedVerdict(s, measured)).toBe("red");
    const r = unreachedProblems("/ 1440x900", [s], measured, "abc1234567");
    expect(r.unlisted).toBe(1);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toContain("T16 RED / 1440x900 part=page");
    expect(r.problems[0]).toContain('a.nav "Only" unreached and no equivalent measured');
    expect(r.problems[0]).toContain("walk=abc1234567");
  });

  it("C1: an equivalent measured element accepts the skip and it is counted", () => {
    const s = skipped(link("https://a.test/signup#hero", "a.hero"));
    expect(unreachedVerdict(s, measured)).toBe("accepted");
    expect(unreachedProblems("p", [s], measured)).toMatchObject({
      problems: [],
      accepted: 1,
      unlisted: 0,
    });
  });

  it("C2: a T16_SIZE_ONLY entry lists the skip; it is never an equivalent", () => {
    const s = skipped(link("https://a.test/x"), "unreached", true);
    expect(unreachedVerdict(s, [])).toBe("listed");
    expect(unreachedProblems("p", [s], [])).toMatchObject({ problems: [], listed: 1 });
  });

  it("W10: two empty-target buttons with the same name are not an equivalent, so the skip is red", () => {
    const s = skipped(button("Send", "||", "button.hidden"));
    expect(unreachedVerdict(s, [button("Send", "||", "button.shown")])).toBe("red");
  });

  it("the allowed reasons pass; any other reason is red", () => {
    expect(ALLOWED_SKIPS).toEqual(["disabled", "inert", "closed-dialog"]);
    const i = button("Go");
    for (const reason of ALLOWED_SKIPS)
      expect(unreachedVerdict(skipped(i, reason), [])).toBe("allowed");
    expect(unreachedVerdict(skipped(i, "anything-new"), [])).toBe("red");
    expect(unreachedProblems("p", [skipped(i, "disabled")], []).problems).toEqual([]);
  });
});

describe("S4 + S5 + S10: what is red about one focus read", () => {
  it("a measured read with a 3:1 ring and the right token is green", () => {
    expect(readProblems(read())).toEqual([]);
    expect(readProblems(read({ ringContrast: 3 }))).toEqual([]);
  });

  it("W1: a ring below 3:1 against its backdrop is red", () => {
    const p = readProblems(
      read({ ringContrast: 1, ring: { ...read().ring, color: "rgb(255, 255, 255)" } }),
    );
    expect(p.map((x) => x.kind)).toEqual(["ring-contrast"]);
    expect(p[0]?.detail).toContain("1.00 < 3");
  });

  it("W3: a ring that is not drawn is red", () => {
    const p = readProblems(
      read({ ringContrast: 0, ring: { ...read().ring, style: "none", width: 0 } }),
    );
    expect(p.map((x) => x.kind)).toEqual(["no-outline"]);
  });

  it("S4: on a dark band the live --rf-focus must be the on-panel token, and the ring must still reach 3:1", () => {
    const dark = { bandDark: true, backdrop: "rgb(17, 17, 17)" };
    expect(
      readProblems(read({ ...dark, focusTok: "rgb(255, 255, 255)", ringContrast: 18 })),
    ).toEqual([]);
    const ink = readProblems(read({ ...dark, focusTok: "rgb(17, 17, 17)", ringContrast: 1 }));
    expect(ink.map((x) => x.kind)).toEqual(["ring-contrast", "band-token"]);
  });

  it("S4: an unresolved backdrop (a picture) is red", () => {
    expect(readProblems(read({ backdrop: null, ringContrast: null })).map((x) => x.kind)).toEqual([
      "backdrop-unresolved",
    ]);
  });

  it("S5: obscured and unsettled are red, unless the row has its own C2 entry", () => {
    const obscured = read({ state: "obscured", obscuredBy: "header.site-header" });
    expect(readProblems(obscured).map((x) => x.kind)).toEqual(["obscured"]);
    expect(readProblems(obscured)[0]?.detail).toContain("WCAG 2.4.11");
    expect(readProblems({ ...obscured, exempt: true })).toEqual([]);
    expect(readProblems(read({ state: "unsettled" })).map((x) => x.kind)).toEqual(["unsettled"]);
    expect(readProblems(read({ state: "unsettled", exempt: true }))).toEqual([]);
    expect(readProblems(read({ state: "focus-refused" })).map((x) => x.kind)).toEqual([
      "focus-refused",
    ]);
  });
});

describe("S8: the header states a page must reach", () => {
  const h = (headerState: "light" | "dark") => read({ part: "header", headerState });
  it("a page with a band and a header read in both states is green", () => {
    expect(
      headerStateProblems("/ 1440x900", { bands: 2, headerRows: [h("light"), h("dark")] }),
    ).toEqual([]);
  });
  it("a band that never turns the header dark is state-not-reached", () => {
    const p = headerStateProblems("/ 1440x900", { bands: 1, headerRows: [h("light")] });
    expect(p).toHaveLength(1);
    expect(p[0]).toContain("state-not-reached");
    expect(p[0]).toContain("on-dark");
  });
  it("a header never read in the light state is state-not-reached; a page with no band owes no dark state", () => {
    expect(headerStateProblems("p", { bands: 0, headerRows: [h("dark")] })[0]).toContain("light");
    expect(headerStateProblems("p", { bands: 0, headerRows: [h("light")] })).toEqual([]);
    expect(headerStateProblems("p", { bands: 3, headerRows: [] })).toHaveLength(1);
  });
});

describe("S14: one grep-able line per red", () => {
  it("carries the page, size, part, header state, tab, settle record, raw values, repro and walk sha", () => {
    const r = read({
      scrollY0: 100,
      scrollY1: 140,
      settleFrames: 5,
      settleMs: 83.4,
      stillAnimating: 1,
    });
    expect(settleRecord(r)).toBe("frames=5 ms=83 animating=1 scrollY=100->140 drift=40");
    const line = redLine({
      label: "/pricing 1440x900",
      part: "header",
      headerState: "dark",
      tab: 7,
      settle: settleRecord(r),
      kind: "ring-contrast",
      detail: "a.x: 1.00 < 3",
      raw: "ring=solid 3px",
      repro: reproOf("/pricing", "1440x900", r),
      sha: "abc1234567",
    });
    expect(
      line.startsWith("T16 RED /pricing 1440x900 part=header header=dark tab=7 kind=ring-contrast"),
    ).toBe(true);
    expect(line).toContain("settle=[frames=5");
    expect(line).toContain(
      'repro="open /pricing at 1440x900, scroll to the top, press Tab 3 times"',
    );
    expect(line.endsWith("walk=abc1234567")).toBe(true);
    expect(line.includes("\n")).toBe(false);
  });

  it("the repro names how the stop was reached", () => {
    expect(reproOf("/", "390x844", { how: "menu-tab", tab: 2, sel: "a" })).toContain(
      "open the menu with Enter",
    );
    expect(
      reproOf("/", "1440x900", { how: "header-stop:section.pb", tab: null, sel: "a.brand" }),
    ).toContain("scroll section.pb so its top is under the header");
  });
});

describe("S12: clean, planted, clean compare on rows that carry no plant", () => {
  const texts: TextRow[] = [];
  const w = (rows: RingRead[]) => ({ rows, texts, unreached: [] as Skip[] });
  it("two identical runs agree; a changed verdict on an unkeyed row is named", () => {
    const a = w([read(), read({ sel: 'a.y "Two"' })]);
    const b = w([read(), read({ sel: 'a.y "Two"' })]);
    expect(diffSignatures(signatures(a), signatures(b))).toEqual([]);
    const c = w([
      read(),
      read({ sel: 'a.y "Two"', ring: { ...read().ring, color: "rgb(1, 2, 3)" } }),
    ]);
    expect(diffSignatures(signatures(a), signatures(c))).toHaveLength(1);
  });
  it("a keyed row (it carries a plant) may differ or exist on one side only", () => {
    const clean = w([read()]);
    const planted = w([read(), read({ sel: 'a.p "Plant"', plant: "W1", ringContrast: 1 })]);
    expect(diffSignatures(signatures(planted), signatures(clean))).toEqual([]);
  });
  it("timing is not a verdict: scroll and settle numbers are left out", () => {
    const a = w([read({ settleMs: 40, scrollY1: 100 })]);
    const b = w([read({ settleMs: 900, scrollY1: 500, tab: 9 })]);
    expect(diffSignatures(signatures(a), signatures(b))).toEqual([]);
  });
});

describe("S3 + S13: the budgets", () => {
  it("are the architect's numbers", () => {
    expect(SETTLE_CAP_MS).toBe(1200);
    expect(SETTLE_STABLE_FRAMES).toBe(3);
    expect(WALK_BUDGET_MS).toBe(60_000);
    expect(WALK_RUN_HARD_MS).toBe(15 * 60_000);
    expect(PLANTS_TEST_HARD_MS).toBe(6 * 60_000);
    expect(CROPS_PER_PAGE).toBe(3);
    expect(CROPS_PER_RUN).toBe(30);
  });
  it("K2: the floor of 50 counts text rows", () => {
    expect(MIN_TEXT_ELEMENTS).toBe(50);
  });
});

describe("S1 + S3 + S5 + S13: what the walk's source may do", () => {
  const walk = stripComments(source("e2e/helpers/site-colour-walk.ts"));

  it("S1: one reader, settleThenRead, defined once; the old band collection and its end-of-part reads are gone", () => {
    expect(walk.match(/(?:const|function)\s+settleThenRead\b/g)).toHaveLength(1);
    expect(walk).not.toContain("__t16Bands");
    expect(walk).not.toMatch(/\bcollectBands\b|\bwalkPart\b|\bbandsOf\b|\bprepare\(/);
  });

  it("S3: nothing is paused, finished, cancelled or sped up (array reverse in bgOf is not an animation call), and no reduced motion is emulated", () => {
    expect(walk).not.toMatch(/document\s*\.\s*getAnimations/);
    expect(walk).not.toMatch(/\.(pause|finish|cancel|updatePlaybackRate)\s*\(/);
    expect(walk).not.toMatch(/playbackRate|reducedMotion|prefers-reduced-motion/);
    const calls = walk.match(/getAnimations\(/g) ?? [];
    const scoped = walk.match(/getAnimations\(\{ subtree: false \}\)/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    expect(scoped).toHaveLength(calls.length);
  });

  it("S5: settleThenRead writes no scroll; the walk's scroll writes are the sweep, the dark stops and the top", () => {
    const at = walk.search(/const settleThenRead\s*=/);
    expect(at).toBeGreaterThan(0);
    const body = blockAfter(walk, at);
    expect(body.length).toBeGreaterThan(500);
    expect(body).not.toMatch(/scrollTo|scrollIntoView|scrollBy|\.scroll\(|scrollTop\s*=/);
    const writers = walk.match(/scrollTo\(|scrollIntoView\(|scrollBy\(/g) ?? [];
    expect(writers).toHaveLength(4);
  });

  it("S13: each walk runs in its own browser, closed in a finally and killed by a hard timer; crops go under local-assets", () => {
    expect(walk).toMatch(/finally\s*\{[^}]*browser\.close\(\)/);
    expect(walk).toMatch(/setTimeout\(\s*\(\) => void browser\.close\(\)/);
    expect(walk).toContain('"local-assets"');
    expect(walk).toMatch(/animations:\s*"allow"/);
  });

  it("the site carries no test hook for the walk", () => {
    for (const rel of [
      "public/site/js/site.js",
      "public/site/js/chrome.js",
      "public/site/js/home-up.js",
      "public/site/graphics/rf-wheel-up.js",
    ]) {
      const js = source(rel);
      expect({ rel, hook: /__t16|__sp\b|data-t16/.test(js) }).toEqual({ rel, hook: false });
    }
  });
});

describe("S12: spec 96 defines no test unless T16_PLANTS=1", () => {
  const spec = stripComments(source("e2e/96-site-t16-plants.spec.ts"));
  it("every test is inside the T16_PLANTS guard, and none asserts 'some problem of this kind'", () => {
    const guard = spec.indexOf('if (process.env.T16_PLANTS === "1") {');
    expect(guard).toBeGreaterThan(0);
    const first = spec.search(/\btest(?:\.describe)?[.(]/);
    expect(first).toBeGreaterThan(guard);
    expect(spec).not.toMatch(/\bhas\(problems|accepted\)\.toBeGreaterThanOrEqual|rings\.length/);
  });

  it("every plant asserts its own keyed row: W1-W12, B1 and SNAP-real are all present", () => {
    for (const id of [
      "W1",
      "W2",
      "W3",
      "W4",
      "W5",
      "W6",
      "W7",
      "W8",
      "W9",
      "W10",
      "W11",
      "W12",
      "B1",
    ])
      expect({ id, found: spec.includes(`"${id}"`) || spec.includes(` ${id} `) }).toEqual({
        id,
        found: true,
      });
    expect(spec).toContain("SNAP-real");
  });
});
