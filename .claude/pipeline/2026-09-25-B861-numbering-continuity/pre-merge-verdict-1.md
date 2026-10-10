# B861 / #2170 — independent pre-merge verdict 1 (Opus, @fa4ff2ff)

Hygiene: CLEAN (5 commits, pinned identity; no root scratch; no migration; no secrets/client ids).
VERDICT: **BLOCK** — one finding; four notes.

1. BLOCK — year-0 max scan `(\d{1,9})` had no leading `0*`: a zero-padded bare number longer than 9
   characters (padding goes to 12; empty prefix allowed) was invisible → a save of next 1000 passed
   over an imported `0090000123` (mint below an existing number) and a pad-10 imported block wedged
   minting into 409s (delivery path included). No duplicate possible (`0*n` taken check + @@unique).
   **Fixed** 65b62492 (`^<esc>0*(\d{1,9})…` for year 0 only; per-year byte-identical); red-first
   e2c122ac: unit REG-B861-Z, DB REG-B861-Z/Z2. Report script aligned.
2. LOW (note) — a save may lower next onto a number reserved but not yet inserted → P2002 on insert
   (fails closed). Accepted.
3. LOW (note) — mintConfigured scans with the pre-UPDATE prefix, formats with the RETURNING prefix; a
   prefix-only save in between can mint one number below the new prefix's max (exact clash still
   caught). Accepted; the taken check re-scans on clash.
4. Q4 prod count still open (merge condition) — unchanged.
5. LOW — web `DocumentNumberType` redeclared locally → **fixed** 65b62492: `Extract<>` of the shared
   `@routeflow/types` enum (L-072).
   Required answers: no weakened assertions; no duplicates (below-existing only via #1, now fixed);
   tenant-scoped yes; unconfigured unchanged yes; no nested tx; stale tab cannot rewind.
   Next: independent re-review of the delta fa4ff2ff..65b62492 only.
