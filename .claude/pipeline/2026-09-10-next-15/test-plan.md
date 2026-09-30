# Test plan — apps/web Next 14.2.35 → 15.5.25 + React 19 (S4)

Status: PLANNED

**Authored by Opus 5 (documented fallback).** The Fable 5.1 planning agents for S4/S5 both died with
"You're out of usage credits. Switch to another model." dev-pipeline's MODEL POLICY permits Opus 5 as the
fallback when Fable is _genuinely unavailable_; credit exhaustion is that case, not a peer choice.

Inputs: `local-assets/handoff/2026-09-09/planning/next15/spec.md` (R1–R9),
`local-assets/handoff/2026-09-09/planning/next15/discovery-brief.md`, and a four-agent Sonnet reader
fan-out (run wf_86153ff5-5f2) which corrected four spec assumptions — see §0.

## §0 Corrections to the spec, from verified reads

| Spec assumed                                 | Verified truth                                                                                                                                                                                  | Consequence                                                                                              |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| test files `*.static.test.ts`, path unstated | House convention for structural tests is **`apps/api/src/common/<topic>.spec.ts`** (fs + `REPO_ROOT`; siblings `no-dead-deps.spec.ts`, `turbo-inputs.spec.ts`, `no-single-schema-path.spec.ts`) | New static tests live in **apps/api**; the red gate runs **api** Jest, not web Jest                      |
| "50 web Jest files"                          | **54** — #683's regression pins landed since                                                                                                                                                    | T5's regression count is 54                                                                              |
| implies `apps/api/jest.config.js`            | apps/api has **no** `jest.config.*`; Jest config is inline in `package.json`                                                                                                                    | `npx jest --config apps/api/jest.config.js` does not exist. Correct: `npm test -w apps/api -- <pattern>` |
| `customers/[id]` has one `params` site       | **Two** — inner `CustomerDetailPageInner` at :1902 and the Suspense wrapper at :4286                                                                                                            | T3 must count destructure **sites**, not files, or a half-converted file passes                          |

## §1 Coverage matrix

| R#               | Requirement                                                                                | T#               | Level                                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1               | next 15.5.25, eslint-config-next 15.5.25, `@next/swc-win32-x64-msvc` ^15.5.25              | T1               | static                                                                                                                                           |
| R2               | apps/web react/react-dom ^19.2.0; Dockerfile force-pin gone; jest.config react mapper gone | T2               | static                                                                                                                                           |
| R3               | 17 client pages read `useParams()`; the 1 server page awaits `searchParams`                | T3               | static                                                                                                                                           |
| R4               | `experimental.serverComponentsExternalPackages` removed from next.config.mjs               | T3(b)            | static                                                                                                                                           |
| R6               | apps/web on ESLint ^9 + flat config (next/core-web-vitals only)                            | —                | oracle: `npm run lint -w apps/web` and `npm run lint -w apps/api` exit 0 (a revert to ESLint 8 fails web lint with Invalid Options); no new spec |
| R7               | allowlist emptied; gate still exits 0, suppressing nothing                                 | T6               | static + behavioural                                                                                                                             |
| R2/R3 regression | the 54 existing apps/web Jest suites still pass under React 19                             | T5               | integration — **not** red gate                                                                                                                   |
| R5               | fonts self-hosted, no `next/font/google`                                                   | T4               | **DEFERRED** — §4                                                                                                                                |
| R8/R9            | gates + rollback                                                                           | operational — §5 |

## §2 Red-gate tests — each must FAIL on master today, on an assertion

Four new files in `apps/api/src/common/`, following the verified convention: `fs.readFileSync` plus
`REPO_ROOT = join(__dirname, "..", "..", "..", "..")`, no runtime imports.

### T1 — `next-version.spec.ts` (R1)

**Then:** `dependencies.next` satisfies `>=15.5.24`; `devDependencies["eslint-config-next"]` major is 15;
`optionalDependencies["@next/swc-win32-x64-msvc"]` major is 15.
**Oracle:** literal `"15.5.25"` for next and eslint-config-next; major `15` for the SWC binary.
**Red today:** next is `"14.2.35"`, so the semver assertion fails `Expected: true / Received: false`.
An assertion failure, not an import error.

### T2 — `no-react-skew-hacks.spec.ts` (R2)

**Then:** apps/web/Dockerfile contains **no** line matching `/react@18/` (today line 48:
`RUN npm install --force --no-save react@18.3.1 react-dom@18.3.1`); apps/web/jest.config.js
`moduleNameMapper` has **no** `^react$` key (line 55 at base); apps/web `dependencies.react` and
`.react-dom` both satisfy `^19.2.0` (today `"^18"`).
**Oracle:** zero pattern matches; the literal `^19.2.0` range for both deps.
**Red today:** all three fail.
**Why it earns its place:** the brief's risk #1 is removing one hack and leaving the other, which
silently breaks every RTL suite. This test makes "both or neither" mechanical.

### T3 — `client-page-params.spec.ts` (R3, R4)

**Then,** over every `apps/web/app/**/page.tsx`: a file containing `"use client"` must not destructure a
`params`/`searchParams` **prop** at any site, and if it reads a route param must import `useParams` from
`next/navigation`; a Server Component reading those props must `await` them. (b) next.config.mjs contains
no `serverComponentsExternalPackages`.
**Oracle:** the offender list deep-equals `[]`. On failure it prints every offending `file:line`, so the
failure message _is_ the work list.
**Red today:** 18 offending sites across 17 files (customers/[id] contributes two) → `expect(offenders).toEqual([])` fails.

### T6 — `audit-allowlist-retired.spec.ts` (R7)

