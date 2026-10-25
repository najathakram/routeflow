# SA-382 (relayed verbatim by the Mac Lead, 2026-09-26) — #2190 sign rule; applies to #2185's finish too
(1) STORED money columns — Total, SubTotal/Sub Total, Entity Discount Amount/Discount Amount (header), Shipping Charge, Item Price, Discount Amount (line), Item Total — NON-NEGATIVE: #2185's boundedMoneyParser as is; negative or unparseable = bad cell.
(2) Balance Due / Balance / Outstanding Amount is NOT stored (drives status only) → a SIGNED bounded parser (one export beside moneyParser, same bound, negatives allowed): negative = overpaid (existing ≤ 0.01 ⇒ PAID); absent (NaN) = status from label as today; unparseable = bad cell.
(3) Skip unit = the INVOICE GROUP (all rows sharing the invoice number), never a single line; reason names column + invoice number. Replaces silent `if (qty <= 0) continue` and `|| 1` on Quantity: present-but-unparseable or ≤ 0 qty ⇒ group skipped with reason (absent qty may keep default 1).
(4) Absent cells keep today's defaults (0; SubTotal ⇒ Total); only PRESENT-but-bad cells skip.
Pins: one case per column, negative and "12abc", each proving no invoice/line row is written; real-Postgres case shows zero $0 lines; a legitimate negative Balance Due imports as PAID.
Base: #2185 merged to master first (Mac Lead option (a)); parsers exported from import-columns.ts.
