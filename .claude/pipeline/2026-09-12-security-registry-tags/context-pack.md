# Context pack — bugs.mjs --tag, Plane label mapping, F49 audit backfill

## 1. bugs.mjs (7908 lines)

`cmds` dispatch table L261 (24 subcommands). Relevant: `.file` L315, `.list` L1022, `.stats`
L1041, `.expand` L1243, `.sync` L1466, `.show` L1586, `.note` L1596, `.discharge` L2408,
`["self-test"]` L2881–7238.

`flag(args,name,fallback)` L192: single-value only, next token after `--name`. **No repeated/array
flag precedent anywhere.** `--files "a.ts b.ts"` (file/enrich) = ONE flag, space-joined value,
split by `fileSet(id)` L7564 (`raw.split(" ").filter(Boolean)`) — copy this for `--tag "a b"`.

`cmds.file` L315: `location`/`severity`/`files` via `flag()`; id=max+1 over catalogue∪ledger
(L342-349); ledger row L384 `upsertLedgerRow(batch,{...,state:"queued",...},{mustBeNew:true})`
(locked `withShardLock`/`withCatalogueLock` L1952/1967; `dropLedgerRow` L2074 inverse); catalogue
push+write L406; `cmds.expand()`; if `--files`, `writeRecord(id,{...rec.front,files:filesFlag},
rec.body)` L446 — `--tag` slots in identically. `readCatalogue/writeCatalogue/readState`
(L151/159/166) are plain JSON parse/stringify per line, **zero schema/field validation** (no
`tags` hits anywhere — new field is safe).

`cmds.list` L1022: `--open`/`--sensitive`/`--batch`. `cmds.stats` L1041: counts bySeverity/
byState/sensitive. `cmds.show` L1586: dumps record. `cmds.note` L1596: `--section` →
`replaceSection` on `SECTIONS` (L1071, 6 fixed section names); else `appendHistory`.

Front matter: `frontFor(bug,st)` L1205 = fixed key set, excludes `files`. `cmds.sync` merge L1501
`{...rec.front,...frontFor(bug,st)}` preserves keys not in `frontFor`'s output, so a `tags` field
in `rec.front` (like `files`) survives every `sync` untouched — no `frontFor` edit needed unless
`sync` must derive it itself. `cmds.expand` L1243 seeds new records via `frontFor`.

`already-fixed`: **no bugs.mjs subcommand sets it** — its only occurrence (L6737) is a self-test
JSONL fixture for `campaign-check.mjs`'s row-id grammar. Enum in `campaign-check.mjs` L121-134:
`CLAIM_STATES`=proven/proven-pending-deploy/done/already-fixed/refuted/regressed;
`EVIDENCE_ONLY_STATES`=already-fixed/refuted/regressed (L129-133); `VALID_STATES`=CLAIM_STATES+
queued/in-flight; guard L194-197. Design `already-fixed <B###> --pr <n> --why "..."` mirroring
`cmds.discharge` L2408, `state:"already-fixed"`, non-empty `--why`→`evidence`.

Self-test L2881-7238: `check(name,got,want)` L2907 (JSON-equality, exits 1 on failure); blocks use
`mkdtempSync`+`BUGS_ROOT`/`BUGS_REGISTER` to drive real `cmds.*`/`runCli()` (L2836). Add a `--tag`
case the same way and assert it survives `cmds.sync()`.

## 2. plane-sync.mjs (1179 lines)

Reimplements readers rather than importing bugs.mjs (its `cmds` runs at import time):
`readCatalogue` L127, `readLedgerState` L139, `board.json` L154.
`buildDescriptionHtml(...)` L219-236 → `<p>` lines ending `registry-hash: <sha256>`. HTTP:
`client.patch` L747/808, `client.post` L780/850/860 — sends name/description_html/state_id,
**never labels today** (zero `label` hits in file).

Labels live in `plane-client.mjs`: `resolveLabels(projectId)` L556 (`GET projects/:id/labels/` →
`Map<lowercase name,id>`), on `createClient()`'s return object L592-612; GET helper
`get(path,{query})` L476. `plane-apply.mjs`'s `resolveLabelIds(ctx,names,index)` L130 (fails
loudly if unresolved L132-133) is the pattern to copy for tag→label in plane-sync.mjs.

`--dry-run`/`--check` L666-700 (never write; `--strict` L497/914/962 only non-zero path).
`--if-digest-changed` L1064, `.plane-sync-digest` L905/1130. Self-test `plane-sync.self-test.mjs`
in `verify`. Write budget/counters in `plane-client.mjs`'s `createClient()`; `--max-writes`/
`--budget-ms` L978. State `.plane-sync-state.json` under `stateDir()` L419/432 (gitignored).

## 3. Gates

- `npm run bugs:self-test` = `node scripts/campaign/bugs.mjs self-test` (pkg L48).
- `node scripts/campaign-check.mjs` **fails today in WT**: `.campaign/runs/` absent. `verify`
  actually gates on the `--freshness-only` variant (pkg L13, 1st token).