**Then:** `parsed.entries` deep-equals `[]`; running the real gate with a stubbed-clean npm audit
(`CI_AUDIT_CMD` → a fixture emitting clean audit JSON) exits **0**; stdout contains no `ALLOWLISTED`
substring and no `all critical advisories are allowlisted` line; stdout does contain `advisories: critical=0`.
**Oracle** (derived from ci-audit-critical.mjs's own doc block at lines 37-50, so knowable without tracing
the code path): exit 0 · `grep -c ALLOWLISTED == 0` · literal `advisories: critical=0` present. The stub
makes this independent of whether the upgrade actually cleared the two GHSAs — separately covered by that
file's existing "audit finds a critical, not allowlisted" tests.
**Red today:** entries holds 2 ids.

## §3 Explicitly NOT in the red gate

- **T5, the 54 existing apps/web Jest suites** — a _regression_ signal that must pass throughout. The red
  gate requires every test in scope to fail, so these run in `perRound`/`final` only (S5 rule 5).
- **The existing hard-coded-ids assertion** in `apps/api/src/common/ci-audit-script.spec.ts:739-740` is
  changed by _implementation_ (package P7), not authored as a red test. Editing it in place would drag that
  file's many passing tests into red-gate scope and break structural RED.

## §4 Deliberately accepted gaps

**1. R5/T4 (fonts) deferred to an immediate follow-up PR.** In order of weight: (a) it requires
**downloading font binaries** from Google Fonts into the repo — an action needing the owner's explicit
approval, which does not belong on the critical path of a security deadline; (b) it is **flake reduction,
not the security fix** — `next/font/google` fetches at build time and has broken the compose build twice,
but that build is currently green (verified 2026-09-07), so this PR neither adds the risk nor needs to
remove it; (c) it reaches into `packages/config/tailwind.config.ts`, widening a deadline PR beyond apps/web.
The audit is already done and belongs to the follow-up: **Spline Sans** and **Spline Sans Mono** must be
self-hosted (base `font-sans`, and `.money`/`.mono`); **Instrument Serif** trims to weight 400 normal only
— its italic face is loaded and never rendered, since the only `<em>` tags live in `(marketing)` and
marketing.css both overrides `font-style: normal` and never references `--font-display`; **Inter is provably
dead** — its sole reference is second in the `sans` stack behind `var(--font-spline)`, which next/font
always injects, so no Inter glyph is ever painted. Estimated 60-105 KB woff2 with Inter dropped, well
inside the 250 KB ceiling.

**2. Thin direct coverage: 1 of the 17 conversions has a render-level test.** Only
`bookkeeping/[transactionId]/page.test.tsx` renders a converted page, and it asserts the
`useParams()` id reaches `useTransaction`. The co-located tests under `customers/[id]`
(`ledger-truncation-note.test.tsx`) and `products/[id]` (`SalesHistoryCard.test.tsx`) render
sub-components only and never import the page, so they do not exercise the `useParams()`
conversion or customers' two-site wrapper-to-Inner `id` plumbing. A literal-path grep of the
37 e2e specs hits 4 more. **What the 17 conversions actually get, stated honestly:** (i) T3, a _structural_
guarantee the pattern was applied everywhere and nowhere half-applied — it cannot prove a page still
renders; (ii) **corrected at close-out** — this plan originally called `check-types` "the real behavioural
gate, because a mis-read `params` is a type error". That is false after the conversion: `useParams()` is
untyped (`Record<string, ParamValue>`), so `params.idd as string` compiles and is undefined at runtime.
The gap is closed structurally instead, by a sixth T3 case added in the close-out commit — _every Client
Component page reads only the route params its own folder declares_ — which pins each key read off a
`useParams()` binding to its path's dynamic segments. `check-types` stays in both gates for every other
type error, and still has to be run explicitly because next.config.mjs sets `typescript.ignoreBuildErrors`
and `eslint.ignoreDuringBuilds`, so the Docker build would ship a broken page (brief risk #4); (iii) the compose-build + `/login` 200 proof; (iv) `local:e2e`'s allow-listed projects, of
which `critical-paths` and `payment-truth` are likeliest to touch these routes indirectly. We are **not**
adding 15 page-render tests — disproportionate for a mechanical conversion whose failure mode is a compile
error. The mitigation that matters is that typecheck is first-class in both `perRound` and `final`.

**3. No `uiVerify` phase.** The production proof for apps/web here is the compose web image, because a host
`next build` is broken in every tree by the react hoist skew. It is run by hand (§5) rather than encoded as
a browser phase, since a host dev server is not reliable evidence in this repo.

## §5 Operational proof the launching session runs by hand

1. `npm run verify` at the repo root — deliberately **not** the engine's `final`, because it needs
   `.campaign/runs/*.json` state a fresh worktree lacks, and a command that fails at Baseline is excluded
   as broken, which would leave the run with no gate at all.
2. `docker compose -p routeflow --profile app up -d --build web` → `/login` returns 200. **Production proof.**
3. `npm run local:validate`, then `npm run local:e2e` (allow-listed projects).
4. Post-merge: Railway web SUCCESS → `npm run post-deploy-check` → deployment E2E vs the 182/0/27 baseline.

## §6 Mutation probe targets

| file                                           | deliberate defect                            | test that must turn RED      |
| ---------------------------------------------- | -------------------------------------------- | ---------------------------- |
| apps/web/package.json                          | downgrade `next` to `14.2.35`                | T1 `next-version`            |
| apps/web/Dockerfile                            | re-add the `react@18.3.1` force-install line | T2 `no-react-skew-hacks`     |
| apps/web/app/(dashboard)/returns/[id]/page.tsx | restore the sync `{ params }` prop           | T3 `client-page-params`      |
| security/audit-allowlist.json                  | re-add one GHSA entry                        | T6 `audit-allowlist-retired` |
