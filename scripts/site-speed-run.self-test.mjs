#!/usr/bin/env node
// Self-test for scripts/site-speed-run.mjs. Injected fakes only: a fake fetcher, a fake gzip (the
// size of the body, so a fixture's weight is its byte count), a fake probe returning canned entries,
// a fake image-label reader and a fake clock. No browser, no Docker, no stack, no network.
// Plain node; exit 0 when every case passes, 1 otherwise. Every case asserts the exit code.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DIRTY_LABEL, SHA_LABEL } from "./lib/proof-stack.mjs";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  PAGES,
  PreflightError,
  loadBudget,
  loadStaticRoutes,
  parseArgs,
  runSpeedRun,
  waitForMenuOpen,
} from "./site-speed-run.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHA = "a".repeat(40);
const KB = 1024;

// The numbers the fakes are measured against: the real budget file, read as text.
const budget = loadBudget();

const bytes = (kbs) => Buffer.alloc(Math.round(kbs * KB), 97);
const tag = (s) => Buffer.from(s);

/** A site where every page is small and passes. `over` replaces or adds files; `html` replaces a page. */
function fakeSite({ over = {}, html = {}, status = {} } = {}) {
  const files = {
    "/login": tag("login"),
    "/site/css/site.css": Buffer.concat([
      tag('@font-face{src:url("../fonts/geist.woff2") format("woff2")}'),
      bytes(10),
    ]),
    "/site/js/chrome.js": bytes(10),
    "/site/js/first-touch.js": bytes(0.5),
    "/site/analytics.js": bytes(1),
    "/site/img/mark.png": bytes(3),
    "/site/fonts/geist.woff2": bytes(20),
    ...over,
  };
  const page = (route) => {
    if (html[route] !== undefined) return html[route];
    const scripts =
      route === "/landing"
        ? '<script defer src="/site/js/first-touch.js"></script>'
        : '<script defer src="/site/js/chrome.js"></script><script src="/site/js/first-touch.js" defer></script>';
    return (
      `<html><head><link rel="stylesheet" href="/site/css/site.css">` +
      `<link rel="preload" href="/site/fonts/geist.woff2" as="font"></head>` +
      `<body><img width="8" height="8" src="/site/img/mark.png">${scripts}</body></html>`
    );
  };
  const calls = [];
  const fetcher = async (url, { acceptEncoding }) => {
    const p = new URL(url).pathname;
    calls.push({ path: p, acceptEncoding });
    if (status[p] !== undefined)
      return { status: status[p], contentType: "text/html", body: tag("") };
    if (PAGES.includes(p))
      return { status: 200, contentType: "text/html; charset=utf-8", body: tag(page(p)) };
    if (files[p]) return { status: 200, contentType: "application/octet-stream", body: files[p] };
    return { status: 404, contentType: "text/plain", body: tag("") };
  };
  return { fetcher, calls };
}

const goodRaw = (width, extra = {}) => ({
  lcpMs: width === "phone" ? 1800 : 900,
  lcpEntries: 1,
  cls: 0.01,
  tbtMs: 40,
  ...(width === "phone"
    ? { menu: { hasButton: true, expanded: true, clickMs: 96, firstInputMs: null } }
    : {}),
  ...extra,
});

/** A fake probe. `make(call)` returns the raw entries of one sample. */
function fakeProbe(make = (c) => goodRaw(c.width)) {
  const samples = [];
  const warms = [];
  return {
    samples,
    warms,
    sample: async (c) => {
      samples.push(c);
      return make({
        ...c,
        n: samples.filter((s) => s.route === c.route && s.width === c.width).length,
      });
    },
    warmNavigate: async (c) => {
      warms.push(c);
    },
  };
}

