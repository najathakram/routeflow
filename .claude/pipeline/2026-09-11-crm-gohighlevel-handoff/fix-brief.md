# Fix brief — CRM (GoHighLevel) lead-handoff, wf_79dfe9f9-496

Engine crashed after Gate & Review (63 findings: 24 blocker/28 major/14 minor). Verify
(06-verify.json) confirmed all 63 (0 refuted). Deduped below to 36 root causes.

## A. Tree state now

- `apps/api` jest `src/crm`: 6 suites / 60 tests — ALL PASS (1 benign WARN log, not a failure).
- `apps/web` jest `settings-gohighlevel|useNotifications.crm`: 2 suites / 5 tests — ALL PASS
  (1 pre-existing `act()` console warning at `useNotifications.crm.test.ts:38`, not a failure).
- `check-types -w apps/api`: PASS, 0 errors. `check-types -w apps/web`: PASS, 0 errors.
- Green because tests only cover the 7 routes that exist; the 63 findings sit outside current
  coverage. Exception: `addon-gate-registry.spec.ts` (not in the `src/crm` run) fails today per
  F6 — run `npx jest addon-gate-registry -w apps/api` after fixing F6.
- `git status --short` (excl. `.claude/*`): CRM files staged `A` except `RESUME.md` (`AM`) and
  code-map/lessons bookkeeping (`M`). `git diff --stat`: only `RESUME.md` (+1 line) — no
  uncommitted-vs-staged drift.

## B. Confirmed findings, deduped, grouped by file

Format: `F#` severity · `path:line` · claim · scenario · R#/T# · fix.

### Blockers

**F1** blocker `crm.controller.ts` L49-96 · Controller has 7/12 routes; sync, retry, dismiss,
import-existing preview+full have no HTTP surface · operator clicks Check now/Retry/Import →
404 · R8,R22,R23 · add 5 handlers delegating to existing (unwired) `GoHighLevelPollService`
methods, same `@UseGuards(AddonGuard)` pattern as the 7 existing routes.

**F2** blocker `crm.types.ts:7` · Only re-exports 3 Prisma enums; 2 specs import
`GhlContact/GhlOpportunity/GhlCustomField` from it → TS2305 · those spec suites won't compile ·
WP1 contract · add `export type {GhlContact, GhlOpportunity, GhlCustomField} from
"./gohighlevel/gohighlevel.client"`.

**F3** blocker (security) `crm-connection.service.ts:141-164,263-276` · `saveConnection`/
`updateConfig` return the raw Prisma row incl. `secretCipher` · response body leaks the
encrypted GHL token · R1 · strip to the safe shape `getStatus` already builds (L101-121);
extract as a shared private method.

**F4** blocker `crm-connection.service.ts:279-301` + `crm.module.ts:93-101` ·
`listPipelines(_tenantId)` ignores tenantId, uses the shared empty-creds
`GO_HIGH_LEVEL_CLIENT_PROVIDER` singleton · `GET /pipelines` 401/500s for every tenant, always ·
R3 · build a per-tenant client like `buildGhlClientForConnection` in `crm.module.ts`, inject
that factory into the service.

**F5** blocker `gohighlevel-poll.service.ts:263-285` (`retryHandoff`) · Reads
`handoff.connectionId`, a column that doesn't exist on `CrmHandoff` (confirmed against
`prisma/schema/platform.prisma:755-776`) → always null connection · TypeError on
`connection.region`, AFTER the row was already mutated to WRITEBACK_PENDING/PENDING · R22 ·
look up the connection by `tenantId` instead.

**F6** blocker `crm.controller.ts` (all `@RequireAddon(CRM_ADDON_KEY)` sites, const at L26) +
`addon-gate-registry.spec.ts:16-17` · Registry's regex only matches quoted literals;
`CRM_ADDON_KEY` is a const → 0 sites → P1b red · `npm run verify` fails on merge · replace with
`@RequireAddon("crm_gohighlevel")` at all 7 (12 after F1) sites — scanner is by-design
literal-only, fix the caller.