- `npm run plane:check` = `plane-sync.mjs --check`.
- `verify` (pkg L13) chains: freshness → lock-edges → lessons → bug-hunt scan → turbo
  check-types/lint/test → `bugs.mjs self-test` → google-signin self-test → all 7
  `plane-*.self-test.mjs` → `plane:doctor --offline` → `stop.gate5.spec.mjs` → bare
  `campaign-check.mjs`.
- WT has **0 `node_modules`** — turbo/jest can't run here; target the landing tree.
- Base sha: WT HEAD `0654d47d`; `origin/master` `e96c405b`.

## 4. Audit backfill → F49 (excl. F11-002,F5-003,F9-006,F12-005,F3-005,F4-003)

Crit/High FIXED(PR): F1-001 adopt-orphans takeover(84,446) · F1-002 invoice-PDF IDOR(84,446) ·
F2-001 BOLA cancel-return(84) · F2-003 BOLA order-template(84,191) · F3-001 OAuth
email_verified(85,191) · F3-002 legacy OAuth auto-OPERATOR(85) · F8-001 OAuth tokens in URL(88) ·
F4-001 buyer self-assign pricingTier(84) · F5-001 secret fallback JWT_SECRET(87,247) · F5-002
encryption downgrade(87) · F6-001 SSRF tenant SMTP(85) · F9-001 pagination unbounded(85,247) ·
F9-004 Redis fail-open(85) · F11-001 no real CSP(86) · F12-001 dep CVEs **PARTIAL**(247,463).

Medium FIXED(PR): F2-002 order-tracking BOLA(247) · F3-004 reset-token in URL(247) · F5-004
plaintext secrets(247) · F12-002 boot-time DDL(PR-1 imp-03a).

Low, "nc"=re-verified 2026-09-11 by file:line/no PR#: F2-005 order authz FIXED(nc) · F2-006
run-chat readable FIXED(nc) · F2-007 unauth Places proxy FIXED(nc) · F4-002 Prisma orderBy inj
FIXED(nc) · F9-007 route-opt throttle-only FIXED(nc) · F9-008 CSV no row cap FIXED(nc) · F9-009
bulk-delete unbounded ids FIXED(nc) · F10-003 credit-notes no role guard FIXED(nc) · F12-004 npm
ci FIXED(nc) · F12-003 Docker root **PARTIAL**(mobile still root, Plane ROAD task 11).
UNREVIEWED: F8-003 "Raw Prisma/exception messages echoed to client in bulk-import errors arrays"
· F10-002 "Customers could mutate line items on already-CONFIRMED orders without
re-confirmation" · F10-004 "Vendor-bill payment/update accepted unvalidated `any` body" · F10-005
"Invoice tax base for boxed products used un-prorated raw qty, diverging from box-prorated
subtotal".

Info: F2-MATRIX — authz matrix, informational.

## 5. Lessons (`.claude/lessons/LESSONS.md`; no digest file in this WT)

L-109 registry-shard commits: regenerate the workspace's Jest cache/manifest after a shard commit
(re-open for full text). L-082 bugs.mjs self-test: never forge a timestamp by plausible uptime —
use a real anchor. L-083 campaign-check freshness: a gate-consumed artifact must carry its own
provenance; the gate must verify it. L-111 Plane sync: an external-system hook w/ real creds must
be dry-by-default/fail-closed. L-112 Plane bulk sync: a fixture must reproduce production SHAPE of
every guarded value. Nothing matched "filing"/"cwd-BUGS_ROOT"/"docs-only PR" (that trap is project
memory, not a lessons entry).

## 6. Learning inputs

3 newest RUN-LOG headings (`~/.claude/skills/dev-pipeline/references/RUN-LOG.md`, 484 lines, all
2026-09-08): ul-rmc-papr ($9.83, clean:false/stale WP4 only) · static-gain (~$30) ·
2026-09-07-ingestion-acme (bugfix, $14.94).

`cost-ledger.jsonl` last 3 rows: plane-harness (clean, $31.78) · plane-learning (clean, $50.42) ·
crm-gohighlevel-handoff (clean, $50.68). No rollup `summary` block — per-run rows only.

## 7. Skill/doc touchpoints

`bug-registry/SKILL.md` 25,525 bytes; 10 headings: bug registry/reporting/analysis pass/carve-out/
picking up work/re-routing+re-tiering/closing out/keeping registry honest/Plane/house rules that
outrank anything here.

`security-testing-program.md` `## 8`="8. Backlog catalogue (standing reference)" L215.
`security-findings-index.md` header (per section, L18/24/44/56/77): `| ID | Title | Status |`.

## 8. Unknowns

- `WT/CONTEXT.md` absent; check main checkout.
- No `LESSONS-DIGEST.md` in WT (only LESSONS.md/ARCHIVE.md/_meta.json).
- No `.campaign/runs/` manifests in WT — confirm pipeline targets a tree with real artifacts.
- Didn't cross-check "nc" rows against CHANGELOG.md for exact PR numbers.
