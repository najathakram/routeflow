# F27 · Estimates

**Bug IDs (5):** B15, B16, B17, B70, B79

**Root cause:** "Send" only flips a status and delivers nothing (B17); a CONVERTED estimate can be laundered back to ACCEPTED and converted a second time (B70); a required Issue Date is never sent and has no column (B79, uses F01).

**Ships as:** One PR.

**Files:** estimates.service.ts (send/accept/decline/convert) · web estimates pages

**Together because:** One estimates lifecycle, several missing guards on its state machine.

**Guardrails / shared infra:** None new. No lane conflicts — freely parallel.

**Dependencies / lane notes:** Requires F01 (semantic, B79 needs Estimate.issueDate + the Estimate.invoiceId/Invoice.estimateId pair).

---

## Proof-tier assignment (frozen at seed — see plan's Phase 2 and `.claude/campaign/status/F27.jsonl`)

| ID  | Tier | Hunt-round SHA | Citation status              |
| --- | ---- | -------------- | ---------------------------- |
| B15 | T2   | 2d0270fd       | NO_TOKEN_UNVERIFIED          |
| B16 | T2   | 2d0270fd       | NO_TOKEN_UNVERIFIED          |
| B17 | T1   | 2d0270fd       | OUT_OF_BOUNDS                |
| B70 | T1   | e5b0af8e       | NO_TOKEN_UNVERIFIED          |
| B79 | T1   | e5b0af8e       | MOVED (disambiguate in-file) |

> T1 = jest spec (api or mobile pure-logic) · T2 = Playwright e2e, web-visible (proven-pending-deploy through the PR, per the plan) · T3 = recorded manual check (forbidden for Critical/High — none here are). See `.claude/campaign/citation-reanchor-log.md` for any bug ID flagged above whose citation needs a discovery-time check before trusting it verbatim.

---

## Bug details — register triple, evidence and suggested fix, pasted verbatim

### B15 — “Convert to Invoice” offered when it can’t succeed

**Area:** Estimates · web

**Meant to do:** Convert to Invoice should only be actionable once an estimate can actually become one, so staff aren't invited to click a doomed action.

**Actually does:** Web renders the button on DRAFT and SENT estimates; the click always 400s server-side and shows a generic "Failed to convert estimate / Please try again" toast.

**The gap:** The real requirement (must be ACCEPTED first) is never surfaced, so the operator retries a permanently-failing action believing it's transient.

**Evidence:** apps/web/app/(dashboard)/estimates/[id]/page.tsx:245-253,265-294,182-188; apps/api/src/estimates/estimates.service.ts:219-230 (ACCEPTED-only claim, BadRequestException)

