# Status — 2026-09-23T03:02:05Z — Lane F (rf-b681-correction)

#1257 fully landed (merged + deployed). On #1246's revision
(fix/b681-correct-ledger, worktree rf-b681-correction), all pre-review work done,
queued for the PC heavy slot (B745 has it now).

Done this session: verified all five architect-ruled items were already correctly
implemented; refactored `b681-correct-ledger.mjs` behavior-preservingly for
testability; wrote 35 self-test cases across two new `.self-test.mjs` files (repo
convention for `.mjs` scripts outside Jest's rootDir); ran fix-revert probes on all
three testable behaviors (live-deploy refusal, existing-correction refusal,
statement timeout) — each genuinely goes red when broken, green when restored;
wired both self-tests into the root `npm run verify` chain (previously unwired);
rewrote PR #1246's body with a rulings-to-test-name table and the probe output.

HEAD: `8e442dbf7` on `fix/b681-correct-ledger`. Not pushed. No DB/railway/Docker/
npm ci run this session — only `node --check` and direct self-test invocation.

Next when cleared: push as fast-forward only (never force) once master is green
and the lead clears the slot; two independent Tier 1 reviews follow. `--guard-sha`
= `3ff8b142` (deployed). Running against production stays the owner's per-call
decision after a dry run — nothing in this PR changes that.
