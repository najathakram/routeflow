### L-082 · 2026-09-06 · testing · bugs.mjs self-test

- **Symptom:** the registry self-test's pid-reuse fixture failed on an ubuntu runner (four checks in a
  cascade) and passed on every Windows run and on its own CI re-run.
- **Root cause:** the fixture forged a stale lock owner's boot stamp as "now minus 20 minutes"; the
  liveness check treats a stamp within 5 s of the machine's real boot as the same boot, and a CI runner
  that had been up about 20 minutes when the self-test started made the impostor look genuinely alive,
  so the waiter spun out and the next fixtures inherited its lock dir.
- **Lesson:** **never forge a timestamp relative to "now" by a plausible machine uptime — forge it
  relative to the real boot stamp, far outside any slop; and give every fixture its own setup and
  cleanup so a give-up cannot cascade into unrelated checks.**
- **Guard:** the pid-reuse fixture forges `bootAt = bootStamp() − 1 year` and asserts the
  "predates this boot" verdict; the owner-write fixture clears the lock dir before its own precondition
  (`scripts/campaign/bugs.mjs` self-test, step 6 of `npm run verify`).
