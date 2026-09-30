# Fix plan — round 1 (Fable ruling, 2026-09-12)

Input: `fix-brief.md` (36 root causes). Every finding is **fix** unless listed under Defer. No disputes.
Three executors, disjoint file ownership, run in parallel. Executors implement THESE designs; a design that
does not fit the code comes back as `designMismatch` with the reason — never improvised. No git commands.
Each executor: after editing, run its scoped commands (below), fix what they surface, and reply with a
≤ 1,500-char report: findings fixed (ids), tests added (names), commands run + results, any designMismatch.

## Shared contracts (all three groups conform; nobody changes these)

- `GoHighLevelPollService` public API: `pollTenant(tenantId: string, opts?: { ignoreCutoff?: boolean;
ignoreEnabledGate?: boolean; budgetMs?: number }): Promise<CrmSyncCounts>` ·
  `retryHandoff(tenantId: string, handoffId: string): Promise<{ status: string }>` ·
  `dismissHandoff(tenantId: string, handoffId: string): Promise<{ status: string }>` ·
  `previewImportExisting(tenantId: string): Promise<{ count: number; sample: Array<{opportunityName, contactName, email, phone}> }>` ·
  `importExisting(tenantId: string): Promise<CrmSyncCounts>` (= `pollTenant(tenantId, {ignoreCutoff:true, ignoreEnabledGate:true})`).
- `CrmConnectionService.listHandoffs(tenantId, {status?, page, limit})` returns the envelope
  `{ data: CrmHandoffRow[], total: number, page: number, limit: number }` (limit clamped to 100). The web reads `.data`.
- `crm.module.ts` keeps the existing `buildGhlClientForConnection(connection)` name and signature. It additionally
  provides the injectable token `GHL_CLIENT_FACTORY` with value `{ forConnection: buildGhlClientForConnection }`
  (type `GhlClientFactory`). Services that need a per-tenant client inject `GHL_CLIENT_FACTORY` and call
  `forConnection(connection)` after decrypting the token via `CrmConnectionService.decryptToken(connection)`
  (Group A exposes `decryptToken` as a public method if it is private today).
- Schema: `CrmConnection` gains `nextPollAt DateTime?` (Group B). No other schema change.
- Tenant scoping (L-100): every Prisma `where` on `crmHandoff`, `crmConnection`, `customer`, `user`,
  `importExternalRef` carries an explicit `tenantId` from the method argument — never inferred.
- Secret discipline: the only object that ever crosses a controller boundary is the safe status shape
  (`toStatusView(row)`), which has no `secretCipher` key.

## Group A — Opus @ high · owns `apps/api/src/crm/crm.controller.ts`, `crm-connection.service.ts`,

`crm.module.ts`, `crm.types.ts`, `dto/*.ts`, `crm.controller.spec.ts`

- **F1** add the five handlers (`POST sync`, `POST handoffs/:id/retry`, `POST handoffs/:id/dismiss`,
  `POST import-existing/preview`, `POST import-existing`), each `@UseGuards(AddonGuard) @RequireAddon("crm_gohighlevel")`,
  reading `tenantId` from `@CurrentUser()` and delegating to the poll service per the shared contract.
- **F6** replace every `@RequireAddon(CRM_ADDON_KEY)` with the literal `@RequireAddon("crm_gohighlevel")` (12 sites);
  delete the const if unused. Then run `npx jest addon-gate-registry` in `apps/api` — must be green.
- **F2** `crm.types.ts`: add `export type { GhlContact, GhlOpportunity, GhlCustomField } from "./gohighlevel/gohighlevel.client";`.
- **F3** private `toStatusView(row)` (the shape `getStatus` already builds) and return it from `saveConnection`,
  `updateConfig`, `testConnection`, `disconnect`. Add spec: each of those resolves to an object whose keys do not
  include `secretCipher` and whose JSON never contains the raw token string.
- **F4** `listPipelines(tenantId)`: load the tenant's connection (`findUnique({where:{tenantId}})`), 404 when absent
  or no `secretCipher`, build the client via `GHL_CLIENT_FACTORY.forConnection`, map stages dropping entries
  without `id`/`name`. Spec: the client factory is called with the tenant's connection, not a singleton.
