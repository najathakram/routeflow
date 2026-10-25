# Handoff — 2026-10-08 · mac-mini-wind-down
- Task: Mac mini lane (coordinator/DB lane/pushes) wound down on owner order; resume unpushed work safely.
- State: in progress — all work committed, 5 branches LOCAL ONLY (not on origin); idle, no processes, Docker down.
- Branch/tree: main checkout chore/opus-5-5-routing @ 94d4b8f57 · uncommitted: 61 (old handoffs/notes; leave) · worktrees (local-only, clean):
  rf-wt-p0b feat/p0b-units-pricing @ feba27056 (WIP top commit, unverified)
  rf-wt-u1 feat/u1-units-settings @ 0021a5684 (verified, DB 7/7)
  rf-wt-u6 feat/u6-units-backfill @ ba2ef4289 (verified, DB 4/4)
  rf-wt-cat-server fix/catalog-variant-server2 @ db27ae933 (WIP, unverified; origin 94f9a3e7a)
  rf-wt-pkg4c fix/create-order-customer-keyboard-v2 @ f80206f9f (#3275 fix, unverified; origin bbd57339a = FAIL)
- Run: none (no pipeline run).
- Decided:
  - No --no-verify/SKIP_VERIFY, even for WIP (owner hard rule); pushes strictly serial (parallel pre-push → ETIMEDOUT).
  - P0a #3319 c4faabdff + sitting/2026-10-08 95d1e9124 pushed: 76 migrations replayed, NO DRIFT — merge only after the owner sitting.
  - 39 clean/pushed worktrees + 48 merged branches removed; stale unpushed trees kept.
- Next:
  - Push one at a time (shim check, normal push): U-6 → U-1 (merge origin/feat/p0a-units-schema first) → #3275 (run CreateOrderModal.customer-keyboard test first) → P0b → cat-server; open draft PRs (U-1/U-6/P0b base feat/p0a-units-schema).
  - Finish: P0b UI pack-pieces ruling; #3322 review fold (merge master); #3323 nits; #3214 DB race pin @9f8458ffb.
  - Full table + briefs: local-assets/landing/queue.md (FINAL STATE), local-assets/specs/*.md.
- Open for owner: delete stale trees with unpushed work? (list in queue.md)
- Do not: touch ~/code/rf-prod-migrate*, branch feat/sitting-b-schema-bundle, repo visibility; run npx husky / plain npm ci; wait-loops that grep "git push".
- Areas touched: api, web, mobile, packages