**F7** blocker (IDOR) `gohighlevel-handoff.service.ts:91-126` (`matchExistingCustomer`) ·
Queries `importExternalRef`/`customer`/`user` (`resolveUsername` L144-155), zero tenant
predicate · a lead's email/phone/name match links to another tenant's customer · R15,
tenant-scoping rule · add `tenantId` to all 4 `findFirst` calls, thread into the signature
(currently `contact, region` only).

**F8** blocker (IDOR) `gohighlevel-poll.service.ts:263-298` (`retryHandoff`, `dismissHandoff`) ·
Both take only `id`, unscoped `findUnique`/`update` · once F1 wires these to routes, any
operator can retry/dismiss another tenant's handoff by UUID · tenant-scoping rule · add
`tenantId` param, use `findFirst({where:{id,tenantId}})` + tenant-checked update. **Ship only
with F1's routes.**

**F9** blocker `crm-connection.service.ts:225-276` (`updateConfig`) · `isFirstSave` branch
computes defaults but always calls `update` (no `create` path) → Prisma P2025 · first config
change on a brand-new tenant → unhandled 500 · R4 · mirror `saveConnection`'s
update-then-catch-P2025-then-create (L139-154), ideally via F3's shared upsert helper.

**F10** blocker `gohighlevel-handoff.service.ts:293-300,387-394` (`runWriteback` call sites) +
`gohighlevel-writeback.service.ts:129-149` (catch) · On the normal poll path `opts.handoffId` is
undefined → `writeBack()` catch does `update({where:{id:undefined}})`, rejected, swallowed by
`runWriteback`'s own try/catch · a failed write-back on a brand-new handoff silently stays
CREATED/LINKED forever, R20 backoff never starts · R20 · `updateHandoff` (L157-173) should
return the row so `runWriteback` gets its real id, or requery by composite key first.

**F11** blocker `crm-connection.service.ts:139-154` (`saveConnection`) · update→catch-P2025→
create races under concurrent saves; only `create` sets `connectedById` (L149), `update`
(L132-137) never does · a second save on an existing row can lose `connectedById` · WP2 · use a
real Prisma `upsert` with `connectedById` in both branches (needsDesign if Prisma 7 lacks
upsert here).

**F12** blocker `gohighlevel-poll.service.ts:337-339` (`importExisting`) · Delegates to
`pollTenant({ignoreCutoff:true})`, which requires `connection.enabled` (L222) · "Import
existing" is the action taken BEFORE enabling ongoing sync → always 0 results · R23 · require
only `secretCipher`, not `enabled` — add an `ignoreEnabledGate` option to `pollTenant`.

**F13** blocker `gohighlevel-poll.service.ts:301-334` (`previewImportExisting`) · Skips the
`secretCipher` guard `pollTenant` applies (only checks `!connection`, L303) · builds a client
with an empty token → throws `CrmAuthError` uncaught → 500 once F1 wires the route · R23 · add
the same guard as `pollTenant:222`, return `{count:0,sample:[]}` when absent.

### Majors

**M1** major `gohighlevel-poll.service.ts:170-213` (`processOpportunity`) · Discards
`handle()`'s return value (L191,212); `created/linked/needsReview/dryRun/failed` counts never
increment · "Check now" toast always all-zero except fetched/new · R8 · capture `handle()`'s
`{status}`, bump the matching counter.

**M2** major `crm-connection.service.ts:208-222` (`disconnect`) · Clears only
`secretCipher/status/enabled`, leaves `tokenLast4/locationName/lastError/attentionNotifiedAt/
customFieldIds` · UI still shows a stale key/location after Disconnect · R5 · null all 5 extra
fields.

