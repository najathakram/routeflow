# UX spec: the Control command center (slice 1 home page)

> **Stage P5 — UX.** Authored 2026-09-30 by Fable 5.1. Status: `DRAFT`.
> Inputs: [spec.md](./spec.md) (R13, R14, R18, R21, R33, R34), [discovery.md](./discovery.md)
> evidence E5, E28, E29, E31. Design system: the repo cache
> [`.claude/pipeline/design-system.md`](../design-system.md) (derived 2026-08-31, E29) **plus** the
> roadmap renderer's own CSS block (`scripts/roadmap/render.mjs:233-282`, E5) which already defines
> a light + dark token set for generated pages. **No new design-system cache is written**: the
> dashboard is an internal tool rendered by a Node service without Tailwind/React, so it consumes
> the *values* of the Ledger tokens (§1) as plain CSS custom properties. The one deliberate
> deviation from the web app is dark mode: web has none (E28), render.mjs does; the dashboard
> follows render.mjs because the owner reads it at night on a PC.

---

## 0. The one-screen summary (what the owner sees in three seconds)

```
NOW      8 lanes · 5 active · 1 blocked · 2 stale         RELEASE R1.1c ships Oct 1 · AT RISK · 6/9 done
BROKEN   79 open bugs · 4 critical · 12 in flight · 9 fixed this week
WASTE    3 items at risk (1 conflicting PR · 1 orphan branch · 1 merged-not-deployed)
```
then, in reading order: the **lane board** (who is on what → what next), the **waste and
blockers** strip, the **release bar**, the **queue**, and only then the reference panels (PRs,
bugs, overlap, piggyback, phases, timeline). Everything above the fold answers "now / next /
broken / shipping"; everything below answers "why" on drill-down.

## 1. Tokens the page uses (derived, not invented)

| Role | Light | Dark | Source |
|---|---|---|---|
| page bg / card / line | `#F7F8FA` / `#FFFFFF` / `#DEE3E9` | `#10151C` / `#182029` / `#2A3542` | render.mjs CSS `--bg/--card/--line` (E5) — same family as Ledger `--canvas/--paper/--line` (E28) |
| ink / muted | `#1B2430` / `#5C6B7A` | `#E7ECF1` / `#93A1AE` | render.mjs `--ink/--muted` |
| accent (links, focus ring, bars) | `#0F6E8C` | `#5CB9D6` | render.mjs `--accent` (brand teal family; Ledger brand-500 `#14A39F` is the app's, render.mjs's darker teal reads better on generated pages) |
| status: done / wip / planned / risk / defer | fg+bg pairs `--done/--done-bg` … | dark pairs | render.mjs pills (`.pill.done` etc.) |
| severity: critical / high / medium / low | `#B42318` on `#FEE4E2` / `#A4400B` on `#FBE6DC` / `#8A6100` on `#FFF1C2` / `#5C6B7A` on `#EAEEF2` | `#F97066` on `#3B1512` / `#E0A24A` on `#3A2A0F` / `#E9C46A` on `#3A3009` / `#93A1AE` on `#212B36` | **new pairs** for the two severities render.mjs lacks (critical, medium); derived from the same hue families; contrast is proven by T62, not eyeballed (dataviz rule: status colors reserved, always icon/label + color) |
| radius / shadow | `8px` cards (render.mjs), `6px` controls (Ledger `--r-ctl`) / `0 1px 2px rgba(15,27,45,.05)` | — | render.mjs `.card`, Ledger `--r-ctl`, `--sh-card` |
| type | system stack `-apple-system,"Segoe UI",system-ui` 15px/1.5 body (render.mjs); `.money`-style `tabular-nums` mono for every count and id | — | render.mjs `body`; Ledger `.money` utility (no webfont: CSP `default-src 'self'`, no external requests) |
| density | operator density: row height 32px in tables, 44px hit targets on 390 (Ledger `--row-h 44px`) | — | Ledger E28 |

