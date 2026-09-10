# Spec — apps/web Next 14.2.35 → 15.5.25 (Fable, 2026-09-09)

Why: two CRITICAL next advisories (GHSA-p293-qw3h-jr36, GHSA-2xp9-vwfh-vxw4) are fixed only in next ≥ 15.5.24; the CI
allowlist (`security/audit-allowlist.json`) expires 2026-09-30 and the gate goes red again by design. Discovery:
`discovery-brief.md` (counts verified). Mode: dev-pipeline, scale major. Branch `chore/next-15` off master AFTER the
gate PR and #675 merge. Production proof = the compose web image (host `next build` is broken by the react skew).

## Requirements

- R1 `apps/web/package.json`: `next` 15.5.25, `eslint-config-next` 15.5.25, optional `@next/swc-win32-x64-msvc` ^15.5.25
  (moves with next — discovery risk 5). Lockfile via `npm install` in the branch worktree only (never a shared tree).
- R2 `apps/web` `react`/`react-dom` → `^19.2.0` (the repo is React 19 everywhere else; `@types/react*` already 19).
  Delete the Dockerfile force-pin (`apps/web/Dockerfile:34-48`) and the `jest.config.js:16-33` moduleNameMapper hack —
  both exist only for the 18/19 skew. Pin: a static test asserts neither hack is present.
- R3 Params: the 17 Client Component `[id]`/`[categoryId]`/`[transactionId]` pages drop the `params` prop and read
  `useParams()` from `next/navigation` (the buyer portal already does); `finance/expenses/page.tsx` (Server Component)
  awaits `searchParams`. Pin: a static test walks `app/**/page.tsx`, and for every `"use client"` page forbids a
  `params`/`searchParams` prop while requiring `useParams`/`useSearchParams`; for server pages requires `await` on
  those props if they are read.
- R4 `next.config.mjs`: `experimental.serverComponentsExternalPackages` (empty) removed; `turbopack.root`, `output`,
  `eslint.ignoreDuringBuilds`, `typescript.ignoreBuildErrors`, `images.unoptimized` (from the gate PR) unchanged.
- R5 Fonts: `app/layout.tsx` stops importing `next/font/google` (Inter, Instrument_Serif, Spline_Sans, Spline_Sans_Mono)
  — the build-time fonts.gstatic.com dependency that already broke the compose build twice. Self-host ONLY the
  weights actually referenced (audit `font-*` usage first; drop unused families) as `next/font/local` under
  `apps/web/fonts/` (heavy-files exception; budget ≤ 250 KB added, woff2 only, sizes listed in the PR). Pin: static
  test forbids `next/font/google` repo-wide in apps/web.
- R6 — apps/web lints with ESLint ^9 and apps/web/eslint.config.mjs (next/core-web-vitals only, the rule set the retired .eslintrc.json applied on master) as its only config. Next 15's `next lint` selects a flat config ahead of .eslintrc.json and strips the legacy options only on ESLint >= 9, so ESLint 8 fails with 'Invalid Options: Unknown options: useEslintrc, extensions'.
- R7 Allowlist retirement in the SAME PR: remove both entries from `security/audit-allowlist.json` (empty `entries`),
  update the policy-guard test to accept an empty list, and prove `node scripts/ci-audit-critical.mjs` exits 0 with
  no ALLOWLISTED line (no next critical remains).
- R8 Gates: `npm run check-types`, `npm run lint`, web Jest (50 files) + api/mobile/pricing report regen for
  campaign-check; `docker compose -p routeflow --profile app up -d --build web` succeeds and `/login` is 200
  (production proof); `npm run local:validate`; `npm run local:e2e` (allow-listed projects); post-merge: Railway
  web SUCCESS, PDC, deployment E2E 37 specs vs the 182/0/27 baseline.
- R9 Rollback: one squash revert; no migration.

## Non-goals

Next 16; Turbopack in prod; touching apps/mobile's react/react-test-renderer pins; any page redesign.

## Test plan (T#)

- T1 static `next-version.static.test.ts`: `next` resolves ≥ 15.5.24 in apps/web (semver), `eslint-config-next` major 15.
- T2 static `no-react-skew-hacks.static.test.ts`: Dockerfile has no `react@18` install line; jest.config has no
  moduleNameMapper for `^react$`.
- T3 static `client-page-params.static.test.ts`: per R3 (walks the tree, lists offenders).
- T4 static `no-google-fonts.static.test.ts`: per R5; also asserts each `next/font/local` src file exists and is woff2.
- T5 existing 50 web Jest files green under React 19 (RTL 16.3.3 supports 19).
- T6 `ci-audit-script.spec.ts` policy guard accepts the empty allowlist; real gate exit 0.
- Red gate: T1–T4 fail on master today (version 14, hacks present, 18 sync-param pages, google fonts imported).

## Build plan (P#)

- P1 (Sonnet high) deps + config: R1, R2 package changes, R4, lockfile; `npm install` in the branch worktree.
- P2 (Sonnet high) the 18 pages (R3), one mechanical pattern, file list from the discovery brief §2a.
- P3 (Sonnet high) fonts (R5) — audit first, report weights kept/dropped and byte sizes.
- P4 (Sonnet medium) Dockerfile + jest.config cleanup (R2), allowlist retirement (R7).
- TP (Sonnet high) T1–T4 + T6 updates.
- Review: Opus refute-first (React 19 runtime behaviour in RTL suites, `useParams` typing, font fallbacks, Dockerfile
  standalone output), then the compose web build proof (Lead-run), then landing.
