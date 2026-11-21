#!/usr/bin/env node
// One command that gates T43 (page weight) and T44 (LCP, CLS, TBT, menu tap) of the public site
// against the BUILT Docker images, warmed, with no retries, per page and width. Spec: the W5 speed-run
// spec (revision 5).
//
//   node scripts/heavy-slot.mjs run --label site-speed-run -- node scripts/site-speed-run.mjs --sha <sha>
//   node scripts/site-speed-run.mjs --help
//
// Exit 0: every rule held. Exit 1: at least one miss. Exit 2: preflight or environment failure (remote
// URL, stale or dirty image, a page not 200, a missing LCP entry, missing constants, zero pages found).
//
// Where this and the static test differ, the static test wins (the two must not disagree). One known
// gap: the static test weighs the HTML with the two analytics tags added (about 0.1-0.2 KB more after
// gzip), so it is the stricter check at the 20 KB HTML cap; both run in the proof.
//
// Scope: weights only for T43 (total, html, own scripts, renderer scripts, raster icons, fonts). The
// four structural rules (img sizes, font swap, prices.js, logo-as-SVG) stay with the static Jest test
// (apps/web/app/(marketing)/site-speed-budget.static.test.ts). `logo-svg` is pending until switch day.
//
// Design: runSpeedRun() takes injected dependencies (fetcher, gzip, probe, image-label reader, clock,
// output writer), so scripts/site-speed-run.self-test.mjs drives it with fakes: no browser, no Docker,
// no stack. The CLI at the bottom wires in the real ones; `playwright` is imported lazily, only in the
// timing path. Budget numbers are read from apps/web/e2e/helpers/site-speed-budget.ts as text and the
// run fails on any missing name; there is no second copy.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import zlib from "node:zlib";
import { DIRTY_LABEL, SHA_LABEL, STACK_IMAGES } from "./lib/proof-stack.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUDGET_FILE = path.join(ROOT, "apps/web/e2e/helpers/site-speed-budget.ts");

export const PAGES = [
  "/",
  "/pricing",
  "/product",
  "/landing",
  "/company",
  "/contact",
  "/getting-started",
  "/does-and-doesnt",
  "/data-in-and-out",
  "/security",
];
const PROOF_FILE = path.join(ROOT, "apps/web/e2e/helpers/site-proof.ts");
const BUDGET_NAMES = [
  "GZIP_TOTAL_KB",
  "HTML_GZIP_KB",
  "SCRIPT_GZIP_KB",
  "RENDERER_SCRIPT_GZIP_KB",
  "RASTER_ICON_GZIP_KB",
  "FONT_GZIP_KB",
  "TIMING_BUDGET",
  "MENU_TAP_DURATION_MS",
  "VIEWPORTS",
  "PHONE_THROTTLE",
  "SPEED_RUNS",
];
const ANALYTICS_SRC = "/site/analytics.js";
const WARM_PASSES = 2;
const SETTLE_MS = 2000;
const TAP_FAST_LABEL = "<16 ms, ok";

/** A failure of the environment, not of the site: exit 2, nothing (more) measured. */
export class PreflightError extends Error {}

const KINDS = ["home", "inner", "landing"];
const WIDTHS = ["desktop", "phone"];

/** Every key the run reads must be a finite number; the first one that is not is named. */
export function validateBudget(b) {
  const num = (v, key) => {
    if (typeof v !== "number" || !Number.isFinite(v))
      throw new PreflightError(`budget key ${key} is missing or not a finite number`);
  };
  for (const n of ["GZIP_TOTAL_KB", "SCRIPT_GZIP_KB"])
    for (const k of KINDS) num(b[n]?.[k], `${n}.${k}`);
  for (const w of WIDTHS) {
    for (const k of ["lcpMs", "cls", "tbtMs"])
      num(b.TIMING_BUDGET?.[w]?.[k], `TIMING_BUDGET.${w}.${k}`);
    for (const k of ["width", "height"]) num(b.VIEWPORTS?.[w]?.[k], `VIEWPORTS.${w}.${k}`);
  }
  for (const k of ["cpuRate", "downloadBytesPerSec", "uploadBytesPerSec", "latencyMs"])
    num(b.PHONE_THROTTLE?.[k], `PHONE_THROTTLE.${k}`);
  for (const n of [
    "HTML_GZIP_KB",
    "RENDERER_SCRIPT_GZIP_KB",
    "RASTER_ICON_GZIP_KB",
    "FONT_GZIP_KB",
    "MENU_TAP_DURATION_MS",
    "SPEED_RUNS",
  ])
    num(b[n], n);
  if (!Number.isInteger(b.SPEED_RUNS) || b.SPEED_RUNS < 1)
    throw new PreflightError("budget key SPEED_RUNS must be a positive integer");
}