Semantics are fixed: **status** hue = teal (in progress) / green (done) / grey (planned) /
orange (at risk, blocked) / purple (deferred, reconsider); **severity** = red→grey ramp above;
**source** badges are neutral outlines with a glyph: `◆ reported`, `⟳ inferred`, `▤ register`,
`✎ overridden`. Never color alone: every pill has text; every severity has a glyph (`!!`, `!`,
`·`, `·`).

## 2. Information hierarchy

| Tier | Read in | Content | Encoding |
|---|---|---|---|
| 0 | < 3 s | header status line (§0) | three fixed lines, tabular numbers, two colored words max per line |
| 1 | < 15 s | lane board; waste + blockers strip; release bar | cards in a grid; each lane card = current (bold) → next (muted) + one-line PR fact; strip = list of ≤ 6 items with a glyph and an action verb |
| 2 | on scan | queue (top 10), bug counters + severity mix, open PRs table | compact tables, sortable by click (client JS, no server) |
| 3 | on drill-down | overlap pairs, piggyback per lane, feature phase bars, timeline | collapsed sections (`<details open>` at 1440, collapsed at 390) |
| 4 | on demand | task drawer (inspect + write-back), PR ledger history, warnings list | side drawer / modal |

Rule: a tier-N element never sits above a tier-(N−1) element at any viewport.

## 3. Panels and their visual encoding (each answers one owner question)

| # | Owner question | Panel | Encoding (dataviz form choice) | Empty state copy |
|---|---|---|---|---|
| P0 | what is happening now | **Header status line** | 3 lines of stat tiles-as-text; no chart (dataviz: a headline number is not a chart) | "No lanes registered — `npm run ctl -- lane register …`" |
| P1 | what is each lane doing / next | **Lane board** — one card per active lane, grid | card: lane name + machine chip · heartbeat dot (green < 4 h, amber < 24 h, red stale, grey silent) · **Current**: `RF-231 · title` + phase pill + PR chip (`#2801 · CI ✓ · review ✎ · clean`) · **Next**: `RF-240 · title` (explicit ★ or computed) · blocker line in orange if any · `overlap ▲2` chip when the lane is in a WARN/HOT pair | "Idle — next: RF-240 (P1)" / "No next eligible — queue empty for this lane" |
| P2 | what is blocked | **Blockers strip** | horizontal list: `⛔ RF-231 · lane-u · "waiting on SA-442" · 3 d` | "No blockers" (muted, still rendered) |
| P3 | what is at risk of waste | **At risk of waste** | list grouped by rule severity; each row: rule glyph + subject (`PR #2733` / `branch fix/B905-…`) + why + **action button** (`Ack`, `Mark superseded`) + age | "Nothing at risk — every open PR is moving" |
| P4 | what ships next / is it ready | **Release bar** — the next unshipped release first, then the rest | one horizontal stacked bar per release: released ▮ / code-complete ▮ / in-progress ▮ / planned ▯ / blocked ▮ (2 px surface gaps, thin marks, direct labels for ≥ 10 %); readiness pill READY / IN PROGRESS / AT RISK; MOVED badge with `Oct 1 → Oct 3`; PR metrics line `12 PRs · lead time med 1.8 d · 2 closed-unmerged` | "No releases — add one in releases.jsonl" |
| P5 | what is next overall | **Queue** — top 10 eligible across lanes | table: priority pill · id · title · release · effort · lane (or `any`) · reason (`P0`, `blocks RF-233`) | "Queue empty" |
| P6 | what is broken | **Bugs** | four stat tiles (open / critical / in flight / fixed 7 d) + one horizontal severity bar (single hue ramp, 4 segments, direct labels) + `register lag n` chip | "No open bugs" |
| P7 | where are the PRs | **PR ledger** — open PRs table; below it two collapsed lists: merged (7 d) and closed-unmerged | row: `#n` · title (truncated 60) · lane chip · links (`RF-231`, `B905`) · state (draft/ready) · CI (✓ ✗ ◌ stale) · review · mergeable · age · files · deployed (✓ api ✓ web) | "No open PRs" |
| P8 | will two lanes collide | **Overlap** | matrix at 1440 (lanes × lanes, cell = shared count, HOT/WARN color) / list at ≤ 768 (`lane-u ↔ r-ui · 4 shared · HOT · from diff`) with the shared paths on expand | "No overlapping work" |
| P9 | what can be fixed cheaply while here | **Piggyback** per active lane | `lane-u (invoices/**): 3 cheap wins` → rows `B905 · low · score .8 · sensitive` with `Assign to lane` action | "No cheap wins near current work" |
| P10 | what is partially done | **Feature phases** | one thin bar per in-progress feature with 9 phase ticks; the current phase tick is filled; `%` label right | "No features in progress" |
| P11 | what changed | **Timeline** — last 40 | `12:04 · lane-u · started RF-231` / `11:58 · ⟳ #2801 merged → RF-229 code-complete` / `11:40 · owner · RF-240 priority P2→P1` (source glyph first) | "No activity yet" |
| P12 | is the data fresh | **Footer / sources bar** | `master 47f648c · state #lane-u 12 · GitHub 09:31:02 (rate 4,120) · Railway api ✓ web ✓ · version 9f3a…` — any source older than 2 min turns amber, 10 min red | — |