- **F9 + F11** replace update-then-catch and the first-save branch with one `prisma.crmConnection.upsert({ where:
{ tenantId }, create: {...defaults, ...patch, connectedById: userId}, update: {...patch, connectedById: userId} })`
  in both `saveConnection` and `updateConfig`; defaults per spec R4. Spec: `updateConfig` on a tenant with no row
  creates it (upsert called with `create` carrying `dryRun:true, triggerMode:"STAGE", defaultRegion:"US"`).
- **M2** `disconnect` also nulls `tokenLast4, locationName, lastError, attentionNotifiedAt, customFieldIds`.
- **M5** in `testConnection`'s auth-failure path set `NEEDS_ATTENTION` only when the prior status was `CONNECTED`;
  otherwise leave status unchanged and return `{ok:false, reason}`.
- **M12** `defaultRegion` written from `location.country` only when it matches `/^[A-Z]{2}$/`; else unchanged.
- **M13** `getStatus` counts via `crmHandoff.groupBy({ by: ["status"], where: { tenantId }, _count: { _all: true } })`.
- `listHandoffs` envelope per the shared contract; `listHandoffs` `where` includes `tenantId`.
- Default region: confirm the Prisma default and the R4 default are `"US"` (owner ruling 2026-09-12); fix if `"CA"`.
- Scoped commands: `cd apps/api && npx jest src/crm/crm.controller src/crm/crm-connection addon-gate-registry --maxWorkers=2`
  and `npm run check-types -w apps/api` (from the worktree root). Do not run the full suite.

## Group B — Opus @ high · owns `apps/api/src/crm/gohighlevel/gohighlevel-poll.service.ts`,

`gohighlevel-handoff.service.ts`, `gohighlevel-writeback.service.ts`, their three `*.spec.ts`,
`apps/api/prisma/schema/platform.prisma`, `apps/api/prisma/migrations/20260911120000_crm_lead_handoff/migration.sql`,
`apps/api/src/testing/prisma-mock.ts` (only if a new model method is needed)

- **Schema (M7)**: add `nextPollAt DateTime?` to `CrmConnection` in `platform.prisma`; regenerate the migration
  with the WP1 hard-line command from `build-plan.md` (diff from base `83af7853` to the schema folder; overwrite the
  same migration file, it is unmerged), then `npx prisma generate` in `apps/api`.
- **F5** `retryHandoff(tenantId, id)`: load the row with `findFirst({ where: { id, tenantId } })` (404 when absent),
  load the connection by `tenantId`, then proceed. Never mutate the row before the connection is resolved.
- **F8** `retryHandoff`/`dismissHandoff` take `tenantId` first; every read/update scoped by `{ id, tenantId }`;
  wrong-tenant id → `NotFoundException`. Spec: a row belonging to tenant B is not found when called with tenant A.
- **F7** `matchExistingCustomer(tenantId, contact, region)`: `tenantId` in all four lookups (`importExternalRef`
  via `ExternalRefService` — pass tenantId if its API allows, else add a `where.tenantId` read; `customer.findFirst`
  email; `customer.findMany` phone candidates; `customer.findFirst` name) and in `resolveUsername`'s `user.findFirst`.
  Spec: every `findFirst`/`findMany` mock is called with `where.tenantId === "t1"`.
- **M6** phone match per the ruling: candidates `customer.findMany({ where: { tenantId, deletedAt: null, OR: [{ phone:
{ not: null } }, { mobile: { not: null } }] }, select: { id: true, phone: true, mobile: true }, take: 5000 })`,
  then in-memory `normalizePhoneE164(row.phone ?? row.mobile, region) === e164`. Spec: stored `"(555) 123-4567"`
  matches contact `"+15551234567"` with region `"US"`.
- **F10 + M3** `updateHandoff` returns the row; `runWriteback` receives the real `handoff.id`, `attempts`,
  `noteWritten` from that row; `writeBack()` persists `noteWritten: true` after a successful note and, on success,
  `status` back to the pre-writeback terminal status (`CREATED`/`LINKED`). Spec: a failing `addTags` on a fresh
  handoff yields `update({ where: { id: "h1" }, data: expect.objectContaining({ status: "WRITEBACK_PENDING", attempts: 1 }) })`;
  a successful note yields `noteWritten: true`.
