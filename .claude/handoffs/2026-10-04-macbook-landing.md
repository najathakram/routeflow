# Handoff: RouteFlow MacBook landing (2026-10-04)

Worktree: `/Users/najathakram/code/routeflow-619` (node_modules symlinked to routeflow-2437; run `prisma generate` in apps/api before any push, a stale client fails verify). One full verify at a time; kill stray CPU burners. Never `git stash`/force-push/`--no-verify`.

## Open PRs (all draft, verify exit 0)
- #2988 B965+B967 `fix/b965-b967-mixed-unit` 2a5486fa6: refund-door RETURN_MIXED_UNIT_PRODUCT, pool+mint in pieces, box-split real-PG pins (UNRUN, no Docker: needs the PC DB lane). SA/Opus passed.
- #2994 W1-AB cleanup `chore/w1-ab-cleanup` 411b1c76f.
- #3183 tooling `fix/deflake-tests-raw-ratchet` 3e24535ab: derived PENDING_TOTAL + CPU-time db-lane bound. Dead-holder flake NOT reproducible; test unchanged.
- #3186 counter sale `feat/counter-sale-screen` 5b522bc5a: screen, capability gate, entry points, 40 tests.

## Next session
1. Mark picked up: needs the PICKUP marker (migration) + POST /orders/:id/pickup-complete {payment}; no stock change on that screen; labels from PC B's shared helper.
2. Counter sale gaps: Email receipt (no endpoint), camera scan screen, lean row vs CreateOrderModal. Swap my local `counter-sale.ts` type and structural `capabilities.fulfilment` read for PC D / U-units' shared types when they land.
3. B969 (box-unaware under-refund): red-first pin 1 box -> $60.00; price in pieces both sides (SA-628p). Branch off master after #2988.
4. #3117 (B1008) parked by owner ruling (driver work deferred).
## Blocked
B956 bundle needs the owner's explicit OK in the MacBook chat; removing 12 stale worktrees likewise.