## 4. Layout wireframes

### 4.1 Desktop 1440 (12-col grid, 24 px gutters, max width 1400)

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ RouteFlow Control            NOW 8 lanes·5 active·1 blocked   RELEASE R1.1c Oct 1 AT RISK 6/9 │
│                              BROKEN 79 open·4 crit·12 in flight WASTE 3 at risk    [⎋ logout] │
├──────────────────────────────────┬───────────────────────────────┬────────────────────────┤
│ LANE BOARD (8 cols)              │                               │ BLOCKERS + WASTE (4)   │
│ ┌ lane-u  PC ● 12m ┐ ┌ r-ui Mac ● ┐ ┌ lane-b ◐ 5h ┐ ┌ f2 ○ 2d  ┐    │ ⛔ RF-231 lane-u 3 d   │
│ │ ▶ RF-231 invoice  │ │ ▶ RF-244  │ │ ▶ B889     │ │ idle     │    │ ⚠ PR #2733 conflicts   │
│ │   #2801 CI✓ rev✎  │ │   #2810 ◌ │ │   #2790 ✗  │ │ next B905│    │ ⚠ fix/B905 orphan 3 d  │
│ │ ★ RF-240 dates    │ │ → RF-250  │ │ ⛔ SA-442  │ │          │    │ ⟳ #2788 not deployed   │
│ └ overlap ▲ r-ui ─┘ └───────────┘ └────────────┘ └──────────┘    │ [Ack] [Superseded]     │
├──────────────────────────────────┴───────────────────────────────┴────────────────────────┤
│ RELEASE R1.1c · ships Oct 1 · AT RISK   ▮▮▮▮▮▮▯▯▯  6 released 1 cc 1 wip 1 planned · 12 PRs · lt 1.8 d │
│ R2 · Oct 9 · IN PROGRESS · MOVED Oct 2→Oct 9        ▮▮▯▯▯▯▯▯▯                             │
├──────────────────────────────┬───────────────────────────┬────────────────────────────────┤
│ QUEUE top 10 (5 cols)        │ BUGS (3 cols)             │ OPEN PRs (4 cols)              │
│ P0 RF-233 … R1.1c S any      │ 79 open  4 crit  12 fly   │ #2801 lane-u RF-231 ✓ ✎ clean  │
│ P1 RF-240 … R1.1c S lane-u   │ ▮▮▮▮▮▮▮▮▮▮▮▮ crit hi med lo│ #2810 r-ui  RF-244 ◌ – clean   │
├──────────────────────────────┴───────────────────────────┴────────────────────────────────┤
│ ▸ OVERLAP (matrix)   ▸ PIGGYBACK per lane   ▸ FEATURE PHASES   ▸ TIMELINE (40)             │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│ master 47f648c · state lane-u#12 · GitHub 09:31:02 (4,120) · Railway api✓ web✓ · v 9f3a   │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

