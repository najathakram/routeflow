#!/usr/bin/env node
// render.mjs — reads the roadmap registers (.claude/roadmap/*.jsonl) and writes three
// self-contained HTML files: roadmap.html (shareholder), tracker.html (internal),
// deferred.html (revisit register), plus lag.json and .rendered.json. Plain Node, no
// dependencies, no external CSS/JS.
//
// Usage:
//   node scripts/roadmap/render.mjs --validate
//   node scripts/roadmap/render.mjs --status
//   node scripts/roadmap/render.mjs [--prs <pr-list.json>] [--out <dir>]
//   node scripts/roadmap/render.mjs --help
//
// --prs takes a JSON file shaped like the output of:
//   gh pr list --state all --limit 200 --json number,state,mergedAt,title,headRefName
// This script never calls `gh` itself — the caller saves that file first.
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { gitEnv } from "../campaign/plane-client.mjs"; // the ONLY plane-client import allowed here (T31)

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const REG_FILES = ["features.jsonl", "deferred.jsonl", "releases.jsonl"];
export const HTML_FILES = ["roadmap.html", "tracker.html", "deferred.html"];
export const STATUS_BYTE_CAP = 768;
const REPO = "najathakram/routeflow";
const SELF_TEST = process.env.ROADMAP_SELF_TEST === "1";

// Seams (test-only, gated like PLANE_SYNC_SELF_TEST=1 + PLANE_RUNS_PATH in plane-client.mjs):
//   ROADMAP_REG_DIR   register directory override
//   ROADMAP_NOW       ISO timestamp used as "now" (footers, stamps, the LAG day)
//   ROADMAP_STATUS_THROW=1  force the status "failed" branch
export function regDir() {
  return SELF_TEST && process.env.ROADMAP_REG_DIR
    ? process.env.ROADMAP_REG_DIR
    : join(ROOT, ".claude", "roadmap");
}
export function defaultOutDir() {
  return join(ROOT, "local-assets", "roadmap");
}
export function nowIso() {
  if (SELF_TEST && process.env.ROADMAP_NOW) return new Date(process.env.ROADMAP_NOW).toISOString();
  return new Date().toISOString();
}
export const dayOf = (iso) => iso.slice(0, 10);
export const sha7 = (h) => (h ? String(h).slice(0, 7) : "unknown");

function loadJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l, i) => {
      try {
        return JSON.parse(l);
      } catch (e) {
        throw new Error(`${path}:${i + 1}: invalid JSON — ${e.message}`);
      }
    });
}

export function registersHash(dir = regDir()) {
  const h = createHash("sha256");
  for (const f of REG_FILES) h.update(readFileSync(join(dir, f)));
  return h.digest("hex");
}

// Throws an Error with `.unreadable = <path>` for a missing or unparsable register (R5).
export function loadRegisters(dir = regDir()) {
  const out = {};
  for (const f of REG_FILES) {
    const p = join(dir, f);
    if (!existsSync(p))
      throw Object.assign(new Error(`registers unreadable (${p})`), { unreadable: p });
    try {
      out[f.replace(".jsonl", "")] = loadJsonl(p);
    } catch {
      throw Object.assign(new Error(`registers unreadable (${p})`), { unreadable: p });
    }
  }
  return out; // { features, deferred, releases }
}

