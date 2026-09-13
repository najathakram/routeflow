```markdown
# build-plan.md — F27 (Estimates)

## Preamble

Tree `rf-F27` @ `2d353752`. Branch `fix/F27`. No schema change, no migration —
`Estimate.issueDate` / `Estimate.invoiceId` (+FK/unique) already migrated by
`20260908000000_campaign_schema_foundation`. Four packages, file-disjoint; every hunk anchored
by quoted code text, never by line number (the batch edits `estimates.service.ts` three times
and `[id]/page.tsx` twice, and B17's toast rewraps under `printWidth 100`).

**Prereq for every package:** `npx prisma generate` run from `apps/api` (generated client absent
in the worktree).

**Package sequencing:** commits land `B70 → B17 → B79` inside WP1, then WP2 (additive-only, so
every commit typechecks), then WP3 (`B17 toast/label` → `B15 + B15-NAV + B79 web`), then WP4
close-out. `apps/web/lib/api/estimates.ts` lives in **WP3**, not WP2: flipping
`useConvertEstimateToInvoice`'s result type to `{ id }` before `onSuccess` reads `.id` would
leave an intermediate commit red on `check-types` if it sat in WP2 next to the additive
`Estimate` type change.

---

## Work packages

### WP1 — API money guard (effort: high)

**Files:** `apps/api/src/estimates/estimates.service.ts`, `apps/api/src/estimates/estimates.service.spec.ts`,
new `apps/api/src/estimates/estimates.issue-date.db.spec.ts`; conditional
`apps/api/src/customers/customers.service.ts` (only if its merge-path `estimate.update` writes
`status` — state the finding in the commit body either way).

**Brief:**
- Bugs: B70 (terminal-status TOCTOU across `send`/`decline`/`accept`/`voidEstimate`, laundered
  double-invoice path) + B17(a) (server never writes `Estimate.invoiceId`) + B79(server)
  (`issueDate` create/read/validate).
- Export `TERMINAL_ESTIMATE_STATUSES = ["CONVERTED", "<VOID-STATUS>"] as const satisfies readonly
  EstimateStatus[]` (`<VOID-STATUS>` copied verbatim from today's `voidEstimate()` literal;
  EXPIRED deliberately excluded).
- One private `claimTransition(id, to, refusal)` helper: `updateMany` claim with
  `status: { notIn: TERMINAL_ESTIMATE_STATUSES }` → `count===1` return; `count===0` →
  `findFirst` on the same keys minus the status predicate → `null` → `NotFoundException`, else
  `BadRequestException(refusal)`. Returns nothing, reads no includes.
- `send`/`decline`/`accept`/`voidEstimate` each call `claimTransition` exactly once, then a
  post-claim read reproducing today's exact return shape.
- `convertToInvoice()`: after `tx.invoice.create`, before `return inv;`, add the link
  `updateMany({ where: { <same keys as the ACCEPTED claim>, status: "CONVERTED" }, data: {
  invoiceId: inv.id } })`; `count!==1` → `ConflictException("Estimate link failed")`.
- `create()`: validate `issueDate` (`/^\d{4}-\d{2}-\d{2}$/` + non-NaN `Date`) → 400 else write;
  absent stays `undefined`, never `now()`. Every explicit `select` in `findAll`/`findOne`/list
  gains `issueDate`.
- Commit bodies must state (written, not assumed): `accept()`'s actual where-clause keys;
  whether `customers.service.ts:~1774` writes `status`; HEAD's `voidEstimate()` outcome on a
  CONVERTED row and on `findFirst → null`; HEAD's exact `expiresAt` parse string for
  `"2026-04-01"`.
- **Forbidden:** schema/migration edits; touching `convertToInvoice`'s `status: "ACCEPTED"`
  claim; any bare `estimate.update` surviving in send/decline/accept/void; a `CreateEstimateDto`
  class or any change to `@Body() dto: any`; new imports in `estimates.module.ts`; `expiresAt`
  parsing changes; a second `issueDate` alias; edits to `invoices.service.ts`,
  `enum-parity.spec.ts`, or `customers.service.ts` beyond the conditional status write; deleting
  or weakening existing B8 tests (extend their mocks with a `findFirst` wrong-status row only).

**Satisfies:** B70, B17(a), B79(server).
**Proven by:** T1–T13, T15–T18, T24–T29, T31–T32 (API REG/PIN commands below); T18 in the DB lane.
**Effort:** high — Fable implements first pass and reviews (sole guard against a second minted
invoice; TOCTOU fix; tx link).
**Wave:** 1. **dependsOn:** —

---

### WP2 — shared type + formatter (effort: medium)

**Files:** `packages/types/api/misc.ts`; new `apps/web/lib/format-date-only.ts` +
`apps/web/lib/format-date-only.test.ts` (or the invoice detail page's existing UTC-fixed
date-only formatter in `apps/web/lib`, if one exists — test added beside it, no new file).

**Brief:**
- `Estimate` gains exactly `issueDate?: string | null;` — optional, nullable, nothing else in
  the interface changes.
- `formatDateOnly(iso: string): string` on
  `new Intl.DateTimeFormat(undefined, { timeZone: "UTC", year: "numeric", month: "short", day:
  "numeric" })`; its test sets `process.env.TZ = "America/New_York"` in `beforeAll`/`afterAll`,
  asserts `/Mar 1, 2026/` for `"2026-03-01T00:00:00.000Z"`.
- **Forbidden:** any other change in `misc.ts`; making `issueDate` required; inlining a formatter
  elsewhere; touching `apps/web/lib/api/estimates.ts` (WP3 owns it) — every edit here stays
  additive so every commit typechecks in isolation.

**Satisfies:** B79(type).
**Proven by:** T30 (`PIN-B79 UTC-fixed display`).
**Effort:** medium (Sonnet).
**Wave:** 1. **dependsOn:** —

---

### WP3 — web pages + client lib (effort: medium)

**Files:** `apps/web/lib/api/estimates.ts`, `apps/web/app/(dashboard)/estimates/[id]/page.tsx`,
`apps/web/app/(dashboard)/estimates/page.tsx`, new
`apps/web/app/(dashboard)/estimates/[id]/page.test.tsx`, new
`apps/web/app/(dashboard)/estimates/page.test.tsx`, `apps/web/e2e/*.spec.ts` matched by
`rg -n 'sent to the customer|Convert to invoice|convert-to-invoice' apps/web/e2e`.

**Brief:**
- Bugs: B17(b) (send toast/label falsely claims delivery), B15 (Convert renders on block
  nesting instead of `canConvert`), B15-NAV (navigates on `.invoiceId`, server returns `.id`),
  B79(web) (dto drops `issueDate`, `as any` cast).
- `CreateEstimateDto` gains `issueDate?: string;` plus every field the create-form dto literal
  already sends and the type lacks; the `dto as any` cast in `estimates/page.tsx` is removed
  unconditionally — a genuine shape mismatch stops the package with a report, never a kept cast.
- `useConvertEstimateToInvoice` result type → `{ id: string }` (or shared `Invoice`);
  `handleConvert onSuccess` navigates to `` `/invoices/${result.id}` ``.
- **B15-NAV contract gate:** before that edit, convert an ACCEPTED estimate in the compose
  stack and record the landing URL in the commit body; if HEAD already lands on `/invoices/<id>`
  (an interceptor remaps the response), stop, report the interceptor's location, and rewrite the
  REG to that contract before merge.
- `[id]/page.tsx`: `const canConvert = status === "ACCEPTED";` is the only Convert predicate;
  delete the Convert button from DRAFT/SENT blocks; hoist the ACCEPTED block's Convert to a
  sibling `{canConvert && <Button>Convert to invoice</Button>}` (delete the now-empty ACCEPTED
  block); verify/gate the sidebar control on `canConvert`; no other Convert predicate literal
  remains.
- `handleSend onSuccess`: title `"Estimate marked as sent"`, description
  `` `${estimate.estimateNumber} is marked Sent. No email was sent.` ``; button label
  `"Mark as sent"`.
- `handleConvert onError`: description = server message (`err?.response?.data?.message`, joined
  with `", "` if array; reuse the existing web API-error helper if present), `"Please try
  again."` only when absent.
- Readers (`estimates/page.tsx` list date, `[id]/page.tsx` both date sites):
  `formatDateOnly(est.issueDate ?? est.createdAt)`, no cast; create-form dto literal gains
  `issueDate` from the existing `"YYYY-MM-DD"` state string.
- e2e: rewrite any spec converting from DRAFT/SENT to Accept-then-Convert; update any old-toast
  assertion; no other e2e edits.
- Mobile is read-only: check `apps/mobile/app/(operator)/estimates/**` and
  `apps/mobile/lib/estimates-logic.ts` for the delivery-claim wording; mirror the two strings
  only if present, else report "none".
- Web tests mock `apps/web/lib/api/estimates` hooks and `next/navigation`; toasts asserted via
  the rendered toast container (L-076); the ACCEPTED-render PIN asserts `toHaveLength(2)`, never
  `>= 1`.
- **Forbidden:** Send/Accept/Decline controls or handlers beyond the toast/label strings; any
  visual/layout redesign; `apps/web/app/providers.tsx`; `useSendEstimate`/`useDeclineEstimate`
  cache writes; any `as any`; mobile edits beyond the mirrored strings; e2e edits outside the
  grep hits; line-number anchoring.

**Satisfies:** B17(b), B15, B15-NAV, B79(web).
**Proven by:** T14, T19–T23, T33, T34 (Web REG/PIN commands below).
**Effort:** medium (Sonnet builds; reviewer applies the B15-NAV contract gate) — the server
claim, not the UI predicate, is the money guard.
**Wave:** 2. **dependsOn:** WP1 (server response shape `{id}` + link write), WP2 (`Estimate.issueDate`,
`formatDateOnly`).

---

### WP4 — bookkeeping (effort: low)

**Files:** registry rows B15/B16/B17/B70/B79 + new B15-NAV row; `.claude/code-map/{api,web,packages}.md`
+ `_meta.json`; `.claude/lessons/LESSONS.md`, `ARCHIVE.md`, `LESSONS-DIGEST.md`, `_meta.json`;
handoff card with F27-DR-B70/B17/B79 as owner items.

**Brief:**
- Mint B15-NAV via `bugs.mjs file` on the master-merged tree, `cd` to repo root in the same
  command, `BUGS_ROOT` = full `.claude/campaign` path — never guessed; linked to B15.
- Close B16 as stale citing `60d10e66` (#621, L-072) and `enum-parity.spec.ts`; file the
  unvalidated `@Query("status")` residual as its own row, not folded into B16.
- Archive three fully-guarded, least-cited lessons whole and verbatim to `ARCHIVE.md` first
  (L-067 untouched), then add L-117 (B15 predicate parity), L-118 (B70 sweep-the-column), L-119
  (B17/B79 write-path-before-column) with the ruling's text; run
  `node scripts/validate-lessons.mjs --digest`; bump `_meta.json`.
- Surgical code-map entries for touched files only; bump `_meta.json`; keep
  `scripts/validate-code-map.mjs` green.
- Raise F27-DR-B70 (money-relevant laundered-invoice report), F27-DR-B17 (invoiceId backfill),
  F27-DR-B79 (no backfill) in the handoff/PR body as owner decisions; no data script written in
  this batch.
- **Forbidden:** whole-map regeneration; shortening/merging a live lesson; any client identifier;
  editing project `CLAUDE.md`.

**Satisfies:** registry/lessons/map bookkeeping for B15/B16/B17/B70/B79/B15-NAV.
**Proven by:** `scripts/validate-lessons.mjs`, `scripts/validate-code-map.mjs` green.
**Effort:** low (Haiku/Sonnet).
**Wave:** 3. **dependsOn:** WP1, WP2, WP3.

---

## Acceptance criteria

1. `TERMINAL_ESTIMATE_STATUSES` exported exactly `["CONVERTED", "<VOID-STATUS>"]`; every claim in
   `send`/`decline`/`accept`/`voidEstimate` goes through `claimTransition`; no bare
   `estimate.update` remains in those four methods.
2. `convertToInvoice()` links `Estimate.invoiceId` inside the same transaction and rolls back
   (`ConflictException`) on a link-count mismatch; its `status: "ACCEPTED"` claim is untouched.
3. Laundered chains (`convert→send→accept→convert`, `convert→void→send→accept→convert`) mint
   exactly one invoice and reject at the first illegal transition.
4. `create()` validates `issueDate` (400 on malformed/NaN), persists and round-trips it through
   every `select`; absent stays `undefined`.
5. `Estimate.issueDate?: string | null` in `packages/types/api/misc.ts`; `formatDateOnly`
   renders UTC-fixed regardless of local TZ.
6. Web: no `as any` cast on the create dto or on `issueDate` readers; Convert button appears
   only on `canConvert` (exactly one predicate, exactly 2 controls when ACCEPTED, 0 on
   DRAFT/SENT); successful convert navigates to `/invoices/<real id>`; convert failure toast
   shows the server message; send toast/label no longer claims delivery.
7. All REGs listed below are red on unmodified HEAD and green after the fix; all PINs are green
   both before and after.
8. B16 closed as stale with citation; B15-NAV minted and linked; three lessons archived
   verbatim, L-117/L-118/L-119 added; code map bumped; `local:validate` and `local:test:db`
   green; `local:e2e` allow-listed lane green.
9. No schema/migration edit anywhere in the batch.

---

## Escalated to Fable (undecided)

These require reading `2d353752` and are routed by the ruling to the implementer/test author as
pre-write steps — not resolved here:

1. Does `apps/api/src/customers/customers.service.ts`'s merge-path `estimate.update` (~`:1774`)
   write `status`? Determines whether it is a fifth mutator needing `claimTransition` or its own
   registry row, and whether an extra REG-B70 test is needed.
2. `voidEstimate()`'s HEAD behavior on a CONVERTED row and on `findFirst → null` — determines
   whether the chain-B void leg and the missing-id void test are REGs or PINs (relabel before
   writing).
3. Literals that must be copied from HEAD, never invented: `<VOID-STATUS>`, `<ACCEPT-MSG>`,
   `<VOID-MSG>`, `accept()`'s where-clause key set (id-only vs id+tenantId), and `ROW` (exact key
   set of `send()`'s existing `estimate.update` mock).
4. HEAD's exact `expiresAt` parse output for `"2026-04-01"` — pin whatever string it actually
   produces if it differs from `"2026-04-01T00:00:00.000Z"`.

---

## Verification commands

**Tier 0 (once):** `cd apps/api && npx prisma generate`

**Tier 1 (per package, on every edit):**
- WP1: `npm run check-types -w apps/api`; `npm run lint -w apps/api`;
  `npm test -w apps/api -- --runTestsByPath src/estimates/estimates.service.spec.ts`
- WP2: `npm run check-types -w packages/types` (if defined) and `-w apps/web`;
  `npm test -w apps/web -- --runTestsByPath lib/format-date-only.test.ts`
- WP3: `npm run check-types -w apps/web`; `npm run lint -w apps/web`; Web REG/PIN commands below

**Tier 2 (package close):**
- `npm test -w apps/api -- src/estimates src/common/enum-parity.spec.ts src/common/no-bare-cron.spec.ts`
- `npm test -w apps/web -- app/\(dashboard\)/estimates lib`
- Ripple typecheck: `npm run check-types -w apps/api`, `-w apps/web`, `-w apps/mobile` (mobile
  red here is a report, not a fix — mobile is read-only this batch)

**Tier 3 (batch gate, in order, none inside `&&`/`| tail`):**
```
npm run local:up
npm run local:seed
npm run local:validate
npm run local:test:db
npm run local:e2e
# record B15-NAV landing-URL confirmation in the commit body
git push
```
`npm run verify` once before push as the house pre-push gate (not a substitute for the tiers
above).

**Red-gate (REG-scoped, `--runTestsByPath`; `[id]` is a regex character class):**
```
npm test -w apps/api -- --runTestsByPath src/estimates/estimates.service.spec.ts -t "REG-B70|REG-B17|REG-B79"
npm test -w apps/api -- --runTestsByPath src/estimates/estimates.service.spec.ts -t "PIN-B70|PIN-B17|PIN-B79"
npm run local:test:db -- --runTestsByPath src/estimates/estimates.issue-date.db.spec.ts
npm test -w apps/web -- --runTestsByPath "app/(dashboard)/estimates/[id]/page.test.tsx" "app/(dashboard)/estimates/page.test.tsx" lib/format-date-only.test.ts -t "REG-B15|REG-B15-NAV|REG-B17|REG-B79"
npm test -w apps/web -- --runTestsByPath "app/(dashboard)/estimates/[id]/page.test.tsx" "app/(dashboard)/estimates/page.test.tsx" lib/format-date-only.test.ts -t "PIN-B15|PIN-B79"
```

---

## Pipeline args

```js
{
  mode: 'bugfix',
  scale: 'small',
  workdir: 'C:/ClaudeCode/routeflow/.claude/worktrees/rf-F27',
  radiusFiles: [
    'apps/api/src/estimates/estimates.service.ts',
    'apps/api/src/estimates/estimates.service.spec.ts',
    'apps/api/src/estimates/estimates.issue-date.db.spec.ts',
    'apps/web/app/(dashboard)/estimates/[id]/page.tsx',
    'apps/web/app/(dashboard)/estimates/[id]/page.test.tsx',
    'apps/web/app/(dashboard)/estimates/page.tsx',
    'apps/web/app/(dashboard)/estimates/page.test.tsx',
    'apps/web/lib/api/estimates.ts',
    'apps/web/lib/format-date-only.ts',
    'apps/web/lib/format-date-only.test.ts',
    'packages/types/api/misc.ts',
    'apps/web/e2e/*.spec.ts',
    'apps/api/src/customers/customers.service.ts',
    '.claude/code-map/api.md', '.claude/code-map/web.md', '.claude/code-map/packages.md',
    '.claude/code-map/_meta.json',
    '.claude/lessons/LESSONS.md', '.claude/lessons/ARCHIVE.md',
    '.claude/lessons/LESSONS-DIGEST.md', '.claude/lessons/_meta.json'
  ],
  siblingPatterns: [
    'rg -n \'"Please try again\\.?"|Something went wrong\' apps/web apps/mobile',
    'rg -n -e \'status (===|!==) "\' -e \'\\].includes\\(status\\)\' -e \'switch \\(status\\)\' apps/web/app apps/web/components apps/mobile/app apps/mobile/lib',
    'rg -n \'@Query("status")\' apps/api/src',
    'rg -nU \'if \\(status\\)\\s*\\{?\\s*where\\.status = status\' apps/api/src',
    'rg -n \'^\\s+\\w+\\s+(String|DateTime|Int|Decimal|Boolean)\\?\' apps/api/prisma/schema',
    'rg -n \'sent to the customer|has been sent|email(ed)? to\' apps/web apps/mobile',
    'rg -nU \'\\.update(Many)?\\(\\{\\s*where:\\s*\\{[^}]*\\bid\\b[^}]*\\},\\s*data:\\s*\\{[^}]*\\bstatus\\b\' apps/api/src',
    'rg -n \'\\(\\w+ as any\\)\\.\\w+\' apps/web apps/mobile',
    'rg -n \'new Date\\(dto\\.\\w+\\)\' apps/api/src'
  ],
  mutationProbe: {
    targets: [
      { file: 'apps/api/src/estimates/estimates.service.ts', revertFix: true, granularity: 'whole-file+hunks' },
      { file: 'apps/web/app/(dashboard)/estimates/[id]/page.tsx', revertFix: true, granularity: 'whole-file+hunks' },
      { file: 'apps/web/app/(dashboard)/estimates/page.tsx', revertFix: true },
      { file: 'apps/web/lib/api/estimates.ts', revertFix: true, expectRed: 'check-types -w apps/web' },
      { file: 'packages/types/api/misc.ts', revertFix: true, expectRed: 'check-types -w apps/web' },
      { file: 'apps/web/lib/format-date-only.ts', revertFix: true, expectRed: 'PIN-B79 UTC-fixed display' }
    ]
  },
  redGate: {
    commands: [
      { cmd: 'npm test -w apps/api -- --runTestsByPath src/estimates/estimates.service.spec.ts -t "REG-B70|REG-B17|REG-B79"', expect: 'fail' },
      { cmd: 'npm run local:test:db -- --runTestsByPath src/estimates/estimates.issue-date.db.spec.ts', expect: 'fail' },
      { cmd: 'npm test -w apps/web -- --runTestsByPath "app/(dashboard)/estimates/[id]/page.test.tsx" "app/(dashboard)/estimates/page.test.tsx" lib/format-date-only.test.ts -t "REG-B15|REG-B15-NAV|REG-B17|REG-B79"', expect: 'fail' }
    ]
  },
  verifyCommands: {
    perRound: [
      'npm run check-types -w apps/api',
      'npm run lint -w apps/api',
      'npm test -w apps/api -- --runTestsByPath src/estimates/estimates.service.spec.ts',
      'npm run check-types -w apps/web',
      'npm run lint -w apps/web',
      'npm test -w apps/web -- --runTestsByPath lib/format-date-only.test.ts'
    ],
    final: [
      'npm test -w apps/api -- src/estimates src/common/enum-parity.spec.ts src/common/no-bare-cron.spec.ts',
      'npm test -w apps/web -- app/\\(dashboard\\)/estimates lib',
      'npm run check-types -w apps/api', 'npm run check-types -w apps/web', 'npm run check-types -w apps/mobile',
      'npm run local:up', 'npm run local:seed', 'npm run local:validate',
      'npm run local:test:db', 'npm run local:e2e', 'npm run verify'
    ]
  },
  packages: [
    { id: 'WP1', title: 'API money guard', files: ['apps/api/src/estimates/estimates.service.ts', 'apps/api/src/estimates/estimates.service.spec.ts', 'apps/api/src/estimates/estimates.issue-date.db.spec.ts', 'apps/api/src/customers/customers.service.ts'], satisfies: ['B70', 'B17a', 'B79-server'], provenBy: ['T1-T13', 'T15-T18', 'T24-T29', 'T31-T32'], effort: 'high', dependsOn: [] },
    { id: 'WP2', title: 'Shared type + formatter', files: ['packages/types/api/misc.ts', 'apps/web/lib/format-date-only.ts', 'apps/web/lib/format-date-only.test.ts'], satisfies: ['B79-type'], provenBy: ['T30'], effort: 'medium', dependsOn: [] },
    { id: 'WP3', title: 'Web pages + client lib', files: ['apps/web/lib/api/estimates.ts', 'apps/web/app/(dashboard)/estimates/[id]/page.tsx', 'apps/web/app/(dashboard)/estimates/page.tsx', 'apps/web/app/(dashboard)/estimates/[id]/page.test.tsx', 'apps/web/app/(dashboard)/estimates/page.test.tsx', 'apps/web/e2e/*.spec.ts'], satisfies: ['B17b', 'B15', 'B15-NAV', 'B79-web'], provenBy: ['T14', 'T19-T23', 'T33', 'T34'], effort: 'medium', dependsOn: ['WP1', 'WP2'] },
    { id: 'WP4', title: 'Bookkeeping', files: ['.claude/code-map/*.md', '.claude/lessons/*.md'], satisfies: ['registry', 'lessons', 'map'], provenBy: ['validate-lessons.mjs', 'validate-code-map.mjs'], effort: 'low', dependsOn: ['WP1', 'WP2', 'WP3'] }
  ],
  lessonsPath: '.claude/lessons/LESSONS.md',
  runDir: '.claude/pipeline/2026-09-13-F27'
}
```

---

## Diff brief

Transcribed the S5 Fable ruling for F27 into four file-disjoint packages: WP1 (API, high) puts
one `claimTransition` helper behind every terminal-status mutator, wires the missing
`invoiceId` link, and adds `issueDate` create/validate/read; WP2 (medium) adds the optional
`issueDate` field and a UTC-fixed formatter as pure additive edits so no intermediate commit
breaks typechecking; WP3 (medium) depends on WP1's `{id}` response shape and WP2's type/formatter
to fix the render predicate, the `/invoices/undefined` navigation bug, the false delivery toast,
and the `as any` casts, gated by a compose-stack B15-NAV contract check; WP4 (low) closes B16 as
stale, mints B15-NAV, archives three lessons and adds L-117/L-118/L-119, and updates the code map.
Nothing here re-judges the ruling — hard lines, forbidden edits, literal placeholders
(`<VOID-STATUS>`, `<ACCEPT-MSG>`, `<VOID-MSG>`, `ROW`), and the four genuinely undetermined
items (customers.service.ts status write, voidEstimate's HEAD behavior, HEAD literals, the
expiresAt parse string) are carried through verbatim into the Escalated section rather than
guessed. Money discipline (`packages/pricing`) is untouched — no line/tax/total math changes in
this batch. All REG/PIN test ids (T1–T34) and their exact red-gate/verify commands are lifted
unchanged from the S5 ruling and bug-test-plan.md.
```