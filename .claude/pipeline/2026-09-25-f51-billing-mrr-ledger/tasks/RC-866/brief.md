### RC-866 — confirm B866 cause

`mrr.service.ts:242` `baseMrr += base;` vs `:249` `… + base - discount` — same loop, same inputs. Probe: `-t "breaks MRR down by plan"` green at 339.