// ── validation ──────────────────────────────────────────────────────────────
export function validate(features, deferred, releases) {
  const errors = [];
  const fIds = new Set();
  for (const f of features) {
    if (fIds.has(f.id)) errors.push(`duplicate feature id: ${f.id}`);
    fIds.add(f.id);
    for (const field of ["release", "targetDate", "status"]) {
      if (!f[field]) errors.push(`feature ${f.id} is missing ${field}`);
    }
  }
  const dIds = new Set();
  for (const d of deferred) {
    if (dIds.has(d.id)) errors.push(`duplicate deferred id: ${d.id}`);
    dIds.add(d.id);
    if (d.status === "open") {
      if (!d.revisitBy) errors.push(`deferred ${d.id} is open but missing revisitBy`);
      if (!d.owner) errors.push(`deferred ${d.id} is open but missing owner`);
    }
    if (d.fromFeature && !fIds.has(d.fromFeature)) {
      errors.push(`deferred ${d.id} fromFeature points to missing feature ${d.fromFeature}`);
    }
  }
  const rIds = new Set();
  for (const r of releases) {
    if (rIds.has(r.id)) errors.push(`duplicate release id: ${r.id}`);
    rIds.add(r.id);
  }
  for (const f of features) {
    for (const dep of f.dependsOn || []) {
      if (!fIds.has(dep)) errors.push(`feature ${f.id} dependsOn missing feature ${dep}`);
    }
  }
  return errors;
}

const utcDay = (d) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
export const daysLate = (date, day) => Math.round((utcDay(day) - utcDay(date)) / 86_400_000);

// THE LAG rule. Strict `<` on the UTC calendar day; `done` never lags; a deferral lags only while open.
export function computeLag(features, deferred, day) {
  const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return {
    features: features
      .filter((f) => f.targetDate < day && f.status !== "done")
      .sort(byId)
      .map((f) => ({
        id: f.id,
        targetDate: f.targetDate,
        status: f.status,
        daysLate: daysLate(f.targetDate, day),
      })),
    deferred: deferred
      .filter((d) => d.status === "open" && d.revisitBy < day)
      .sort(byId)
      .map((d) => ({ id: d.id, revisitBy: d.revisitBy, daysLate: daysLate(d.revisitBy, day) })),
  };
}

export function validateWarnings(features, releases, day) {
  const ship = new Map(releases.map((r) => [r.id, r.shipDate]));
  const warns = [];
  for (const f of features) {
    const s = ship.get(f.release);
    if (s && f.targetDate > s)
      warns.push(`warn: ${f.id} targetDate ${f.targetDate} is after ${f.release} ships ${s}`);
    if (f.targetDate < day && f.status === "planned" && Number(f.percentDone) === 0) {
      warns.push(`warn: ${f.id} is past its targetDate (${f.targetDate}) but still planned at 0%`);
    }
  }
  return warns;
}

export function writeAtomic(path, text) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}

function headSha() {
  try {
    const r = spawnSync("git", ["-C", ROOT, "rev-parse", "HEAD"], {
      env: gitEnv(),
      encoding: "utf8",
    });
    return r.status === 0 && r.stdout ? r.stdout.trim() : null;
  } catch {
    return null;
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
  );
}

function bugIdsIn(text) {
  return [...String(text ?? "").matchAll(/\bB\d{2,4}\b/g)].map((m) => m[0]);
}

function bugCounts(features, deferred, bugs) {
  const byId = new Map(bugs.map((b) => [b.id, b]));
  const ids = new Set();
  for (const f of features) for (const id of bugIdsIn(f.notes)) ids.add(id);
  for (const d of deferred) for (const id of bugIdsIn(d.fromBug)) ids.add(id);
  let open = 0;
  let known = 0;
  for (const id of ids) {
    const b = byId.get(id);
    if (!b) continue;
    known++;
    if (String(b.register).toLowerCase() === "open") open++;
  }
  return { referenced: ids.size, known, open };
}

function prLink(n, prMap) {
  const state = prMap?.get(n);
  const tag = state ? ` <span class="prstate ${state.toLowerCase()}">${state}</span>` : "";
  return `<a href="https://github.com/${REPO}/pull/${n}" target="_blank" rel="noopener">#${n}</a>${tag}`;
}

const STATUS_LABEL = {
  done: "Done",
  "in-progress": "In progress",
  planned: "Planned",
  "at-risk": "At risk",
  deferred: "Deferred",
  open: "Open",
  scheduled: "Scheduled",
  dropped: "Dropped",
};

function pill(status) {
  return `<span class="pill ${status}">${esc(STATUS_LABEL[status] || status)}</span>`;
}

