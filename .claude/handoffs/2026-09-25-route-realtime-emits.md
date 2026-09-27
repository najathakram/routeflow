# Handoff — 2026-09-25 · route-realtime-emits (#2095 follow-up)

- Task: route-driven realtime events for buyer rooms + delete dead inventory.low.stock.
- State: IMPLEMENTED, all scoped gates green, independent Opus review SHIP (1 fix round applied). UNCOMMITTED.
- Branch: feat/2095-route-realtime-emits off feat/2095-buyer-portal-tracking @ 32ddb9c14 (that base is local-only, unpushed; must land first — then rebuild per L-190).
- Run dir: .claude/pipeline/2026-09-25-route-realtime-emits (brief.md = decisions + test plan). Ledger row appended; RUN-LOG entry written by hand.
- Do not stage: apps/api/.claude/ (router-hook artifact), .claude/pipeline/agent-log.jsonl, approach-rotation.json.
- Next: commit (Conventional: feat(api,web,mobile)) with `Bookkeeping-Follow-Up: pending`; pre-merge-review on the diff; code-map entries for route-realtime.ts, live-gateway-harness.ts, gateway emitRouteProgress, route-optimization gateway dep in the docs follow-up.
- Open for owner: (1) deleteRun unlinks orders without telling buyers (minor, left out); (2) a live low-stock push is a new feature if wanted (N4 digest is the signal today); (3) lesson proposal (register at 52/52, needs an allocator id + an archive): "jest array options (--testPathIgnorePatterns) swallow a following path — put `--` before file paths".