- **M4** at the top of `handle()`: if the row already has `customerId` and status `WRITEBACK_PENDING`, skip match/
  create/tags/notify and go straight to `runWriteback`. Spec: no `emitCrmHandoff` on a write-back retry.
- **F12 + F13** `pollTenant` requires `secretCipher` always and `enabled` only when `!opts.ignoreEnabledGate`;
  `previewImportExisting` returns `{count:0, sample:[]}` when the connection is absent or has no `secretCipher`.
- **M1** `processOpportunity` returns `handle()`'s `{status}`; `pollTenant` increments `created/linked/needsReview/
dryRun/failed` from it.
- **M7** on `CrmRateLimitError` set `nextPollAt = now + (retryAfterSec ?? 60) s` and `lastError`; `pollAll` selects
  connections with `OR: [{ nextPollAt: null }, { nextPollAt: { lte: now } }]`; `pollTenant` returns zero counts with
  `skipped: "cooldown"` when `nextPollAt` is in the future (manual sync included).
- **M8** the dry-run writer stores `payload.opportunity` (id, name, monetaryValue, source, contactId, pipelineStageId,
  status, lastStageChangeAt, lastStatusChangeAt); `retryHandoff` uses it; when absent, re-fetch via
  `client.getOpportunity(id)` (add to the client only if it does not exist — it is NOT in Group B's files: if the
  client lacks it, use `searchOpportunities({ id })` semantics only if supported, else mark designMismatch and fall
  back to the stored payload).
- **M11** wrap the per-opportunity call in `pollTenant` in try/catch: log at warn with opportunity id, count as
  `failed`, continue.
- **M17** `ensureTags` receives a per-tick tag cache (`Map<string,string>` name → id) created in `pollTenant` and
  passed through `handle(connection, opportunity, { tagCache })`; `listTags` is called at most once per tick.
- **M9/M10** fix the two spec defects exactly as the brief says.
- **m1** budget message: `"Stopped after 120 s; will continue on the next check"`. **m2** `previewImportExisting`
  gets the same `budgetMs` guard and batches the existing-row lookup per page (`findMany({ where: { tenantId,
opportunityId: { in: ids } }, select: { opportunityId: true } })`).
- Scoped commands: `cd apps/api && npx jest src/crm/gohighlevel --maxWorkers=2`, `npm run check-types -w apps/api`,
  `cd apps/api && node scripts/split-prisma-schema.mjs --check`, `npm run lint:migrations` (root). Do not run the full suite.

## Group C — Sonnet @ medium · owns `apps/web/lib/api/crm.ts`,

`apps/web/app/(dashboard)/settings/_components/GoHighLevelSettingsTab.tsx`,
`apps/web/app/(dashboard)/settings/settings-gohighlevel.test.tsx`

- **M14** build ux-spec Card 2: radio (`STAGE` default / `WON`), Pipeline Select → Stage Select fed by
  `useCrmPipelines` (enabled only when connected), "Start from" date input; all saved through the existing
  `onUpdateConfig` path with `{ triggerMode, pipelineId, stageId, stageName, startFrom }`. The Enabled switch is
  disabled only while `triggerMode === "STAGE" && !stageId`.
- **M15 / m5** wire "Save & test" to save then `useTestCrmConnection().mutate()`; wire "Preview existing leads" to
  `usePreviewCrmImport` and "Import these" to `useImportExistingCrmLeads`; add `useRetryHandoff(id)` /
  `useDismissHandoff(id)` hooks (`POST /crm/gohighlevel/handoffs/:id/retry|dismiss`) and pass `onRetry`/`onDismiss`
  from the container; every mutation invalidates `["crm","gohighlevel"]`.
- **M16** the handoffs query reads `res.data.data` (API envelope `{data, total, page, limit}`); "Load more" uses
  `page`.
- **m3** add the "When" column (relative time from `createdAt`). **m4** thread `isLoading`/`isError` into the
  table: skeleton rows while loading, inline error with retry, the empty-state text only when loaded and empty.
- **m6** the Needs-attention banner gets a "Test again" button calling the test mutation.
- Add to `settings-gohighlevel.test.tsx`: stage picker renders the pipelines' stages and saving sends
  `{ triggerMode: "STAGE", pipelineId: "p1", stageId: "s1" }`; the Activity table renders rows from `{ data: [...] }`;
  "Preview existing leads" calls the preview endpoint. Copy stays verbatim per ux-spec.
- Scoped commands: `cd apps/web && npx jest settings-gohighlevel useNotifications.crm`, `npm run check-types -w apps/web`,
  `npm run lint -w apps/web`. Do not run the full suite.

## Defer (owner questions, not fixed this round)

None.

## After the round (Fable runs these, not the executors)

Scoped re-gate on all three groups → Opus refute-first review of the full diff → six manual mutation probes →
ask the landing lead for the host slot → full gates → rebase onto master → format → commit.

# Fix plan — round 2 (Fable ruling, 2026-09-12; input: Opus refute-first review, 1 blocker / 5 major / 4 minor)

All fix. Two executors, disjoint files, parallel. Each adds a spec with a concrete oracle per fix, runs its scoped
commands, formats its files, reports ≤ 1,200 chars. No git commands.

## Group D — Opus @ high · owns `gohighlevel-handoff.service.ts`, `gohighlevel-writeback.service.ts`,

`crm-connection.service.ts` and their specs

- **#1 blocker** `gohighlevel-handoff.service.ts` ref lookup: the `importExternalRef.findFirst` where-clause must use
  `externalSource: "gohighlevel"` (the model field), never `source`. Spec: assert the call's `where` deep-includes
  `{ tenantId: "t1", entityType: "CUSTOMER", externalSource: "gohighlevel", externalId: "<contactId>" }` and has no
  `source` key.
- **#3 major** `ensureTags`: wrap `createTag` in try/catch; on any error re-read `listTags()` and reuse the id of the
  tag with that exact name; only if still absent rethrow. Spec: `createTag` rejecting once with a conflict error →
  `listTags` called a second time and the found id assigned; no throw.
- **#2 major** `gohighlevel-writeback.service.ts`: persist `noteWritten: true` immediately after a successful
  `createNote` (its own `crmHandoff.update`), so a later step failing cannot lose it. Spec: note OK then
  `updateOpportunityStatus` rejecting → the row update sequence contains `noteWritten: true` before the
  `WRITEBACK_PENDING` update; a retry does not call `createNote` again.
- **#10 minor** filter custom-field entries without an `id` out of the PUT body; if none remain, skip the PUT.
  Spec: `customFieldIds` missing one key → PUT body has exactly two entries.
- **#7 minor** `listHandoffs` uses an explicit `select` = the R22 field list (`id, opportunityId, opportunityName,
contactId, contactName, status, matchedBy, reason, customerId, attempts, createdAt, processedAt`) — no `payload`.
  Spec: `findMany` called with a `select` that has no `payload` key.
- Scoped: `cd apps/api && npx jest src/crm --maxWorkers=2`, `npm run check-types -w apps/api`.

## Group E — Sonnet @ medium · owns `GoHighLevelSettingsTab.tsx`, `settings-gohighlevel.test.tsx`,

`apps/api/scripts/crm-gohighlevel-check.mjs`, `docs/runbooks/gohighlevel-client-setup.md`

- **#4 major** Save & test flow: branch on the test result — `res.ok === false` or `res.connection?.status !==
"CONNECTED"` → no success toast; render the inline error with `res.reason` ("GoHighLevel rejected this key. Create a
  new one and paste it here." on the rejected-token reason) and keep the card in edit mode. Test: mocked test
  response `{ok:false, reason:"GoHighLevel rejected the token"}` → the inline error text is in the document and no
  "Connected to" toast.
- **#5 major** on a successful Save & test: clear `tokenInput` and `locationInput`, set `editingConnection=false`;
  also re-derive `editingConnection` when `status` changes (effect). Test: after success the summary line with
  "key ending in" renders and no input holds the pasted key value.
- **#6 minor** check script reads `handoffs.body?.data` (array) — fix the loop condition. **#9 minor** delete the
  stale "no sync route" note and call `POST /crm/gohighlevel/sync` after connecting instead of waiting for a tick.
- **#8 minor** runbook scope list = Contacts (read + write), Opportunities (read; write only if "Mark the lead as
  Won" is used), Custom fields (read + write), Location (read) — identical wording to the in-app help.
- Scoped: `cd apps/web && npx jest settings-gohighlevel`, `npm run check-types -w apps/web`, `npm run lint -w apps/web`,
  `node --check apps/api/scripts/crm-gohighlevel-check.mjs`.
