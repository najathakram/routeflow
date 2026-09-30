# F01 · Schema foundation — discovery

**Status: EXECUTED** · scale MINOR (additive DDL only, no behavior change) · base `master 7e5c2d98`
· Batch F01, board #514, no bug IDs closed (columns only; the nine consuming batches close them).

Register evidence re-confirmed on this base for every column the plan's F01 card names — each
checked directly against `schema.prisma` and the consuming service:

| Column(s)                                        | For           | Confirmed absent / present state on base                                                                                                                               |
| ------------------------------------------------ | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ReturnItem.condition`, `.notes`                 | B20 (F08)     | model at L2670 had neither; `returns.service.ts:133-139` drops `dto.items[].notes`                                                                                     |
| `Estimate.issueDate`                             | B79 (F27)     | model at L2341 had no date besides `createdAt`/`expiresAt`                                                                                                             |
| `Estimate.invoiceId` ↔ `Invoice.estimate`        | B17/B70 (F27) | no link existed in either direction; B70's double-conversion has nothing to trip on                                                                                    |
| `NumberingSequence.year` + widened unique        | B100 (F16/G6) | `@@unique([tenantId, docType])` at L3772; `reserveNext` real but year-blind                                                                                            |
| `DocumentNumberType.RETURN`, `.ORDER`            | G6            | enum had INVOICE/ESTIMATE/CREDIT_NOTE/PAYMENT only; ad-hoc minters at `returns.service.ts:37` (`RET-<year>-`, pad 4) and `orders.service.ts:1909-1916` (`ORD-`, pad 5) |
| `AuditLog.impersonatedBy`                        | B165 (F14)    | model at L3273 had no impersonation marker                                                                                                                             |
| `RecurringInvoice.lastRunStatus`, `.lastError`   | B106 (F13)    | model at L2746 had nothing beyond `isActive`/`lastRunAt`                                                                                                               |
| `RouteRunStop.skipReason`                        | B34 (F11)     | absent                                                                                                                                                                 |
| `RouteRunStop.podHistory`                        | B120 (F10)    | absent; `signatureUrl`/`podPhotoUrls` are the sole pointers to stored objects (#477)                                                                                   |
| `RouteRun.settlementVariance`, `.settlementNote` | B167 (F05)    | absent; settlement note currently appended to free-text `notes`                                                                                                        |
| `DriverLocation.accuracy`                        | B185 (F25)    | model at L919 had heading/speedKph/battery but no accuracy                                                                                                             |

**Ripple found and fixed in-batch:** widening the NumberingSequence unique key renames Prisma's
compound-unique input `tenantId_docType` → `tenantId_docType_year`. Five call sites in
`src/import/numbering.service.ts` (+1 spec expectation) updated to `{ …, year: 0 }` — behavior
identical (0 = the year-agnostic series every existing row already means).

**Not done here, deliberately:** no writer for any new column beyond the year-0 mechanical rename.
Every column's writer ships in its consuming batch (F05/F08/F10/F11/F13/F14/F16/F25/F27) — a
column with no writer is inert, which is exactly what an up-front schema batch should be.
