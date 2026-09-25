# Handoff — wholesaler onboarding playbook (2026-09-24)

**Branch:** `docs/wholesaler-onboarding` (worktree `rf-docs-onboarding`, base `025bcdce`).
Docs + registry only, not pushed. Push/PR only when the owner says.

**Landed on the branch:**

- Playbook: `docs/runbooks/wholesaler-onboarding.md`.
- Parked build spec: `docs/superpowers/plans/2026-09-24-wholesaler-onboarding-build.md`.
- Registry B852–B862 (filed, not fixed), plus a B558 note.
- TEN-N5/TEN-M9 corrected in `docs/product/tenancy.md`.
- A code-map row, and a lessons `updatedAt` bump.

**Rulings:** memory `project_onboarding_rulings_2026-09-24.md`.

**Open owner items:**

- **B858/B859 before a big catalog:** the importers drop pack sizes, tiers, barcodes, costs,
  terms, limits and exemptions, so all of that is keyed by hand.
- **B857 before a Growth customer pays by bank:** Manual Activation can't pick GROWTH.
- **B861:** new invoices can't continue the old numbering.
- **DPA:** is one needed beyond Terms + Privacy?

**Candidate lessons.** Held because the register is 52/52 and `docs/lessons-compaction-0923` owns
it; the lessons lane places them:

1. **tooling:** `bugs.mjs file` mints max+1 from the LOCAL catalogue. Reserved ranges on unmerged
   `origin/docs/file-b###-b###` branches are invisible to it, and master's next id (B847) was
   already taken. Scan `origin/*` catalogues first and pass `--id` above the highest.
2. **process:** `docs/product/*` claims go stale when fixes land. TEN-N5 still said "NOT WIRED"
   after B100/F16b, and was wrong in a subtler way (B861). Re-verify such claims against master
   before planning around them.

**Not verified:** a compose-stack run of the import templates (the prover owns the stack). Specs
were checked against the importer source.
