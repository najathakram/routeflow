# build-plan.md — F27 (Estimates) — task-loop engine (2026-09-12 rebuild)

## Preamble

Tree `fix/F27` @ `2d353752` (= origin/master), worktree `rf-F27-build`. No schema change, no
migration — `Estimate.issueDate` / `Estimate.invoiceId` (+FK/unique) already migrated by
`20260908000000_campaign_schema_foundation`. This build-plan targets the REBUILT task-loop engine
(`args.tasks[]`, not the retired `packages[]`/`mutationProbe`/`radiusFiles` shape) — S5 ruling by
Fable, task-graph mapping also by Fable (chain-over-merge for shared files: the 1.5 KB brief cap
cannot hold three causes' exact code shapes for one HIGH-risk file, and one adversarial review per
cause beats one review of seven unrelated hunks).

Full cause/fix reasoning: `cause-ruling.md` (S3, this directory). Full REG/PIN test detail:
`test-plan.md` (S4, this directory, = `bug-test-plan.md` at the worktree root, T1-T34).

**Two parallel chains + shared bookkeeping:**
- API chain (all HIGH risk): rc-b70/rc-b17/rc-b79 -> rt-b70 -> fix-b70 -> rp-b70 -> rt-b17-api ->
  fix-b17-api -> rp-b17-api -> rt-b79-api + rt-b79-db -> fix-b79-api -> rp-b79-api.
- Type/formatter (feature, no bug chain): feat-b79-types (depends on rc-b79 only).
- Web chain: rc-b17/rc-b15 -> rt-b17-web -> fix-b17-web -> rp-b17-web -> rt-b15 -> fix-b15 ->
  rp-b15 -> rt-b79-web (also needs feat-b79-types) -> fix-b79-web -> rp-b79-web.
- `verify-web` (ui-verify) joins both chains: compose gates, e2e sweep, DB-lane confirmation,
  B15-NAV landing-URL check.
- `docs-closeout` (docs): registry (B15/B17/B70/B79 fixed, B16 stale, B15-NAV minted), lessons
  L-117/L-118/L-119, code map, owner-surfaced findings (F27-DR-B70/B17/B79 data repair reports).

B16 (Expired filter) is REFUTED as stale (already fixed in #621, L-072) — no fix task; closed only
in docs-closeout.

## Task summary (26 tasks: 4 root-cause, 8 repro-test, 6 fix, 6 revert-probe, 1 feature, 1
ui-verify, 1 docs)

- **rc-b70** (root-cause) — B70 root cause: status mutators launder CONVERTED/voided estimates
- **rc-b17** (root-cause) — B17 root cause: convert never links invoiceId; send toast claims delivery
- **rc-b79** (root-cause) — B79 root cause: issueDate dropped by web dto, never written by create(), absent from shared type
- **rc-b15** (root-cause) — B15/B15-NAV root cause: Convert rendered on DRAFT/SENT; onSuccess navigates on invoiceId
- **rt-b70** (repro-test) — REG/PIN-B70 tests in estimates.service.spec.ts
- **fix-b70** (fix) — B70 fix: claimTransition helper + terminal-status set for send/decline/accept/void
- **rp-b70** (revert-probe) — Revert-probe B70: HEAD estimates.service.ts must turn REG-B70 chain A red
- **rt-b17-api** (repro-test) — REG/PIN-B17 server tests: convert links invoiceId, count mismatch rolls back
- **fix-b17-api** (fix) — B17 server fix: link estimate.invoiceId inside convertToInvoice's transaction
- **rp-b17-api** (revert-probe) — Revert-probe B17 server: HEAD estimates.service.ts must turn the link REG red
- **rt-b79-api** (repro-test) — REG/PIN-B79 server tests: create() persists and validates issueDate
- **rt-b79-db** (repro-test) — REG-B79 DB-lane round-trip: read path returns the persisted issueDate
- **fix-b79-api** (fix) — B79 server fix: create() validates + writes issueDate; select audit
- **rp-b79-api** (revert-probe) — Revert-probe B79 server: HEAD estimates.service.ts must turn the persist REG red
- **feat-b79-types** (feature) — B79 shared type (issueDate) + UTC-fixed date-only formatter with PIN
- **rt-b17-web** (repro-test) — REG-B17 web test: send toast/label no longer claim delivery
- **fix-b17-web** (fix) — B17 web fix: honest send toast + 'Mark as sent' label
- **rp-b17-web** (revert-probe) — Revert-probe B17 web: HEAD [id]/page.tsx must turn the toast REG red
- **rt-b15** (repro-test) — REG/PIN-B15 + REG-B15-NAV web tests in [id]/page.test.tsx
- **fix-b15** (fix) — B15 + B15-NAV fix: single canConvert predicate, server-reason toast, navigate on .id
- **rp-b15** (revert-probe) — Revert-probe B15: HEAD [id]/page.tsx must turn the DRAFT-control REG red
- **rt-b79-web** (repro-test) — REG/PIN-B79 web tests: submit carries issueDate; readers fall back to createdAt
- **fix-b79-web** (fix) — B79 web fix: dto carries issueDate, cast removed, readers use formatDateOnly
- **rp-b79-web** (revert-probe) — Revert-probe B79 web: HEAD estimates/page.tsx must turn the submit REG red
- **verify-web** (ui-verify) — F27 compose gates, e2e sweep, DB lane, B15-NAV landing-URL confirmation
- **docs-closeout** (docs) — F27 bookkeeping: registry (B16 stale, B15-NAV minted), lessons L-117..119, code map, owner findings

Full per-task brief, files, tests and dependsOn: see the `## Pipeline args` block below — that
block is authoritative; this summary is a reading aid only.

## Acceptance criteria

1. `TERMINAL_ESTIMATE_STATUSES` exported exactly `["CONVERTED", "<VOID-STATUS>"]`; every claim in
   send/decline/accept/voidEstimate goes through `claimTransition`; no bare `estimate.update`
   remains in those four methods.
2. `convertToInvoice()` links `Estimate.invoiceId` inside the same transaction and rolls back
   (`ConflictException`) on a link-count mismatch; its `status: "ACCEPTED"` claim is untouched.
3. Laundered chains (convert->send->accept->convert, convert->void->send->accept->convert) mint
   exactly one invoice and reject at the first illegal transition.
4. `create()` validates `issueDate` (400 on malformed/NaN), persists and round-trips it through
   every `select`; absent stays `undefined`.
5. `Estimate.issueDate?: string | null` in `packages/types/api/misc.ts`; `formatDateOnly` renders
   UTC-fixed regardless of local TZ.