### 4.2 Tablet 768 (single column, 16 px gutters; lane cards 2-up)

```
┌ header: 3 status lines stacked, logout right ┐
│ LANE BOARD (2 cards per row)                 │
│ BLOCKERS + WASTE (full width list)           │
│ RELEASE bars (full width)                    │
│ QUEUE (full width table, 5 columns)          │
│ BUGS tiles 2×2 + severity bar                │
│ OPEN PRs (table: #, lane, links, CI, mergeable; review/files hidden < 900 px) │
│ ▸ Overlap (list form)  ▸ Piggyback  ▸ Phases  ▸ Timeline │
│ footer sources                               │
└──────────────────────────────────────────────┘
```

### 4.3 Phone 390 (single column, 16 px gutters, 44 px targets)

```
┌ RouteFlow Control            [≡] ┐   ≡ opens a section jump list (Now, Lanes, Waste,
│ NOW 8·5·1·2   REL R1.1c AT RISK  │     Release, Queue, Bugs, PRs, More)
│ BROKEN 79·4   WASTE 3            │
│ LANES (1-up cards, 3 lines each) │   card = current line, next line, PR/blocker line
│ WASTE + BLOCKERS (≤ 6, "more…")  │
│ RELEASE next only (others under ▸)│
│ QUEUE top 5 (id · title · P · lane)│
│ BUGS 4 tiles 2×2                 │
│ ▸ PRs ▸ Overlap ▸ Piggyback      │   collapsed by default
│ ▸ Phases ▸ Timeline              │
│ footer (2 lines)                 │
└──────────────────────────────────┘
```
No horizontal scroll at any width (tables switch to a two-line row layout ≤ 480 px: first line id
+ title, second line the chips).

## 5. States (every panel, every surface)

| State | Trigger | Rendering |
|---|---|---|
| Loading (first paint) | page served before the first fold completed (boot) | skeleton rows (Ledger `.skeleton` shimmer, reduced-motion aware) per panel + footer "warming up · sources: master ◌ state ◌ GitHub ◌" ; auto-refresh via SSE |
| Empty | a panel has no rows | the panel stays with its empty copy (§3) — never removed, so the layout is stable |
| Stale source | a source's last success > 2 min (amber) / > 10 min (red) | footer chip colors + a top banner at red: "GitHub data is 12 min old (rate limit 0, resets 09:58)" — panels keep the last data, badge `⟳ old` on inferred chips |
| Malformed rows | fold `warnings[]` non-empty | dismissible banner "3 events could not be applied — lane-b #14 illegal transition …" + ⓘ per affected task; the rest renders |
| Register lag | inferred ≠ register (§5.7) | `register lag` chip on the value; never a banner |
| Write pending | owner clicked a write-back control | the control is disabled with an inline spinner; **no optimistic value** (R18); other controls stay enabled |
| Write confirmed | 200 + SSE version | control re-enabled with the new value; toast "RF-240 priority P2 → P1 · [Undo 10 s]" (Ledger Toast with `action`) |
| Write failed | 4xx/5xx/network | control re-enabled with the old value; inline red text beside the control ("Not saved: rate limited (429)"); toast persists until dismissed |
| Conflict | 409 (state moved on) | toast "State changed elsewhere — reloaded"; the page refetches; the drawer stays open on the same task with fresh values |
| Logged out / expired | 401 on any fetch | full-page login form (single password field, submit, error line); after login return to `/` |
| Rate limited (login) | 429 | form disabled 2 s, message "Too many attempts, try again in 15 min" |
| SSE dropped | `EventSource.onerror` | footer chip "live ◌ reconnecting"; polling fallback every 60 s |
| Local mode | `CONTROL_LOCAL=1` | header chip `LOCAL · 127.0.0.1` in orange; no logout control |
| Drawer | click on any task id | right drawer 440 px (full screen ≤ 768) with: title, status/source badges, priority select, release select, lane select, "Set as next for lane" select, Reconsider (with why), Areas (textarea, one glob per line), PR facts, event history (last 20), `Esc` closes |

