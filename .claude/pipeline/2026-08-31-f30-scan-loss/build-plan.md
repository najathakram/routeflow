# F30 — build plan

**Status: APPROVED (Fable)** · worktree `.claude/worktrees/rf-F30`, branch `fix/F30-scan-loss`
· ONE PR · scale **major** · carries additive migration `20260910000000_order_idempotency`
(`Order.idempotencyKey String?` + `@@unique([tenantId, idempotencyKey])`) — applied to prod
BEFORE merge per the house flight (Fable-reviewed under the owner delegation; additive-only, no
writer until this PR's server half deploys — old clients simply send no key).

Discovery = the F30 card (`.claude/pipeline/fix-cards/F30-mobile-scan-loss.md`, copied into this
worktree's fix-cards by Phase 0 if absent). The card's fix set is the authoritative change list;
briefs below scope ownership.

## P1 — scan gate + camera buffer (mobile lib)

- satisfies R1 R2 · provenBy T-B190 T-B191 T-B192
- **Files:** `apps/mobile/lib/scan-loop.ts`, `apps/mobile/components/ScanCamera.tsx`,
  `apps/mobile/components/ScanOrderSheet.tsx` (indicator only), their test files.
- Gate: normalized-candidate LRU (last 4), accept-only cooldown refresh. Camera: pending buffer
  depth 2 deduped by normalized code; expose `isResolving`; scan-lookup timeout 5s (scoped —
  do not change the global axios timeout here).

## P2 — wedge path + sale-line fold (mobile screens/lib)

- satisfies R3 R4 · provenBy T-B193 T-B194 T-B201 · dependsOn P1 (shares scan plumbing idioms)
- **Files:** `apps/mobile/components/NewOrderScreen.tsx`,
  `apps/mobile/app/(operator)/(tabs)/orders/[id]/edit-items.tsx`,
  `apps/mobile/app/(operator)/(tabs)/invoices/new.tsx`, `apps/mobile/lib/sale-line.ts`, tests.
- Synchronous field clear at submit (web CreateOrderModal invariant, cited in the card); buffer
  a burst arriving mid-resolve; sale-line boxed branches fold prev plain qty via
  `normalizeBoxesPieces`.

## P3 — resolve ladder honesty (mobile lib)

- satisfies R5 · provenBy T-B195
- **Files:** `apps/mobile/lib/barcode-resolve.ts`, `apps/mobile/lib/scan-ladder.ts`, the
  draft-resume block in `NewOrderScreen.tsx` (~L763-854 — coordinate with P2's ownership: P3
  edits ONLY the resume block; P2 owns the rest of the file — dependsOn P2 to serialize).
- Distinct `archived` outcome; resume keeps archived lines flagged.

## P4 — never-silent queue + iOS toast (mobile infra)

- satisfies R6 R7 · provenBy T-B196a T-B196b T-B143 T-B151
- **Files:** `apps/mobile/hooks/useNetworkSync.ts`, `apps/mobile/store/offlineQueue.ts`
  (failedActions persistence), `apps/mobile/lib/api-client.ts`, `apps/mobile/lib/toast.ts`, tests.
- NetInfo-gated enqueue; replay preserves `_offlineQueued`; 4xx/exhaustion → persisted
  failedActions + alert; iOS showToast → existing InlineToast host, Alert fallback.

## P5 — server half (api)

- satisfies R8 R9 R10 R11 R12 · provenBy T-B196c T-B197 T-B198 T-B199 T-B200
- **Files:** `apps/api/src/orders/orders.service.ts`, `apps/api/src/orders/orders.controller.ts`,
  `apps/api/src/orders/dto/*` (idempotency header/DTO), `apps/api/prisma/schema.prisma` +
  `migrations/20260910000000_order_idempotency/migration.sql`, buyer-catalog scan endpoint
  (locate via `findByBarcode` callers), specs.
- ⚠️ LANE: this package's orders.service/controller edits are the reason F30 precedes F06.
  Idempotency: nullable column, unique (tenantId, idempotencyKey); on P2002 → fetch & return the
  existing order (replay semantics). Merge: denomination-aware inside the existing transaction
  shape with an atomic claim.

## P6 — mobile client sends the key

- satisfies R8 · provenBy T-B196c (client leg via api-client spec) · dependsOn P4 P5
- **Files:** `apps/mobile/components/NewOrderScreen.tsx` (submitOrder — uuid per cart session;
  P2 owns the file, so dependsOn P2 too), `apps/mobile/lib/api-client.ts` header pass-through.

## Pipeline args

scale major · workdir rf-F30 · TPs mirror the test-plan (TP1 mobile gate/camera, TP2 mobile
wedge/sale-line/resolve, TP3 mobile queue/toast, TP4 api server half) · redGate = the two
commands in the test plan, expect fail · verify perRound api tsc + mobile tsc; final: api jest
JSON, mobile jest JSON, web tsc, scanner, scanner --self-test, campaign-check --batch F30
--pipeline-dir <this folder>. Mutation targets: gate LRU (revert to raw single-slot → REG-B190),
cooldown (refresh-on-reject → REG-B191), sale-line fold (discard prev.qty → REG-B194), queue
(silent dequeue → REG-B143), merge (flatten → REG-B199), idempotency (drop the unique lookup →
REG-B196). No uiVerify (mobile; Expo cannot run in the pane — memory rule).

## Close-out

1. Fable pass runs in-pipeline (new engine). 2. Migration flight: backup → replay locally →
   prod-migrate BEFORE merge. 3. Ledger F30.jsonl → proven ×12 + B143/B111/B151 partial-cut notes
   in F19/F20 shards' evidence fields (do NOT flip those — their batches finish the job).
2. Register: 12 NEW articles (B190–B201) + chips, republish `310ae33a…`. 5. Board #549 done.
3. Owner notified for an Expo build + device retest with the reporting client.