/** Reads the budget numbers out of the .ts as text. Any missing name throws. */
export function loadBudget(file = BUDGET_FILE) {
  const text = readFileSync(file, "utf8");
  const out = {};
  for (const name of BUDGET_NAMES) {
    const m = new RegExp(
      `export const ${name}(?:\\s*:[^=]+?)?\\s*=\\s*([\\s\\S]*?);[ \\t]*\\r?\\n`,
    ).exec(text);
    if (!m) throw new PreflightError(`constant ${name} not found in ${file}`);
    try {
      out[name] = new Function(`return (${m[1].replace(/\s+as const\s*$/, "")});`)();
    } catch (err) {
      throw new PreflightError(`constant ${name} in ${file} is unreadable: ${err.message}`);
    }
    if (out[name] === undefined || out[name] === null)
      throw new PreflightError(`constant ${name} in ${file} is empty`);
  }
  validateBudget(out);
  return out;
}

/** STATIC_ROUTES from site-proof.ts, read as text. */
export function loadStaticRoutes(file = PROOF_FILE) {
  const m = /export const STATIC_ROUTES = \[([\s\S]*?)\]/.exec(readFileSync(file, "utf8"));
  if (!m) throw new PreflightError(`STATIC_ROUTES not found in ${file}`);
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

export function isLocalUrl(url) {
  let hostname;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return false;
  }
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname.endsWith(".localhost")
  );
}

export function parseArgs(argv, today = new Date().toISOString().slice(0, 10)) {
  const opts = {
    baseUrl: "http://localhost:3001",
    sha: null,
    out: `local-assets/runs/${today}-w5/speed-run.json`,
    pages: PAGES,
    only: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--base-url") opts.baseUrl = argv[++i];
    else if (a === "--sha") opts.sha = argv[++i];
    else if (a === "--out") opts.out = argv[++i];
    else if (a === "--pages") opts.pages = String(argv[++i] ?? "").split(",");
    else if (a === "--only") opts.only = argv[++i];
    else throw new PreflightError(`unknown argument ${JSON.stringify(a)} (see --help)`);
  }
  if (!opts.baseUrl || !opts.out) throw new PreflightError("--base-url and --out need a value");
  if (opts.only !== null && opts.only !== "bytes" && opts.only !== "timing")
    throw new PreflightError("--only takes bytes or timing");
  if (opts.pages.some((p) => !p.startsWith("/")))
    throw new PreflightError("--pages takes a comma list of paths");
  return opts;
}

const kb = (bytes) => bytes / 1024;
const round = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

export function median(values) {
  const v = values.filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

const attr = (tag, name) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];