## 6. Interaction model for write-back

- **Inline** (one click, no drawer) for: `Ack` / `Mark superseded` on waste rows, `Set next`
  from a queue row (`★` button), `Assign to lane` from piggyback rows.
- **Drawer** for everything with a choice (priority, release, lane, reconsider, areas).
- **Confirmed, not optimistic**: the value changes only when the server's fold comes back (R18).
- **Undo = compensating event** shown in the toast for 10 s, and always available from the
  timeline row's `↶` for owner events (posts the inverse event; history keeps both).
- **Version guard**: every POST carries `expectedVersion`; the server's 409 reloads.
- **Keyboard**: every control is a native `<button>`/`<select>`/`<textarea>`; drawer traps focus
  and restores it on close; `/` focuses the section jump list; `?` shows a legend of glyphs.

## 7. Accessibility

Landmarks (`<header>`, `<main>`, `<nav>` for the jump list, `<footer>`); one `<h1>`, one `<h2>`
per panel; tables with `<th scope>`; status pills carry text; severity glyphs plus text; live
region `aria-live="polite"` announces "state updated" at most once per 30 s; focus ring = 2 px
accent (Ledger `.focus-ring` values); `prefers-reduced-motion` disables shimmer and toast
slide; contrast per T62 (computed WCAG ratios for every fg/bg pair in both schemes; any pair
< 4.5:1 for text or < 3:1 for pills fails the test, so the palette above is provisional until T62
passes — the fix is to darken the fg step, never to drop the label); minimum 44 px targets at
390 px; no information conveyed by hover only (no tooltip primitive exists, E29 — every `title=`
also appears in the drawer).

## 8. Copy rules (ux-copy pass)

Verbs in the imperative on buttons (`Ack`, `Set next`, `Assign`, `Undo`); ids in mono; time as
relative + absolute on hover (`3 d` / `2026-09-27 14:02Z`); never "error occurred" — always what
and what next (`Not saved: state changed elsewhere — reloaded`); one sentence per empty state
that names the command that fills it.

## 9. Design-critique pass (self-review, design:design-critique framework)

**Overall impression.** The page reads top-down as now → next → broken → shipping, and the
three-line header carries the whole answer for the 3-second read. Biggest opportunity: the
waste panel and the blockers strip compete for the same right-hand column at 1440; if both are
long the release bar scrolls below the fold.

| Finding | Severity | Recommendation (applied?) |
|---|---|---|
| Blockers + waste share one column; long lists push the release bar down | 🟡 | **Applied**: cap the strip at 6 rows with "+n more" opening the full list; release bar is fixed as the first full-width row below the board |
| Lane cards show a PR chip with five glyphs (`#2801 CI✓ rev✎ clean`) — dense for first read | 🟡 | **Applied**: chip shows only CI + mergeable at tier 1; review/files in the drawer |
| Overlap matrix at 1440 has n² cells for 8 lanes (64) — mostly empty | 🟢 | **Applied**: matrix hides lanes with no current task; falls back to the list form under 5 active lanes |
| Two colored words per header line could become five on a bad day (AT RISK, blocked, stale, crit) | 🟡 | **Applied**: rule — a header line colors at most the single worst word; the rest is plain ink |
| Undo only in the toast | 🟡 | **Applied**: `↶` also on timeline rows for owner events |
| Dark palette for critical/medium severities is new and unvalidated | 🟡 | **Accepted as risk**: T62 computes contrast; dataviz validator run in WP7 before the capture (`node scripts/validate_palette.js …` from the dataviz skill) |
| No Tooltip primitive → `title=` on hover is invisible on touch | 🟢 | **Applied**: everything under `title=` is repeated in the drawer |

**What works**: status line, lane card current→next structure, inferred/reported badges make
provenance visible (fleet-lead §1), waste rows carry an action verb.

**Verdict:** `REVISED — 6 edits applied, 1 accepted risk (T62 + validator gate before capture)`.