6. Web: no `as any` cast on the create dto or on `issueDate` readers; Convert button appears only
   on `canConvert` (exactly one predicate, exactly 2 controls when ACCEPTED, 0 on DRAFT/SENT);
   successful convert navigates to `/invoices/<real id>`; convert failure toast shows the server
   message; send toast/label no longer claims delivery.
7. All 23 REGs (T1-T23) red on unmodified HEAD and green after the fix; all 11 PINs (T24-T34)
   green both before and after.
8. B16 closed as stale with citation; B15-NAV minted and linked; three lessons archived verbatim,
   L-117/L-118/L-119 added; code map bumped; `local:validate` and `local:test:db` green;
   `local:e2e` allow-listed lane green.
9. No schema/migration edit anywhere in the batch.

## Verification commands

perRound (scoped, runs after each task's implement/fix round): typecheck/lint on apps/api and
apps/web. final (once, at Final): the estimates + enum-parity + no-bare-cron API suite, the
estimates + lib web suite, and a full check-types ripple across api/web/mobile (mobile red here is
a report, not a fix — mobile is read-only this batch). The compose-stack gates (`local:up`
.. `local:e2e`) are NOT here — they are `verify-web`'s own task, not a repo-wide final gate.

## Pipeline args

```js
{
  buildPlanPath: '.claude/pipeline/2026-09-13-F27-build/build-plan.md',
  testPlanPath: '.claude/pipeline/2026-09-13-F27-build/test-plan.md',
  lessonsPath: '.claude/lessons/LESSONS.md',
  startedAt: '2026-09-13T03:15:00Z',
  runDir: '.claude/pipeline/2026-09-13-F27-build',
  scale: 'small',
  mode: 'bugfix',
  profile: 'standard',
  workdir: 'C:/ClaudeCode/routeflow/.claude/worktrees/rf-F27-build',
  context: 'F27 (Estimates carve-out): B15/B17/B70/B79 fixes + B15-NAV, B16 closed stale. Money-adjacent (estimate/invoice state machine) -- HIGH risk on estimates.service.ts.',
  baselineSha: '2d353752',
  formatCommand: 'npm run format',

siblingPatterns: [
  { pattern: '"Please try again\\.?"|Something went wrong',
    note: "fixed-string error toasts hiding a server message (B15 class); scope apps/web apps/mobile" },
  { pattern: 'status (===|!==) "|\\]\\.includes\\(status\\)|switch \\(status\\)',
    note: "render predicate vs server claim mismatch (B15 class); scope apps/web/app apps/web/components apps/mobile/app apps/mobile/lib" },
  { pattern: '@Query\\("status"\\)',
    note: "B16 residual: unvalidated status query string flowing into where.status; scope apps/api/src" },
  { pattern: '^\\s+\\w+\\s+(String|DateTime|Int|Decimal|Boolean)\\?',
    note: "nullable schema columns: cross-check each has a write site — migrated-but-never-written (B17/B79 class); scope apps/api/prisma/schema" },
  { pattern: 'sent to the customer|has been sent|email(ed)? to',
    note: "delivery claims without an EmailService call (B17 class); scope apps/web apps/mobile" },
  { pattern: '\\.update(Many)?\\(\\{\\s*where:\\s*\\{[^}]*\\bid\\b[^}]*\\},\\s*data:\\s*\\{[^}]*\\bstatus\\b',
    note: "status mutators without a status predicate (B70 class); run with rg -nU over apps/api/src" },
  { pattern: '\\(\\w+ as any\\)\\.\\w+',
    note: "cast-to-read a field the shared type lacks (B79 class); scope apps/web apps/mobile" },
  { pattern: 'new Date\\(dto\\.\\w+\\)',
    note: "unvalidated Date sink (B79 class); scope apps/api/src" },
],

tasks: [
  // ───────── wave 1: root causes (investigative, no file ownership) ─────────
  {
    id: "rc-b70",
    title: "B70 root cause: status mutators launder CONVERTED/voided estimates",
    type: "root-cause",
    files: [],
    tests: [],
    risk: "HIGH",
    dependsOn: [],
    radius: ["apps/api/src/estimates/estimates.service.ts", "apps/api/src/customers/customers.service.ts", "apps/api/src/estimates/estimates.controller.ts"],
    brief: `Confirm B70 on HEAD (rf-F27 @2d353752; ':NNN' anchors are hints — locate by text). Cause: send() (~:231-233) and decline() (~:246-248) do a bare estimate.update({ where: { id }, data: { status } }) with NO status predicate, so a CONVERTED estimate launders CONVERTED->SENT->ACCEPTED->convertToInvoice() and mints a second invoice; voidEstimate() (~:249-255) is read-then-check (TOCTOU) and its status launders the same way (void->send->accept->convert); accept() (~:236-244) claims via updateMany with status { not: "CONVERTED" }. Smallest probe: a mocked-prisma spec chain convert->send->accept->convert shows invoice.create called twice. Report VERBATIM from HEAD (downstream copies, never invents): (1) the enum literal voidEstimate() writes (<VOID-STATUS>); (2) accept()'s exact updateMany where-clause key set (id only, or id + tenant key) and whether this.prisma is the tenant-scoped extension; (3) accept()'s and voidEstimate()'s existing refusal messages; (4) voidEstimate()'s HEAD behaviour on a CONVERTED row and when its findFirst returns null (400 or 404?); (5) the include/select send()'s estimate.update carries, if any; (6) REQUIRED FINDING: does apps/api/src/customers/customers.service.ts ~:1774 (customer merge) write Estimate.status? Expected: it reassigns customerId only. Answer yes/no with the quoted code. Do not edit files.`,
  },
  {
    id: "rc-b17",
    title: "B17 root cause: convert never links invoiceId; send toast claims delivery",
    type: "root-cause",
    files: [],
    tests: [],
    risk: "HIGH",
    dependsOn: [],
    radius: ["apps/api/src/estimates/estimates.service.ts", "apps/web/app/(dashboard)/estimates/[id]/page.tsx", "apps/api/prisma/schema/finance.prisma"],
    brief: `Confirm both halves of B17 on HEAD (anchors are hints; locate by text). Server: convertToInvoice() (~:280-335, inside tenantTransaction) claims via tx.estimate.updateMany({ where: { <keys>, status: "ACCEPTED" }, data: { status: "CONVERTED" } }) (~:284-287), creates the invoice (~:307-334) and returns inv — it NEVER writes Estimate.invoiceId, although the column exists (invoiceId @unique, FK onDelete: SetNull, migrated by 20260908000000_campaign_schema_foundation; no schema change in F27). Probe: mocked tx, call convertToInvoice, assert no call carries invoiceId. Web: [id]/page.tsx handleSend onSuccess (~:121-122) toasts a delivery claim and the button (~:244) reads "Send", while POST /estimates/:id/send is status-only — send() writes status: "SENT" and nothing in apps/api/src/estimates calls an EmailService (rg -n "EmailService|sendMail|mailer" apps/api/src/estimates = 0 hits). Report verbatim: the claim's where keys at ~:284-287 (must equal rc-b70 finding 2), the exact "return inv;" hunk, HEAD's toast title/description and button label, and whether the mobile operator estimate screens carry the same delivery claim (rg -n -i "sent to|has been sent" apps/mobile/app apps/mobile/lib). Do not edit files.`,
  },
  {
    id: "rc-b79",
    title: "B79 root cause: issueDate dropped by web dto, never written by create(), absent from shared type",
    type: "root-cause",
    files: [],
    tests: [],
    risk: "HIGH",
    dependsOn: [],
    radius: ["apps/api/src/estimates/estimates.service.ts", "apps/web/app/(dashboard)/estimates/page.tsx", "apps/web/lib/api/estimates.ts", "packages/types/api/misc.ts"],
    brief: `Confirm the three-part B79 cause on HEAD (anchors are hints; locate by text). (1) Web: apps/web/app/(dashboard)/estimates/page.tsx keeps an issueDate "YYYY-MM-DD" string in state (~:149) and renders the input, but the create dto literal (~:343-356) omits issueDate and is passed as "dto as any" (~:358) because CreateEstimateDto in apps/web/lib/api/estimates.ts lacks it. (2) API: estimates.service.ts create() (~:141-158) never writes issueDate (data literal lacks it) although Estimate.issueDate exists in finance.prisma (migrated by 20260908000000_campaign_schema_foundation; no schema change in F27). (3) Shared type: packages/types/api/misc.ts Estimate (~:59-74) lacks issueDate, so readers page.tsx ~:921 and [id]/page.tsx ~:358, ~:501 read "(est as any).issueDate ?? est.createdAt". Smallest probe: mocked-prisma create({ ...valid, issueDate: "2026-09-01" }) -> estimate.create data has no issueDate key. Report verbatim: every field the web dto literal sends that CreateEstimateDto lacks; HEAD's exact expiresAt parse in create() (~:150-154) and its Date output for the value the web sends (T32 pins it); whether findAll/findOne/list use explicit select blocks (list each); the three readers' current formatter calls; whether a UTC-fixed date-only helper already exists in apps/web/lib (rg -n 'timeZone: "UTC"' apps/web/lib); the controller's @Body() dto: any signature. Do not edit files.`,
  },
  {
    id: "rc-b15",
    title: "B15/B15-NAV root cause: Convert rendered on DRAFT/SENT; onSuccess navigates on invoiceId",
    type: "root-cause",
    files: [],
    tests: [],
    dependsOn: [],
    radius: ["apps/web/app/(dashboard)/estimates/[id]/page.tsx", "apps/web/lib/api/estimates.ts", "apps/api/src/estimates/estimates.controller.ts", "apps/api/src/estimates/estimates.service.spec.ts"],
    brief: `Confirm B15 and B15-NAV on HEAD [id]/page.tsx (anchors are hints; locate by text). B15: const canConvert = ... (~:214); the DRAFT block (~:249-257), SENT block (~:288-296) and ACCEPTED block (~:300-309) each render a "Convert to invoice" <Button>, and the sidebar control (~:458-470) renders from canConvert — so DRAFT/SENT show Convert controls (today's DRAFT count: 2) while the server's convertToInvoice() claim (status: "ACCEPTED") refuses with a 400 whose message the UI drops: handleConvert onError (~:184-190) toasts a fixed "Please try again." (quote HEAD's exact strings). Smallest probe: RTL render with status "DRAFT" -> getAllByRole("button", { name: /convert to invoice/i }).length === 2. B15-NAV: handleConvert onSuccess (~:176, ~:182) navigates to /invoices/\${data.invoiceId} while the server returns the raw Invoice keyed id (estimates.service.spec.ts ~:126 pins it; the controller returns the service result; useConvertEstimateToInvoice in apps/web/lib/api/estimates.ts ~:105 types the result with invoiceId) -> lands on /invoices/undefined. Probe: rg -n "APP_INTERCEPTOR|ClassSerializerInterceptor|invoiceId" apps/api/src/estimates apps/api/src/main.ts apps/api/src/app.module.ts — report any interceptor that could remap the convert response (expected: none; if one exists say where — fix-b15 must stop on it). Report: the canConvert expression, what ~:458-470 actually reads, the exact onError/onSuccess code, and whether a shared API-error helper exists in apps/web/lib (rg -n -F "response?.data?.message" apps/web/lib). Do not edit files.`,
  },

  // ───────── API chain: B70 → B17(server) → B79(server) ─────────
  {
    id: "rt-b70",
    title: "REG/PIN-B70 tests in estimates.service.spec.ts",
    type: "repro-test",
    files: [],
    tests: ["apps/api/src/estimates/estimates.service.spec.ts"],
    risk: "HIGH",
    dependsOn: ["rc-b70"],
    radius: ["apps/api/src/estimates/estimates.service.ts"],
    brief: `Write into estimates.service.spec.ts; the existing B8 tests (~:46-78) stay green — extend their mocks, never delete. Copy <VOID-STATUS>, refusal messages and accept()'s where keys from HEAD/rc-b70; never invent. Detail: bug-test-plan.md T1-T11, T24-T28. REG (each red on today's wrong value): T1 send() on CONVERTED -> BadRequestException; T2 send() on <VOID-STATUS> -> throws; T3 decline() on CONVERTED -> throws; T4 accept() on voided -> throws, discriminated by where-shape: updateMany where objectContaining({ status: { notIn: expect.arrayContaining(["CONVERTED", "<VOID-STATUS>"]) } }); T5 voidEstimate() claims atomically via updateMany with that predicate (no read-then-check); T6 exact title "REG-B70 laundered chain A convert->send->accept->convert mints one invoice": invoice.create called 1x (today 2x); T7 chain B convert->void->send->accept->convert: 1x (today 2x); T8-T11 missing id (updateMany {count:0}, findFirst null) -> NotFoundException, not BadRequest, for send/decline/accept/voidEstimate (T11 becomes a PIN if rc-b70 finding 4 says HEAD already 404s). PIN (green today and after): T24 send() resolves HEAD's shape (same include/select); T25 key-set parity — accept/send/decline/void updateMany wheres carry the identical key set; T26 accept() still allows DECLINED->ACCEPTED; T27 B8 tests green; T28 the notIn set is exactly ["CONVERTED", "<VOID-STATUS>"] (no EXPIRED). Prefix titles REG-B70 / PIN-B70. Mock prisma at the module boundary; updateMany resolves { count } per call.`,
  },
  {
    id: "fix-b70",
    title: "B70 fix: claimTransition helper + terminal-status set for send/decline/accept/void",
    type: "fix",
    files: ["apps/api/src/estimates/estimates.service.ts"],
    tests: [],
    risk: "HIGH",
    dependsOn: ["rc-b70", "rt-b70"],
    radius: ["apps/api/src/estimates/estimates.service.spec.ts", "apps/api/src/estimates/estimates.controller.ts", "apps/api/src/customers/customers.service.ts"],
    brief: `estimates.service.ts only; anchor by text. (1) Top of file: const TERMINAL_ESTIMATE_STATUSES = ["CONVERTED", "<VOID-STATUS>"] as const satisfies readonly EstimateStatus[]; — <VOID-STATUS> is the literal voidEstimate() writes on HEAD (copy it); EXPIRED deliberately excluded. (2) One private helper: private async claimTransition(id: string, to: EstimateStatus, refusal: string): Promise<void> { const r = await this.prisma.estimate.updateMany({ where: { <accept()'s where keys verbatim: id, plus the tenant key if accept() has one>, status: { notIn: [...TERMINAL_ESTIMATE_STATUSES] } }, data: { status: to } }); if (r.count === 1) return; const row = await this.prisma.estimate.findFirst({ where: { <same keys, no status> } }); if (!row) throw new NotFoundException("Estimate not found"); throw new BadRequestException(refusal); } (3) send(): replace the bare update with await this.claimTransition(id, "SENT", "Converted or voided estimates cannot be re-sent"); then a post-claim read reproducing today's return shape exactly (HEAD's include/select). (4) decline(): same, refusal "Converted or voided estimates cannot be declined". (5) accept(): swap its { not: "CONVERTED" } claim for claimTransition(id, "ACCEPTED", <its existing message>); keep its post-claim read. (6) voidEstimate(): claimTransition(id, "<VOID-STATUS>", <its existing message>); keep its read/return. Do not touch convertToInvoice() or create(). Declared: accept() refuses voided; missing id -> 404; void of voided -> 400; DECLINED->ACCEPTED still allowed. customers.service.ts ~:1774: never edit; if rc-b70 says it writes status, report it for a registry row.`,
  },
  {
    id: "rp-b70",
    title: "Revert-probe B70: HEAD estimates.service.ts must turn REG-B70 chain A red",
    type: "revert-probe",
    file: "apps/api/src/estimates/estimates.service.ts",
    test: "REG-B70 laundered chain A convert->send->accept->convert mints one invoice",
    files: ["apps/api/src/estimates/estimates.service.ts"],
    tests: ["apps/api/src/estimates/estimates.service.spec.ts"],
    risk: "HIGH",
    dependsOn: ["fix-b70"],
    brief: `Restore HEAD content of the file (git show 2d353752:apps/api/src/estimates/estimates.service.ts > that path), run ONLY the named test — it must go red on the bug's own wrong value (invoice.create called 2x). Then git checkout -- the path (fix committed on the branch) and rerun: green. A red under no probe is a harness defect, not a pass.`,
  },
  {
    id: "rt-b17-api",
    title: "REG/PIN-B17 server tests: convert links invoiceId, count mismatch rolls back",
    type: "repro-test",
    files: [],
    tests: ["apps/api/src/estimates/estimates.service.spec.ts"],
    risk: "HIGH",
    dependsOn: ["rc-b17", "rp-b70"],
    radius: ["apps/api/src/estimates/estimates.service.ts"],
    brief: `Append to estimates.service.spec.ts after rt-b70's tests (every existing test stays green except your REGs). Detail: bug-test-plan.md T12, T13, T29. Mock: tenantTransaction runs the callback with a tx whose estimate.updateMany resolves { count: 1 } for the ACCEPTED claim and then { count: 1 } (T12) / { count: 0 } (T13) for the link; tx.invoice.create resolves { id: "inv_1", ... }. REG-B17 T12, exact title "REG-B17 convertToInvoice links the estimate to the minted invoice": expect a tx.estimate.updateMany call with { where: objectContaining({ <the claim's where keys>, status: "CONVERTED" }), data: { invoiceId: "inv_1" } } and assert via mock.invocationCallOrder that it runs AFTER tx.invoice.create — red today (no such call). REG-B17 T13 "link count mismatch rolls back": with the link resolving { count: 0 }, convertToInvoice rejects with ConflictException("Estimate link failed") and never resolves the invoice — red today. PIN-B17 T29 "convert still claims via updateMany status ACCEPTED and returns the invoice": the first updateMany is still { where: objectContaining({ status: "ACCEPTED" }), data: { status: "CONVERTED" } } and the resolved value is tx.invoice.create's result — green today and after. Copy the claim's where keys from HEAD (rc-b17); never invent a tenant key.`,
  },
  {
    id: "fix-b17-api",
    title: "B17 server fix: link estimate.invoiceId inside convertToInvoice's transaction",
    type: "fix",
    files: ["apps/api/src/estimates/estimates.service.ts"],
    tests: [],
    risk: "HIGH",
    dependsOn: ["rc-b17", "rt-b17-api", "rp-b70"],
    radius: ["apps/api/prisma/schema/finance.prisma", "apps/api/src/estimates/estimates.controller.ts", "apps/api/src/invoices/invoices.service.ts", "apps/api/src/estimates/estimates.service.spec.ts"],
    brief: `One hunk in estimates.service.ts convertToInvoice(), inside the existing tenantTransaction, after const inv = await tx.invoice.create(...) and before return inv; (locate by text — B70's hunks have already moved lines):
const linked = await tx.estimate.updateMany({
  where: { <the same keys as the status: "ACCEPTED" claim at the top of this transaction>, status: "CONVERTED" },
  data: { invoiceId: inv.id },
});
if (linked.count !== 1) throw new ConflictException("Estimate link failed"); // throwing rolls the tx back
Same client shape as the claim (updateMany — never a bare update on the unique key). Import ConflictException from @nestjs/common if absent. Return shape (inv) unchanged. The status: "ACCEPTED" claim remains the sole duplicate-conversion guard; invoiceId is traceability only. P2002 on invoiceId @unique is unreachable (inv.id is minted in this transaction; a retry after commit dies at the ACCEPTED claim) — the count check exists so the impossible case rolls back instead of half-committing. No schema/migration change (the column exists). Touch nothing else in the file: send/decline/accept/void/helper are B70's (landed); create() is fix-b79-api's.`,
  },
  {
    id: "rp-b17-api",
    title: "Revert-probe B17 server: HEAD estimates.service.ts must turn the link REG red",
    type: "revert-probe",
    file: "apps/api/src/estimates/estimates.service.ts",
    test: "REG-B17 convertToInvoice links the estimate to the minted invoice",
    files: ["apps/api/src/estimates/estimates.service.ts"],
    tests: ["apps/api/src/estimates/estimates.service.spec.ts"],
    risk: "HIGH",
    dependsOn: ["fix-b17-api"],
    brief: `Restore HEAD content (git show 2d353752:apps/api/src/estimates/estimates.service.ts > that path), run ONLY the named test — red on the wrong value (no updateMany carrying invoiceId). Then git checkout -- the path and rerun: green. Red under no probe = harness defect.`,
  },
  {
    id: "rt-b79-api",
    title: "REG/PIN-B79 server tests: create() persists and validates issueDate",
    type: "repro-test",
    files: [],
    tests: ["apps/api/src/estimates/estimates.service.spec.ts"],
    risk: "HIGH",
    dependsOn: ["rc-b79", "rp-b17-api"],
    radius: ["apps/api/src/estimates/estimates.service.ts"],
    brief: `Append to estimates.service.spec.ts after rt-b17-api's tests. Detail: bug-test-plan.md T15, T16, T31, T32. REG-B79 T15, exact title "REG-B79 create() persists issueDate": create({ ...valid, issueDate: "2026-09-01" }) -> prisma.estimate.create called with data objectContaining({ issueDate: new Date("2026-09-01") }) (UTC midnight) — red today (key absent). REG-B79 T16 "create() rejects a malformed issueDate" (two cases): issueDate "2026-13-45" and "09/01/2026" each reject with BadRequestException whose message is "issueDate must be YYYY-MM-DD" — red today (HEAD silently ignores the field, so create resolves). PIN-B79 T31 "create() without issueDate leaves it unset": data.issueDate is undefined. PIN-B79 T32 "expiresAt still parsed as before": pass the expiresAt value the web sends and assert the exact Date rc-b79 recorded from HEAD's parse — green today and after. Mock prisma at the module boundary as the existing tests do. DB-lane tests do NOT go here (rt-b79-db owns estimates.issue-date.db.spec.ts).`,
  },
  {
    id: "rt-b79-db",
    title: "REG-B79 DB-lane round-trip: read path returns the persisted issueDate",
    type: "repro-test",
    files: [],
    tests: ["apps/api/src/estimates/estimates.issue-date.db.spec.ts"],
    risk: "HIGH",
    dependsOn: ["rc-b79"],
    radius: ["apps/api/src/estimates/estimates.service.ts", "scripts/lib/test-tenants.cjs"],
    brief: `New DB-lane spec apps/api/src/estimates/estimates.issue-date.db.spec.ts — the *.db.spec.ts lane, executed ONLY by "npm run local:test:db" against the compose Postgres (bring the stack up first if needed: npm run local:up; npm run local:seed). Follow an existing *.db.spec.ts in apps/api for bootstrap/teardown; approved test tenant "test" only, via assertTestTenant — never a live slug. REG-B79 T17 "read path returns the persisted issueDate (DB lane)": through the real EstimatesService + PrismaService, create an estimate with issueDate: "2026-09-01", then read it back through findOne AND the list/findAll path; both must return issueDate equal to new Date("2026-09-01T00:00:00.000Z"). Behavioural red today: create() never writes the column, so the read-back is null — paste that failing assertion (expected 2026-09-01..., received null) as the RED evidence. After the fix this same test also catches any explicit select that drops the column — that is its purpose (do not replace it with a mocked select inspection). Delete the rows you created in afterAll. The host jest run cannot execute this lane; its GREEN is proven by verify-web's local:test:db step.`,
  },
  {
    id: "fix-b79-api",
    title: "B79 server fix: create() validates + writes issueDate; select audit",
    type: "fix",
    files: ["apps/api/src/estimates/estimates.service.ts"],
    tests: [],
    risk: "HIGH",
    dependsOn: ["rc-b79", "rt-b79-api", "rt-b79-db", "rp-b17-api"],
    radius: ["apps/api/src/estimates/estimates.controller.ts", "apps/api/src/main.ts", "apps/api/prisma/schema/finance.prisma", "apps/api/src/estimates/estimates.service.spec.ts"],
    brief: `estimates.service.ts create() only (~:141-158; locate by text — earlier hunks moved lines). Before the data literal:
let issueDate: Date | undefined;
if (dto.issueDate != null) {
  if (typeof dto.issueDate !== "string" || !/^\\d{4}-\\d{2}-\\d{2}$/.test(dto.issueDate))
    throw new BadRequestException("issueDate must be YYYY-MM-DD");
  issueDate = new Date(dto.issueDate); // UTC midnight (L-047)
  if (Number.isNaN(issueDate.getTime()))
    throw new BadRequestException("issueDate must be YYYY-MM-DD");
}
and add issueDate to the data literal. No second alias; absent -> stays NULL. expiresAt parsing untouched. Read-path audit: if findAll/findOne/list use explicit select blocks (rc-b79 listed them), add issueDate: true to each — the DB-lane REG (T17) proves it, not inspection. Controller stays @Body() dto: any — no CreateEstimateDto class in F27 (forbidNonWhitelisted in main.ts would 400 every existing field). convertToInvoice() still mints Invoice.issueDate = conversion date; a backdated estimate does NOT backdate its invoice (deliberate). Touch nothing else.`,
  },
  {
    id: "rp-b79-api",
    title: "Revert-probe B79 server: HEAD estimates.service.ts must turn the persist REG red",
    type: "revert-probe",
    file: "apps/api/src/estimates/estimates.service.ts",
    test: "REG-B79 create() persists issueDate",
    files: ["apps/api/src/estimates/estimates.service.ts"],
    tests: ["apps/api/src/estimates/estimates.service.spec.ts"],
    risk: "HIGH",
    dependsOn: ["fix-b79-api"],
    brief: `Restore HEAD content (git show 2d353752:apps/api/src/estimates/estimates.service.ts > that path), run ONLY the named test — red on the wrong value (create data lacks issueDate). Then git checkout -- the path and rerun: green. Red under no probe = harness defect.`,
  },

  // ───────── shared type + formatter (net-new; no wrong behaviour fixed here) ─────────
  {
    id: "feat-b79-types",
    title: "B79 shared type (issueDate) + UTC-fixed date-only formatter with PIN",
    type: "feature",
    files: ["packages/types/api/misc.ts", "apps/web/lib/format-date-only.ts"],
    tests: ["apps/web/lib/format-date-only.test.ts"],
    dependsOn: ["rc-b79"],
    radius: ["apps/mobile/lib/estimates-logic.ts", "apps/web/lib/api/estimates.ts"],
    brief: `Shared-type + helper work; no wrong behaviour is fixed here, so no REG. (1) packages/types/api/misc.ts, Estimate: add "issueDate?: string | null;" — optional, so no fixture/e2e/mobile literal breaks; nothing else changes. (2) New apps/web/lib/format-date-only.ts exporting formatDateOnly(value: string | Date | null | undefined): string — UTC-fixed, date-only: new Intl.DateTimeFormat(undefined, { timeZone: "UTC", year: "numeric", month: "short", day: "numeric" }).format(d); return "" for null/undefined/invalid dates. If rc-b79 found an existing UTC-fixed date-only helper in apps/web/lib (the one the invoice detail page uses for Invoice.issueDate), delegate to it from this file — never a second Intl block. (3) PIN-B79 T30 in apps/web/lib/format-date-only.test.ts: set process.env.TZ = "America/New_York" at the very top of the file BEFORE any import (Node >= 13 honours a runtime TZ change; CI is Node 20); formatDateOnly("2026-09-01T00:00:00.000Z") and formatDateOnly("2026-09-01") both render "Sep 1, 2026" — never Aug 31; null -> "". Run npm run check-types for packages/types and apps/web.`,
  },

  // ───────── web chain: B17(toast) → B15(+NAV) → B79(web) ─────────
  {
    id: "rt-b17-web",
    title: "REG-B17 web test: send toast/label no longer claim delivery",
    type: "repro-test",
    files: [],
    tests: ["apps/web/app/(dashboard)/estimates/[id]/page.test.tsx"],
    dependsOn: ["rc-b17"],
    radius: ["apps/web/app/(dashboard)/estimates/[id]/page.tsx", "apps/web/lib/api/estimates.ts"],
    brief: `Create apps/web/app/(dashboard)/estimates/[id]/page.test.tsx (Jest + RTL, npm test -w apps/web; copy the QueryClient/router/toast wiring from an existing dashboard page test; mock the @/lib/api/estimates hooks and the toast hook at the module boundary and assert the toast mock's calls). Detail: bug-test-plan.md T14. REG-B17 T14, exact title "REG-B17 send toast does not claim delivery": render with a DRAFT estimate whose estimateNumber is "EST-0001", click the send control, resolve the mocked send mutation, then assert the toast was called with title "Estimate marked as sent" and description "EST-0001 is marked Sent. No email was sent." and that no argument of any toast call matches /sent to the customer|has been sent|email(ed)? to/i — red today on HEAD's delivery-claim strings (quote them, from rc-b17, in the assertion message). Also assert the send button's accessible name is "Mark as sent" (red today: "Send"); query it in a way that resolves both before and after the rename. rt-b15 appends to this file later — expose a render helper taking { status } and reuse the mocks.`,
  },
  {
    id: "fix-b17-web",
    title: "B17 web fix: honest send toast + 'Mark as sent' label",
    type: "fix",
    files: ["apps/web/app/(dashboard)/estimates/[id]/page.tsx"],
    tests: [],
    dependsOn: ["rc-b17", "rt-b17-web"],
    radius: ["apps/web/lib/api/estimates.ts", "apps/mobile/lib/estimates-logic.ts"],
    brief: `apps/web/app/(dashboard)/estimates/[id]/page.tsx, two text edits only; locate by quoted text (anchors ~:121-122 and ~:244 are hints). (1) handleSend onSuccess toast: title "Estimate marked as sent", description template "\${estimate.estimateNumber} is marked Sent. No email was sent.". (2) The Send button label -> "Mark as sent". Why: POST /estimates/:id/send is status-only (send() writes status: "SENT", house-correct); the toast/label lied about delivery. Prettier (printWidth 100) will rewrap the toast — fine. Nothing else in this file: the Convert controls, canConvert, onError and the convert onSuccess belong to fix-b15; the date readers to fix-b79-web. Mobile: if rc-b17 found the operator estimate screen carries the same delivery claim, mirror this wording there (web is golden) and include that file in your diff — no other F27 task touches apps/mobile; otherwise leave mobile untouched.`,
  },
  {
    id: "rp-b17-web",
    title: "Revert-probe B17 web: HEAD [id]/page.tsx must turn the toast REG red",
    type: "revert-probe",
    file: "apps/web/app/(dashboard)/estimates/[id]/page.tsx",
    test: "REG-B17 send toast does not claim delivery",
    files: ["apps/web/app/(dashboard)/estimates/[id]/page.tsx"],
    tests: ["apps/web/app/(dashboard)/estimates/[id]/page.test.tsx"],
    dependsOn: ["fix-b17-web"],
    brief: `Restore HEAD content (git show "2d353752:apps/web/app/(dashboard)/estimates/[id]/page.tsx" > that path), run ONLY the named test — red on HEAD's delivery-claim strings. Then git checkout -- the path and rerun: green. Red under no probe = harness defect.`,
  },
  {
    id: "rt-b15",
    title: "REG/PIN-B15 + REG-B15-NAV web tests in [id]/page.test.tsx",
    type: "repro-test",
    files: [],
    tests: ["apps/web/app/(dashboard)/estimates/[id]/page.test.tsx"],
    dependsOn: ["rc-b15", "rp-b17-web"],
    radius: ["apps/web/app/(dashboard)/estimates/[id]/page.tsx", "apps/web/lib/api/estimates.ts"],
    brief: `Append to [id]/page.test.tsx (reuse rt-b17-web's render helper/mocks). Detail: bug-test-plan.md T20-T23, T34. REG-B15 T20, exact title "REG-B15 convert control is absent on DRAFT": status "DRAFT" -> queryAllByRole("button", { name: /convert to invoice/i }).length === 0 — red today (2). REG-B15 T21: same for "SENT" — red today. REG-B15 T22 "convert failure toast surfaces the server reason": status "ACCEPTED", click Convert, mocked convert mutation rejects with { response: { data: { message: "Estimate must be ACCEPTED" } } } (second case: message as ["Estimate must be ACCEPTED", "x"]) -> a toast call's description contains the server message and is not "Please try again." — red today. REG-B15-NAV T23 "successful convert navigates to the returned invoice": mocked convert resolves { id: "inv_1" } — the server's real shape, NO invoiceId key — -> the router mock was called with "/invoices/inv_1" — red today ("/invoices/undefined"). PIN-B15 T34 "ACCEPTED renders exactly 2 convert controls" (header + sidebar) — green today and after. Titles prefixed REG-B15 / REG-B15-NAV / PIN-B15; keep the literal token B15-NAV (its registry id is minted by docs-closeout, never guessed).`,
  },
  {
    id: "fix-b15",
    title: "B15 + B15-NAV fix: single canConvert predicate, server-reason toast, navigate on .id",
    type: "fix",
    files: ["apps/web/app/(dashboard)/estimates/[id]/page.tsx", "apps/web/lib/api/estimates.ts"],
    tests: [],
    dependsOn: ["rc-b15", "rt-b15", "rp-b17-web"],
    radius: ["apps/api/src/estimates/estimates.controller.ts", "apps/api/src/estimates/estimates.service.spec.ts", "apps/web/app/providers.tsx", "apps/mobile/lib/estimates-logic.ts"],
    brief: `Anchor by text (fix-b17-web already moved lines). [id]/page.tsx: (1) const canConvert = status === "ACCEPTED"; — the single render predicate. (2) Delete the Convert <Button> from the DRAFT block and from the SENT block; keep Send/Accept/Decline there. (3) Hoist the Convert button out of the ACCEPTED block to a sibling of the status blocks: {canConvert && <Button ...>Convert to invoice</Button>}; delete the ACCEPTED block if it is then empty. (4) Verify the sidebar control (~:458-470) reads canConvert; if it reads anything else, gate it on canConvert. Zero other Convert predicate literals remain (rg the file for "ACCEPTED" and "Convert"). (5) handleConvert onError: (err) => description = the server message — err?.response?.data?.message, joined with ", " when it is an array (use the existing web API-error helper if rc-b15 found one in apps/web/lib, else inline); fallback "Please try again." ONLY when no message is present. (6) B15-NAV, apps/web/lib/api/estimates.ts: the useConvertEstimateToInvoice result type becomes { id: string } (or the shared Invoice type); [id]/page.tsx handleConvert onSuccess navigates on data.id. Do not touch the send toast/label (fix-b17-web) or the date readers (fix-b79-web). If rc-b15 reported an interceptor that remaps the convert response, STOP and report — the REG-B15-NAV contract must be rewritten before this lands.`,
  },
  {
    id: "rp-b15",
    title: "Revert-probe B15: HEAD [id]/page.tsx must turn the DRAFT-control REG red",
    type: "revert-probe",
    file: "apps/web/app/(dashboard)/estimates/[id]/page.tsx",
    test: "REG-B15 convert control is absent on DRAFT",
    files: ["apps/web/app/(dashboard)/estimates/[id]/page.tsx"],
    tests: ["apps/web/app/(dashboard)/estimates/[id]/page.test.tsx"],
    dependsOn: ["fix-b15"],
    brief: `Restore HEAD content (git show "2d353752:apps/web/app/(dashboard)/estimates/[id]/page.tsx" > that path), run ONLY the named test — red on the wrong value (2 Convert controls on DRAFT). Then git checkout -- the path and rerun: green. Red under no probe = harness defect.`,
  },
  {
    id: "rt-b79-web",
    title: "REG/PIN-B79 web tests: submit carries issueDate; readers fall back to createdAt",
    type: "repro-test",
    files: [],
    tests: ["apps/web/app/(dashboard)/estimates/page.test.tsx"],
    dependsOn: ["rc-b79"],
    radius: ["apps/web/app/(dashboard)/estimates/page.tsx", "apps/web/lib/api/estimates.ts"],
    brief: `Create apps/web/app/(dashboard)/estimates/page.test.tsx (Jest + RTL; mock the @/lib/api/estimates hooks and the list query at the module boundary, as the existing dashboard page tests do). Detail: bug-test-plan.md T19, T33. REG-B79 T19, exact title "REG-B79 web submit carries issueDate": open the create form, fill the required fields plus the issue-date input with "2026-09-01", submit, assert the mocked create mutation was called with a dto objectContaining({ issueDate: "2026-09-01" }) — red today (the dto literal omits it). PIN-B79 T33 "readers fall back to createdAt when issueDate is null": render the list with one estimate { issueDate: null, createdAt: "2026-08-15T12:00:00.000Z" } -> its row shows "Aug 15, 2026", and one { issueDate: "2026-09-01T12:00:00.000Z" } -> "Sep 1, 2026" — green today (via the (as any) read) and after. Use NOON UTC timestamps so this PIN is timezone-neutral; the UTC-fixed display itself is pinned by T30 in format-date-only.test.ts, not here.`,
  },
  {
    id: "fix-b79-web",
    title: "B79 web fix: dto carries issueDate, cast removed, readers use formatDateOnly",
    type: "fix",
    files: ["apps/web/app/(dashboard)/estimates/page.tsx", "apps/web/app/(dashboard)/estimates/[id]/page.tsx", "apps/web/lib/api/estimates.ts"],
    tests: [],
    dependsOn: ["rc-b79", "rt-b79-web", "feat-b79-types", "rp-b15"],
    radius: ["packages/types/api/misc.ts", "apps/web/lib/format-date-only.ts", "apps/mobile/lib/estimates-logic.ts"],
    brief: `Anchor by text. (1) apps/web/lib/api/estimates.ts CreateEstimateDto: add issueDate?: string; ("YYYY-MM-DD") AND every other field the create form's dto literal (estimates/page.tsx ~:343-356) already sends that the type lacks (rc-b79 listed them); then remove the "dto as any" cast (~:358) unconditionally. If a field cannot be typed by adding it to the DTO (a genuine shape mismatch), STOP and report — never silently keep the cast. (2) estimates/page.tsx dto literal: add issueDate (the "YYYY-MM-DD" string already in state ~:149). (3) Readers — estimates/page.tsx ~:921, [id]/page.tsx ~:358 and ~:501: formatDateOnly(est.issueDate ?? est.createdAt) imported from @/lib/format-date-only; drop the (est as any) cast (the shared Estimate type now carries issueDate). Keep the createdAt fallback. (4) Nothing else in [id]/page.tsx — controls/toast/onError/onSuccess belong to earlier tasks. Gate: npm run check-types -w apps/web green with the cast gone; the api-side format check (YYYY-MM-DD -> 400) already landed, so the form must send the date-only string, never an ISO timestamp.`,
  },
  {
    id: "rp-b79-web",
    title: "Revert-probe B79 web: HEAD estimates/page.tsx must turn the submit REG red",
    type: "revert-probe",
    file: "apps/web/app/(dashboard)/estimates/page.tsx",
    test: "REG-B79 web submit carries issueDate",
    files: ["apps/web/app/(dashboard)/estimates/page.tsx"],
    tests: ["apps/web/app/(dashboard)/estimates/page.test.tsx"],
    dependsOn: ["fix-b79-web"],
    brief: `Restore HEAD content (git show "2d353752:apps/web/app/(dashboard)/estimates/page.tsx" > that path), run ONLY the named test — red on the wrong value (dto without issueDate). Then git checkout -- the path and rerun: green. Red under no probe = harness defect.`,
  },

  // ───────── gates + bookkeeping ─────────
  {
    id: "verify-web",
    title: "F27 compose gates, e2e sweep, DB lane, B15-NAV landing-URL confirmation",
    type: "ui-verify",
    files: ["apps/web/e2e/"],
    tests: [],
    dependsOn: ["rp-b79-api", "rp-b79-web"],
    radius: ["apps/web/e2e/LOCAL-LANE.md", "apps/api/src/estimates/estimates.issue-date.db.spec.ts"],
    brief: `Run against the compose stack built from this tree, gates in order, never piping a gate into "| tail": npx prisma generate (in apps/api) -> npm run verify -> npm run local:up -> npm run local:seed -> npm run local:validate -> npm run local:test:db (REG-B79 T17 in estimates.issue-date.db.spec.ts must be GREEN now — it was red before fix-b79-api) -> e2e sweep -> npm run local:e2e. E2E sweep: rg -n -i "convert to invoice|sent to the customer|has been sent|name: /send/" apps/web/e2e — edit ONLY the specs the grep hits: a spec that clicks Convert on a DRAFT/SENT estimate now needs an ACCEPTED one; the old send-toast assertion becomes "Estimate marked as sent"; a button named "Send" is now "Mark as sent". Then drive the UI (http://localhost:3001, tenant "test", operator admin / Admin@123; test tenant only): (a) DRAFT and SENT estimate detail show no Convert control; ACCEPTED shows exactly two; (b) Mark as sent toasts "Estimate marked as sent" with "No email was sent."; (c) B15-NAV: convert an ACCEPTED estimate and RECORD the landing URL — it must be /invoices/<uuid>, never /invoices/undefined; (d) create an estimate with issue date 2026-09-01 and confirm the list and the detail show Sep 1, 2026. Report each observation with the URL/text seen; any mismatch is a red, not a note.`,
  },
  {
    id: "docs-closeout",
    title: "F27 bookkeeping: registry (B16 stale, B15-NAV minted), lessons L-117..119, code map, owner findings",
    type: "docs",
    files: [".claude/code-map/api.md", ".claude/code-map/web.md", ".claude/code-map/packages.md", ".claude/code-map/_meta.json", ".claude/lessons/LESSONS.md", ".claude/lessons/LESSONS-DIGEST.md", ".claude/lessons/ARCHIVE.md", ".claude/lessons/_meta.json", ".claude/campaign/"],
    tests: [],
    dependsOn: ["verify-web"],
    brief: `Bookkeeping only, no source edits. (1) Registry — run bugs.mjs from the repo root (it resolves its data dir from cwd; BUGS_ROOT = the full .claude/campaign path): close B15, B17, B70, B79 as fixed with their REG titles; close B16 as STALE — removed in 60d10e66 (#621, L-072), guarded by enum-parity.spec.ts ~:222-237, no fix; mint the B15-NAV row with "bugs.mjs file" (never guess the number; alias B15-NAV, linked to B15; tests keep the REG-B15-NAV token); if rc-b70 reported customers.service.ts ~:1774 writes Estimate.status, file it as its own row (fifth mutator -> claimTransition). (2) Lessons — register at cap 40/40: first archive the three least-cited fully-guarded entries to ARCHIVE.md whole and verbatim (never merge/shorten; L-067 untouched), then add L-117 (B15: one render predicate equal to the server's claim predicate), L-118 (B70: adding a terminal-state guard means sweeping every writer of the column through one claim helper with a status predicate), L-119 (B17/B79: a migrated column with no write path is a bug the schema cannot show — audit write sites when a column lands); _meta.json nextId 120; node scripts/validate-lessons.mjs --digest. (3) Code map — surgical rows: estimates.service.ts (claimTransition, TERMINAL_ESTIMATE_STATUSES, create issueDate, convert link), [id]/page.tsx, estimates/page.tsx, lib/api/estimates.ts, format-date-only.ts, misc.ts Estimate; bump _meta.json; node scripts/validate-code-map.mjs. (4) Surface to the owner (not scheduled): F27-DR-B70 (laundered estimates may have minted a second invoice — read-only report first), F27-DR-B17 (CONVERTED rows have invoiceId NULL), the B70 contract changes (missing id -> 404; accept() refuses voided; void of voided -> 400), residuals: estimate send-email feature, PATCH estimate, unvalidated @Query("status"), unvalidated expiresAt sink.`,
  },
],

  verifyCommands: {
    perRound: [
      'npm run check-types -w apps/api',
      'npm run lint -w apps/api',
      'npm run check-types -w apps/web',
      'npm run lint -w apps/web',
    ],
    final: [
      'npm test -w apps/api -- src/estimates src/common/enum-parity.spec.ts src/common/no-bare-cron.spec.ts',
      'npm test -w apps/web -- app/(dashboard)/estimates lib',
      'npm run check-types -w apps/api',
      'npm run check-types -w apps/web',
      'npm run check-types -w apps/mobile',
    ],
  },
}
```

## Diff brief

Transcribed Fable's S5 task-graph ruling into build-plan.md (this file) verbatim for `tasks[]`/
`siblingPatterns`, adding only the standard top-level args fields (buildPlanPath, testPlanPath,
lessonsPath, startedAt, runDir, scale, mode, profile, workdir, context, baselineSha,
formatCommand, verifyCommands) and this human-readable summary/acceptance-criteria wrapper.
Graph validated programmatically before launch: every `fix` reaches a `root-cause` AND a
`repro-test` ancestor; every `revert-probe` depends on its own `fix`; every pair of tasks sharing
a file (estimates.service.ts, estimates.service.spec.ts, [id]/page.tsx, [id]/page.test.tsx,
lib/api/estimates.ts, estimates/page.tsx, estimates/page.test.tsx) has a dependsOn path between
them. No decisions re-made; nothing guessed.
