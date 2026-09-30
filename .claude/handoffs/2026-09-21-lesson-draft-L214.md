# LESSONS draft — for the coordinator's bookkeeping follow-up (NOT in any code PR)

Register is at its cap (52/52 entries, 57.6/64.0 KB, nextId 214): land this only after archiving the least-cited
fully-guarded entry to ARCHIVE.md (whole, verbatim), then regenerate LESSONS-DIGEST.md. Entry ≤ 10 lines,
no client identifiers.

### L-214 · 2026-09-21 · domain · a flag has two surfaces: the one that CREATES the new value and every one that merely CARRIES it — refuse on the carriers

- **Symptom:** four independent defects in one night on `flag.units_v1`, found by three different lanes, all the
  same shape. **B641 (the dangerous one):** the invoice edit form re-saved a draft's Case line as a pack line —
  72 pieces stored instead of 864 while the money still read $1,440, so every screen agreed and nothing looked wrong.
  B638: a Case line parked on web and resumed on mobile collapsed to a pack line ($480 -> $42, 288 pieces -> 1).
  A1: a staff `replaceAll` re-denominated a Case to the pack. Update-path refusal: `update()` correctly refuses a
  unit, but a saved-draft edit would have turned that refusal into a silent conversion.
- **Root cause:** the new denomination was built on the surface that creates it (picker, create endpoints); the
  surfaces that only CARRY the record (edit forms, park/resume round-trips, field-by-field mappers, replace-all
  writers, snapshot restores) predate the field, so they drop it and fall into the default (pack) branch instead of
  refusing — and the server cannot always tell.
- **Lesson:** **When a feature adds a value that changes what a quantity MEANS, enumerate every path that can carry
  the record without understanding the new field and make each one refuse visibly — never convert, never fall back to
  the default branch, never drop the field. Write and test each refusal BEFORE the happy path; the worst variant keeps
  the money consistent, so only quantity/stock reveals it, months later.**
- **Guard:** flag-off characterization + a refusal test per carrier, each mutation-checked
  (`invoices/[id]/edit/page.test.tsx`, `unit-aware-guard.spec.ts`; the mobile draft parity test is owed under B638);
  the server writers stay inventoried in `unit-line-writers.ast.spec.ts` (B635: the scanner cannot see top-level
  writers — extend it before relying on it).
