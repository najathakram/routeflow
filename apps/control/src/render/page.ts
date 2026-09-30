/**
 * The command-center home page (ux-spec §3/§4): one self-contained HTML string, CSP-safe
 * (`script-src 'self'`: exactly one external script, no inline script, no on* handlers) and
 * deterministic for a given state + `now`.
 */
import { esc } from "./esc";
import {
  PANELS,
  banners,
  ctx,
  h,
  headerLines,
  join,
  raw,
  renderFragments,
  type PanelKey,
  type Raw,
  type RenderOpts,
} from "./panels";
import { naturalCompare } from "../domain/next";

export { renderFragments } from "./panels";
export type { RenderOpts } from "./panels";

const MAIN_PANELS = PANELS.filter((k) => k !== "sources");
const NAV: { id: string; label: string }[] = [
  { id: "top", label: "Now" },
  { id: "p-lanes", label: "Lanes" },
  { id: "p-waste", label: "Waste" },
  { id: "p-release", label: "Release" },
  { id: "p-queue", label: "Queue" },
  { id: "p-bugs", label: "Bugs" },
  { id: "p-prs", label: "PRs" },
  { id: "p-overlap", label: "More" },
];

function section(key: PanelKey, inner: string): Raw {
  return raw(
    `<section id="p-${key}" class="panel p-${key}" data-panel="${key}" aria-labelledby="h-${key}">${inner}</section>`,
  );
}

const LEGEND: [string, string][] = [
  ["◆ reported", "a lane or the owner reported this value"],
  ["⟳ inferred", "derived from GitHub or Railway; ⟳ old means the source is stale"],
  ["▤ register", "read from a register file"],
  ["✎ overridden", "the owner changed the register value (hover shows the register value)"],
  ["CI ✓ ✗ ◌ ⟳ –", "green, red, pending, stale, none"],
  ["● ◐ ○", "lane heartbeat: live, stale, silent"],
  ["!! ! ·", "bug severity: critical, high, medium or low"],
  ["⛔ ⚠", "blocker, risk of waste"],
];

export function renderPage(state: unknown, opts: RenderOpts): string {
  const c = ctx(state, opts);
  const frags = renderFragments(state, opts);
  const lines = headerLines(c);
  const releases = Object.keys(c.v.releases).sort(naturalCompare).join(",");
  const lanes = Object.keys(c.v.lanes).sort(naturalCompare).join(",");

  const tools = h`<div class="tools">${
    opts.local
      ? h`<span class="chip local">LOCAL · 127.0.0.1</span>`
      : h`<form method="post" action="/logout" class="inline"><button type="submit" class="btn">Log out</button></form>`
  }<button type="button" class="btn" data-act="theme" aria-label="Toggle color theme">Theme</button><button type="button" class="btn" data-act="legend" aria-label="Show legend and shortcuts">?</button></div>`;

  const body = h`<a class="skip" href="#main">Skip to content</a>
<header id="top" class="top"><div class="brand"><h1>RouteFlow Control</h1></div><div class="lines">${join(lines)}</div>${tools}</header>
<nav class="jump" aria-label="Sections"><details><summary>Jump to section</summary><ul>${join(
    NAV.map((n) => h`<li><a href="#${n.id}">${n.label}</a></li>`),
  )}</ul></details></nav>
<div id="banners" class="banners">${banners(c)}</div>
<main id="main" class="grid">${join(MAIN_PANELS.map((k) => section(k, frags[k])))}</main>
<footer class="sources">${section("sources", frags.sources)}</footer>
<aside id="drawer" class="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title" data-releases="${releases}" data-lanes="${lanes}" hidden><div class="drawer-h"><h3 id="drawer-title">Task</h3><button type="button" class="btn" data-act="close-drawer" aria-label="Close">×</button></div><div id="drawer-body"></div></aside>
<div id="scrim" class="scrim" hidden></div>
<dialog id="legend" class="legend" aria-labelledby="legend-title"><h3 id="legend-title">Legend and shortcuts</h3><dl>${join(
    LEGEND.map(([k, v]) => h`<dt>${k}</dt><dd>${v}</dd>`),
  )}</dl><p class="mut">Keys: <kbd>/</kbd> section list · <kbd>?</kbd> this legend · <kbd>Esc</kbd> close.</p><button type="button" class="btn" data-act="close-legend">Close</button></dialog>
<div id="toasts" class="toasts" role="status" aria-live="polite"></div>
<p id="sr" class="sr" aria-live="polite"></p>
<script src="/assets/client.js" defer></script>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex, nofollow">
<meta name="control-version" content="${esc(c.v.version)}">
<meta name="csrf-token" content="${esc(opts.csrf ?? "")}">
<title>RouteFlow Control</title>
<link rel="stylesheet" href="/assets/styles.css">
</head>
<body>
${body.s}
</body>
</html>
`;
}
