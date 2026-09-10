# Build plan — apps/web Next 14.2.35 → 15.5.25 + React 19 (S5)

Status: PLANNED · scale `major` · branch `chore/next-15` · worktree `.claude/worktrees/rf-F25`

**Authored by Opus 5 (documented fallback)** — Fable 5.1 planning agents returned
"out of usage credits"; dev-pipeline's MODEL POLICY allows Opus 5 when Fable is genuinely unavailable.

Read with: `test-plan.md` (authoritative for T#s, and §0 there lists four corrections to the spec),
`local-assets/handoff/2026-09-09/planning/next15/spec.md` (R1–R9), and the discovery brief.

**Why this change exists:** `next@14.2.35` carries two CRITICAL advisories (GHSA-p293-qw3h-jr36,
GHSA-2xp9-vwfh-vxw4) fixed only in `>=15.5.24`. They are suppressed by an allowlist that **expires
2026-09-30**, after which CI goes red by design. Shipping nothing means a red gate on every PR plus two
unpatched criticals.

**R5 (fonts) is NOT in this run** — deferred to an immediate follow-up PR; reasons and the completed audit
are in `test-plan.md` §4.1. Do not remove `next/font/google` in this run.

## Waves

- **Wave 1: P1 alone.** P1 runs `npm install`, which mutates `node_modules` for every later package.
  Nothing may run beside it.
- **Wave 2: P2, P3, P4, P5, P6, P7 concurrently.** File sets are disjoint; every one declares `dependsOn: ["P1"]`.

## The exact conversion (transcribe this; do not improvise)

### Client page, single site — the pattern for 16 of the 17 files

`useParams()` comes from `next/navigation`. Most of these files **already import from
`next/navigation`** (usually `useRouter`) — **merge into that existing import statement; never add a second
import from the same module.**

```tsx
// BEFORE
export default function ReturnDetailPage({ params }: { params: { id: string } }) {
  // ... body referencing params.id
```

```tsx
// AFTER
import { useParams } from "next/navigation";   // merged into the existing next/navigation import

export default function ReturnDetailPage() {
  const params = useParams();
  const id = params.id as string;
  // ... body: every `params.id` becomes `id`
```

Rules: keep the component name and every other prop. Replace **all** `params.<name>` reads in the file.
Do not convert `useSearchParams()`/`useParams()` calls that are already hooks — they are correct already.

### `customers/[id]/page.tsx` — the two-site file

This file destructures `{ params }` **twice**: inner `CustomerDetailPageInner` at :1902 and the Suspense
wrapper `CustomerDetailPage` at :4286. Call the hook **once in the wrapper** and pass a plain string down —
one hook call, and the inner component stops depending on Next's routing shape:

```tsx
// wrapper (was :4286)
export default function CustomerDetailPage() {
  const params = useParams();
  const id = params.id as string;
  return (
    /* existing Suspense/boundary JSX unchanged */
    <CustomerDetailPageInner id={id} />
  );
}

// inner (was :1902)
function CustomerDetailPageInner({ id }: { id: string }) {
  // body: every `params.id` becomes `id`
```

Its existing `useSearchParams()` at :2056 (the `?tab=` deep link) is already a hook — **leave it alone**.

### The one Server Component — `finance/expenses/page.tsx`

In 15 `searchParams` is a Promise, so the component becomes `async` and awaits it:

```tsx
export default async function LegacyExpensesHubRedirect({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sp = await searchParams;
  // body: every `searchParams[...]` becomes `sp[...]`
```

## Packages

| id  | title                                  | files                                                                          | effort   | dependsOn | satisfies | provenBy |
| --- | -------------------------------------- | ------------------------------------------------------------------------------ | -------- | --------- | --------- | -------- |
| P1  | deps + lockfile (**wave 1, alone**)    | `apps/web/package.json`, `package-lock.json`, `apps/web/tsconfig.json`         | medium   | —         | R1, R2    | T1, T2   |
| P2  | remove both React-skew hacks           | `apps/web/Dockerfile`, `apps/web/jest.config.js`                               | medium   | P1        | R2        | T2       |
| P3  | next.config key removal                | `apps/web/next.config.mjs`                                                     | medium   | P1        | R4        | T3       |
| P4  | params → useParams, **money surfaces** | the 8 money pages below                                                        | **high** | P1        | R3        | T3       |
| P5  | params → useParams, ops surfaces       | the 9 pages below                                                              | medium   | P1        | R3        | T3       |
| P6  | server page awaits searchParams        | `apps/web/app/(dashboard)/finance/expenses/page.tsx`                           | medium   | P1        | R3        | T3       |
| P7  | retire the audit allowlist             | `security/audit-allowlist.json`, `apps/api/src/common/ci-audit-script.spec.ts` | medium   | P1        | R7        | T6       |

### P1 detail

- `apps/web/package.json`: `next` → `"15.5.25"`; `devDependencies["eslint-config-next"]` → `"15.5.25"`;
  `optionalDependencies["@next/swc-win32-x64-msvc"]` → `"^15.5.25"`; `dependencies.react` and
  `.react-dom` → `"^19.2.0"`.
- **Move `eslint` to `^9` (see spec R6).**
- Then run `npm install` **in this worktree only** to refresh `package-lock.json`. Never `--force`, never
  `--no-save`, and never touch apps/mobile's `react`/`react-test-renderer` pins (non-goal; they move with
  mobile's react).
- Do not add root `overrides` for react — the whole point is that apps/web now agrees with the hoisted 19.
- apps/web/tsconfig.json — `"target": "ES2017"`, written by Next 15's TypeScript setup on first build/lint; kept, since removing it is re-added on the next build (with noEmit it only affects type-checking).

### P2 detail

- Delete `apps/web/Dockerfile` lines 34-48 — the comment block **and** the
  `RUN npm install --force --no-save react@18.3.1 react-dom@18.3.1` line. Its own comment says to revisit it
  exactly here: _"revisit only alongside a Next 15 upgrade (which supports React 19 natively)"_.
- Delete the `^react$` entry from `apps/web/jest.config.js` `moduleNameMapper` **and its comment block**
  (lines 30-60 at base (the React-skew-hack comment block through the `^react$` entry at :55)). **Keep** `"^@/(.*)$": "<rootDir>/$1"`, **keep** the campaign reporter at lines 20-23, and
  **keep** `testTimeout: 30_000`.
- Both hacks exist for the same 18-vs-19 skew. Removing one and leaving the other is the brief's #1 risk.

### P4 — money surfaces (effort high)

`apps/web/app/(dashboard)/` → `invoices/[id]/page.tsx` (:1418) · `invoices/[id]/edit/page.tsx` (:331) ·
`credit-notes/[id]/page.tsx` (:195) · `vendor-bills/[id]/page.tsx` (:705) · `estimates/[id]/page.tsx` (:71) ·
`bookkeeping/[transactionId]/page.tsx` (:131) · `finance/commissions/[id]/page.tsx` (:43) ·
`orders/[id]/page.tsx` (:1564).
A wrong id on these pages shows one tenant's money document in place of another's — this is why they are
`high` and separated from P5. Change **only** the params plumbing: no pricing, totals or query logic.

### P5 — ops surfaces

`apps/web/app/(dashboard)/` → `customers/[id]/page.tsx` (**two sites**, see above) ·
`drivers/[id]/page.tsx` (:111) · `sales-agents/[id]/page.tsx` (:97) · `products/[id]/page.tsx` (:310) ·
`returns/[id]/page.tsx` (:315) · `compliance/[categoryId]/page.tsx` (:34) · `routes/[id]/page.tsx` (:463) ·
`routes/[id]/dispatch/page.tsx` (:428) · `routes/templates/[id]/page.tsx` (:512).

### P7 detail

- `security/audit-allowlist.json`: keep `$schema-note`, set `"entries": []`. No script change is needed —
  `loadAllowlist`/`main`/`runAuditLoop` all handle `[]`, suppressing nothing.
- `apps/api/src/common/ci-audit-script.spec.ts` lines 739-740: replace the hard-coded
  `expect(ids).toEqual(["GHSA-2xp9-vwfh-vxw4", "GHSA-p293-qw3h-jr36"])` with `expect(parsed.entries).toEqual([])`.
  **Leave the per-entry shape/window loop at 742-754 untouched** — it is vacuous over `[]` and remains the
  guard against re-adding a malformed entry.

## Test packages (authored BEFORE implementation, must go RED)

| id  | title                      | files                                                                                                                                           |
| --- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| TP1 | static upgrade guards      | `apps/api/src/common/next-version.spec.ts`, `apps/api/src/common/no-react-skew-hacks.spec.ts`, `apps/api/src/common/client-page-params.spec.ts` |
| TP2 | allowlist-retirement guard | `apps/api/src/common/audit-allowlist-retired.spec.ts` (+ its clean-audit fixture)                                                               |

Follow the house convention exactly: `fs` reads plus `REPO_ROOT = join(__dirname, "..", "..", "..", "..")`,
no runtime imports, `<topic>.spec.ts`. See `apps/api/src/common/no-dead-deps.spec.ts` as the model.
T3 must count destructure **sites**, not files. Oracles and red-today reasoning are in `test-plan.md` §2.

## Verification

- `perRound`: `npm run check-types -w apps/web` · `npm run lint -w apps/web` · `npm run check-types -w apps/api`
- `final`: the above plus `npm test -w apps/web` (54 files) and `npm test -w apps/api`
- **Close-out correction — the four guards do NOT run under `npm test -w apps/api`.** A fix round moved
  them into the **repo-truth lane**, as house rule L-062 requires of any spec that reads outside apps/api
  (these read apps/web and security/). The main lane now lists them in `testPathIgnorePatterns`, so the
  engine's `final` api gate (4,417 green), its red-gate command and its mutation-probe command all
  executed **zero** of them after that move. They are proven by `npm run test:repo-truth -w apps/api`,
  run by hand at close-out (7 suites / 44 tests green), and they gate every push and CI run through
  `npm run verify` → `turbo run … test:repo-truth` (`.husky/pre-push`, `.github/workflows/ci.yml`).
- **`npm run verify` is deliberately NOT the engine's `final`.** It chains campaign-check, the lock-edge
  validator and the lessons validator, which need `.campaign/runs/*.json` and registry state a fresh
  worktree lacks; it would fail at Baseline, be excluded as a broken command, and leave the run with no gate
  at all. The launching session runs it by hand pre-push.
- **No `uiVerify`.** The production proof is the compose web image
  (`docker compose -p routeflow --profile app up -d --build web` → `/login` 200), run by hand — a host
  `next build` is broken in every tree by the react hoist skew.
- Campaign-check caveat: a _scoped_ Jest run overwrites `.campaign/runs/<artifact>.json` with only what ran,
  so the **full** suite must be the last Jest run before campaign-check reads it. `npm run verify` already
  orders it that way.

## Rollback

One squash revert; no migration. It restores `apps/web/package.json`, `package-lock.json`,
`apps/web/tsconfig.json`, `next.config.mjs`, `Dockerfile`, `jest.config.js`, the 17 pages, the server page, the allowlist pair, `apps/web/eslint.config.mjs`, `apps/web/.eslintrc.json`
(deleted), and the three `eslint-disable-next-line @next/next/no-html-link-for-pages` lines in `(auth)/login/page.tsx`,
`inventory/page.tsx` and `buyer/invite/[token]/page.tsx`.
Railway redeploys the reverted commit automatically for **web only**. The api does not redeploy on a revert, because `package-lock.json` is outside its `watchPatterns`. After reverting, trigger the same fresh api build ("Deploy latest commit" for `@routeflow/api`, or `railway up --service @routeflow/api --ci` from a clean checkout of the revert sha) so the api drops react 19.3.0. Then re-run the invoice and statement PDF download check.

**API runtime effect.** This PR moves the hoisted `react`/`react-dom` that apps/api resolves for its money-document PDFs (`@react-pdf/renderer` 4.9.0: invoice, statement, bookkeeping-invoice, tobacco-report) from 19.2.5 to 19.3.0 (`react-dom` from 18.3.1). apps/api has no nested copy; its own `^19.2.4` range holds 19.3.0 at the root. `package-lock.json` is outside the api service's `watchPatterns` (`apps/api/**`, `packages/**`), so neither this merge nor a revert rebuilds the api. The landing window must trigger a fresh api build from the merged master sha: Railway "Deploy latest commit" for `@routeflow/api`, or `railway up --service @routeflow/api --ci` from a clean checkout of the merge sha. A plain redeploy reuses the old image. Then download an invoice PDF and a statement PDF on the `test` tenant. Pre-merge proof: `npm run build -w apps/api && npm run smoke:pdf -w apps/api` renders both templates unmocked through the api-resolved react and exits non-zero on a throw or a non-PDF buffer.

### Deviations for the PR body

- **API runtime effect.** This PR moves the hoisted `react`/`react-dom` that apps/api resolves for its money-document PDFs (`@react-pdf/renderer` 4.9.0: invoice, statement, bookkeeping-invoice, tobacco-report) from 19.2.5 to 19.3.0 (`react-dom` from 18.3.1). apps/api has no nested copy; its own `^19.2.4` range holds 19.3.0 at the root. `package-lock.json` is outside the api service's `watchPatterns` (`apps/api/**`, `packages/**`), so neither this merge nor a revert rebuilds the api. The landing window must trigger a fresh api build from the merged master sha: Railway "Deploy latest commit" for `@routeflow/api`, or `railway up --service @routeflow/api --ci` from a clean checkout of the merge sha. A plain redeploy reuses the old image. Then download an invoice PDF and a statement PDF on the `test` tenant. Pre-merge proof: `npm run build -w apps/api && npm run smoke:pdf -w apps/api` renders both templates unmocked through the api-resolved react and exits non-zero on a throw or a non-PDF buffer.
- apps/web `eslint` `^8` → `^9` (spec R6).
- Root `eslint` and `@eslint/js` 9.39.4 → 9.39.5, with the nested `@eslint/js` copies dropped from apps/api and
  packages/eslint-config (api lint still exits 0).
- `next/typescript` dropped from `apps/web/eslint.config.mjs`, so the live rule set equals master's
  (`next/core-web-vitals` only).
- Three `eslint-disable-next-line @next/next/no-html-link-for-pages` lines, in `(auth)/login/page.tsx`,
  `inventory/page.tsx` and `buyer/invite/[token]/page.tsx`.
