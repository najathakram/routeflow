# Build (Sonnet 5 @ high) + corrections + revert probes · detached HEAD at master 67fb1bd8 in focused-knuth-179e2b
RED before fix: commission "stamped NSF_FEE + non-prefix" base expected 1000 got 1025; uncategorised where lacked the AND/OR null-safe shape.
GREEN: invoices/sales-agents/regulated/common 145 suites / 2589; api tsc 0; types tsc 0; lint:migrations clean (--files); split-prisma-schema --check OK; backfill --self-test 7/7; size-ratchet OK.
Corrections: L-072 — hand const removed, Prisma InvoiceItemSystemKind used (the .mjs backfill keeps a pinned string); duplicate `as any` removed; commission select gets a NEED-DB executed-proof spec.
NEED-DB (F2): regulated/uncategorised-lines.nsf-2169.db.spec.ts; sales-agents/commission-engine.nsf-2169.db.spec.ts.
Revert probes (HEAD version restored, then byte-identical restore verified): commission-engine.service.ts → 1 red; uncategorised-lines.ts → 1 red; invoices.service.ts → 2 red (duplicate).
