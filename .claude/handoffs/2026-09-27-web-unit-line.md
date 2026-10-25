# Handoff — RouteFlow Lane web unit-line edit (Mac mini) · 2026-09-27 14:33Z · SAFE POINT

Worktree `~/code/routeflow-wt-b718-web` — clean, on bug/2277…; nothing uncommitted.

## Local-only (NOT pushed)
- #2447 tripwire (claimed; filed by me): `chore/2447-tripwire-no-local-unitlinecount-outside-packages-p` @ d646b362 (off master 213e7b2f). Red on master pre-#2430; green with #2430. #2430 is now MERGED → next: merge master, re-run pricing no-mirrors spec, ask Mac Lead for a slot.

## Open PRs (pushed; coordinator/gates own them)
- #2434 (#2277, 400 UNIT_NOT_OFFERED) d7842143 — api check-types spec errors 606 ≤ baseline 606 vs master.
- #2287 (#2173 buyer bell) a4469c19 — waits for #2264; then merge master, resolve, slot.

## Merged/closed since start
#2430, #2432 (+SA-070 fold), #2444, #2289, #2220 (Train D #2422). #2248/#2247 closed.

## Queue (claim each via `node scripts/work/claim.mjs N --worker …` from the worktree)
1. Driver short-pick display (short-pick.tsx:314 `boxes ?? qty`) — NOT started, no issue yet.
2. #2457 (mobile draft total omits LOCKED line; tier1, display only) — filed, NOT claimed/started.
3. isEmptyUnitLineSplit → packages/pricing after #2428 lands.
4. #2331 kit A — design ruled (local-assets/handoff/2026-09-27/kit-a-2331-design.md); waits for #2330.

## Rules to carry
Push only with a Mac Lead slot; api check-types spec errors ≤ baseline before push; `prisma generate` after master moves.