/** The local files a page links (same extraction as the static test). Anything outside /site/ throws. */
export function linkedFiles(html, page) {
  const out = { scripts: new Set(), styles: new Set(), images: new Set(), preloaded: new Set() };
  const take = (url, into) => {
    if (!url || /^(https?:)?\/\/|^(data|mailto|tel|javascript):|^#/.test(url)) return;
    if (!url.startsWith("/site/"))
      throw new PreflightError(`${page}: linked file ${url} is not under /site/`);
    into.add(url);
  };
  for (const [tag] of html.matchAll(/<(?:script|img|link)\b[^>]*>/g)) {
    if (tag.startsWith("<script")) take(attr(tag, "src"), out.scripts);
    else if (tag.startsWith("<img")) take(attr(tag, "src"), out.images);
    else {
      const rel = attr(tag, "rel") ?? "";
      const href = attr(tag, "href");
      if (/\bstylesheet\b/.test(rel)) take(href, out.styles);
      else if (/\b(preload|icon)\b/.test(rel) && href && /\.woff2$/.test(href))
        take(href, out.preloaded);
    }
  }
  return {
    scripts: [...out.scripts],
    styles: [...out.styles],
    images: [...out.images],
    preloaded: [...out.preloaded],
  };
}

const kindOf = (route) => (route === "/" ? "home" : route === "/landing" ? "landing" : "inner");

/** A redirect target for an error message: a non-local host is masked. */
export function maskLocation(location) {
  if (!location) return "(no location header)";
  if (!/^[a-z][a-z0-9+.-]*:\/\/|^\/\//i.test(location)) return location;
  try {
    const u = new URL(location, "http://localhost");
    return isLocalUrl(u.toString()) ? location : `<non-local host masked>${u.pathname}`;
  } catch {
    return "(unreadable location)";
  }
}

async function getOk(deps, url, acceptEncoding, what) {
  let res;
  try {
    res = await deps.fetcher(url, { acceptEncoding });
  } catch (err) {
    throw new PreflightError(`${what}: ${url} could not be fetched (${err.message})`);
  }
  if (res.status >= 300 && res.status < 400)
    throw new PreflightError(
      `${what}: ${url} redirected (${res.status}) to ${maskLocation(res.location)}`,
    );
  if (res.status !== 200) throw new PreflightError(`${what}: ${url} answered ${res.status}`);
  return res;
}

/** Fetches one page and everything it links; returns its parts and the request count. */
async function fetchPage(deps, base, route, acceptEncoding) {
  const url = new URL(route, base).toString();
  const res = await getOk(deps, url, acceptEncoding, route);
  const html = res.body.toString("utf8");
  const linked = linkedFiles(html, route);
  const bodies = new Map();
  let requests = 1;
  const grab = async (u) => {
    if (bodies.has(u)) return bodies.get(u);
    const r = await getOk(deps, new URL(u, base).toString(), acceptEncoding, route);
    requests++;
    bodies.set(u, r.body);
    return r.body;
  };
  for (const u of [...linked.scripts, ...linked.styles, ...linked.images, ...linked.preloaded])
    await grab(u);
  const cssFonts = [];
  for (const css of linked.styles) {
    const text = (await grab(css)).toString("utf8");
    for (const m of text.matchAll(/url\(["']?([^"')]+\.woff2)/g))
      cssFonts.push(path.posix.normalize(path.posix.join(path.posix.dirname(css), m[1])));
  }
  const fonts = [...new Set([...linked.preloaded, ...cssFonts])];
  for (const f of fonts) await grab(f);
  return { html, htmlBytes: res.body, linked, fonts, bodies, requests };
}

/** Warm: every page and every file it links, twice, gzip accepted. */
async function warmFiles(deps, base, pages) {
  let requests = 0;
  for (const route of pages)
    for (let i = 0; i < WARM_PASSES; i++)
      requests += (await fetchPage(deps, base, route, "gzip")).requests;
  return requests;
}

/** T43 for one page. Weights over HTTP, gzip locally. */
async function weighPage(deps, budget, base, route) {
  const kind = kindOf(route);
  const p = await fetchPage(deps, base, route, "identity");
  if (
    !p.linked.scripts.length &&
    !p.linked.styles.length &&
    !p.linked.images.length &&
    !p.fonts.length
  )
    throw new PreflightError(`${route}: the page links no files (never a skip)`);
  const renderer = new Set(["/site/js/first-touch.js", ANALYTICS_SRC]);
  const gzOf = (u) => deps.gzipSize(p.bodies.get(u));
  const own = p.linked.scripts.filter((u) => !renderer.has(u));
  let rendererUrls = p.linked.scripts.filter((u) => renderer.has(u));
  let rendererGz = rendererUrls.reduce((n, u) => n + gzOf(u), 0);
  // The local stack has no analytics site ID, so the page does not link analytics.js: weigh it directly.
  let analyticsDirect = false;
  if (!rendererUrls.includes(ANALYTICS_SRC)) {
    const a = await getOk(deps, new URL(ANALYTICS_SRC, base).toString(), "identity", route);
    rendererGz += deps.gzipSize(a.body);
    rendererUrls = [...rendererUrls, ANALYTICS_SRC];
    analyticsDirect = true;
  }
  const sum = (urls) => urls.reduce((n, u) => n + gzOf(u), 0);
  const htmlGz = deps.gzipSize(p.htmlBytes);
  const scriptGz = sum(own);
  const styleGz = sum(p.linked.styles);
  const imageGz = sum(p.linked.images);
  const fontGz = sum(p.fonts);
  const totalGz = htmlGz + scriptGz + rendererGz + styleGz + imageGz + fontGz;
  const rasterKb = p.linked.images
    .filter((u) => /\.(png|jpe?g|webp|gif)$/i.test(u))
    .map((u) => kb(gzOf(u)));
  const iconMax = rasterKb.length ? Math.max(...rasterKb) : 0;
  const fontMax = p.fonts.length ? Math.max(...p.fonts.map((u) => kb(gzOf(u)))) : 0;
  const row = {
    page: route,
    kind,
    kb: {
      html: round(kb(htmlGz), 2),
      scripts: round(kb(scriptGz), 2),
      renderer: round(kb(rendererGz), 2),
      styles: round(kb(styleGz), 2),
      images: round(kb(imageGz), 2),
      fonts: round(kb(fontGz), 2),
      total: round(kb(totalGz), 2),
      iconMax: round(iconMax, 2),
    },
    fontFiles: p.fonts.length,
    analyticsFetchedDirectly: analyticsDirect,
    limits: {
      total: budget.GZIP_TOTAL_KB[kind],
      html: budget.HTML_GZIP_KB,
      scripts: budget.SCRIPT_GZIP_KB[kind],
      renderer: budget.RENDERER_SCRIPT_GZIP_KB,
      icon: budget.RASTER_ICON_GZIP_KB,
      font: budget.FONT_GZIP_KB,
    },
    misses: [],
  };
  const miss = (rule, got, limit) =>
    row.misses.push(`T43 ${route} ${rule} ${round(got, 2)} > ${limit} KB`);
  if (kb(totalGz) > row.limits.total) miss("total", kb(totalGz), row.limits.total);
  if (kb(htmlGz) > row.limits.html) miss("html", kb(htmlGz), row.limits.html);
  if (kb(scriptGz) > row.limits.scripts) miss("own scripts", kb(scriptGz), row.limits.scripts);
  if (kb(rendererGz) > row.limits.renderer)
    miss("renderer scripts", kb(rendererGz), row.limits.renderer);
  if (iconMax > row.limits.icon) miss("raster icon", iconMax, row.limits.icon);
  if (p.fonts.length !== 1)
    row.misses.push(`T43 ${route} ${p.fonts.length} font files, exactly 1 is required`);
  if (!/<link\b[^>]*rel="preload"[^>]*\.woff2/.test(p.html))
    row.misses.push(`T43 ${route} the font is not preloaded`);
  if (!p.linked.scripts.includes("/site/js/first-touch.js"))
    row.misses.push(`T43 ${route} first-touch.js is not linked`);
  if (fontMax > row.limits.font) miss("font", fontMax, row.limits.font);
  return row;
}

function bytesLine(r) {
  const f = (v, lim) => `${v}/${lim} ${v > lim ? "MISS" : "ok"}`;
  return (
    `T43 ${r.page.padEnd(17)} total ${f(r.kb.total, r.limits.total)}  html ${f(r.kb.html, r.limits.html)}` +
    `  scripts ${f(r.kb.scripts, r.limits.scripts)}  renderer ${f(r.kb.renderer, r.limits.renderer)}` +
    `  icons max ${f(r.kb.iconMax, r.limits.icon)}  fonts ${r.fontFiles} (max ${r.limits.font})` +
    (r.analyticsFetchedDirectly ? "  (analytics.js fetched directly)" : "")
  );
}

/** One sample to a verdict-ready record. A missing LCP entry throws (exit 2). */
function readSample(route, width, raw) {
  if (!raw || !raw.lcpEntries || !(raw.lcpMs > 0))
    throw new PreflightError(`${route} ${width}: no LCP entry was recorded`);
  const sample = { lcp: raw.lcpMs, cls: raw.cls, tbt: raw.tbtMs };
  if (width === "phone") {
    const m = raw.menu ?? {};
    if (!m.hasButton) sample.tapMiss = "no .menu-btn at 390";
    else if (!m.expanded) sample.tapMiss = "the menu did not open (aria-expanded is not true)";
    else {
      const ms = m.clickMs ?? m.firstInputMs ?? null;
      sample.tap = ms;
      if (ms === null) sample.tapLabel = TAP_FAST_LABEL;
    }
  }
  return sample;
}

async function timePage(deps, budget, base, route, width) {
  const vp = budget.VIEWPORTS[width];
  const throttle = width === "phone" ? budget.PHONE_THROTTLE : null;
  const runs = [];
  for (let i = 0; i < budget.SPEED_RUNS; i++) {
    const raw = await deps.probe.sample({ baseUrl: base, route, width, viewport: vp, throttle });
    runs.push(readSample(route, width, raw));
  }
  const b = budget.TIMING_BUDGET[width];
  const med = {
    lcp: median(runs.map((r) => r.lcp)),
    cls: median(runs.map((r) => r.cls)),
    tbt: median(runs.map((r) => r.tbt)),
  };
  const row = {
    page: route,
    width,
    runs: runs.map((r) => ({
      lcp: r.lcp,
      cls: r.cls,
      tbt: r.tbt,
      tap: r.tapLabel ?? r.tap ?? null,
    })),
    median: med,
    budget: { lcp: b.lcpMs, cls: b.cls, tbt: b.tbtMs },
    misses: [],
  };
  const miss = (rule, got, limit, unit = "") =>
    row.misses.push(`T44 ${route} ${width} ${rule} ${round(got, 3)}${unit} > ${limit}${unit}`);
  if (med.lcp > b.lcpMs) miss("LCP", med.lcp, b.lcpMs, " ms");
  if (med.cls > b.cls) miss("CLS", med.cls, b.cls);
  if (med.tbt > b.tbtMs) miss("TBT", med.tbt, b.tbtMs, " ms");
  if (width === "phone") {
    for (const r of runs)
      if (r.tapMiss) row.misses.push(`T44 ${route} ${width} menu tap: ${r.tapMiss}`);
    // A tap faster than the 16 ms Event Timing threshold counts as 0 ms in the median.
    const taps = runs.filter((r) => !r.tapMiss).map((r) => r.tap ?? 0);
    med.tap = median(taps);
    row.budget.tap = budget.MENU_TAP_DURATION_MS;
    if (med.tap === 0 && runs.some((r) => r.tapLabel)) row.tapLabel = TAP_FAST_LABEL;
    if (med.tap !== null && med.tap > budget.MENU_TAP_DURATION_MS)
      miss("menu tap", med.tap, budget.MENU_TAP_DURATION_MS, " ms");
  }
  return row;
}

function timingLine(r) {
  const f = (v, lim, d = 0) => `${round(v, d)}/${lim} ${v > lim ? "MISS" : "ok"}`;
  const px = r.width === "phone" ? 390 : 1440;
  let line =
    `T44 ${r.page.padEnd(17)} ${String(px).padEnd(5)} LCP ${f(r.median.lcp, r.budget.lcp)}` +
    `   CLS ${f(r.median.cls, r.budget.cls, 3)}   TBT ${f(r.median.tbt, r.budget.tbt)}`;
  if (r.width === "phone") {
    const tap =
      r.median.tap === null
        ? "n/a"
        : r.tapLabel && r.median.tap === 0
          ? r.tapLabel
          : f(r.median.tap, r.budget.tap);
    line += `   tap ${tap}`;
  }
  const lcps = r.runs.map((x) => Math.round(x.lcp)).join(" ");
  return `${line}   (${r.runs.length} runs: lcp ${lcps})`;
}

/** Image labels: the web image must be built from the claimed sha (or a descendant), clean tree. */
function checkImage(deps, sha) {
  const image = STACK_IMAGES.find((i) => /web/.test(i));
  const res = deps.readImageLabels(image);
  if (!res || res.error) throw new PreflightError(res?.error ?? `cannot inspect ${image}`);
  const imageSha = res.labels?.[SHA_LABEL] ?? null;
  const dirty = res.labels?.[DIRTY_LABEL] ?? null;
  if (!imageSha) throw new PreflightError(`${image} has no ${SHA_LABEL} label (stale image)`);
  if (imageSha !== sha && deps.isAncestor(sha, imageSha) !== true)
    throw new PreflightError(`${image} is built from ${imageSha}, which does not include ${sha}`);
  if (String(dirty) !== "false")
    throw new PreflightError(`${image} was built from a dirty tree (${DIRTY_LABEL}=${dirty})`);
  return { image, imageSha, dirty: false };
}

/**
 * The whole run. Returns { exit, result }. Never throws for a site or environment problem: a
 * PreflightError becomes exit 2, any other error is rethrown (a bug in this script).
 */
export async function runSpeedRun(opts, deps) {
  const log = deps.log ?? (() => {});
  const result = { misses: [], exit: 2 };
  try {
    // 1. Local only, before any network or Docker call. There is no --allow-remote.
    if (!isLocalUrl(opts.baseUrl))
      throw new PreflightError(`refusing ${opts.baseUrl}: not localhost (no remote mode exists)`);
    const routes = deps.staticRoutes ?? loadStaticRoutes();
    if (routes.length !== PAGES.length || !PAGES.every((p) => routes.includes(p)))
      throw new PreflightError("PAGES differs from STATIC_ROUTES in e2e/helpers/site-proof.ts");
    const budget = deps.budget ?? loadBudget();
    const runBytes = opts.only !== "timing";
    const runTiming = opts.only !== "bytes";
    const sha = opts.sha ?? deps.headSha();
    if (!sha) throw new PreflightError("no --sha and the head of the worktree is unreadable");
    const image = checkImage(deps, sha);
    Object.assign(result, {
      sha,
      imageSha: image.imageSha,
      dirty: image.dirty,
      baseUrl: opts.baseUrl,
      date: deps.clock.now().toISOString().slice(0, 10),
      host: deps.host ?? {},
    });
    // 2. Preflight: /login and every page answers 200 text/html.
    await getOk(deps, new URL("/login", opts.baseUrl).toString(), "identity", "/login");
    for (const route of opts.pages) {
      const r = await getOk(deps, new URL(route, opts.baseUrl).toString(), "identity", route);
      if (!/^text\/html/i.test(r.contentType ?? ""))
        throw new PreflightError(`${route}: content-type is ${r.contentType}, not text/html`);
    }
    if (!opts.pages.length) throw new PreflightError("zero pages to measure");
    // 3. Warm.
    const widths = Object.keys(budget.VIEWPORTS);
    const warm = { pages: opts.pages.length, requests: 0, untimedNavigations: 0 };
    warm.requests = await warmFiles(deps, opts.baseUrl, opts.pages);
    if (runTiming) {
      for (const route of opts.pages)
        for (const width of widths) {
          await deps.probe.warmNavigate({
            baseUrl: opts.baseUrl,
            route,
            width,
            viewport: budget.VIEWPORTS[width],
          });
          warm.untimedNavigations++;
        }
    }
    result.warm = warm;
    // 4. T43.
    result.t43 = [];
    if (runBytes)
      for (const route of opts.pages) {
        const row = await weighPage(deps, budget, opts.baseUrl, route);
        result.t43.push(row);
        log(bytesLine(row));
      }
    // 5. T44: three samples, median compared, never a second set.
    result.t44 = [];
    if (runTiming) await deps.clock.sleep(SETTLE_MS);
    if (runTiming)
      for (const route of opts.pages)
        for (const width of widths) {
          const row = await timePage(deps, budget, opts.baseUrl, route, width);
          result.t44.push(row);
          log(timingLine(row));
        }
    result.misses = [...result.t43, ...result.t44].flatMap((r) => r.misses);
    result.exit = result.misses.length ? 1 : 0;
    if (result.misses.length)
      log(`\n${result.misses.length} miss(es):\n  ${result.misses.join("\n  ")}`);
    else log("\nevery rule held");
  } catch (err) {
    if (!(err instanceof PreflightError)) throw err;
    result.error = err.message;
    result.exit = 2;
    log(`preflight failure: ${err.message}`);
  }
  return { exit: result.exit, result };
}

const HELP = `usage: node scripts/site-speed-run.mjs [--base-url URL] [--sha SHA] [--out FILE] [--pages /a,/b] [--only bytes|timing]

Gates page weight (T43) and timing (T44) of the ten static site pages against the built Docker
images, warmed, no retries. Local URLs only. Run it under the heavy slot:
  node scripts/heavy-slot.mjs run --label site-speed-run -- node scripts/site-speed-run.mjs --sha <sha>
Exit 0 all held, 1 a miss, 2 environment failure.`;

// ---- real dependencies (CLI only) ----

function realFetcher() {
  return async (url, { acceptEncoding }) => {
    const res = await fetch(url, {
      headers: { "accept-encoding": acceptEncoding },
      redirect: "manual",
    });
    return {
      status: res.status,
      contentType: res.headers.get("content-type") ?? "",
      location: res.headers.get("location") ?? "",
      body: Buffer.from(await res.arrayBuffer()),
    };
  };
}

function realGit(args) {
  const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  return { status: r.status ?? 1, stdout: r.stdout ?? "" };
}

function realReadImageLabels(image) {
  const r = spawnSync(
    "docker",
    ["image", "inspect", "--format", "{{json .Config.Labels}}", image],
    {
      encoding: "utf8",
    },
  );
  if (r.status !== 0) return { error: `cannot inspect ${image} (not built? run npm run local:up)` };
  try {
    return { labels: JSON.parse(r.stdout.trim() || "null") ?? {} };
  } catch {
    return { error: `unreadable labels on ${image}` };
  }
}

/** Runs in the page before any script: collects the raw entries onto window.__speed. */
function installProbes() {
  const s = { lcp: 0, lcpEntries: 0, cls: 0, fcp: null, longtasks: [], clicks: [], firstInput: [] };
  window.__speed = s;
  const observe = (type, cb, extra = {}) => {
    try {
      new PerformanceObserver((list) => list.getEntries().forEach(cb)).observe({
        type,
        buffered: true,
        ...extra,
      });
    } catch {
      // entry type not supported in this browser build
    }
  };
  observe("largest-contentful-paint", (e) => {
    s.lcp = e.startTime;
    s.lcpEntries++;
  });
  observe("layout-shift", (e) => {
    if (!e.hadRecentInput) s.cls += e.value;
  });
  observe("paint", (e) => {
    if (e.name === "first-contentful-paint") s.fcp = e.startTime;
  });
  observe("longtask", (e) => s.longtasks.push({ start: e.startTime, duration: e.duration }));
  observe(
    "event",
    (e) => {
      if (e.name === "click") s.clicks.push(e.duration);
    },
    { durationThreshold: 16 },
  );
  observe("first-input", (e) => s.firstInput.push(e.duration));
}

const WINDOW_MS = 3000;

/** Polls aria-expanded until it is "true" or the timeout passes (spec 87 waits the same way). */
export async function waitForMenuOpen(
  read,
  { timeoutMs = 5000, intervalMs = 50, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {},
) {
  for (let waited = 0; ; waited += intervalMs) {
    if ((await read()) === "true") return true;
    if (waited >= timeoutMs) return false;
    await sleep(intervalMs);
  }
}

/** Lazy browser probe: playwright is imported only when the first navigation happens. */
function realProbe() {
  let browser = null;
  const launch = async () => {
    if (!browser) {
      const { chromium } = await import("playwright");
      browser = await chromium.launch();
    }
    return browser;
  };
  const open = async ({ viewport, width, throttle, blockCounters }) => {
    const b = await launch();
    const context = await b.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      hasTouch: width === "phone",
      isMobile: width === "phone",
    });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    if (blockCounters)
      await cdp.send("Network.setBlockedURLs", {
        urls: ["*cloud.umami.is*", "*/site/analytics.js*"],
      });
    if (throttle) {
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle.cpuRate });
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: throttle.latencyMs,
        downloadThroughput: throttle.downloadBytesPerSec,
        uploadThroughput: throttle.uploadBytesPerSec,
      });
    }
    return { context, page };
  };
  return {
    async warmNavigate({ baseUrl, route, width, viewport }) {
      const { context, page } = await open({
        viewport,
        width,
        throttle: null,
        blockCounters: true,
      });
      try {
        await page.goto(new URL(route, baseUrl).toString(), { waitUntil: "load" });
      } finally {
        await context.close();
      }
    },
    async sample({ baseUrl, route, width, viewport, throttle }) {
      const { context, page } = await open({ viewport, width, throttle, blockCounters: true });
      try {
        await page.addInitScript(installProbes);
        await page.goto(new URL(route, baseUrl).toString(), { waitUntil: "load" });
        await page.waitForTimeout(WINDOW_MS);
        const m = await page.evaluate(() => {
          const s = window.__speed;
          const fcp = s.fcp ?? 0;
          const tbt = s.longtasks
            .filter((t) => t.start >= fcp)
            .reduce((n, t) => n + Math.max(0, t.duration - 50), 0);
          return { lcpMs: s.lcp, lcpEntries: s.lcpEntries, cls: s.cls, tbtMs: tbt };
        });
        if (width !== "phone") return m;
        const btn = page.locator(".menu-btn").first();
        const menu = {
          hasButton: (await btn.count()) > 0 && (await btn.isVisible()),
          expanded: false,
        };
        if (menu.hasButton) {
          try {
            await btn.tap({ timeout: 5000 });
          } catch {
            // a tap that cannot land leaves the menu closed, which scores as a miss below
          }
          menu.expanded = await waitForMenuOpen(() => btn.getAttribute("aria-expanded"));
          await page.waitForTimeout(600);
          const t = await page.evaluate(() => ({
            click: window.__speed.clicks.at(-1) ?? null,
            first: window.__speed.firstInput.at(-1) ?? null,
          }));
          menu.clickMs = t.click;
          menu.firstInputMs = t.first;
        }
        return { ...m, menu };
      } finally {
        await context.close();
      }
    },
    async close() {
      if (browser) await browser.close();
    },
  };
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  if (opts.help) {
    console.log(HELP);
    return;
  }
  // The refusal runs before any network, Docker or browser use.
  if (!isLocalUrl(opts.baseUrl)) {
    console.error(`refusing ${opts.baseUrl}: not localhost (no remote mode exists)`);
    process.exit(2);
  }
  const probe = realProbe();
  const deps = {
    fetcher: realFetcher(),
    gzipSize: (buf) => zlib.gzipSync(buf).length,
    probe,
    readImageLabels: realReadImageLabels,
    isAncestor: (a, b) => realGit(["merge-base", "--is-ancestor", a, b]).status === 0,
    headSha: () => {
      const r = realGit(["rev-parse", "HEAD"]);
      return r.status === 0 ? r.stdout.trim() : null;
    },
    clock: { now: () => new Date(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
    host: { cpus: cpus().length, node: process.version },
    log: (line) => console.log(line),
  };
  let out;
  try {
    out = await runSpeedRun(opts, deps);
  } finally {
    await probe.close();
  }
  mkdirSync(path.dirname(path.resolve(ROOT, opts.out)), { recursive: true });
  writeFileSync(path.resolve(ROOT, opts.out), `${JSON.stringify(out.result, null, 2)}\n`);
  console.log(`wrote ${opts.out}`);
  process.exit(out.exit);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(2);
  });
}