function areaLabel(a) {
  return String(a ?? "")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── shared page chrome ───────────────────────────────────────────────────────
const CSS = `
:root{--bg:#F7F8FA;--card:#FFFFFF;--ink:#1B2430;--muted:#5C6B7A;--line:#DEE3E9;--accent:#0F6E8C;
--done:#1F7A4D;--done-bg:#E4F3EA;--wip:#0F6E8C;--wip-bg:#E3F1F6;--planned:#5C6B7A;--planned-bg:#EAEEF2;
--risk:#A4400B;--risk-bg:#FBE6DC;--defer:#7A3E9D;--defer-bg:#F1E6F7;}
@media (prefers-color-scheme:dark){:root{--bg:#10151C;--card:#182029;--ink:#E7ECF1;--muted:#93A1AE;
--line:#2A3542;--accent:#5CB9D6;--done:#5FC08C;--done-bg:#12321F;--wip:#5CB9D6;--wip-bg:#12303B;
--planned:#93A1AE;--planned-bg:#212B36;--risk:#E0A24A;--risk-bg:#3A2A0F;--defer:#C79BE0;--defer-bg:#2E2038;}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,"Segoe UI",system-ui,sans-serif;
padding:16px}
.wrap{max-width:960px;margin:0 auto}
h1{font-size:1.7rem;margin:8px 0 4px}
h2{font-size:1.15rem;margin:32px 0 10px;padding-bottom:6px;border-bottom:1px solid var(--line)}
p.lede{color:var(--muted);max-width:64ch;margin:0 0 20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px 16px;margin-bottom:10px}
.card h3{margin:0 0 4px;font-size:1.02rem}
.card .desc{color:var(--muted);margin:0 0 8px}
.meta{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:.82rem;color:var(--muted)}
.meta b{color:var(--ink)}
.pill{display:inline-block;font-size:.72rem;letter-spacing:.02em;padding:2px 9px;border-radius:999px;font-weight:600}
.pill.done{color:var(--done);background:var(--done-bg)}
.pill.in-progress{color:var(--wip);background:var(--wip-bg)}
.pill.planned{color:var(--planned);background:var(--planned-bg)}
.pill.at-risk{color:var(--risk);background:var(--risk-bg)}
.pill.deferred,.pill.open{color:var(--defer);background:var(--defer-bg)}
.pill.scheduled{color:var(--wip);background:var(--wip-bg)}
.pill.dropped{color:var(--muted);background:var(--planned-bg)}
.bar{height:6px;border-radius:3px;background:var(--planned-bg);overflow:hidden;margin-top:8px}
.bar>span{display:block;height:100%;background:var(--accent)}
.prstate{font-size:.68rem;padding:0 5px;border-radius:4px;background:var(--planned-bg);color:var(--muted)}
.prstate.merged{color:var(--done);background:var(--done-bg)}
.prstate.open{color:var(--wip);background:var(--wip-bg)}
.prstate.closed{color:var(--risk);background:var(--risk-bg)}
.lag{border-color:var(--risk)}
.stats{display:flex;flex-wrap:wrap;gap:10px;margin:14px 0}
.stat{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 14px;min-width:120px}
.stat b{display:block;font-size:1.3rem}
.stat span{color:var(--muted);font-size:.78rem}
.notes{font-size:.86rem;color:var(--muted);border-top:1px dashed var(--line);margin-top:8px;padding-top:8px}
footer{color:var(--muted);font-size:.78rem;margin-top:40px}
@media(max-width:640px){.meta{flex-direction:column;gap:3px}}
`;

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style></head>
<body><div class="wrap">${body}</div></body></html>`;
}

// ── roadmap.html (shareholder) ───────────────────────────────────────────────
function renderRoadmap(features, releases, now) {
  const pub = features.filter((f) => f.public);
  const sections = releases
    .map((r) => {
      const rows = pub.filter((f) => f.release === r.id);
      if (!rows.length) return "";
      const cards = rows
        .map(
          (f) => `<div class="card"><h3>${esc(f.name)}</h3>
<p class="desc">${esc(f.description)}</p>
<div class="meta">${pill(f.status)}<span>Target: <b>${esc(f.targetDate)}</b></span>
<span>${esc(areaLabel(f.area))}</span></div></div>`,
        )
        .join("\n");
      return `<h2>${esc(r.name)} — ${esc(r.shipDate)}</h2><p class="lede">${esc(r.goal)}</p>${cards}`;
    })
    .join("\n");
  const body = `<h1>RouteFlow Product Roadmap</h1>
<p class="lede">What we're shipping, grouped by release.</p>
${sections}
<footer>Generated ${now.slice(0, 10)}.</footer>`;
  return page("RouteFlow Product Roadmap", body);
}

// ── tracker.html (internal) ─────────────────────────────────────────────────
function renderTracker(features, deferred, releases, prMap, bugStats, lag, day, now) {
  const lagFeatureIds = new Set(lag.features.map((f) => f.id));
  const lagDeferredIds = new Set(lag.deferred.map((d) => d.id));
  const lagFeatures = features.filter((f) => lagFeatureIds.has(f.id));
  const lagDeferred = deferred.filter((d) => lagDeferredIds.has(d.id));

  const featureCard = (
    f,
  ) => `<div class="card ${f.targetDate < day && f.status !== "done" ? "lag" : ""}">
<h3>${esc(f.id)} — ${esc(f.name)}</h3>
<p class="desc">${esc(f.description)}</p>
<div class="meta">${pill(f.status)}<span>${esc(f.percentDone)}%</span>
<span>${esc(areaLabel(f.area))}</span><span>${esc(f.release)}</span>
<span>Target: <b>${esc(f.targetDate)}</b></span>
<span>Lane: <b>${esc(f.ownerLane)}</b></span><span>Machine: <b>${esc(f.machine)}</b></span></div>
<div class="bar"><span style="width:${Math.max(0, Math.min(100, f.percentDone))}%"></span></div>
${f.prs?.length ? `<div class="meta">PRs: ${f.prs.map((n) => prLink(n, prMap)).join(", ")}</div>` : ""}
${f.dependsOn?.length ? `<div class="meta">Depends on: ${f.dependsOn.join(", ")}</div>` : ""}
${f.notes ? `<div class="notes">${esc(f.notes)}</div>` : ""}
</div>`;

  const byRelease = releases
    .map((r) => {
      const rows = features.filter((f) => f.release === r.id);
      if (!rows.length) return "";
      return `<h2>${esc(r.name)} (${esc(r.status)}, ship ${esc(r.shipDate)})</h2>${rows
        .map(featureCard)
        .join("\n")}`;
    })
    .join("\n");

  const lagHtml =
    lagFeatures.length || lagDeferred.length
      ? `<h2>Lag</h2>
${lagFeatures.map((f) => `<div class="card lag"><b>${esc(f.id)}</b> ${esc(f.name)} — target ${esc(f.targetDate)} has passed, status is ${esc(f.status)}.</div>`).join("\n")}
${lagDeferred.map((d) => `<div class="card lag"><b>${esc(d.id)}</b> ${esc(d.title)} — revisitBy ${esc(d.revisitBy)} has passed and it's still open.</div>`).join("\n")}`
      : `<h2>Lag</h2><p class="lede">Nothing is overdue.</p>`;

  const stats = `<div class="stats">
<div class="stat"><b>${features.length}</b><span>features tracked</span></div>
<div class="stat"><b>${deferred.filter((d) => d.status === "open").length}</b><span>open deferrals</span></div>
<div class="stat"><b>${bugStats.referenced}</b><span>bug ids referenced (${bugStats.open} open of ${bugStats.known} known)</span></div>
</div>`;

  const body = `<h1>RouteFlow Roadmap Tracker</h1>
<p class="lede">Internal view — every feature, percent done, lane, machine, and PRs.</p>
${stats}${lagHtml}${byRelease}
<footer>Generated ${now}.</footer>`;
  return page("RouteFlow Roadmap Tracker", body);
}

// ── deferred.html ────────────────────────────────────────────────────────────
function renderDeferred(deferred, features, now) {
  const fName = new Map(features.map((f) => [f.id, f.name]));
  const sorted = [...deferred].sort((a, b) => {
    if ((a.status === "open") !== (b.status === "open")) return a.status === "open" ? -1 : 1;
    return (a.revisitBy || "9999").localeCompare(b.revisitBy || "9999");
  });
  const rows = sorted
    .map(
      (d) => `<div class="card">
<h3>${esc(d.id)} — ${esc(d.title)}</h3>
<div class="meta">${pill(d.status)}<span>Revisit by: <b>${esc(d.revisitBy || "—")}</b></span>
<span>Owner: <b>${esc(d.owner || "—")}</b></span><span>Decided by: <b>${esc(d.decidedBy)}</b></span>
<span>Decided: ${esc(d.decidedOn)}</span></div>
<div class="meta">${d.fromFeature ? `From feature: <b>${esc(d.fromFeature)}${fName.has(d.fromFeature) ? " — " + esc(fName.get(d.fromFeature)) : ""}</b>` : ""}
${d.fromBug ? ` From bug: <b>${esc(d.fromBug)}</b>` : ""}</div>
<div class="notes">${esc(d.why)}${d.notes ? " — " + esc(d.notes) : ""}</div>
</div>`,
    )
    .join("\n");
  const body = `<h1>RouteFlow Deferred / Revisit Register</h1>
<p class="lede">Everything cut from scope, why, who decided, and when to look again. Open items first, soonest revisit first.</p>
${rows}
<footer>Generated ${now}.</footer>`;
  return page("RouteFlow Deferred Register", body);
}

// Returns { errors } on invalid registers (nothing written) or { errors: [], stamp, lag, files }.
export function renderAll({
  outDir = defaultOutDir(),
  prsPath = null,
  now = nowIso(),
  dir = regDir(),
} = {}) {
  const regs = loadRegisters(dir);
  const errors = validate(regs.features, regs.deferred, regs.releases);
  if (errors.length) return { errors };
  const day = dayOf(now);
  const prMap = prsPath
    ? new Map(JSON.parse(readFileSync(prsPath, "utf8")).map((p) => [p.number, p.state]))
    : null;
  const bugsPath =
    SELF_TEST && process.env.ROADMAP_REG_DIR
      ? join(dir, "bugs.jsonl")
      : join(ROOT, ".claude", "campaign", "bugs.jsonl");
  const stats = bugCounts(regs.features, regs.deferred, loadJsonl(bugsPath));
  const lag = computeLag(regs.features, regs.deferred, day);
  mkdirSync(outDir, { recursive: true });
  writeAtomic(join(outDir, "roadmap.html"), renderRoadmap(regs.features, regs.releases, now));
  writeAtomic(
    join(outDir, "tracker.html"),
    renderTracker(regs.features, regs.deferred, regs.releases, prMap, stats, lag, day, now),
  );
  writeAtomic(join(outDir, "deferred.html"), renderDeferred(regs.deferred, regs.features, now));
  writeAtomic(
    join(outDir, "lag.json"),
    JSON.stringify({ generatedAt: now, day, ...lag }, null, 2) + "\n",
  );
  const stamp = { renderedAt: now, day, registersHash: registersHash(dir), headSha: headSha() };
  writeAtomic(join(outDir, ".rendered.json"), JSON.stringify(stamp, null, 2) + "\n");
  return { errors: [], stamp, lag, files: [...HTML_FILES, "lag.json", ".rendered.json"] };
}

// ── status ────────────────────────────────────────────────────────────────
function readStamp(path) {
  if (!existsSync(path)) return null;
  try {
    const s = JSON.parse(readFileSync(path, "utf8"));
    return s && typeof s === "object" ? s : null;
  } catch {
    return null; // a malformed stamp is "no stamp"
  }
}
function staleWhy(stamp, currentHash, today) {
  if (stamp.registersHash !== currentHash) return `registers are now ${sha7(currentHash)}`;
  if (stamp.day !== today) return `today is ${today}`;
  return null;
}
function countsLine({ features, deferred, releases }, today) {
  const c = (s) => features.filter((f) => f.status === s).length;
  const named = ["in-progress", "planned", "at-risk", "done"];
  const other = features.length - named.reduce((n, s) => n + c(s), 0);
  const next = releases
    .filter((r) => r.shipDate >= today)
    .sort((a, b) => (a.shipDate < b.shipDate ? -1 : 1))[0];
  return `Roadmap: ${features.length} features (${c("in-progress")} in-progress · ${c("planned")} planned · ${c("at-risk")} at-risk · ${c("done")} done${other ? ` · ${other} other` : ""}) · ${deferred.length} deferred (${deferred.filter((d) => d.status === "open").length} open) · next: ${next ? `${next.id} ships ${next.shipDate}` : "none"}`;
}
function lagLine(lag, keepF = lag.features.length, keepD = lag.deferred.length) {
  const list = (rows, keep) => {
    if (!rows.length) return "";
    const ids = rows.slice(0, keep).map((r) => `${r.id} -${r.daysLate}d`);
    if (rows.length > keep) ids.push(`+${rows.length - keep} more`);
    return ` (${ids.join(", ")})`;
  };
  return `Roadmap LAG: ${lag.features.length} features past target${list(lag.features, keepF)} · ${lag.deferred.length} deferred past revisitBy${list(lag.deferred, keepD)}`;
}
function renderLine(outDir, currentHash, today) {
  const fix = "→ node scripts/roadmap/render.mjs";
  const stampPath = join(outDir, ".rendered.json");
  const stamp = readStamp(stampPath);
  const anyHtml = HTML_FILES.some((f) => existsSync(join(outDir, f)));
  if (!stamp && !anyHtml)
    return `Roadmap render: never rendered on this machine (no ${stampPath}) ${fix}`;
  if (!stamp) return `Roadmap render: STALE — no stamp (regenerate once to stamp it) ${fix}`;
  const missing = HTML_FILES.find((f) => !existsSync(join(outDir, f)));
  if (missing) return `Roadmap render: STALE — ${missing} missing ${fix}`;
  const why = staleWhy(stamp, currentHash, today);
  if (why)
    return `Roadmap render: STALE — rendered ${stamp.renderedAt} (day ${stamp.day}, registers ${sha7(stamp.registersHash)}) but ${why} ${fix}`;
  return `Roadmap render: fresh (${stamp.renderedAt}, registers ${sha7(stamp.registersHash)})`;
}
function publishLine(outDir, currentHash, today, hasKey) {
  const stamp = readStamp(join(outDir, ".published.json"));
  if (!stamp) {
    return hasKey
      ? "Roadmap publish: never published on this machine → npm run roadmap:publish"
      : "Roadmap publish: no PLANE_API_KEY on this machine — the PC's hourly job publishes";
  }
  const why = staleWhy(stamp, currentHash, today);
  if (why) {
    return `Roadmap publish: STALE — last published ${stamp.publishedAt} (day ${stamp.day}, registers ${sha7(stamp.registersHash)}) but ${why} → npm run roadmap:publish${hasKey ? "" : " (needs PLANE_API_KEY)"}`;
  }
  return `Roadmap publish: fresh (${stamp.publishedAt}, target ${stamp.target})`;
}
const bytesOf = (lines) => Buffer.byteLength(lines.join("\n"), "utf8");

// Never throws; never network; ≤ 5 lines; ≤ 768 bytes (the LAG line is REBUILT with fewer ids).
export function statusReport({
  outDir = defaultOutDir(),
  now = nowIso(),
  hasKey = Boolean(process.env.PLANE_API_KEY),
  dir = regDir(),
} = {}) {
  try {
    if (SELF_TEST && process.env.ROADMAP_STATUS_THROW === "1") throw new Error("self-test throw");
    const today = dayOf(now);
    const lines = [];
    let regs = null;
    let currentHash = null;
    let lag = null;
    try {
      regs = loadRegisters(dir);
    } catch (err) {
      if (!err?.unreadable) throw err;
      lines.push(`Roadmap: registers unreadable (${err.unreadable})`);
    }
    if (regs) {
      currentHash = registersHash(dir);
      const errors = validate(regs.features, regs.deferred, regs.releases);
      if (errors.length)
        lines.push(
          `Roadmap: registers INVALID (${errors.length} problems) → node scripts/roadmap/render.mjs --validate`,
        );
      lines.push(countsLine(regs, today));
      lag = computeLag(regs.features, regs.deferred, today);
      lines.push(lagLine(lag));
    }
    const lagIdx = lag ? lines.length - 1 : -1;
    lines.push(renderLine(outDir, currentHash, today));
    lines.push(publishLine(outDir, currentHash, today, hasKey));
    if (lag) {
      let keepF = lag.features.length;
      let keepD = lag.deferred.length;
      while (bytesOf(lines) > STATUS_BYTE_CAP && (keepF > 0 || keepD > 0)) {
        if (keepF > 0) keepF--;
        else keepD--;
        lines[lagIdx] = lagLine(lag, keepF, keepD);
      }
    }
    return { lines, bytes: bytesOf(lines) };
  } catch (err) {
    const line = `Roadmap: status failed (${err?.message ?? err})`;
    return { lines: [line], bytes: Buffer.byteLength(line, "utf8") };
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────
const USAGE =
  "Usage: render.mjs [--validate] [--status] [--prs <pr-list.json>] [--out <dir>] [--help]";
function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  const args = { validate: false, status: false, prs: null, out: defaultOutDir() };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--validate") args.validate = true;
    else if (tok === "--status") args.status = true;
    else if (tok === "--prs") args.prs = argv[++i];
    else if (tok === "--out") args.out = resolve(argv[++i]);
    else return { bad: tok };
  }
  return args;
}
function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(
      `${USAGE}\n--status exits 0 always — a session start must never block on it.\n`,
    );
    process.exitCode = 0;
    return;
  }
  if (args.bad) {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  if (args.status) {
    // Exit 0 in EVERY case — a session start must never block on this (R5).
    let out;
    try {
      out = statusReport({ outDir: args.out });
    } catch (err) {
      out = { lines: [`Roadmap: status failed (${err?.message ?? err})`] };
    }
    process.stdout.write(out.lines.join("\n") + "\n");
    process.exitCode = 0;
    return;
  }

  if (args.validate) {
    let regs;
    try {
      regs = loadRegisters();
    } catch (err) {
      console.error(err.message);
      process.exitCode = 1;
      return;
    }
    const errors = validate(regs.features, regs.deferred, regs.releases);
    if (errors.length) {
      console.error(`roadmap validate: ${errors.length} problem(s):`);
      for (const e of errors) console.error(`  - ${e}`);
      process.exitCode = 1;
      return;
    }
    console.log(
      `roadmap validate: OK — ${regs.features.length} features, ${regs.deferred.length} deferred, ${regs.releases.length} releases.`,
    );
    for (const w of validateWarnings(regs.features, regs.releases, dayOf(nowIso())))
      console.error(w);
    return;
  }

  let r;
  try {
    r = renderAll({ outDir: args.out, prsPath: args.prs });
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
    return;
  }
  if (r.errors.length) {
    console.error("render: registers fail validation, fix before rendering:");
    for (const e of r.errors) console.error(`  - ${e}`);
    process.exitCode = 1;
    return;
  }
  console.log(`wrote roadmap.html, tracker.html, deferred.html to ${args.out}`);
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