function deps({
  site = fakeSite(),
  probe = fakeProbe(),
  labels,
  ancestor = true,
  staticRoutes,
} = {}) {
  const sleeps = [];
  const sleepAt = [];
  const log = [];
  let dockerCalls = 0;
  return {
    d: {
      fetcher: site.fetcher,
      gzipSize: (buf) => buf.length,
      probe,
      budget,
      readImageLabels: () => {
        dockerCalls++;
        return { labels: labels ?? { [SHA_LABEL]: SHA, [DIRTY_LABEL]: "false" } };
      },
      isAncestor: () => ancestor,
      headSha: () => SHA,
      clock: {
        now: () => new Date("2026-11-21T00:00:00Z"),
        sleep: async (ms) => {
          sleeps.push(ms);
          sleepAt.push(log.filter((l) => l.startsWith("T43")).length);
        },
      },
      host: { cpus: 4, node: "test" },
      staticRoutes: staticRoutes ?? PAGES,
      log: (l) => log.push(l),
    },
    sleeps,
    sleepAt,
    log,
    docker: () => dockerCalls,
  };
}

const opts = (extra = {}) => ({ ...parseArgs([]), sha: SHA, ...extra });

const cases = [];
const test = (name, fn) => cases.push({ name, fn });
const eq = (got, want, what) => {
  if (JSON.stringify(got) !== JSON.stringify(want))
    throw new Error(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
};

test("all-pass: ten pages, both widths, exit 0", async () => {
  const x = deps();
  const { exit, result } = await runSpeedRun(opts(), x.d);
  eq(exit, 0, "exit");
  eq(result.t43.length, 10, "t43 rows");
  eq(result.t44.length, 20, "t44 rows");
  eq(result.misses, [], "misses");
});

test("a 200 KB page exits 1 and names the total", async () => {
  const x = deps({
    site: fakeSite({
      over: { "/site/img/big.webp": bytes(200) },
      html: {
        "/pricing":
          '<html><link rel="stylesheet" href="/site/css/site.css"><img src="/site/img/big.webp"></html>',
      },
    }),
  });
  const { exit, result } = await runSpeedRun(opts({ only: "bytes" }), x.d);
  eq(exit, 1, "exit");
  if (!result.misses.some((m) => m.includes("/pricing total"))) throw new Error("no total miss");
});

test("the total cap is >, not >=: exactly 115 KB passes, one byte more misses", async () => {
  // html 5 + css 10 + first-touch 0.5 + analytics 1 (fetched directly) + a pad svg = 115 KB exactly.
  const head =
    '<html><link rel="stylesheet" href="/site/css/site.css"><img src="/site/img/pad.svg">' +
    '<script src="/site/js/first-touch.js"></script>';
  const html = head + " ".repeat(5 * KB - Buffer.byteLength(head));
  const run = async (padKb, extra = 0) => {
    const site = fakeSite({
      html: { "/pricing": html },
      over: {
        "/site/css/site.css": bytes(10),
        "/site/img/pad.svg": Buffer.alloc(Math.round(padKb * KB) + extra, 97),
      },
    });
    return runSpeedRun(opts({ only: "bytes", pages: ["/pricing"] }), deps({ site }).d);
  };
  const at = await run(98.5);
  if (at.result.misses.some((m) => m.includes("total"))) throw new Error("total missed at the cap");
  const over = await run(98.5, 1);
  if (!over.result.misses.some((m) => m.includes("total"))) throw new Error("no total miss");
});

test("a non-local URL exits 2 before any fetch, probe or docker call", async () => {
  const site = fakeSite();
  const probe = fakeProbe();
  const x = deps({ site, probe });
  const { exit } = await runSpeedRun(opts({ baseUrl: "https://example.com" }), x.d);
  eq(exit, 2, "exit");
  eq(site.calls.length, 0, "fetches");
  eq(probe.samples.length + probe.warms.length, 0, "probe calls");
  eq(x.docker(), 0, "docker calls");
});

test("local hosts are accepted: localhost, 127.0.0.1, [::1], *.localhost", async () => {
  for (const u of [
    "http://localhost:3001",
    "http://127.0.0.1:3001",
    "http://[::1]:3001",
    "http://shop.localhost:3001",
  ]) {
    const { exit } = await runSpeedRun(opts({ baseUrl: u, only: "bytes" }), deps().d);
    eq(exit, 0, u);
  }
  const { exit } = await runSpeedRun(opts({ baseUrl: "http://localhost.evil.test" }), deps().d);
  eq(exit, 2, "lookalike host");
});

test("a stubbed 0-entry LCP exits 2 (an error, not a skipped sample)", async () => {
  const probe = fakeProbe((c) => goodRaw(c.width, { lcpEntries: 0, lcpMs: 0 }));
  const { exit, result } = await runSpeedRun(opts({ only: "timing" }), deps({ probe }).d);
  eq(exit, 2, "exit");
  if (!/no LCP entry/.test(result.error)) throw new Error(`unexpected error ${result.error}`);
});

test("menu opened but no click or first-input entry: '<16 ms, ok', exit 0", async () => {
  const probe = fakeProbe((c) =>
    c.width === "phone"
      ? goodRaw("phone", {
          menu: { hasButton: true, expanded: true, clickMs: null, firstInputMs: null },
        })
      : goodRaw("desktop"),
  );
  const x = deps({ probe });
  const { exit, result } = await runSpeedRun(opts({ only: "timing" }), x.d);
  eq(exit, 0, "exit");
  const phone = result.t44.find((r) => r.width === "phone");
  eq(phone.tapLabel, "<16 ms, ok", "label");
  eq(phone.median.tap, 0, "counted as 0 ms in the median");
  eq(phone.runs[0].tap, "<16 ms, ok", "run label");
});

test("no click entry but a first-input entry: the first-input duration is the tap", async () => {
  const probe = fakeProbe((c) =>
    c.width === "phone"
      ? goodRaw("phone", {
          menu: { hasButton: true, expanded: true, clickMs: null, firstInputMs: 250 },
        })
      : goodRaw("desktop"),
  );
  const { exit, result } = await runSpeedRun(
    opts({ only: "timing", pages: ["/pricing"] }),
    deps({ probe }).d,
  );
  eq(exit, 1, "exit");
  eq(result.t44.find((r) => r.width === "phone").median.tap, 250, "tap");
});

test("the menu did not open: exit 1", async () => {
  const probe = fakeProbe((c) =>
    c.width === "phone"
      ? goodRaw("phone", {
          menu: { hasButton: true, expanded: false, clickMs: null, firstInputMs: null },
        })
      : goodRaw("desktop"),
  );
  const { exit, result } = await runSpeedRun(
    opts({ only: "timing", pages: ["/"] }),
    deps({ probe }).d,
  );
  eq(exit, 1, "exit");
  if (!result.misses.some((m) => /did not open/.test(m))) throw new Error("no open miss");
});

test("no .menu-btn at 390: exit 1", async () => {
  const probe = fakeProbe((c) =>
    c.width === "phone"
      ? goodRaw("phone", { menu: { hasButton: false, expanded: false } })
      : goodRaw("desktop"),
  );
  const { exit, result } = await runSpeedRun(
    opts({ only: "timing", pages: ["/"] }),
    deps({ probe }).d,
  );
  eq(exit, 1, "exit");
  if (!result.misses.some((m) => /no \.menu-btn/.test(m))) throw new Error("no button miss");
});

test("a tap over 200 ms misses (median of the three)", async () => {
  const probe = fakeProbe((c) =>
    c.width === "phone"
      ? goodRaw("phone", { menu: { hasButton: true, expanded: true, clickMs: 260 } })
      : goodRaw("desktop"),
  );
  const { exit } = await runSpeedRun(opts({ only: "timing", pages: ["/"] }), deps({ probe }).d);
  eq(exit, 1, "exit");
});

test("a tap of exactly 200 ms passes (the cap is >, not >=)", async () => {
  const probe = fakeProbe((c) =>
    c.width === "phone"
      ? goodRaw("phone", { menu: { hasButton: true, expanded: true, clickMs: 200 } })
      : goodRaw("desktop"),
  );
  const { exit } = await runSpeedRun(opts({ only: "timing", pages: ["/"] }), deps({ probe }).d);
  eq(exit, 0, "exit");
});

test("a dirty image exits 2", async () => {
  const x = deps({ labels: { [SHA_LABEL]: SHA, [DIRTY_LABEL]: "true" } });
  const { exit, result } = await runSpeedRun(opts(), x.d);
  eq(exit, 2, "exit");
  if (!/dirty/.test(result.error)) throw new Error(result.error);
});

test("an image without the dirty label exits 2", async () => {
  const x = deps({ labels: { [SHA_LABEL]: SHA } });
  eq((await runSpeedRun(opts(), x.d)).exit, 2, "exit");
});

test("an image that does not include the sha exits 2", async () => {
  const x = deps({
    labels: { [SHA_LABEL]: "b".repeat(40), [DIRTY_LABEL]: "false" },
    ancestor: false,
  });
  eq((await runSpeedRun(opts(), x.d)).exit, 2, "exit");
});

test("an image built from a descendant of the sha is accepted", async () => {
  const x = deps({
    labels: { [SHA_LABEL]: "b".repeat(40), [DIRTY_LABEL]: "false" },
    ancestor: true,
  });
  eq((await runSpeedRun(opts({ only: "bytes" }), x.d)).exit, 0, "exit");
});

test("an unlabelled image or a docker error exits 2", async () => {
  const x = deps({ labels: {} });
  eq((await runSpeedRun(opts(), x.d)).exit, 2, "unlabelled");
  const y = deps();
  y.d.readImageLabels = () => ({ error: "cannot inspect" });
  eq((await runSpeedRun(opts(), y.d)).exit, 2, "docker error");
});

test("a page that answers 500 exits 2 and nothing is measured", async () => {
  const probe = fakeProbe();
  const x = deps({ site: fakeSite({ status: { "/security": 500 } }), probe });
  eq((await runSpeedRun(opts(), x.d)).exit, 2, "exit");
  eq(probe.samples.length, 0, "samples");
});

test("/login not 200 exits 2", async () => {
  const x = deps({ site: fakeSite({ status: { "/login": 503 } }) });
  eq((await runSpeedRun(opts(), x.d)).exit, 2, "exit");
});

test("a linked file outside /site/ exits 2", async () => {
  const html = '<html><link rel="stylesheet" href="/other/a.css"></html>';
  const x = deps({ site: fakeSite({ html: { "/company": html } }) });
  eq((await runSpeedRun(opts({ only: "bytes" }), x.d)).exit, 2, "exit");
});

test("a page with zero linked files exits 2, never a skip", async () => {
  const x = deps({ site: fakeSite({ html: { "/contact": "<html><body>hi</body></html>" } }) });
  eq((await runSpeedRun(opts({ only: "bytes" }), x.d)).exit, 2, "exit");
});

test("a linked file that 404s exits 2", async () => {
  const html = '<html><link rel="stylesheet" href="/site/css/gone.css"></html>';
  const x = deps({ site: fakeSite({ html: { "/contact": html } }) });
  eq((await runSpeedRun(opts({ only: "bytes" }), x.d)).exit, 2, "exit");
});

test("landing: any own script is a miss (exit 1)", async () => {
  const html =
    '<html><link rel="stylesheet" href="/site/css/site.css"><script src="/site/js/chrome.js"></script></html>';
  const x = deps({ site: fakeSite({ html: { "/landing": html } }) });
  const { exit, result } = await runSpeedRun(opts({ only: "bytes" }), x.d);
  eq(exit, 1, "exit");
  if (!result.misses.some((m) => m.includes("/landing own scripts")))
    throw new Error("no script miss");
});

test("a big analytics.js (fetched directly) overruns the renderer cap: exit 1", async () => {
  const x = deps({ site: fakeSite({ over: { "/site/analytics.js": bytes(3) } }) });
  const { exit, result } = await runSpeedRun(opts({ only: "bytes", pages: ["/pricing"] }), x.d);
  eq(exit, 1, "exit");
  eq(result.t43[0].analyticsFetchedDirectly, true, "flag");
  if (!result.misses.some((m) => m.includes("renderer scripts")))
    throw new Error("no renderer miss");
});

test("two font files, or one font over 25 KB, is a miss (exit 1)", async () => {
  const two = '<link rel="preload" href="/site/fonts/two.woff2" as="font">';
  const a = deps({
    site: fakeSite({
      over: { "/site/fonts/two.woff2": bytes(5) },
      html: {
        "/pricing": `<html><link rel="stylesheet" href="/site/css/site.css">${two}</html>`,
      },
    }),
  });
  eq((await runSpeedRun(opts({ only: "bytes" }), a.d)).exit, 1, "two fonts");
  const b = deps({ site: fakeSite({ over: { "/site/fonts/geist.woff2": bytes(26) } }) });
  eq((await runSpeedRun(opts({ only: "bytes" }), b.d)).exit, 1, "big font");
});

test("a raster icon over 15 KB is a miss (exit 1); a 16 KB svg is not", async () => {
  const a = deps({ site: fakeSite({ over: { "/site/img/mark.png": bytes(16) } }) });
  eq((await runSpeedRun(opts({ only: "bytes" }), a.d)).exit, 1, "png");
  const html =
    '<html><link rel="stylesheet" href="/site/css/site.css">' +
    '<link rel="preload" href="/site/fonts/geist.woff2" as="font">' +
    '<img src="/site/img/m.svg"><script src="/site/js/first-touch.js"></script></html>';
  const b = deps({
    site: fakeSite({ over: { "/site/img/m.svg": bytes(16) }, html: { "/company": html } }),
  });
  const r = await runSpeedRun(opts({ only: "bytes", pages: ["/company"] }), b.d);
  eq(r.exit, 0, "svg");
});

test("an LCP miss exits 1 and is never retried: exactly 3 samples per page and width", async () => {
  const probe = fakeProbe((c) => goodRaw(c.width, { lcpMs: c.width === "phone" ? 3000 : 900 }));
  const { exit, result } = await runSpeedRun(
    opts({ only: "timing", pages: ["/pricing"] }),
    deps({ probe }).d,
  );
  eq(exit, 1, "exit");
  eq(probe.samples.length, 6, "samples (3 desktop + 3 phone)");
  if (!result.misses.some((m) => /LCP/.test(m))) throw new Error("no LCP miss");
});

test("the median of three is compared: one bad sample passes, two bad samples miss", async () => {
  const o = { only: "timing", pages: ["/"] };
  const phoneOne = fakeProbe((c) =>
    goodRaw(c.width, { lcpMs: c.width === "phone" ? (c.n === 2 ? 9000 : 1800) : 900 }),
  );
  eq((await runSpeedRun(opts(o), deps({ probe: phoneOne }).d)).exit, 0, "one bad phone sample");
  const phoneTwo = fakeProbe((c) =>
    goodRaw(c.width, { lcpMs: c.width === "phone" ? (c.n === 1 ? 1800 : 9000) : 900 }),
  );
  eq((await runSpeedRun(opts(o), deps({ probe: phoneTwo }).d)).exit, 1, "two bad phone samples");
});

test("median really is the middle sample", async () => {
  const probe = fakeProbe((c) => goodRaw(c.width, { lcpMs: [1000, 5000, 1100][c.n - 1] }));
  const { result } = await runSpeedRun(opts({ only: "timing", pages: ["/"] }), deps({ probe }).d);
  eq(result.t44.find((r) => r.width === "desktop").median.lcp, 1100, "median");
});

test("CLS and TBT over the cap miss (exit 1); desktop caps are tighter than phone", async () => {
  const cls = fakeProbe((c) => goodRaw(c.width, { cls: 0.03 }));
  const r = await runSpeedRun(opts({ only: "timing", pages: ["/"] }), deps({ probe: cls }).d);
  eq(r.exit, 1, "cls");
  eq(r.result.t44.find((x) => x.width === "desktop").misses.length, 1, "desktop only");
  eq(r.result.t44.find((x) => x.width === "phone").misses.length, 0, "phone ok at 0.03");
  const tbt = fakeProbe((c) => goodRaw(c.width, { tbtMs: 350 }));
  eq(
    (await runSpeedRun(opts({ only: "timing", pages: ["/"] }), deps({ probe: tbt }).d)).exit,
    1,
    "tbt",
  );
});

test("warm: every page and file twice with gzip, one untimed navigation per page and width", async () => {
  const site = fakeSite();
  const probe = fakeProbe();
  const x = deps({ site, probe });
  const { result } = await runSpeedRun(opts(), x.d);
  eq(result.warm.pages, 10, "pages");
  eq(result.warm.untimedNavigations, 20, "navigations");
  eq(probe.warms.length, 20, "probe warms");
  const gz = site.calls.filter((c) => c.acceptEncoding === "gzip");
  eq(gz.length, result.warm.requests, "gzip requests recorded");
  eq(gz.filter((c) => c.path === "/pricing").length, 2, "page fetched twice");
  eq(gz.filter((c) => c.path === "/site/fonts/geist.woff2").length, 20, "font twice per page");
  eq(x.sleeps, [2000], "settle");
  eq(x.sleepAt, [10], "the settle comes after T43, directly before T44");
  eq(
    site.calls.filter((c) => c.acceptEncoding === "identity").length > 0,
    true,
    "T43 uses identity",
  );
});

test("--only bytes never touches the probe; --only timing skips T43", async () => {
  const probe = fakeProbe();
  const a = await runSpeedRun(opts({ only: "bytes" }), deps({ probe }).d);
  eq(a.exit, 0, "bytes");
  eq(probe.samples.length + probe.warms.length, 0, "no probe");
  eq(a.result.t44.length, 0, "no t44");
  const b = await runSpeedRun(opts({ only: "timing" }), deps().d);
  eq(b.result.t43.length, 0, "no t43");
});

test("the JSON carries sha, imageSha, dirty, warm, t43, t44, misses and exit", async () => {
  const { result } = await runSpeedRun(opts(), deps().d);
  for (const k of [
    "sha",
    "imageSha",
    "dirty",
    "baseUrl",
    "date",
    "host",
    "warm",
    "t43",
    "t44",
    "misses",
    "exit",
  ])
    if (!(k in result)) throw new Error(`missing ${k}`);
  eq(result.dirty, false, "dirty");
});

test("constants come from the budget file as text; a missing name fails with exit 2 semantics", () => {
  eq(budget.SPEED_RUNS, 3, "SPEED_RUNS");
  eq(budget.GZIP_TOTAL_KB.landing, 45, "landing total");
  eq(budget.TIMING_BUDGET.phone.lcpMs, 2500, "phone lcp");
  eq(budget.PHONE_THROTTLE.latencyMs, 40, "latency");
  eq(budget.PHONE_THROTTLE.downloadBytesPerSec, 1250000, "10 Mb/s");
  eq(budget.VIEWPORTS.phone, { width: 390, height: 844 }, "phone viewport");
  let threw = false;
  try {
    loadBudget(fileURLToPath(import.meta.url));
  } catch (err) {
    threw = err instanceof PreflightError;
  }
  eq(threw, true, "missing constants throw PreflightError");
});

test("argument parsing: unknown flag, --allow-remote and bad --only are refused", () => {
  for (const argv of [["--bogus"], ["--allow-remote"], ["--only", "both"], ["--retries", "2"]]) {
    let threw = false;
    try {
      parseArgs(argv);
    } catch (err) {
      threw = err instanceof PreflightError;
    }
    eq(threw, true, argv.join(" "));
  }
});

test("CLI: a remote base URL exits 2 before touching the network or Docker", () => {
  const r = spawnSync(
    process.execPath,
    [path.join(HERE, "site-speed-run.mjs"), "--base-url", "https://example.com", "--sha", SHA],
    { encoding: "utf8" },
  );
  eq(r.status, 2, "exit");
  if (!/not localhost/.test(r.stderr)) throw new Error(`stderr: ${r.stderr}`);
});

const GOOD_HTML =
  '<html><link rel="stylesheet" href="/site/css/site.css">' +
  '<link rel="preload" href="/site/fonts/geist.woff2" as="font">' +
  '<script src="/site/js/first-touch.js"></script>';
const FT = '<script src="/site/js/first-touch.js"></script>';
const CSS_ONLY = '<html><link rel="stylesheet" href="/site/css/site.css">';
const bytesRun = (site) =>
  runSpeedRun(opts({ only: "bytes", pages: ["/company"] }), deps({ site }).d);

test("a gif over 15 KB is a raster miss (exit 1)", async () => {
  const site = fakeSite({
    over: { "/site/img/a.gif": bytes(16) },
    html: { "/company": GOOD_HTML + '<img src="/site/img/a.gif"></html>' },
  });
  const r = await bytesRun(site);
  eq(r.exit, 1, "exit");
  if (!r.result.misses.some((m) => m.includes("raster icon"))) throw new Error("no icon miss");
});

test("zero font files is a miss (exit 1), as is a missing preload", async () => {
  const none = fakeSite({
    over: { "/site/css/site.css": bytes(10) },
    html: { "/company": CSS_ONLY + FT + "</html>" },
  });
  const r = await bytesRun(none);
  eq(r.exit, 1, "zero fonts");
  if (!r.result.misses.some((m) => m.includes("0 font files"))) throw new Error("no font miss");
  const noPreload = fakeSite({ html: { "/company": CSS_ONLY + FT + "</html>" } });
  const p = await bytesRun(noPreload);
  eq(p.exit, 1, "no preload");
  if (!p.result.misses.some((m) => m.includes("not preloaded"))) throw new Error("no preload miss");
});

test("a page without first-touch.js is a miss (exit 1)", async () => {
  const bad = fakeSite({ html: { "/company": GOOD_HTML.replace(FT, "") + "</html>" } });
  const r = await bytesRun(bad);
  eq(r.exit, 1, "exit");
  if (!r.result.misses.some((m) => m.includes("first-touch.js is not linked")))
    throw new Error("no first-touch miss");
  const good = fakeSite({ html: { "/company": GOOD_HTML + "</html>" } });
  eq((await bytesRun(good)).exit, 0, "with it, exit 0");
});

const tapProbe = (clickFor) =>
  fakeProbe((c) =>
    c.width === "phone"
      ? goodRaw("phone", {
          menu: { hasButton: true, expanded: true, clickMs: clickFor(c.n), firstInputMs: null },
        })
      : goodRaw("desktop"),
  );

test("taps [<16, <16, 250]: fast taps count as 0 ms, the median passes with its label", async () => {
  const o = { only: "timing", pages: ["/"] };
  const r = await runSpeedRun(opts(o), deps({ probe: tapProbe((n) => (n === 3 ? 250 : null)) }).d);
  eq(r.exit, 0, "exit");
  const phone = r.result.t44.find((x) => x.width === "phone");
  eq(phone.median.tap, 0, "median");
  eq(phone.tapLabel, "<16 ms, ok", "label kept");
  const slow = await runSpeedRun(
    opts(o),
    deps({ probe: tapProbe((n) => (n === 1 ? null : 250)) }).d,
  );
  eq(slow.exit, 1, "[<16, 250, 250]");
});

test("a hidden or missing .menu-btn is a recorded miss: exit 1 with the rows kept", async () => {
  const probe = fakeProbe((c) =>
    c.width === "phone"
      ? goodRaw("phone", { menu: { hasButton: false, expanded: false } })
      : goodRaw("desktop"),
  );
  const r = await runSpeedRun(opts({ only: "timing", pages: ["/"] }), deps({ probe }).d);
  eq(r.exit, 1, "exit");
  eq(r.result.t44.length, 2, "rows kept for the JSON");
  eq(r.result.exit, 1, "result.exit");
});

test("waitForMenuOpen polls: true on the second poll passes; never true times out", async () => {
  let n = 0;
  const slept = [];
  const sleep = async (ms) => slept.push(ms);
  const late = await waitForMenuOpen(async () => (++n >= 2 ? "true" : "false"), { sleep });
  eq([late, n], [true, 2], "second poll");
  const never = await waitForMenuOpen(async () => "false", {
    timeoutMs: 200,
    intervalMs: 50,
    sleep,
  });
  eq(never, false, "timeout");
  eq(slept.length, 1 + 4, "bounded polling");
});

const withBudget = (edit) => {
  const dir = mkdtempSync(path.join(tmpdir(), "speed-run-"));
  const file = path.join(dir, "budget.ts");
  const real = path.join(HERE, "../apps/web/e2e/helpers/site-speed-budget.ts");
  writeFileSync(file, edit(readFileSync(real, "utf8")));
  return file;
};

test("a renamed or non-numeric budget key makes loadBudget throw, naming the key", () => {
  const cases = [
    ["lcpMs", (t) => t.replace(/lcpMs/g, "lcpMillis"), "lcpMs"],
    ["SPEED_RUNS", (t) => t.replace("SPEED_RUNS = 3", "SPEED_RUNS = 4"), "SPEED_RUNS"],
    ["home", (t) => t.replace("home: 175", "homepage: 175"), "GZIP_TOTAL_KB.home"],
    ["latency", (t) => t.replace("latencyMs: 40", "latencyMs: NaN"), "latencyMs"],
  ];
  for (const [label, edit, key] of cases) {
    let msg = null;
    try {
      loadBudget(withBudget(edit));
    } catch (err) {
      msg = err instanceof PreflightError ? err.message : "wrong error type";
    }
    if (!msg || !msg.includes(key)) throw new Error(label + ": " + msg);
  }
});

test("a 302 on a page or on /login exits 2 (a redirect is not a page)", async () => {
  for (const p of ["/pricing", "/login"]) {
    const site = fakeSite({ status: { [p]: 302 } });
    eq((await runSpeedRun(opts({ only: "bytes" }), deps({ site }).d)).exit, 2, p);
  }
});

test("a route set that differs from STATIC_ROUTES exits 2; the real file matches PAGES", async () => {
  const x = deps({ staticRoutes: PAGES.slice(1) });
  eq((await runSpeedRun(opts(), x.d)).exit, 2, "missing route");
  const y = deps({ staticRoutes: [...PAGES, "/extra"] });
  eq((await runSpeedRun(opts(), y.d)).exit, 2, "extra route");
  eq([...loadStaticRoutes()].sort(), [...PAGES].sort(), "site-proof.ts");
});

let failed = 0;
for (const c of cases) {
  try {
    await c.fn();
    console.log(`ok   ${c.name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${c.name}\n     ${err.message}`);
  }
}
console.log(`\n${cases.length - failed}/${cases.length} cases passed`);
process.exit(failed ? 1 : 0);
