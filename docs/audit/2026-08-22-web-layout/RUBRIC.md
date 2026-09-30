# Layout audit rubric — apply this verbatim

You are auditing ONE surface of an existing, shipped product. The owner's constraints are absolute:

- **Do NOT propose redesigns.** No new visual ideas, no new components, no new colors or fonts.
- **Do NOT propose changes to look and feel or branding.**
- **Do NOT propose anything that changes behaviour.**
- You are looking for *inconsistency and mess*, not for things you would have designed differently.

RouteFlow already has a written design system. Conformance to it is the entire standard:

- Tokens: `packages/config/tailwind.config.ts`
- Radius: `sm 4px` · `ctl 6px` (controls) · `DEFAULT 8px` · `card 10px` · `lg 12px` · `xl 16px` · `full`
- Elevation, hairline-first, ONLY these three: `shadow-card` (`0 1px 2px rgba(15,27,45,.05)`),
  `shadow-dropdown`, `shadow-modal`. Tailwind's `shadow-sm|md|lg|xl` are **off-token**.
- Operator surface = **compact density**: 44px row height, 13.5px body.
- Scrim: `bg-ink-900/40`. `bg-black/40` is drift.
- Shared primitives live in `@routeflow/ui/web`: `PageHeader`, `Card`, `Badge`, `Button`, `Modal`,
  `Table`, `EmptyState`, `Skeleton`/`SkeletonRows`, `StatCard`, `Tabs`.

## Two hard rules that override your judgement

1. **Raw `<table>` + `SortableTh` is a SANCTIONED idiom** (66 files use it deliberately).
   **NEVER** file "convert this to the `<Table>` component". That is not a finding.
2. **No density / whitespace / "looks sparse" finding on a table with fewer than 3 rows.**
   The capture tenant has thin demo data. Sparse data is not a layout defect. File `H4 DATA_THIN`
   instead and move on.

## Evidence you are given per page

- `probe/<slug>__w<width>.json` — **measurements**, which outrank your visual impression:
  - `h1Count` / `h1s` — more than one page-level `<h1>` is a real a11y defect (the app shell's
    topbar already renders one; `PageHeader` deliberately renders `<h2>`)
  - `tables[].clipped: true` — the table is wider than its host and **nothing scrolls**. `<main>`
    is `overflow-x-hidden`, so those columns are **clipped and unreachable**, not scrollable. This
    is invisible in the screenshot. Always S0.
  - `mainOverflow` > 1 — page-level horizontal overflow, likewise clipped
  - `escapees` — elements whose right edge escapes main's content box
  - `shell` — the page's own outermost wrapper: authored class, computed padding, max-width
  - `radii` / `shadows` — histogram of every computed value on the page; anything outside the
    sanctioned sets above is token drift
- `shots/<slug>__default__w<width>.png` — the screenshot

## Categories (you may ONLY file these codes)

- **A** shell/container — A1 missing `p-6`; A2 rhythm drift (`space-y-4/5/6`); A3 no width cap on a
  form/detail page; A4 full-height page fighting `<main>`'s `pb-24`; A5 doubled bottom padding
- **B** header/titling — B1 duplicate `<h1>`; B2 hand-rolled header instead of `PageHeader`;
  B3 title overflow; B4 action not top-right; B5 subtitle inconsistent
- **C** surface/elevation — C1 off-token radius; C2 off-token shadow; C3 hand-rolled card div;
  C4 `bg-black/N` scrim; C5 hand-rolled modal; C6 off-token colour
- **D** tables/density — **D0 clipped table (no overflow wrapper)**; D1 row height off 44px;
  D2 numeric column not right-aligned/tabular; D3 too many columns for the width; D4 no sticky
  header; D5 bare "no results" instead of `EmptyState`; D6 spinner instead of `Skeleton`
- **E** actions — E1 primary action misplaced; E2 competing primaries; E3 button size drift;
  E4 icon-only button with no accessible name; E5 destructive action without `ConfirmDialog`;
  E6 action-row alignment inconsistent with peers
- **F** alignment/whitespace — F1 ragged card heights; F2 stat row inconsistent with peers;
  F3 orphan gap >120px; F4 form fields misaligned; F5 toolbar wrapping raggedly
- **G** responsive/overflow — G1 page-level overflow; G2 hard `min-w-[Npx]`; G3 modal taller than
  viewport with no internal scroll; G4 long values breaking a cell
- **H** state coverage — H1 no loading state; H2 no empty state; H3 no error state;
  **H4 DATA_THIN** (could not judge density — too little data)

## Severity

| | Meaning |
|---|---|
| **S0** | Broken: content clipped/unreachable, elements overlapping, page-level overflow |
| **S1** | Structural drift: missing padding, duplicate `<h1>`, missing container. Cheap, safe, high impact |
| **S2** | Token drift: radius/shadow/scrim off-spec, hand-rolled card |
| **S3** | Polish: alignment, whitespace, placement. **Must cite the token spec or a peer-page precedent — if you cannot, it is S4** |
| **S4** | Out of scope: would need a redesign or a behaviour change. Log it, never fix it |

## Output — append ONE JSON object per line to your OWN shard file

Append after **each page**, never buffer. If you are killed, at most one page is lost.

```json
{"id":"D0-suppliers-001","slug":"suppliers","route":"/suppliers",
 "file":"apps/web/app/(dashboard)/suppliers/page.tsx","cat":"D0","sev":"S0","width":1440,
 "evidence":"probe tables[0]: tableW=1412 hostW=1152 hasScroller=false clipped=true",
 "problem":"Supplier table is 260px wider than its container with no scroller; main is overflow-x-hidden so the last columns are clipped and unreachable.",
 "fix":"Wrap the <table> in <div className=\"overflow-x-auto\">. Markup only, no logic change.",
 "touchesLogic":false,"confidence":"measured"}
```

`confidence`: `measured` (probe-backed) · `visual` (screenshot only) · `static` (source only).
**Only `measured` or `visual` may carry S0 or S1.**

Be terse. One finding per real problem. Do not pad the list — a short, true report is worth far
more than a long, speculative one.
