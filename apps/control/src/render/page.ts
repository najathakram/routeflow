/**
 * The command-center home page (ux-spec §3/§4): one self-contained HTML string, CSP-safe
 * (`script-src 'self'`: exactly one external script, no inline script, no on* handlers) and
 * deterministic for a given state + `now`. Written in plain words for a reader who is not a
 * programmer (owner ruling 2026-09-30); the hooks the client and tests rely on are unchanged.
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
  VIEW_ONLY_CHIP_TITLE,
  type PanelKey,
  type Raw,
  type RenderOpts,
} from "./panels";
import { naturalCompare } from "../domain/next";

export { renderFragments } from "./panels";
export type { RenderOpts } from "./panels";

const MAIN_PANELS = PANELS.filter((k) => k !== "sources");
export const NAV: { id: string; label: string }[] = [
  { id: "top", label: "Summary" },
  { id: "p-lanes", label: "Who is doing what" },
  { id: "p-waste", label: "At risk" },
  { id: "p-release", label: "Releases" },
  { id: "p-queue", label: "Up next" },
  { id: "p-bugs", label: "Bugs" },
  { id: "p-prs", label: "Pull requests" },
  { id: "p-overlap", label: "More" },
];

function section(key: PanelKey, inner: string): Raw {
  return raw(
    `<section id="p-${key}" class="panel p-${key}" data-panel="${key}" aria-labelledby="h-${key}">${inner}</section>`,
  );
}

/** What the page tells a first-time reader it is, under the title. */
export const TAGLINE =
  "A live view of what every lane is doing, what is next, and what is at risk. A lane is one Claude session. This page updates by itself.";

/** The help dialog: each symbol the page uses, in the words the page uses for it. */
export const LEGEND: [string, string][] = [
  [
    "◆ Set by you, or reported by a lane",
    "Set or changed by you or by a lane — the badge names who. A lane is one Claude session.",
  ],
  [
    "✎ Changed from the register file",
    "The value differs from the one the register file holds. Hover to see the register file's value.",
  ],
  [
    "⟳ Detected from GitHub or Railway",
    "This page worked it out itself. Detected earlier means the source has not updated lately, so it may be out of date.",
  ],
  ["▤ From the register file", "Read straight from a register file."],
  ["✓ ✗ ◌ ⟳ –", "Checks on a pull request: passed, failing, running, out of date, none yet."],
  [
    "● ◐ ○",
    "How lively a lane is: active (updated recently), quiet (not for a while) or inactive (not for a long time).",
  ],
  [
    "High collision risk, Possible collision",
    "Two lanes are changing the same files, so their work may clash when it merges.",
  ],
  ["⛔", "Blocked: the task cannot move until something else happens."],
  [
    "⚠",
    "At risk of being wasted: a pull request or branch that is going stale, conflicting or never reached production.",
  ],
];

export function renderPage(state: unknown, opts: RenderOpts): string {
  const c = ctx(state, opts);
  const frags = renderFragments(state, opts);
  const lines = headerLines(c);
  const releases = Object.keys(c.v.releases).sort(naturalCompare).join(",");
  const lanes = Object.keys(c.v.lanes).sort(naturalCompare).join(",");
  const nexts = Object.keys(c.v.lanes)
    .sort(naturalCompare)
    .map((k) => `${k}:${c.v.lanes[k].next?.value ?? ""}`)
    .join(",");

  const tools = h`<div class="tools">${
    opts.local
      ? h`<span class="chip local" title="Only reachable from this computer (127.0.0.1)">Running on this computer only</span>`
      : h`<form method="post" action="/logout" class="inline"><button type="submit" class="btn">Log out</button></form>`
  }${
    c.writeback
      ? raw("")
      : h`<span class="chip view-only" title="${VIEW_ONLY_CHIP_TITLE}">View only</span>`
  }<button type="button" class="btn" data-act="theme" aria-label="Light / dark: change the colour theme">Light / dark</button><button type="button" class="btn" data-act="legend" aria-label="Help: what the symbols mean">Help</button></div>`;

  const body = h`<a class="skip" href="#main">Skip to content</a>
<header id="top" class="top"><div class="brand"><h1>RouteFlow Control</h1><p class="tagline">${TAGLINE}</p></div><div class="lines">${join(lines)}</div>${tools}</header>
<nav class="jump" aria-label="Sections"><details><summary>Go to a section</summary><ul>${join(
    NAV.map((n) => h`<li><a href="#${n.id}">${n.label}</a></li>`),
  )}</ul></details></nav>
<div id="banners" class="banners">${banners(c)}</div>
<main id="main" class="grid">${join(MAIN_PANELS.map((k) => section(k, frags[k])))}</main>
<footer class="sources">${section("sources", frags.sources)}</footer>
<aside id="drawer" class="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title" data-releases="${releases}" data-lanes="${lanes}" data-nexts="${nexts}" hidden><div class="drawer-h"><h3 id="drawer-title">Task</h3><button type="button" class="btn" data-act="close-drawer" aria-label="Close">×</button></div><div id="drawer-body"></div></aside>
<div id="scrim" class="scrim" hidden></div>
<dialog id="legend" class="legend" aria-labelledby="legend-title"><h3 id="legend-title">Help: how to read this page</h3><dl>${join(
    LEGEND.map(([k, v]) => h`<dt>${k}</dt><dd>${v}</dd>`),
  )}</dl><p class="mut">Keys: <kbd>/</kbd> go to a section · <kbd>?</kbd> this help · <kbd>Esc</kbd> close.</p><button type="button" class="btn" data-act="close-legend">Close</button></dialog>
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
<meta name="control-writeback" content="${c.writeback ? "on" : "off"}">
<title>RouteFlow Control</title>
<link rel="stylesheet" href="/assets/styles.css">
</head>
<body>
${body.s}
</body>
</html>
`;
}