**M3** major `gohighlevel-handoff.service.ts:175-201` (`runWriteback`) +
`gohighlevel-writeback.service.ts` (no success-path write) · Hardcodes `attempts:0,
noteWritten:false` every call; `writeBack()` never persists `noteWritten:true` on success ·
every retry re-posts the GHL note · R19(4),R20 · add a success-path
`crmHandoff.update({data:{noteWritten:true}})`; pass real values into `runWriteback` (needs
F10's requery plumbing).

**M4** major `gohighlevel-handoff.service.ts:265-301` (`handle`, match branch) · Re-invoking
`handle()` for a WRITEBACK_PENDING row (via retry) redoes the FULL forward path, not just
write-back · fires a second "customer linked" notification · R20 · needsDesign: short-circuit
to `runWriteback` directly when the row is already CREATED/LINKED.

**M5** major `crm-connection.service.ts:196-201` (`testConnection` catch) · Retesting a
deliberately DISCONNECTED connection flips it to NEEDS_ATTENTION · tells operator "lost access"
when nothing was connected · only set NEEDS_ATTENTION when prior status was CONNECTED.

**M6** major `gohighlevel-handoff.service.ts:107-114` (phone match) · Compares E.164-normalized
GHL phone against raw, unnormalized `customer.phone/mobile` columns · `(555) 123-4567` never
matches `+15551234567` · R15(c) · needsDesign: normalize on read or add a normalized column.

**M7** major `gohighlevel-poll.service.ts:118-124` (429 branch) · Records `lastError`, sets no
cooldown · next cron tick immediately re-hits the rate-limited tenant · R13 · persist a
`nextPollAt` from `retryAfterSec`; skip tenants not yet due.

**M8** major `gohighlevel-poll.service.ts:276-284` (`retryHandoff` fallback) · Falls back to a
synthetic opportunity when `payload.opportunity` is absent; dry-run writer never stores that key
· retried DRY_RUN rows lose deal name/value/source · downstream of R14 · persist
`payload.opportunity` in the dry-run writer, or re-fetch by id on retry.

**M9** major (test-quality) `gohighlevel-handoff.service.spec.ts:286` · `new
CrmHttpError("GoHighLevel 404")` passes 1 arg; real ctor is `(status,code,message)` — test then
monkey-patches `.status/.code` after · diverges from production contract · T51 · `new
CrmHttpError(404,"http","GoHighLevel 404")`, drop the manual assignments.

**M10** major (test-quality) `gohighlevel-handoff.service.spec.ts:230,265` ·
`ghlClient.listTags` mocked as plain strings; real `listTags()` returns `GhlTag[]` objects ·
test never exercises `ensureTags`'s object-shape branch · T31/T31b · mock with `{id,name}`.

**M11** major `gohighlevel-poll.service.ts:229-247` (`pollTenant` loop) · Only
`searchOpportunities` is try/caught (L236-241), `processOpportunity` (L246) is not · one bad
opportunity aborts the rest of the tenant's tick · R8 spirit · wrap L246 in try/catch,
log+continue.

**M12** major `crm-connection.service.ts:183-192` (`testConnection` success) · Writes raw
`location.country` into `defaultRegion`, no ISO-3166 validation · a garbage string silently
breaks phone matching thereafter · validate before writing, drop on failure.

**M13** major `crm-connection.service.ts:75-87` (`getStatus`) · Loads every `CrmHandoff` row
just to compute 6 counts · unbounded query cost for long-lived tenants · use
`prisma.crmHandoff.groupBy({by:['status'],where:{tenantId},_count:true})`.

**M14** major (UX/spec) `GoHighLevelSettingsTab.tsx:294-380` (Card 2) · Missing ux-spec's
trigger-mode radio, pipeline/stage Selects, "Start from" date; Enabled switch disabled on
`!config.stageId` (L367), which nothing in this file ever sets · STAGE mode (the default) can
never be turned on from the UI · ux-spec Card 2 · needsDesign: build the missing controls, wire
via `onUpdateConfig` like the existing toggles.

**M15** major `GoHighLevelSettingsTab.tsx:252-258,503-506` + container `:515-608` · "Save &
test" never calls `testConnection` (`void`-discarded L526); Import button has no `onClick`;
`onRetry`/`onDismiss` (used L472/481) never passed by the container · 4 dead controls · ux-spec
· wire `testConnection.mutate()`, wire Import to `previewImport`/`importLeads` (also
`void`-discarded L527-528), pass `onRetry`/`onDismiss` once F1/F8 exist.

**M16** major `GoHighLevelSettingsTab.tsx:554-562` vs `crm-connection.service.ts:304-316` ·
Container reads `handoffs?.data`; API returns a bare array · Activity table permanently empty in
production · contract mismatch · check a sibling list endpoint's envelope convention, then wrap
in `{data:rows}` or read `handoffs ?? []` — whichever matches.

**M17** major (perf) `gohighlevel-handoff.service.ts:129-142` (`ensureTags`) · Calls
`listTags()` (full location tag list) on every `handle()` call (L266,367) · multiplies external
API calls against the R13 rate limit · cache the tag map per poll tick instead of refetching
per-opportunity.

### Minors

**m1** minor `gohighlevel-poll.service.ts:230-233` · Budget-exhaustion writes literal `"budget"`
into operator-visible `lastError` · confusing copy · use a human-readable message.

**m2** minor (perf) `gohighlevel-poll.service.ts:301-334` (`previewImportExisting`) · No
wall-clock budget (unlike `pollTenant`), 1 DB query per opportunity · N+1 + unbounded preview
time · add the same `budgetMs` guard; batch-fetch existing `opportunityId`s per page.

**m3** minor (UX) `GoHighLevelSettingsTab.tsx:429-434` · Activity table header missing the
"When" (relative time) column ux-spec requires · add a `<th>` + relative-time cell.

**m4** minor (UX) `GoHighLevelSettingsTab.tsx:420-423` · No loading/error state; failed/
in-flight query renders the same "No leads yet" text · thread `isLoading`/`isError` through
props, branch the empty-state message.

**m5** minor (UX) `GoHighLevelSettingsTab.tsx:504-506` · "Import existing leads" button wired to
nothing (ux-spec's own callout, distinct from M15's broader dead-controls finding) · see M15.

**m6** minor (UX) `GoHighLevelSettingsTab.tsx:208-212` · Needs-attention banner missing the
"Test again" button ux-spec requires · add a `Button` calling `onCheckNow`/`testConnection`.

## C. Unfinished spec surface

- [ ] `POST /crm/gohighlevel/sync` — `crm.controller.ts` → `pollTenant`
- [ ] `POST /crm/gohighlevel/handoffs/:id/retry` — same file → `retryHandoff` (needs F8)
- [ ] `POST /crm/gohighlevel/handoffs/:id/dismiss` — same file → `dismissHandoff` (needs F8)
- [ ] `POST /crm/gohighlevel/import-existing/preview` — → `previewImportExisting` (needs F13)
- [ ] `POST /crm/gohighlevel/import-existing` — → `importExisting` (needs F12)
- [ ] ux-spec Card 2 (trigger-mode radio, pipeline/stage Selects, Start-from date) — M14
- [ ] ux-spec Card 4 "When" column + loading/error states — m3, m4
- [ ] ux-spec Needs-attention "Test again" button — `GoHighLevelSettingsTab.tsx:208-212` (m6)
- [ ] Wire unused hooks `useTestCrmConnection`/`usePreviewCrmImport`/`useImportExistingCrmLeads`
      in `apps/web/lib/api/crm.ts`; add missing `useRetryHandoff`/`useDismissHandoff` (M15)

## D. Dispute candidates

None — every finding traced to real code at the cited line, matching verify's 0 refutations.
Keep two near-duplicate pairs separate during the fix round: F10 (write-back never starts) vs
M3 (hardcoded attempts/noteWritten once it runs) — same call, two bugs; F12 (`importExisting`
gated on `enabled`) vs F13 (`previewImportExisting` NOT gated on `secretCipher`) —
opposite-direction gate bugs, don't cross-copy the guards.
