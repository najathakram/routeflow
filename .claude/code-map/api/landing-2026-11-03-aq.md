# Api landing 2026-11-03, train ap (merge commit `c8221d4b46`, range `f10b57ce34..c8221d4b46`; train PR #4182, head `be2f11f2ac`)

Paths under `apps/api/` unless they start with `apps/web/`, `apps/mobile/` or `packages/`. Members: #4181 `6437200b80` (docs only), #4179 `6c76c10fa6` (web only), #4173 `da8280c079` (SA-1098 PR-2 with A-1 to A-4: the driver's stop on the web). **No migration**, no cron, no plan flag or addon gate, no new env var, no new route. Web side: `web/landing-2026-11-03-aq.md`. Tests are named from the diff and the PR text and were not run for this note.

## #4173 `da8280c079` drivers finish stops on the web (SA-1098 PR-2, A-1 to A-4)

- Delivered goes through the existing `POST /route-runs/:id/stops/:stopId/complete-with-payment` with no `payment`, one explicit entry per line of every order at the stop (built by `buildStopDeliveries` from `packages/pricing/src/delivery-plan.ts`) and one `Idempotency-Key` per stop; the server's `remaining` per line is the only source of what is left.
- A-2: a key kept across a reopen cannot say "completed" on an open stop. `routes/stop-completion-key.ts` (`replayStopKey`) reads the stop's status in the same transaction, after the row is found and before the hash check, and answers 409 `STOP_REOPENED` (`common/api-error-codes.ts`, `packages/types/api/error-codes.ts`), nothing written, on `completeStop` and `completeWithPayment` in `routes/routes.service.ts`; `routes/delivery-lines.util.ts` carries the shared line reads.
- A-3: a line left off a delivered stop reconciles to the office. `orders/order-invoices-review.ts` (`attachInvoicesNeedReview`, `ORDER_LINE_LEFT_OFF_MESSAGE`, `STOP_COMPLETION_CONTEXT`) flags an order when the latest audit row with `meta.kind: "line-left-off"` has a live line with a delivered quantity on no non-void invoice; `invoices/invoices.service.ts` writes the row.
- A-4: the fold is refused. `invoices/invoice-partition.ts` (`placeUnbilledLines`) puts on the one draft left only that draft's own group's lines, read from the category its items carry; a draft with no items, two categories, or a category that is not a group has no readable group and every unbilled line stays off with `needsReview`.
- Tests: `routes/driver-stops-web.db.spec.ts` (rows D-1 to D-51b on real Postgres), `routes/stop-completion-key.spec.ts`, `routes/routes.skipped-stop-completion.spec.ts`, `routes/routes.realtime-wiring.spec.ts`, `routes/routes.service.spec.ts`, `orders/order-invoices-review.spec.ts`, `invoices/invoice-partition-placement.spec.ts`, `packages/pricing/src/delivery-plan.spec.ts`.

## #4179

- No api source; see `web/landing-2026-11-03-aq.md`.
