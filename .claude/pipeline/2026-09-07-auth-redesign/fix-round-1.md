# Light loop — round 1 (post-engine review + UI verify) — auth-redesign

Written by the Lead (Fable 5.1) on 2026-09-07 after the account switch. Engine `wf_ca7094ab-7e5` was
stopped mid fix-loop (62 agents, no `result.json`). Its tree is the checkpoint commit **`102c79ce`**
(`chore(auth): engine checkpoint`, 37 files, +3732/−1493) on `feat/auth-redesign`, base **`42a4893e`**
(= `feat/marketing-port` head, PR #657). Gates on 102c79ce were GREEN: `tsc` clean, `npm run lint -w apps/web`
0 errors, web Jest 445/445, prettier clean (`local-assets/handoff/2026-09-07/logs/auth-gate-*.log`).

Diff under review: `git -C C:/ClaudeCode/routeflow/.claude/worktrees/rf-F09 diff 42a4893e 102c79ce`.
Plan artifacts (same dir as this file): `spec.md`, `ux-spec.md`, `test-plan.md` (§Regression fence at
line ~122), `build-plan.md`, `discovery.md`.

## Binding constraints (from the engine's brief; any breach is a finding)

1. **Logic byte-identical** on every reskinned page: same requests (path, method, payload keys), same
   redirects, same error branches, same state machine; only markup/classes/shell change.
2. Every string in `test-plan.md` §Regression fence (labels, placeholders, buttons, links) survives verbatim.
3. `apps/web/app/globals.css` and `packages/config/tailwind.config.ts` byte-identical to 42a4893e (MKT-PIN T7).
4. No `next/image`; no `packages/ui` edits; no middleware or route-file changes; `/login` stays proxied for phones.
5. No "Design preview" / fake mockup values from the Codex `AuthPreview` in real pages.
6. One `h1` per page; layout collapses to a single column at ≤ 850 px.
7. New CSS scoped under `.rf-auth` only (no unscoped `body`/`html`/`:root` rules).

## The 15 pages (7 operator, 8 buyer)

`/login`, `/signup`, `/signup/check-email`, `/forgot-password`, `/reset-password`, `/change-password`,
`/verify-email`, `/buyer/login`, `/buyer/register`, `/buyer/forgot-password`, `/buyer/reset-password`,
`/buyer/change-password`, `/buyer/verify-email`, `/buyer/verify-merge`, `/buyer/invite/[token]`.

## R1 — Opus refute-first review (claims; each HELD / REFUTED with file:line)

- **C1** `components/brand/BrandMark.tsx` (+18): additive only; every marketing usage
  (`app/(marketing)/**`, `components/brand/*`, dashboard `TenantLogo`) renders exactly as on 42a4893e;
  `BrandMark.test.tsx` and `no-next-image.test.ts` unchanged and green.
- **C2** `app/(auth)/login/page.test.tsx` (+76) and `app/buyer/forgot-password/page.test.tsx` (+6): the
  hunks only ADD assertions; no `expect` removed or weakened, no pinned label/link/selector relaxed.
- **C3** The two extra pages `app/change-password/page.tsx` and `app/verify-email/page.tsx`: middleware
  (unchanged) still serves them as Next pages on desktop; they sit outside `MARKETING_AUTH_PATHS` so phones
  are proxied exactly as `/login` is — confirm from `middleware.ts` + `lib/marketing-routes.ts` on the branch.
- **C4** Specs 46/47/48: **`playwright.config.ts` on 102c79ce has ONE new project (spec 46, line ~619);
  specs 47 and 48 have NO project entry** (Lead observed). Report: what each of 47/48 asserts, whether 48
  imports `@axe-core/playwright` (NOT a dependency on this branch), whether every pre-existing project is
  intact. Do not fix; Fable rules in S4 (wire vs fold vs drop).
- **C5** `.claude/pipeline/design-system.md` (+4): cache refresh only, no rule change.
- **C6** Regression fence: grep every fenced string against the reskinned pages; list any miss.
- **C7** `globals.css` + `tailwind.config.ts` absent from the diff.
- **C8** No `next/image`, no `packages/ui`, no `middleware.ts`/route changes, no mockup fake values; one
  `h1` per page in the JSX (static read, all 15).
- **C9** Logic byte-identical per page (HIGH): for each of the 15 pages compare old vs new: fetch/mutation
  calls, payload keys, redirect targets, error branches, query-param handling (`token`, `next`, `email`),
  timers/resend cooldowns, `router.replace` vs `push`. Any behavioural delta = HIGH finding with a failing
  scenario. This is the money-equivalent of this slice (auth).
- **C10** `components/auth/auth-shell.css` (331 lines): every rule scoped under `.rf-auth`; no `@import`
  of Google fonts (fonts are the marketing layout's); no `!important` on marketing/dashboard selectors.
- **C11** `AuthShell.tsx` a11y: one landmark `main`, the `h1` comes from the page not the shell, links
  (`RouteFlow home`, `Need help?`) have accessible names, no focus trap, `prefers-reduced-motion` honoured.
- **C12** `auth-copy.ts`: no string there replaces a fenced string with different text.

Output: per-claim table (HELD/REFUTED + evidence), findings list (severity HIGH/MED/LOW, file:line,
failing scenario), verdict **SHIP / FIX-FIRST / BLOCK**. Carry `.claude/lessons/LESSONS.md` (L-072 enum
mirrors, L-085–L-091 this week). Read-only: no edits, no gates beyond a scoped `npx jest <path>` if a
claim needs it.

## R2 — Sonnet UI-verify driver (evidence only, no judgment)

Server: `http://localhost:3009` (rf-F09 `next dev`, started by the Lead; if it is not answering, say so
and stop — never start a second one). Keep the **desktop user agent** (a phone UA is proxied by the
middleware); set only the viewport. Reduced motion ON. Viewports **1280×800** and **375×812**; plus a
collapse probe at **851** and **849** wide on `/login` and `/buyer/register`.

Script lives in the scratchpad, never in the repo. Output PNGs to
`apps/web/test-output/auth-redesign/light-r1/<page>-<w>.png` (gitignored; confirm with `git check-ignore`).
Segment captures taller than 8000 px. Token pages use a dummy `token=light-r1`; whatever state renders is
the evidence (note it). For each page × viewport record: HTTP status, `rf-auth` marker present in the HTML,
`h1` count, console errors, failed requests (status ≥ 400, excluding the expected API 4xx for the dummy
token), horizontal overflow (`document.documentElement.scrollWidth > window.innerWidth`), first-Tab focus
target + a screenshot of it, and at 851/849 which layout (two-column vs single) the shell computes.
Report: one table + the PNG paths. Grounded claims only.

## R3 — Opus judge (after R2)

Inputs: `ux-spec.md` (§Layout, §Tokens, §Responsive, §Accessibility), the driver's report, the PNGs
(read them). Per page × viewport PASS/FAIL against the spec; measure any contrast the spec floors from the
pixels; call out anything that reads as a mockup ("Design preview", placeholder totals), any clipped or
invisible mark on the panel, any focus ring below 3:1. Findings with severity + file hint; verdict.

## S4 (Fable) — after R1 + R3

Ruling over every finding: fix / dispute / defer → `fix-round-2.md` with designs and executor tiers
(Opus for page logic and shell; Sonnet for mechanics). Then S5 execute + one scoped Opus re-check → land
per handoff §5B-3.
