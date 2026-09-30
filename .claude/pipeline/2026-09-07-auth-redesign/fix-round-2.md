# Light loop — round 2 (Fable ruling over R1 + R3) — auth-redesign

Fable ruling, 2026-09-08. Inputs: R1 Opus refute-first review (verdict FIX-FIRST; C1–C9, C12 HELD;
C10 REFUTED; C11 partially) and R3 Opus UI judge (verdict FIX-FIRST) on checkpoint `102c79ce`.
Worktree `C:/ClaudeCode/routeflow/.claude/worktrees/rf-F09`, branch `feat/auth-redesign`.
Binding constraints of round 1 still apply (logic byte-identical, fence strings verbatim, globals.css +
tailwind config untouched, no next/image, no middleware, one h1, ≤ 850 collapse, `.rf-auth` scoping).

## Rulings

| Finding                                                                                                  | Ruling                                                                                                                                                            | Executor                             |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| R1 MED-1 fixed `h1` contradicts page state (invite, verify-email, buyer/verify-merge, reset-password ×2) | **FIX** — D1                                                                                                                                                      | E1 Opus                              |
| R1 LOW-1 fenced headings gained a trailing period (`Check your inbox`, `Choose a new password`)          | **FIX** — D2                                                                                                                                                      | E1 Opus                              |
| R1 MED-2 specs 47 + 48 unrunnable (no project)                                                           | **DROP both files** — D3 (47 duplicates the driver evidence; 48's probes duplicate spec 46 T5e)                                                                   | E2 Sonnet                            |
| R1 MED-3 / C10 unscoped `.rf-kicker .rf-real-link .rf-legal-note .rf-btn`                                | **FIX** — D4                                                                                                                                                      | E2 Sonnet                            |
| R3 F1 HIGH buyer links `#059669` 3.77:1                                                                  | **FIX** — D5                                                                                                                                                      | E2 Sonnet (E1 for the files E1 owns) |
| R3 F2 MED password placeholder clipped at 375                                                            | **FIX (CSS only)** — D6                                                                                                                                           | E2 Sonnet                            |
| R3 F6 dead `.rf-auth-forgot` rule                                                                        | **FIX** — folded into D4                                                                                                                                          | E2 Sonnet                            |
| R3 F8 focus ring spans the story column                                                                  | **FIX (one line)** — D7                                                                                                                                           | E2 Sonnet                            |
| R3 F5 kicker colours better than spec; F7 540px vs 44ch                                                  | **DISPUTE the spec** — D8 corrects `ux-spec.md` §Tokens/§Layout to the measured code                                                                              | E2 Sonnet                            |
| R3 F3 `/verify-email` stuck on "Verifying…" with zero network                                            | **RE-PROBE** — D9; C9 says logic is unchanged, so if the old page behaves the same it is pre-existing → registry row, not a fix here                              | E3 Sonnet (read-only)                |
| R3 F4 change-password pages unverified                                                                   | **RE-VERIFY** in round-2 driver pass with a seeded operator session (approved `test` tenant only); buyer page rests on R1 C9 (zero logic delta) + the static test | E4 driver                            |
| R3 F10 disabled resend label 3.27:1                                                                      | **ACCEPT** (disabled control, WCAG-exempt)                                                                                                                        | —                                    |
| R3 F11 operator/buyer copy asymmetries (OR/or, arrow, footer link)                                       | **DEFER** — fenced, page-owned strings; note in the PR                                                                                                            | —                                    |
| R1 LOW-2 login test module-mocks tenant-host + tenant-provider                                           | **DEFER** — fidelity note in the PR; `tenantSlugFromHostname` keeps its own unit coverage                                                                         | —                                    |
| R1 LOW-3 story `h2` precedes card `h1` in DOM                                                            | **DEFER** — design intent; hidden ≤ 850                                                                                                                           | —                                    |
| R1 LOW-4 `Order RF-1042` decorative card                                                                 | **ALLOWED** — spec-specified, `aria-hidden`; not a mockup value                                                                                                   | —                                    |
| R1 LOW-5 `/login` mark fallback dropped                                                                  | **ACCEPT** — intentional, pinned by test                                                                                                                          | —                                    |
| R1 "next build never ran"                                                                                | **LANDING GATE** — compose web image built from rf-F09 before the PR (serial, host quiet)                                                                         | Lead                                 |

## Designs

**D1 — state-derived titles (E1, Opus `high`).** Invariant: the single `h1` (rendered by `AuthShell`
from `title`) announces the page's current state exactly as the old page's `h1` did; no state string is
rendered twice. For each page, read the OLD file (`git show 42a4893e:<path>`) and map each state's old
`h1` text to the new `title` prop: `app/buyer/invite/[token]/page.tsx` (`Invalid Invite`,
`Invite Accepted!`, idle = the designed title), `app/verify-email/page.tsx` (`Verifying your email…`,
`Email verified!`, `Verification failed`), `app/buyer/verify-merge/page.tsx` (`Verifying...`,
`Account Verified!`, `Verification Failed`), `app/(auth)/reset-password/page.tsx` and
`app/buyer/reset-password/page.tsx` (invalid-token state → the old invalid-link heading text; valid
state → the fenced `Choose a new password`, see D2). Pass a computed `title` expression; delete the
demoted `<h2>` duplicates so each state string appears once, as the `h1`. Keep every request, redirect
and branch byte-identical (C9). Pattern to copy: `app/buyer/change-password/page.tsx:128–133`.
Pin: E2 adds static assertions (see D10). Scoped gate: `npx jest` on the touched page tests +
`auth-redesign.static.test.ts` + `AuthShell.test.tsx`; `tsc`; `npm run lint -w apps/web`.

**D2 — fenced headings literal (E1).** `app/(auth)/signup/check-email/page.tsx:42` → `Check your inbox`
(no period); both reset-password pages' valid-state title → `Choose a new password` (no period).
Unfenced redesigned titles keep their period.

**D3 — drop dead specs (E2, Sonnet `medium`).** `git rm apps/web/e2e/47-auth-redesign-evidence.spec.ts
apps/web/e2e/48-auth-redesign-a11y.spec.ts`; remove any mention of 47/48 from `build-plan.md` /
`test-plan.md` / `RESUME.md` in the run dir (one line each, no rewrite). `playwright.config.ts` keeps its
single `auth-redesign` project. Spec numbers 47 and 48 return to the pool (Lead notes it on the board).

**D4 — scope the CSS (E2).** In `apps/web/components/auth/auth-shell.css` prefix every top-level selector
that does not already start with `.rf-auth` with `.rf-auth ` (`.rf-kicker`, `.rf-real-link`,
`.rf-legal-note`, `.rf-btn` and their `:hover`/`:focus-visible`/`:disabled`/media variants, lines ~40,
123, 156, 175, 194, 198, 203, 213, 278, 281). Delete the dead `.rf-auth-forgot` block (~170–174).
Invariant: `.rf-auth .rf-btn` (0,2,0) now beats Tailwind's `bg-accent-strong` (0,1,0) by specificity, not
by bundle order. Pin: D10 guard "every top-level rule in auth-shell.css starts with `.rf-auth`
(inside `@media` blocks too; `@keyframes` exempt)".

**D5 — buyer links (E2; E1 for `buyer/invite` + `buyer/verify-merge`).** One palette: every link on the
buyer auth pages uses the SAME Tailwind utility the operator `/login` "Forgot password?" link uses
(measured `#0b6e6b`, 6.07:1) — read `app/(auth)/login/page.tsx` for the exact class and replace the
emerald utilities (`text-emerald-*`, `hover:text-emerald-*`) on `app/buyer/login`, `app/buyer/register`,
`app/buyer/verify-email`, `app/buyer/forgot-password`, `app/buyer/reset-password`,
`app/buyer/change-password`, `app/buyer/invite/[token]`, `app/buyer/verify-merge` (only where the
class is on an `<a>`/`Link`; buttons unchanged). Link text stays verbatim (fence). Pin: D10 guard "no
`emerald` utility inside the 15 auth pages".

**D6 — placeholder fit at 375 (E2, CSS only).** In `auth-shell.css` inside the existing `≤ 850px`
media block: `.rf-auth input::placeholder { font-size: 12px; }` (and `letter-spacing: -0.01em` if
still clipped). Placeholder strings untouched. Driver proves both sign-up pages show the full rule at 375.

**D7 — focus ring hugs the wordmark (E2).** `.rf-auth-story > a { align-self: flex-start; }` (or the
equivalent on the `Brand` link's wrapper) so the `:focus-visible` outline wraps the wordmark, not the
546 px column. Driver re-captures the focus shot.

**D8 — spec corrections (E2, docs).** `ux-spec.md` §Tokens: story kicker = `#ffffff` (14.9:1), card
kicker = `--rf-charcoal #292c33` (14.0:1), links = the operator link utility (`#0b6e6b`, 6.07:1) — not
navy; §Layout: story measure `max-width: 540px` / paragraph `400px` (not `44ch`). Two-line edits.

**D9 — F3 re-probe (E3, Sonnet `low`, read-only).** Against `http://localhost:3009/verify-email?token=light-r1`
(desktop UA, reduced motion): log EVERY request (`page.on('request')` + `requestfailed` + `response`)
for 15 s; report whether a `POST …/auth/verify-email` is issued, its status/timing, and the final
rendered state. Then read `git show 42a4893e:apps/web/app/verify-email/page.tsx` beside the new file
and state whether the effect/guard that decides to fire the POST differs at all. Also probe
`/buyer/verify-email?token=light-r1` the same way for comparison. Report facts only.

**D10 — pins (E2 owns `apps/web/app/(auth)/auth-redesign.static.test.ts`).** Add: (a) for each of
the five D1 pages, the `title=` passed to `AuthShell` is not a string literal and the file contains
each of that page's state strings exactly once; (b) auth-shell.css scoping guard (D4); (c) no-emerald
guard (D5); (d) `check-email` and both reset-password files contain the fenced heading without a
trailing period. Keep existing assertions.

## Execution

- E1 Opus `high` (D1, D2, D5 on its two files): files `app/buyer/invite/[token]/page.tsx`,
  `app/verify-email/page.tsx`, `app/buyer/verify-merge/page.tsx`, `app/(auth)/reset-password/page.tsx`,
  `app/buyer/reset-password/page.tsx`, `app/(auth)/signup/check-email/page.tsx`.
- E2 Sonnet `medium` (D3, D4, D5 on the other buyer pages, D6, D7, D8, D10): `auth-shell.css`, the six
  other buyer pages, the two spec deletions, `auth-redesign.static.test.ts`, `ux-spec.md`, run-dir notes.
- E3 Sonnet `low` (D9), read-only, in parallel.
- Disjoint files; E1 and E2 run together. Each runs scoped gates (`tsc`, `npm run lint -w apps/web`,
  `npx jest` on the touched suites) and reports deviations as findings, never improvisations.
- Then E4 Sonnet driver re-verify (375 sign-up placeholders, focus shots, buyer link colour sample,
  `/change-password` with a seeded operator session on the approved `test` tenant) and ONE scoped Opus
  `high` re-check of D1–D8 → SHIP or back to Fable. Max one more round.
