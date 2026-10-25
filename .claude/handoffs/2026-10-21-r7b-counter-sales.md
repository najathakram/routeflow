# R7b counter-sales fixes: start card (2026-10-21, Mac mini lane)

**Owner:** Mac mini lane; confirmed by Routeflow Lead after row 688 (PR #3564). New work, so it goes through **dev-pipeline**
(the bug rows go through bug-pipeline). Explicit model + effort for every agent; never Fable.

**Scope:** routeflow-specs `releases/PLAN-2026-10-20.md` row 6 + "### R7b additions" (line ~47). That covers 3 batches
(row 643) + B1261-B1264 + the owner's counter rulings.
**Read first:**
- the counter UX audit: specs/counter-sales/ux-run-2026-10-19/ (report 110/168, inventory, BUILD-BRIEF f6e13ad);
- card handoff/lanes/2026-10-20-counter-ux-lane.md;
- the SA rulings in specs/: sa-740, sa-741r3, sa-762r, spec-fulfilment-counter-sales-admin-toggle.md;
- SA-655 (COUNTER_SALES_DISABLED approved copy): branch counter-sale-api-old @ 24dae7f7c (no PR; NEEDS-OWNER in
  macbook-inventory-2026-10-19.md). Check it against the merged PRs before reusing it.

**Machine:** Mac mini RAM is tight and disk is ~19 GB (rule 20). One heavy job at a time, coordinated with the landing lane.
The tree ~/code/rf-wt-r3img holds fix/row-688 (PR #3564, don't move that sha). Use a new branch from origin/master,
and rebuild the packages (`npx turbo run build --filter='./packages/*'`) before trusting any red.
**Rules:** GRAPH FIRST; page.tsx at its ratchet → extract first; `Bookkeeping-Follow-Up: pending`; no client names;
report sha + counts to Routeflow Lead. Release items are due end of 10-22.
