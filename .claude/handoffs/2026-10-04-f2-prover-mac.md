# F2 prover (Mac) handoff, 2026-10-04

- Worktree `.claude/worktrees/prove-2865z` (mine): branch `fix/admin-account-protection` exists off origin/master b4643dca (S2 = draft PR #3191, folds pushed with verify; do NOT change the PR text beyond generic wording). Detached heads used for proofs.
- Scratch DBs (compose Postgres, local only): `rf_prove_2865z` (qa-2865z tenant; qa captures), `rf_prove_2856` (fully migrated; DB lanes). Colima up (6 GB), containers up, node servers stopped.
- Acceptance seed (not yet run): `local-assets/handoff/seed-qa-shipping-wholesaler.js` (creds in its CREDS block). Tenants: qa-shipping-wholesaler (fleet off), qa-delivery-distributor (control, fleet on). TODO add qa-in-store (pickup_ship) and qa-in-store-only (pickup) once `fulfilment_model` exists; add a 2nd product to c1's order history for "Usually buys".
- Pending: acceptance run when onboarding shas arrive (rows N/A until builds land: in-store, batch ship, packing slips, last-price chips, live stock, auto-confirm, auto-print), #3135 invoices DB lane + recalc-guard mutation, #3116 web pixels (5bc09106).
- Read tool pre-hook flaky: when down, post DOM evidence and ask PC for pixels.
- Traps: wipe `.next` after any checkout before a web capture; stale Prisma client vs scratch DB (migrate deploy + generate first); never `.last()` selectors.
- Proof screenshots: `local-assets/proofs/2865-casec/`; scripts in the session scratchpad.
- STATE: STOPPED (account switch). The #3106 visual pixel read is DONE: PASS, #2554 5981094790. Queue reports go to Mac Lead.
