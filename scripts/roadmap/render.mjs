#!/usr/bin/env node
// render.mjs — reads the roadmap registers (.claude/roadmap/*.jsonl) and writes three
// self-contained HTML files: roadmap.html (shareholder), tracker.html (internal),
// deferred.html (revisit register). Plain Node, no dependencies, no external CSS/JS.
//
// Usage:
//   node scripts/roadmap/render.mjs --validate
//   node scripts/roadmap/render.mjs [--prs <gh-pr-list.json>] [--out <dir>]
//
// --prs takes a JSON file shaped like the output of:
//   gh pr list --state all --limit 200 --json number,state,mergedAt,title,headRefName
// This script never calls `gh` itself — the caller saves that file first.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REG_DIR = join(ROOT, ".claude", "roadmap");
const REPO = "najathakram/routeflow";

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

function parseArgs(argv) {
  const args = { validate: false, prs: null, out: join(ROOT, "local-assets", "roadmap") };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--validate") args.validate = true;
    else if (argv[i] === "--prs") args.prs = argv[++i];
    else if (argv[i] === "--out") args.out = resolve(argv[++i]);
  }
  return args;
}

// ── validation ──────────────────────────────────────────────────────────────
function validate(features, deferred, releases) {
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

// ── helpers ──────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
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
  return String(a ?? "").replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
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
function renderRoadmap(features, releases) {
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
<span>${esc(areaLabel(f.area))}</span></div></div>`
        )
        .join("\n");
      return `<h2>${esc(r.name)} — ${esc(r.shipDate)}</h2><p class="lede">${esc(r.goal)}</p>${cards}`;
    })
    .join("\n");
  const body = `<h1>RouteFlow Product Roadmap</h1>
<p class="lede">What we're shipping, grouped by release.</p>
${sections}
<footer>Generated ${new Date().toISOString().slice(0, 10)}.</footer>`;
  return page("RouteFlow Product Roadmap", body);
}

// ── tracker.html (internal) ─────────────────────────────────────────────────
function renderTracker(features, deferred, releases, prMap, bugStats) {
  const today = new Date().toISOString().slice(0, 10);
  const lagFeatures = features.filter((f) => f.targetDate < today && f.status !== "done");
  const lagDeferred = deferred.filter((d) => d.status === "open" && d.revisitBy < today);

  const featureCard = (f) => `<div class="card ${f.targetDate < today && f.status !== "done" ? "lag" : ""}">
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

  const lagHtml = lagFeatures.length || lagDeferred.length
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
<footer>Generated ${new Date().toISOString()}.</footer>`;
  return page("RouteFlow Roadmap Tracker", body);
}

// ── deferred.html ────────────────────────────────────────────────────────────
function renderDeferred(deferred, features) {
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
</div>`
    )
    .join("\n");
  const body = `<h1>RouteFlow Deferred / Revisit Register</h1>
<p class="lede">Everything cut from scope, why, who decided, and when to look again. Open items first, soonest revisit first.</p>
${rows}
<footer>Generated ${new Date().toISOString()}.</footer>`;
  return page("RouteFlow Deferred Register", body);
}

// ── main ─────────────────────────────────────────────────────────────────────
function main() {
  const args = parseArgs(process.argv.slice(2));
  const features = loadJsonl(join(REG_DIR, "features.jsonl"));
  const deferred = loadJsonl(join(REG_DIR, "deferred.jsonl"));
  const releases = loadJsonl(join(REG_DIR, "releases.jsonl"));

  if (args.validate) {
    const errors = validate(features, deferred, releases);
    if (errors.length) {
      console.error(`roadmap validate: ${errors.length} problem(s):`);
      for (const e of errors) console.error(`  - ${e}`);
      process.exit(1);
    }
    console.log(
      `roadmap validate: OK — ${features.length} features, ${deferred.length} deferred, ${releases.length} releases.`
    );
    return;
  }

  const errors = validate(features, deferred, releases);
  if (errors.length) {
    console.error("render: registers fail validation, fix before rendering:");
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  let prMap = null;
  if (args.prs) {
    const raw = JSON.parse(readFileSync(args.prs, "utf8"));
    prMap = new Map(raw.map((p) => [p.number, p.state]));
  }
  const bugs = loadJsonl(join(ROOT, ".claude", "campaign", "bugs.jsonl"));
  const stats = bugCounts(features, deferred, bugs);

  mkdirSync(args.out, { recursive: true });
  writeFileSync(join(args.out, "roadmap.html"), renderRoadmap(features, releases), "utf8");
  writeFileSync(
    join(args.out, "tracker.html"),
    renderTracker(features, deferred, releases, prMap, stats),
    "utf8"
  );
  writeFileSync(join(args.out, "deferred.html"), renderDeferred(deferred, features), "utf8");
  console.log(`wrote roadmap.html, tracker.html, deferred.html to ${args.out}`);
}

main();
