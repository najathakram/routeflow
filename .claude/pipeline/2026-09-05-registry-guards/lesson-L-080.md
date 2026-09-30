### L-080 · 2026-09-06 · process · registry-guards

- **Symptom:** three PRs (#612/#617/#618) landed bug-ledger rows while the per-bug records still
  said `queued`; every other worktree's Stop-hook Gate 4 then rewrote nine records on its next turn,
  and a triage id filed without `--batch` (B213) could not be moved into a batch under its own id.
- **Root cause:** the record front matter is a mirror DERIVED from the ledger by `sync`, yet nothing
  refused a push whose ledger edit skipped `sync`; and `move` only knew how to re-home an existing
  shard row, so an id with no row had to be re-filed under a new number.
- **Lesson:** **a committed derived file needs a read-only `--check` of its own derivation that the
  pre-push gate runs on the real tree; a state machine that mints ids must be able to give any
  catalogued id its FIRST row, not only move an existing one.**
- **Guard:** `sync --check` (T13/T13b) and `move --tier` (T14) in `scripts/campaign/bugs.mjs`
  `self-test`, which `npm run verify` runs before every push.