**Suggested fix:** Only render Convert to Invoice when status==="ACCEPTED" (mirror mobile's estimateActionFlags), and fall back to the server's actual error message in the toast.

### B16 — “Expired” estimate filter always errors

**Area:** Estimates · web

**Meant to do:** The Expired filter/KPI chip should let operators find estimates whose validity date has passed.

**Actually does:** EstimateStatus has no EXPIRED value and nothing sets it; selecting it sends status=EXPIRED straight into an unvalidated Prisma `where.status`.

**The gap:** No estimate can ever be surfaced this way — the option is permanently dead and never returns real results.

**Evidence:** apps/api/prisma/schema.prisma:235-241 (enum, no EXPIRED); apps/web/app/(dashboard)/estimates/page.tsx:86,780-789 (option+chip); apps/api/src/estimates/estimates.service.ts:156 (`if (status) where.status = status;`)

**Suggested fix:** Remove the EXPIRED option/chip (and the [id]/page.tsx "has expired" branch) until a real EXPIRED status is computed from expiresAt.

### B17 — “Send” marks an estimate Sent without sending anything

**Area:** Estimates · web + API

**Meant to do:** Send should actually deliver the estimate to the customer (email/PDF/link), and a converted estimate should stay traceable to the invoice it produced.

**Actually does:** Send only flips status to SENT (no email/PDF/print/customer view anywhere in api or web); convertToInvoice creates an Invoice with no FK linking it back to the Estimate, or vice versa.

**The gap:** Customers receive nothing despite the record saying SENT; nobody can navigate from a CONVERTED estimate to the invoice it became.

**Evidence:** apps/api/src/estimates/estimates.controller.ts:39-41 + estimates.service.ts:193-195 (send=status-only); grep "estimate" in apps/api/src/email = none; grep pdf/print/email in apps/web = none; schema.prisma Estimate 2341-2365 (no invoiceId), Invoice 1835+ (no estimateId)

**Suggested fix:** Wire a real email/PDF send mirroring invoices' email.service.ts + invoice-pdf-template, and add an Estimate.invoiceId/Invoice.estimateId column set inside convertToInvoice's transaction.

### B70 — A CONVERTED estimate can be laundered back to ACCEPTED and converted a second time

**Area:** apps/api/src/estimates

**Meant to do:** CONVERTED is terminal under every transition, so a converted estimate can never be re-accepted and re-converted into a second invoice.

**Actually does:** send() and decline() are bare `estimate.update` calls with no status predicate, so a CONVERTED estimate can be flipped to SENT or DECLINED unconditionally. accept()'s updateMany excludes only CONVERTED (not DECLINED), so it then succeeds -> ACCEPTED, and convertToInvoice()'s ACCEPTED claim matches again and mints a second invoice with identical lines.

**The gap:** send/decline lack the CONVERTED guard that accept, convertToInvoice and voidEstimate all carry — voidEstimate throws explicitly on CONVERTED, proving the terminal intent decline() omits. Nothing downstream can detect the duplicate: Invoice has no estimateId back-reference.

**Evidence:** apps/api/src/estimates/estimates.service.ts:193-195 (send, unguarded), :198-206 (accept excludes only CONVERTED), :208-210 (decline, unguarded), :211-217 (voidEstimate DOES block CONVERTED), :219-230 (convertToInvoice's ACCEPTED claim); apps/api/src/estimates/estimates.controller.ts:39-53 (no further route guard); apps/api/prisma/schema.prisma:2369 (estimateId exists only on EstimateItem; Invoice has no back-reference).

**Suggested fix:** Make decline() and send() atomic claims excluding CONVERTED (`updateMany` with `status: { not: 'CONVERTED' }`, throwing on count === 0), mirroring accept()'s existing pattern.

### B79 — Estimate Issue Date is required in the UI, never sent, and has no column to store it

**Area:** apps/web/estimates + apps/api/src/estimates

**Meant to do:** An operator picks an Issue Date for a new estimate (including a backdated one) and that date is saved, shown and editable.

**Actually does:** The form validates issueDate as required, but the submit DTO never includes it; the Estimate model has no issueDate column; the detail page falls back to `(estimate as any).issueDate ?? estimate.createdAt`; and the controller exposes no PATCH at all.

**The gap:** A required field is dropped client-side, has no server column, and no edit endpoint exists to correct it afterwards — every estimate is dated createdAt, permanently.

**Evidence:** apps/web/app/(dashboard)/estimates/page.tsx:151, :336, :345-358, :469-477; apps/web/app/(dashboard)/estimates/[id]/page.tsx:353-354; apps/web/lib/api/estimates.ts:81-87 (CreateEstimateDto has no issueDate); apps/api/src/estimates/estimates.controller.ts:14-58 (POST/GET only); apps/api/prisma/schema.prisma:2341-2365 (no issueDate column).

**Suggested fix:** Add an issueDate column to Estimate, include it in the create DTO and service, and add PATCH /estimates/:id so a wrong date can be corrected.

---

## Discovery instructions (per the campaign plan)

Discovery's job is to confirm these lines still say what the register says they say on
current master, and find what the register missed — **never a broad repo sweep**. Where the
citation table above flags a bug ID, search within the files that ID's evidence already
names; do not expand beyond them without a specific reason. Classify every bug ID as
`CONFIRMED on master@<sha>`, `ALREADY FIXED (evidence)`, or `EVIDENCE MOVED (new path:line)`
before writing any code. An already-fixed ID is flipped in the register with its evidence —
never silently carried, never silently dropped.
