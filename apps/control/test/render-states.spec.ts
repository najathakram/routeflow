/**
 * WP6 T61 / R33: page states per ux-spec §5 — loading, empty lanes, stale source, malformed rows,
 * local mode, plus the client-side write states (pending / failed / conflict / undo) asserted on
 * the shipped assets. Contract as in render.spec.ts; `opts.loading` renders the boot skeleton.
 */
import * as fs from "fs";
import * as path from "path";

/* eslint-disable @typescript-eslint/no-explicit-any */
const R: any = () => require("../src/render/page");
const NOW = "2026-01-12T10:00:00Z";
const ASSETS = path.join(__dirname, "../src/render/assets");
const base = (): any =>
  JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/acme/state.json"), "utf8"));
const minutesAgo = (m: number) => new Date(Date.parse(NOW) - m * 60_000).toISOString();
const render = (s: any, o: any = {}) => R().renderPage(s, { now: NOW, ...o }) as string;
const read = (f: string) => fs.readFileSync(path.join(ASSETS, f), "utf8");

describe("T61 stale source", () => {
  it("fresh sources show no banner", () => {
    const h = render(base());
    expect(h).not.toMatch(/data-banner="stale"/);
    expect(h).not.toMatch(/has not updated for/);
  });
  it("amber chip (no banner) between 2 and 10 minutes", () => {
    const s = base();
    s.sources.github.lastOk = minutesAgo(5);
    const h = render(s);
    expect(h).not.toMatch(/data-banner="stale"/);
    expect(h).toMatch(/data-fresh="amber"/);
  });
  it("red banner over 10 minutes names the source and age", () => {
    const s = base();
    s.sources.github.lastOk = minutesAgo(11);
    const h = render(s);
    expect(h).toMatch(/data-banner="stale"/);
    expect(h).toContain(
      "GitHub has not updated for 11 minutes, so the numbers below may be out of date.",
    );
    expect(h).toMatch(/data-fresh="red"/);
    // inferred badges keep the last data but say it was detected earlier and may be out of date
    expect(h).toContain(
      'class="badge inf" title="#2801"><span aria-hidden="true">⟳</span> Detected earlier — may be out of date',
    );
    expect(h).not.toMatch(
      /class="badge inf"[^>]*>(?:<[^>]+>)*⟳(?:<[^>]+>)* Detected from GitHub or Railway/,
    );
    expect(h).toContain("Acme invoice date fixes"); // panels keep the last data
  });
});

describe("T61 malformed rows", () => {
  it("lists the 3 warnings including lane-b#14 and still renders every panel", () => {
    const s = base();
    s.warnings = [
      { lane: "lane-b", seq: 14, reason: "illegal transition planned -> released" },
      { lane: "lane-u", seq: 9, reason: "unknown task F-99" },
      { lane: "owner", seq: 2, reason: "bad payload" },
    ];
    const h = render(s);
    expect(h).toMatch(/data-banner="warnings"/);
    expect(h).toContain(
      "3 updates from the lanes could not be read — the rest of the page is fine.",
    );
    expect(h).toContain("lane-b #14</code>: illegal transition planned -&gt; released");
    expect(h).toContain("lane-u #9</code>: unknown task F-99");
    expect(h).toContain("owner #2</code>: bad payload");
    expect((h.match(/data-panel="/g) ?? []).length).toBe(12);
  });
  it("no warnings means no banner", () => {
    expect(render(base())).not.toMatch(/data-banner="warnings"/);
  });
});

describe("T61 empty lanes", () => {
  it("lane panel shows its empty copy and the header says so", () => {
    const s = base();
    s.lanes = {};
    const h = render(s);
    expect(h).toContain(
      "No lanes yet. A lane appears when a Claude session registers it with the ctl tool.",
    );
    expect(h).toContain("ctl");
    expect(h).toMatch(/data-line="now"[^>]*><span class="lbl">Lanes<\/span> No lanes yet</);
  });
});

describe("loading (first paint)", () => {
  it("renders skeleton rows and a warming-up footer, not stale zeros", () => {
    const h = render(base(), { loading: true });
    expect(h).toContain("Warming up — loading GitHub and Railway data.");
    expect(h).toMatch(/class="[^"]*skeleton/);
    expect((h.match(/data-panel="/g) ?? []).length).toBe(12);
  });
  it("keeps the dash placeholders under the plain labels and never claims all clear", () => {
    const h = render(base(), { loading: true });
    const head = h.slice(h.indexOf("<header"), h.indexOf("</header>"));
    for (const [key, label] of [
      ["now", "Lanes"],
      ["release", "Next release"],
      ["broken", "Bugs"],
      ["waste", "Work at risk"],
    ])
      expect(head).toContain(`data-line="${key}"><span class="lbl">${label}</span> —</p>`);
    expect(head).toContain("Loading the latest numbers");
    expect(head).not.toContain("All clear");
  });
});

describe("write-back states live in the shipped client (R18, R33)", () => {
  const js = () => read("client.js");
  it("client.js exists, is vanilla and <= 500 lines", () => {
    const t = js();
    expect(t.split("\n").length).toBeLessThanOrEqual(500);
    expect(t).not.toMatch(/\bimport\s|\brequire\(/);
  });
  it("uses SSE, ETag refetch and server-rendered fragments (never templates html)", () => {
    const t = js();
    expect(t).toContain("EventSource");
    expect(t).toContain("/api/stream");
    expect(t).toContain("/api/state.json");
    expect(t).toContain("fragments");
    expect(t).toContain("data-panel");
  });
  it("posts confirmed writes with token + expectedVersion and never updates optimistically", () => {
    const t = js();
    expect(t).toContain("/api/event");
    expect(t).toContain("X-Control-Token");
    expect(t).toContain("expectedVersion");
    expect(t).toMatch(/Not saved/); // failure copy, inline
    expect(t).toMatch(/409/);
    expect(t).toContain("Someone changed this at the same time, so the page was refreshed.");
    expect(t).toMatch(/Undo/);
    expect(t).toMatch(/aria-live|role="status"|role=.status./);
  });
  it("handles 401 (login), 429, SSE drop and Esc-to-close drawer", () => {
    const t = js();
    expect(t).toMatch(/401/);
    expect(t).toMatch(/429/);
    expect(t).toMatch(/onerror|addEventListener\(["']error["']/);
    expect(t).toMatch(/Escape/);
  });
});

describe("drawer and toast scaffolding in the page", () => {
  it("ships a dialog drawer, toast region and the section jump list", () => {
    const h = render(base());
    expect(h).toMatch(/id="drawer"[^>]*role="dialog"|role="dialog"[^>]*id="drawer"/);
    expect(h).toMatch(/id="toasts"/);
    expect(h).toMatch(/<nav[^>]*>[\s\S]*href="#[a-z-]+"/);
    expect(h).toContain("csrf"); // page embeds the write-back token for client.js
  });
});

describe("styles.css behaviour hooks", () => {
  it("has breakpoints, reduced-motion and dark scheme", () => {
    const c = read("styles.css");
    for (const bp of ["1400", "900", "480"]) expect(c).toContain(bp);
    expect(c).toContain("prefers-reduced-motion");
    expect(c).toContain("prefers-color-scheme: dark");
    expect(c).toMatch(/:focus-visible[\s\S]{0,120}2px/);
  });
});
