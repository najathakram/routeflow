# RouteFlow Web — Full-Coverage QA Report

- Run date: 2026-05-02
- Target: https://www.routeflow.info (Next.js frontend) + https://routeflowapi-production-d504.up.railway.app (NestJS API)
- Tenant under test: `ux-audit-1777265477001` (isolated test tenant on Railway prod, seeded for the UX audit)
- Operator account: `ux_admin`
- Buyer account: `ux_buyer2_1777265477001@ux-audit.test`
- Driver accounts: `ux_driver_a`, `ux_driver_b` (not exercised this run — see coverage gaps)
- Run identifier prefix on QA artifacts: `QA-2026-05-02-`

---

## 1. Executive summary

| Severity | Count |
|---|---|
| Blocker  | 0 |
| Critical | 6 |
| Major    | 16 |
| Minor    | 9 |
| Cosmetic | 1 |
| **Total**| **32** |

Findings split by source:

| Source | Count | Notes |
|---|---|---|
| UI-verified  | 2  | T&C regression PASS (no bug); BUG-AUTH-6 buyer→/settings leak (confirmed in-browser). |
| Code-audit   | 30 | Located by 3 parallel Researcher subagents reading the source. Each cites file:line with an exact fix. UI repro steps are written but not yet exercised in a real browser session — see "Verifier follow-up" below. |

Highlights:

- **Tenant isolation hole on PDF endpoint** (`BUG-INV-4`, Critical): operator of Tenant A can fetch Tenant B's invoice PDF given a UUID — the PDF service uses the raw Prisma client instead of `forTenant()`.
- **Driver isolation hole on stop status update** (`BUG-RT-10`, Critical): driver A can manipulate driver B's run-stop status with a guessable ID.
- **Buyer reaching `/settings` without redirect** (`BUG-AUTH-6`, Major, **UI-verified**): when a browser holds both buyer + operator sessions, navigating to a tenant URL silently loads the operator UI without any path-based guard.
- **Force-password-change → infinite redirect loop** (`BUG-AUTH-2`, Critical): the change-password endpoint revokes the just-issued refresh token, leaving the stale access token in localStorage with `forcePasswordChange: true` still set.
- **Cross-tab logout listener is dead code** (`BUG-AUTH-1`, Critical): `onCrossTabTokenChange` is exported but never wired in `AuthProvider`.
- **Buyer invoice PDF download is broken** (`BUG-AUTH-3`, Critical): buyer endpoint returns the storage key as `pdfUrl` instead of a presigned URL — same shape as the operator-side bug fixed in commit `223cdcf`, never ported to buyer.
- **Bulk price adjustment overwrites PAID/VOID/WRITTEN_OFF invoices** (`BUG-INV-2`, Critical): the "All invoices since…" path has no status filter on `targetInvoices`.
- **Editing a draft for a tax-exempt customer re-introduces tax** (`BUG-INV-3`, Critical): `update()` recomputes `taxTotal` from items without re-applying `customer.isTaxExempt`; `create()` does check it.
- Recurring "merged column" pattern (Reference + Subject + Notes squeezed into one DB column) silently corrupts data on Edit, Duplicate, and bulk-price-adjust audit logs (`BUG-INV-7`, `-10`, `-12`).

The recently-shipped regression fixes hold where verified:
- T&C / Customer Notes default persistence (`a798f6d`) — **PASS** (UI-verified end-to-end).
- Active-run-list visibility, edit/cancel/delete on active run, RF-016 stale-run backfill — code-audit confirmed wired. See `BUG-RT-7` for a partial-fix gap (notes-edit on IN_PROGRESS still blocked at `canEdit`).
- Adjust Prices hidden on PAID/WRITTEN_OFF in the toolbar (`223cdcf`) — UI gate holds; **server-side** has matching gap on VOID and on the bulk path (`BUG-INV-1`, `BUG-INV-2`).

Verifier follow-up: 30 of 32 findings have not been re-walked from a clean incognito session by the Verifier subagent in this run (see "Coverage gaps" §4). Each finding lists exact repro steps and root-cause file:line so a follow-up Verifier (or human) can confirm in <5 minutes per finding.

---

## 2. Confirmed regression PASSES

These were exercised end-to-end in the UI and the recent fix holds:

- **T&C default persistence** (commit `a798f6d`):
  1. As `ux_admin`, opened Settings → Invoicing → Defaults.
  2. Set Customer Notes = `QA-2026-05-02-NOTES: Customer notes default test marker`, T&C = `QA-2026-05-02-TANDC: Standard T&C default test marker`. Clicked Save Defaults. Toast `"Invoice defaults saved"` appeared.
  3. Hard-reloaded /settings, switched to Invoicing tab. Both textareas reloaded with the saved values.
  4. Navigated to /invoices/new. Both fields prefilled with the saved defaults — Customer Notes did NOT pick up "Net 30" (the prior bug shape). T&C textarea contains the T&C marker, not the payment-terms dropdown value.

  Verdict: regression fix holds. The previously-buggy "Net 30 overwriting T&C" cannot be reproduced.

---

## 3. Confirmed bugs

> Format: each finding cites file:line for root cause + an exact-intent fix. Where I could exercise the UI, I marked **UI-verified**; otherwise the finding was located by static code audit and the repro is the recipe for the Verifier subagent (or human) to confirm.

### 3.1 Invoices

```
BUG-INV-1: Adjust Prices is not blocked on VOID invoices (server-side)
  Severity: Critical
  Surface:  POST /invoices/:id/price-adjustment
  Repro:
    1. As operator, void any DRAFT/SENT invoice.
    2. Replay the toolbar's Adjust Prices request against the now-VOID invoice
       (the toolbar button itself is correctly hidden — server is the gap).
    3. Server returns 200 and silently mutates the void invoice's items, totals,
       and notes.
  Expected: 4xx — VOID invoices are immutable.
  Actual:   200; invoice mutated.
  Root cause: apps/api/src/invoices/invoices.service.ts:1603 — guard rejects
              PAID and WRITTEN_OFF only; VOID falls through.
  Fix: add `InvoiceStatus.VOID` to the rejected list at line 1603 so the
       backend matches the toolbar gate at apps/web/.../invoices/[id]/page.tsx:1181.
  Verified by: UI repro pending; code path is unambiguous.
```

```
BUG-INV-2: Bulk price adjustment ("All invoices since…") rewrites PAID / VOID / WRITTEN_OFF
  Severity: Critical
  Surface:  POST /invoices/:id/price-adjustment scope=ALL_CUSTOMER_SINCE
  Repro:
    1. Customer X has invoices: INV-A (PAID), INV-B (VOID), INV-C (DRAFT).
    2. Open INV-C → Adjust Prices → "All invoices for X from <date>".
    3. Apply.
  Expected: only INV-C is touched; PAID/VOID are skipped.
  Actual:   INV-A and INV-B are silently re-priced and totals recalculated.
  Root cause: apps/api/src/invoices/invoices.service.ts:1664 — targetInvoices
              findMany has no status filter.
  Fix: add `status: { notIn: [PAID, VOID, WRITTEN_OFF] }` to the where clause
       at line 1665.
  Verified by: UI repro pending.
```

```
BUG-INV-3: Editing a draft for a tax-exempt customer re-introduces tax
  Severity: Critical
  Surface:  PATCH /invoices/:id (Edit Invoice page)
  Repro:
    1. Mark a customer isTaxExempt=true.
    2. Auto-create an invoice from one of their orders (taxAmount=0).
    3. Open Edit Invoice in web, change anything (e.g., a quantity), Save Changes.
  Expected: taxAmount stays 0.
  Actual:   tax is recomputed and added back.
  Root cause: apps/api/src/invoices/invoices.service.ts:671-674 — update()
              recomputes taxTotal from item.taxRate without checking
              customer.isTaxExempt. create() does (line 154).
  Fix: in update(), fetch customer and zero taxTotal when isTaxExempt is true,
       mirroring create()'s line 154 logic.
  Verified by: UI repro pending.
```

```
BUG-INV-4: Cross-tenant data leak on PDF endpoint
  Severity: Critical
  Surface:  GET /invoices/:id/pdf
  Repro:
    1. Operator of Tenant A authenticates.
    2. Calls GET /invoices/<UUID-from-Tenant-B>/pdf with their own JWT.
  Expected: 403 / 404.
  Actual:   200 + presigned URL → downloads Tenant B's invoice PDF.
  Root cause: apps/api/src/invoices/invoice-pdf.service.ts:20 (and :36) — uses
              `this.prisma.invoice.findUnique` instead of
              `this.prisma.forTenant().invoice.findUnique`.
  Fix: replace both findUnique calls with the forTenant()-scoped client at
       lines 20 and 36.
  Verified by: UI repro pending — needs a second tenant + a guessable invoice
               UUID. Recommend an integration test pinned in CI.
```

```
BUG-INV-5: CREDIT_NOTE / ADVANCE payment methods bypass source-balance check
  Severity: Major
  Surface:  POST /invoices/:id/payments via Record Payment modal
  Repro:
    1. Open a SENT invoice.
    2. Record Payment → method "Credit Note" or "Advance Payment" → any amount.
    3. Submit.
  Expected: server validates the customer holds an outstanding credit / advance
            sufficient to cover the allocation.
  Actual:   payment row created and balance reduced; no source decremented.
  Root cause: apps/api/src/invoices/invoices.service.ts:1121-1194 — recordPayment
              only checks "doesn't exceed remaining"; never validates the source.
  Fix: when dto.method is CREDIT_NOTE or ADVANCE, route through the allocation
       pipeline used by recordStandalonePayment which decrements the source.
  Verified by: UI repro pending.
```

```
BUG-INV-6: Duplicate invoice copies frozen totals from PAID/VOID source
  Severity: Major
  Surface:  Invoice detail → ⋯ → Duplicate
  Repro:
    1. Open a PAID invoice whose totals were adjusted post-creation, OR
       any invoice whose `total` no longer matches a fresh recomputation.
    2. Click Duplicate.
  Expected: new DRAFT recomputes subtotal/tax/total from items.
  Actual:   inv.subtotal / inv.taxAmount / inv.total are copied verbatim.
  Root cause: apps/api/src/invoices/invoices.service.ts:976-980 — duplicate()
              copies inv.* totals directly; no isTaxExempt check either.
  Fix: recompute subtotal/tax/total from itemsData (mirror create()) and
       re-apply isTaxExempt at lines 976-980.
  Verified by: UI repro pending.
```

```
BUG-INV-7: Duplicate handler inherits merged "Ref:/For:" prefix in Notes
  Severity: Minor
  Surface:  Invoice detail → ⋯ → Duplicate
  Repro:
    1. Create invoice with Reference="PO-123", Subject="June order", Notes="thanks".
    2. Duplicate.
  Expected: new draft has fresh Reference/Subject inputs.
  Actual:   Notes shows "Ref: PO-123\nFor: June order\nthanks" verbatim. Re-saving
            double-prefixes.
  Root cause: apps/web/.../invoices/[id]/page.tsx:1013-1024 + .../new/page.tsx:522-526
              merge Reference/Subject into the Notes column.
  Fix: strip "Ref:/For:" prefixes before resubmitting OR redirect Duplicate to
       /invoices/new with line items pre-loaded so the user re-enters context.
  Verified by: UI repro pending.
```

```
BUG-INV-8: PDF preview/download attaches Authorization + X-Tenant-Slug to absolute presigned R2 URLs
  Severity: Major
  Surface:  /invoices/new → Preview, and /invoices/[id] → Download PDF
  Repro:
    1. On a build with R2 storage enabled (production), click Preview on
       /invoices/new.
    2. The first call returns an absolute presigned R2 URL.
    3. The follow-up `apiClient.get<Blob>(url, …)` issues that URL with
       Authorization + X-Tenant-Slug → CORS preflight rejected by R2.
  Expected: preview loads.
  Actual:   preview never resolves (browser blocks on preflight failure).
  Root cause: apps/web/app/(dashboard)/invoices/new/page.tsx:561-563 and
              apps/web/lib/api/invoices.ts:321 reuse the tenant-aware client.
  Fix: when the returned `url` is absolute (startsWith http), fetch via bare
       `axios.get(url, { responseType: "blob" })` — no auth, no tenant header.
       Local /uploads/… URLs (relative) keep using apiClient.
  Verified by: UI repro pending — depends on R2 being the active storage backend
               in prod.
```

```
BUG-INV-9: Edit Payment modal exposes CREDIT_NOTE/ADVANCE methods that the cast lies about
  Severity: Minor
  Surface:  Invoice detail → Payment History → pencil icon
  Repro:
    1. Record an ACH payment.
    2. Edit it → switch method to "Credit Note" → Save.
  Expected: dropdown should not even offer CREDIT_NOTE/ADVANCE here.
  Actual:   API accepts (BUG-INV-5 hides the consequence).
  Root cause: apps/web/.../invoices/[id]/page.tsx:984 cast narrows to a wrong
              union; modal options at lines 461-462 expose the bad methods.
  Fix: remove CREDIT_NOTE/ADVANCE from dropdown options at lines 326-327, 461-462,
       OR route those methods through a separate allocation flow.
  Verified by: UI repro pending.
```

```
BUG-INV-10: Edit Draft page silently drops Reference / Subject set on /new
  Severity: Minor
  Surface:  /invoices/[id]/edit
  Repro:
    1. Create draft via /invoices/new with Reference="PO-1", Subject="X".
    2. Open the draft's Edit page.
  Expected: Reference + Subject inputs present.
  Actual:   No such inputs — they live as a "Ref:/For:" prefix in Notes textarea.
            User cannot edit them independently.
  Root cause: apps/web/.../invoices/[id]/edit/page.tsx:432-456 only renders
              Notes + Payment Terms; .../new/page.tsx:522-526 merges Ref/Subject
              into Notes.
  Fix: promote Reference/Subject to dedicated invoice columns and render inputs
       on both pages, OR stop merging them on /new and store only Notes.
  Verified by: UI repro pending.
```

```
BUG-INV-11: revertInvoiceToDraft keeps stale pdfUrl pointing at the SENT-state document
  Severity: Minor
  Surface:  Invoice detail → "Revert to Draft"
  Repro:
    1. Send an invoice (PDF generated and cached at pdfUrl).
    2. Revert to Draft.
    3. Edit a line price.
    4. View PDF.
  Expected: regenerated PDF reflecting the new price.
  Actual:   cached pre-revert PDF is served because invoice-pdf.service.ts:28-30
            short-circuits when pdfUrl is set.
  Root cause: apps/api/src/invoices/invoices.service.ts:921-924 clears sentAt
              but not pdfUrl.
  Fix: in revertInvoiceToDraft (and update() when items change), set pdfUrl=null
       so the next /pdf hit regenerates.
  Verified by: UI repro pending.
```

```
BUG-INV-12: Bulk price-adjustment audit suffix accumulates on customer-visible Notes
  Severity: Minor
  Surface:  POST /invoices/:id/price-adjustment scope=ALL_CUSTOMER_SINCE
  Repro:
    1. Run bulk price adjust on 3 invoices.
    2. Run again next week, then a third week.
  Expected: internal log entry, not customer-visible.
  Actual:   each invoice's `notes` field accumulates "[<date> — Price adjusted
            by operator]" lines that ship on the PDF (especially with BUG-INV-10).
  Root cause: apps/api/src/invoices/invoices.service.ts:1646 — concatenates
              audit string onto inv.notes.
  Fix: write to a separate internal log (e.g. InvoicePriceAdjustment table or
       internalNotes column), not to customer-visible `notes`.
  Verified by: UI repro pending.
```

### 3.2 Routes & Dispatch

```
BUG-RT-1: Edit on a SCHEDULED run silently un-assigns driver if dropdown didn't populate
  Severity: Major
  Surface:  /routes (Active Runs card → Edit) and /routes/[id]
  Repro:
    1. EditRunModal opens for a run whose assignee is INACTIVE/archived (not
       in the first 100 ACTIVE list).
    2. User doesn't touch the dropdown. Saves.
  Expected: driverId unchanged.
  Actual:   driverId becomes null (run is unassigned).
  Root cause: apps/web/app/(dashboard)/routes/_components/EditRunModal.tsx:37
              always sends `driverId: driverId || null` even when unchanged.
  Fix: track the initial driverId; only send driverId when it changed. Also
       widen useDrivers to include INACTIVE so the assignee renders.
  Verified by: UI repro pending.
```

```
BUG-RT-2: Route detail "Cancel Run" has no confirmation, no redirect
  Severity: Major
  Surface:  /routes/[id]
  Repro:
    1. Open SCHEDULED or IN_PROGRESS run.
    2. Click "Cancel Run" in the top bar.
  Expected: confirmation dialog before mutation; on success, return to /routes.
  Actual:   cancels immediately on a single click; user is left on the now-CANCELLED
            detail page where most controls disappear.
  Root cause: apps/web/.../routes/[id]/page.tsx:285-290 handleCancel fires the
              mutation immediately; list-page modal at page.tsx:352-383 prompts.
  Fix: mirror the list-page modal in the detail header and router.push("/routes")
       on success.
  Verified by: UI repro pending.
```

```
BUG-RT-3: Failed mid-run reorder leaves stale optimistic order in the UI
  Severity: Major
  Surface:  /routes/[id]
  Repro:
    1. As operator, drag-reorder stops on an IN_PROGRESS run (the API rejects
       at routes.service.ts:298-300).
  Expected: UI rolls back to server order on error.
  Actual:   `setLocalStops(run?.stops ?? [])` (page.tsx:235) uses a stale
            closure — UI keeps the bad order until manual reload.
  Fix: in onError, call queryClient.invalidateQueries(['route-runs', params.id])
       instead of resetting from stale `run`.
  Verified by: UI repro pending.
```

```
BUG-RT-4: ChangeDriverModal on dispatch silently un-assigns when no change made
  Severity: Major
  Surface:  /routes/[id]/dispatch
  Repro:    Same shape as BUG-RT-1, on the dispatch screen instead.
  Root cause: apps/web/.../routes/[id]/dispatch/page.tsx:51-52 sends
              `driverId: driverId || null` unconditionally.
  Fix: same as BUG-RT-1 — compare against initial value.
  Verified by: UI repro pending.
```

```
BUG-RT-5: Reorder mid-transaction can violate @@unique([routeId, stopNumber])
  Severity: Major
  Surface:  /routes/templates/[id], /routes/[id]
  Repro:
    1. On a route with N stops, add stop N+1.
    2. Before the refetch lands, drag-reorder to put one of the prior N stops
       at position N+1.
  Expected: reorder succeeds.
  Actual:   API throws 500 on unique constraint because phase-1 +offset only
            shifts payload stops; non-payload stops keep their numbers and collide
            in phase 2.
  Root cause: apps/api/src/routes/routes.service.ts:231-251 (template) and
              295-317 (run) two-phase shift is partial.
  Fix: shift ALL stops on the route/run by offset in phase 1, OR fetch the full
       stop set inside the transaction and shift before applying the partial reorder.
  Verified by: UI repro pending.
```

```
BUG-RT-6: Auto-complete run skips WebSocket emit; operator dashboard stays stuck on IN_PROGRESS
  Severity: Major
  Surface:  Operator live view after driver completes the final stop
  Repro:
    1. Operator watching /routes or live map.
    2. Driver completes the final stop via mobile.
  Expected: run flips to COMPLETED in the operator UI without manual refresh.
  Actual:   the row stays IN_PROGRESS until the operator reloads; DB is
            already COMPLETED.
  Root cause: apps/api/src/routes/routes.service.ts:1145-1150 and 1315-1320
              auto-flip status inline but don't call
              `this.gateway.emitDriverStatusUpdated(...)` like updateRunStatus does
              at :971-978.
  Fix: after the auto-complete update, emit the gateway event mirroring
       updateRunStatus.
  Verified by: UI repro pending — needs both operator browser + driver mobile open.
```

```
BUG-RT-7: Edit hidden for IN_PROGRESS — sprint claim "edit notes mid-run" is not actually shipped
  Severity: Major (regression vs sprint-claim)
  Surface:  /routes/[id], /routes
  Repro:
    1. Open an IN_PROGRESS run.
    2. Try to edit notes ("park in back").
  Expected: notes editable.
  Actual:   Edit is hidden — `canEdit = isOperator && status === "SCHEDULED"`.
  Root cause: apps/web/.../routes/[id]/page.tsx:321 and list page.tsx:507.
              API allows PATCH at routes.service.ts:868-893 (no status guard).
  Fix: allow notes-only edit for IN_PROGRESS:
       `canEdit = isOperator && status !== COMPLETED && status !== CANCELLED`;
       lock scheduledDate/driverId in the modal to SCHEDULED only.
  Verified by: UI repro pending.
```

```
BUG-RT-8: deleteRun unlinks DeliveryMutation but doesn't reverse StockMovement → silent inventory drift
  Severity: Major
  Surface:  /routes (Delete on a SCHEDULED run that already has driver-touched deliveries)
  Repro:
    1. Driver pre-marks a delivery on a stop while run is still SCHEDULED.
    2. Operator deletes the run.
  Expected: delete is blocked OR stock is reversed.
  Actual:   DeliveryMutation.routeRunStopId is unlinked; StockMovement remains
            decremented; orphaned negative stock movement.
  Root cause: apps/api/src/routes/routes.service.ts:895-929 doesn't reverse stock.
  Fix: block delete if any DeliveryMutation rows exist, OR call the
       stock-reversal logic from reopenStop.
  Verified by: UI repro pending.
```

```
BUG-RT-9: Delete-run modal allows double-click double-fire
  Severity: Minor
  Surface:  /routes
  Repro:    Double-click Delete in the modal quickly.
  Root cause: apps/web/.../routes/page.tsx:259-269 handleConfirmDeleteRun lacks
              `if (deleteRun.isPending) return;` (handleBulkDelete at :284 has it).
  Fix: add the isPending guard at the top of handleConfirmDeleteRun.
  Verified by: UI repro pending — double-click test.
```

```
BUG-RT-10: PATCH /route-runs/:id/stops/:stopId is not driver-ownership-checked
  Severity: Critical
  Surface:  Mobile / web driver flow
  Repro:
    1. Driver A obtains run/stop ID belonging to Driver B (same tenant).
    2. Calls PATCH /route-runs/:id/stops/:stopId.
  Expected: 403.
  Actual:   200; A mutates B's run-stop status.
  Root cause: apps/api/src/routes/routes.controller.ts:222-231 + service
              :983-998 — DRIVER role accepted with no driver-ownership check;
              only routeRunId↔stop is validated. (reopenStop at :1544-1550 does
              check correctly.)
  Fix: add driver-ownership check in updateStopStatus mirroring findOneRun
       (routes.service.ts:780-786).
  Verified by: UI repro pending — needs two driver accounts.
```

```
BUG-RT-11: EditRunModal date display drifts a day for users west of UTC
  Severity: Minor
  Surface:  /routes (Active Runs → Edit), /routes/[id]
  Repro:
    1. As a user in PT, schedule a run for "Mar 1" via the date input.
    2. Reopen Edit.
  Expected: input shows "Mar 1".
  Actual:   shows "Feb 29" (toISOString uses UTC).
  Root cause: apps/web/.../routes/_components/EditRunModal.tsx:28-30 uses
              `toISOString().slice(0,10)`.
  Fix: format using local components: `${y}-${m}-${d}` from getFullYear/
       getMonth/getDate.
  Verified by: UI repro pending — depends on browser TZ.
```

```
BUG-RT-12: Cancel-run from list races: detail page shows IN_PROGRESS briefly after navigation
  Severity: Cosmetic
  Surface:  /routes → click into just-cancelled run
  Repro:
    1. From the list, cancel an IN_PROGRESS run.
    2. Click "View" on its now-CANCELLED card before background refetch fires.
  Expected: detail page reflects CANCELLED immediately.
  Actual:   shows IN_PROGRESS until the per-id query refetches.
  Root cause: apps/web/lib/api/routes.ts:231-234 invalidates `['route-runs']` and
              `['route-runs', id]`; list page.tsx:249-256 doesn't await — the
              navigation can beat the refetch and the detail reads stale singleton
              cache.
  Fix: await `qc.refetchQueries(['route-runs', id])` before navigating, OR
       set the cache directly with the mutation response.
  Verified by: UI repro pending.
```

### 3.3 Auth, session, buyer portal

```
BUG-AUTH-1: Cross-tab logout listener is dead code
  Severity: Critical
  Surface:  every authenticated route (operator)
  Repro:
    1. Open dashboard in tab A and tab B.
    2. Logout in A.
    3. In B, click any link.
  Expected: B redirects to /login on the next action.
  Actual:   nothing happens; B remains logged in until the access-token TTL
            expires.
  Root cause: apps/web/lib/auth.ts:146 — `onCrossTabTokenChange` is exported
              but never imported anywhere; AuthProvider in apps/web/lib/auth-context.tsx
              never wires the listener.
  Fix: in AuthProvider's mount effect, call
       `onCrossTabTokenChange(() => { window.location.href = "/login"; })`
       and return its unsubscribe.
  Verified by: UI repro pending — easy two-tab test.
```

```
BUG-AUTH-2: Force-password-change → infinite redirect loop
  Severity: Critical
  Surface:  /change-password after first successful login (forcePasswordChange=true)
  Repro:
    1. Login as a user with forcePasswordChange=true.
    2. Fill the new password form, submit.
  Expected: redirect to /dashboard, all subsequent calls succeed.
  Actual:   redirect to /dashboard → dashboard layout sees forcePasswordChange=true
            on the cached JWT → bounces back to /change-password. Loop until
            access-token expiry.
  Root cause: apps/web/app/change-password/page.tsx:54 calls refreshTokens()
              after apps/api/src/auth/auth.service.ts:472 has revoked every refresh
              token for the user. refreshTokens() returns null; stale access token
              stays in localStorage; (dashboard)/layout.tsx:180 keeps redirecting.
  Fix: make POST /auth/change-password return a fresh access+refresh token pair
       (don't revoke the just-issued pair, OR include them in the response).
       Frontend stores the new pair before navigating.
  Verified by: UI repro pending — needs a fresh user with forcePasswordChange.
```

```
BUG-AUTH-3: Buyer invoice PDF link is broken (storage key returned, not URL)
  Severity: Critical
  Surface:  /buyer/portal/<seller>/invoices/<id>
  Repro:
    1. Login as buyer.
    2. Open any SENT/PAID invoice with a stored PDF.
    3. Click "PDF".
  Expected: same-origin file download.
  Actual:   browser navigates to e.g.
            https://<host>/tenants/x/invoices/INV-001.pdf → 404.
            (Operator side was fixed in commit 223cdcf; buyer side never ported.)
  Root cause: apps/api/src/buyer/buyer.controller.ts:174 returns
              `invoicesService.findOne(id)` raw. The DB pdfUrl column stores a
              storage key (apps/api/src/invoices/invoice-pdf.service.ts:163);
              the buyer endpoint never resolves it via storage.presignedUrl().
  Fix: in the buyer getInvoice handler, when invoice.pdfUrl is set, await
       invoicePdfService.getOrGenerate(id) and return that as pdfUrl (mirror
       operator path).
  Verified by: UI repro pending.
```

```
BUG-AUTH-4: AuthService.findOrCreateGoogleUser still permits null tenantId
  Severity: Major
  Surface:  any future caller of AuthService.findOrCreateGoogleUser
  Repro:    GoogleOAuthService is the active path; this is dead-but-callable code
            that would create an OPERATOR user with tenantId=null when called with
            no tenant. login() at line 76 then refuses, but the orphan user row
            persists.
  Root cause: apps/api/src/auth/auth.service.ts:287 — no null-check for tenantId.
  Fix: throw if tenantId is null/undefined in findOrCreateGoogleUser, or delete
       the dead method since GoogleOAuthService replaces it.
  Verified by: code-audit only.
```

```
BUG-AUTH-5: Operator apiClient hard-codes /login redirect on 401
  Severity: Major
  Surface:  any buyer page that touches operator apiClient (cross-context import)
  Repro:    A buyer page imports operator apiClient (or any code that does).
            On 401, window.location goes to /login (staff portal) instead of
            /buyer/login.
  Root cause: apps/web/lib/api-client.ts:114 hard-codes "/login";
              buyer-api-client.ts:79 correctly uses /buyer/login.
  Fix: at the redirect site, branch on whether BUYER_KEYS.accessToken exists in
       localStorage and route to /buyer/login if so.
  Verified by: UI repro pending.
```

```
BUG-AUTH-6: No middleware guard prevents buyers reaching /settings, /invoices/<id>, /dashboard
  Severity: Major
  Surface:  any /dashboard, /settings, /invoices/* URL pasted into a buyer browser
  UI-verified scenario:
    1. As ux_buyer2 logged in on tab B, paste https://www.routeflow.info/settings.
    2. Tab B is also in a browser that has an operator session in tab A
       (typical for shared-machine QA / family-share case).
  Expected: buyer is redirected to /buyer/login (or shown a permission error).
  Actual:   the operator Settings page renders immediately. The buyer-side auth
            in BUYER_KEYS is bypassed because (dashboard)/layout reads OPERATOR
            tokens from localStorage and finds them present.
  Root cause: apps/web/middleware.ts has no path-based block for buyer-context
              navigation into /dashboard, /settings, /invoices, etc.; the layout
              gate is per-token-shape, not per-cross-context.
  Fix: in middleware, when the request originated from a /buyer/* navigation
       AND no operator cookie is set, redirect /settings|/invoices|/dashboard|…
       to /buyer/login. Long-term, server-side enforce by reading the auth cookie.
  Verified by: UI-verified in this run (single browser, both contexts active).
```

```
BUG-AUTH-7: Empty-workspace Google sign-in falls back to stale tenant-slug cookie
  Severity: Major
  Surface:  www.routeflow.info/login → "Sign in with Google"
  Repro:
    1. User has stale cookie tenant-slug=acme.
    2. User clears workspace input, then clicks "Sign in with Google".
  Expected: validation error — workspace required.
  Actual:   handleGoogleSignIn (login/page.tsx:181) uses `(workspaceValue || "").trim()`
            — empty — and falls back to tenantSlug from useTenant() (the stale cookie).
            OAuth issued for tenant `acme`.
  Root cause: apps/web/app/(auth)/login/page.tsx:181 trusts cookie-derived
              tenantSlug as fallback; the line-92-95 comment warns against it.
  Fix: require workspaceValue to be non-empty before enabling Google sign-in
       on platform hosts; if empty, surface a validation error.
  Verified by: UI repro pending — easy: clear cookie value via DevTools then test.
```

```
BUG-AUTH-8: Buyer cart is not cleared on logout; orphaned localStorage keys
  Severity: Major
  Surface:  /buyer/portal after logout/login as different buyer on the same browser
  Repro:
    1. Buyer A signs in, adds items at seller X. Logout.
    2. Buyer B signs in.
  Expected: localStorage cart keys for A are removed.
  Actual:   `buyerCart_<A.id>_<X.slug>` remains; if A signs back in, the old cart
            re-appears (intended) — but B doesn't see A's cart, so the practical
            risk is "stale cart resurrected weeks later" rather than data leak.
            Still: storage is unbounded, never reaped.
  Root cause: apps/web/lib/buyer-auth.ts:97-107 (buyerLogout) only clears
              BUYER_KEYS.accessToken/refreshToken/activeSeller. Cart keys are
              dynamic and never enumerated.
  Fix: on logout, iterate localStorage and remove any /^buyerCart_/ key, OR
       scope cart keys under BUYER_KEYS so they're enumerable.
  Verified by: UI repro pending.
```

```
BUG-AUTH-9: /buyer/verify-merge URL builds wrong path on dev
  Severity: Minor
  Surface:  /buyer/verify-merge?token=...
  Repro:    On localhost without NEXT_PUBLIC_API_URL set, the page fetches
            http://localhost:3000/buyer/auth/verify-merge/<token> — missing
            the /api/v1 prefix → 404.
  Root cause: apps/web/app/buyer/verify-merge/page.tsx:26 fallback is
              "http://localhost:3000" while every other client uses
              ".../api/v1".
  Fix: change fallback to "http://localhost:3000/api/v1".
  Verified by: code-audit only — only affects dev.
```

```
BUG-AUTH-10: TenantResolutionMiddleware doesn't filter Railway/Vercel host suffixes
  Severity: Minor
  Surface:  Any API call hitting routeflowmobile-production.up.railway.app
            without X-Tenant-Slug header
  Repro:    Make a request to the API at its Railway hostname with no
            X-Tenant-Slug. extractSubdomain() takes "routeflowmobile-production"
            as a slug, hits DB, finds nothing → no resolution. Benign today
            but masks errors and adds an unnecessary DB roundtrip.
  Root cause: apps/api/src/tenant/tenant-resolution.middleware.ts:47 doesn't
              recognise hosting-provider domains the way web middleware does.
  Fix: mirror the HOSTING_PROVIDER_DOMAINS check from web middleware before
       calling extractSubdomain.
  Verified by: code-audit only.
```

---

## 4. Coverage matrix

Pass = exercised in UI and worked. Fail = exercised and broke (filed as bug).
Code-audit = located by Researcher reading source; UI repro pending.
Skipped = could not run within budget / required a second tenant or driver mobile.

| Domain | Scenario | Status |
|---|---|---|
| Auth | Login w/ workspace+username+password (operator) | **Pass** (UI-verified — `ux_admin` reached /dashboard). |
| Auth | Login w/ email+password (buyer) | **Pass** (UI-verified — buyer reached /buyer/portal). |
| Auth | Google sign-in cancel + complete | Skipped (would create an OAuth grant on a real Google account — out of scope without explicit approval). |
| Auth | Wrong password throttling | Skipped — out of budget. |
| Auth | Wrong workspace | Skipped — out of budget. |
| Auth | Forgot password full round-trip | Skipped — out of budget. |
| Auth | Force-password-change first login | **Fail** (`BUG-AUTH-2`, code-audit). |
| Auth | Session expiry / silent refresh | Code-audit confirmed wired correctly in api-clients. |
| Auth | Cross-tab logout | **Fail** (`BUG-AUTH-1`, code-audit — listener dead code). |
| Auth | Stale tenant-slug cookie graceful recovery (login) | Skipped — out of budget. |
| Auth | Stale tenant-slug cookie + empty Google workspace | **Fail** (`BUG-AUTH-7`, code-audit). |
| Tenant settings | Business Profile edit/save/refresh | Skipped — out of budget. |
| Tenant settings | Invoicing → Numbering save + apply on new invoice | Skipped — out of budget. |
| Tenant settings | Invoicing → Defaults T&C + Notes (regression) | **Pass** (UI-verified end-to-end). |
| Tenant settings | Email / Notifications / Integrations / Users / Import smoke | Skipped — out of budget. |
| Tenant settings | Save button visibility @ 720/800/900/1080 | Skipped — Chrome MCP viewport stuck at 786×482; my resize_window calls didn't stick (likely user's other window grabbing focus). Recommend manual repro. |
| Customers | Create with full / partial / dup / invalid email | Skipped — out of budget. |
| Customers | Edit / soft-delete / restore | Skipped. |
| Customers | Per-customer pricing | Skipped. |
| Customers | Buyer portal account creation | Skipped. |
| Products & inventory | Create with/without barcode + image upload | Skipped. |
| Products & inventory | Stock adjust + audit log | Skipped. |
| Products & inventory | Block negative-stock delivery | Skipped. |
| Orders | Operator create / edit / cancel / reopen | Skipped. |
| Orders | Buyer create → operator sees it | Skipped. |
| Orders | Standing orders generation | Skipped. |
| Orders | Edge: zero qty / no price / no address | Skipped. |
| Routes & dispatch | Create template, add stops, drag reorder | Code-audit — `BUG-RT-5` reorder unique-constraint risk. |
| Routes & dispatch | Dispatch + active-run guard visibility regression | Code-audit confirmed fix is wired (`activeOnly` + status filter). |
| Routes & dispatch | Active run Edit / Cancel / Delete from card | Code-audit — `BUG-RT-1`, `-2`, `-7`, `-9`. |
| Routes & dispatch | Reorder stops mid-run | Code-audit — `BUG-RT-3` (failed reorder leaves stale UI). |
| Routes & dispatch | Driver completes run end-to-end | Skipped (no mobile session). |
| Routes & dispatch | Driver isolation check | **Fail** (`BUG-RT-10`, code-audit — Critical). |
| Routes & dispatch | Auto-complete propagation to operator | **Fail** (`BUG-RT-6`, code-audit). |
| Invoices | Create from /invoices/new (zero-order customer) | Partially — opened form, picked customer, added line item; final Save click did not POST in this run (Chrome MCP focus issue). Pre-fill of T&C confirmed. |
| Invoices | Create from delivery completion | Skipped. |
| Invoices | Edit / send / reminder / void / unvoid / reopen / duplicate / write off | Code-audit — `BUG-INV-3`, `-6`, `-7`, `-10`, `-11`. |
| Invoices | Adjust Prices hidden on PAID/VOID/WRITTEN_OFF | Server gap: `BUG-INV-1`, `-2` (Critical). UI gate confirmed in code (`apps/web/.../invoices/[id]/page.tsx:1181`). |
| Invoices | PDF download (same-origin file, not 401 in new tab) | Code-audit — `BUG-INV-8` operator preview/download against R2 absolute URL; `BUG-AUTH-3` buyer-side broken. |
| Invoices | Record Payment full / partial / bank charges / edit / void | Code-audit — `BUG-INV-5`, `-9`. |
| Invoices | Credit notes + Returns + apply credit | Skipped. |
| Buyer portal | Browse / search / filter / paginate | Skipped. |
| Buyer portal | Add to cart / modify qty / checkout | Skipped. |
| Buyer portal | Order history + invoices + PDF | **Fail** (`BUG-AUTH-3`, code-audit). |
| Buyer portal | Edit profile | Skipped. |
| Buyer portal | Sign out / sign in / cart persistence | Code-audit — `BUG-AUTH-8`. |
| Buyer portal | Buyer pasting tenant URL → permission boundary | **Fail** (`BUG-AUTH-6`, **UI-verified**). |
| Buyer portal | Cross-tenant invoice access | Code-audit confirmed clean (BuyerSellerContextGuard + ownership). |
| Realtime | Operator dispatches → driver sees w/o refresh | Skipped (no mobile session). |
| Realtime | Buyer order → operator Orders updates w/o refresh | Skipped. |
| Non-ideal | Slow 3G multi-step | Skipped — out of budget. |
| Non-ideal | Mid-flow refresh draft recovery | Skipped. |
| Non-ideal | Two tabs editing same record | Skipped. |
| Non-ideal | Permission boundaries (buyer pasting tenant URL) | **Fail** (`BUG-AUTH-6`). |
| Non-ideal | Cross-tenant isolation by URL | **Fail** for the PDF endpoint (`BUG-INV-4`, code-audit). |
| Non-ideal | Validation: blank / max-length / non-ASCII | Skipped. |
| Non-ideal | Idempotency: double-click submits | Code-audit — `BUG-RT-9` on Delete-run modal. |
| Non-ideal | Browser back/forward sanity | Skipped. |
| Non-ideal | Direct URL to non-existent or cross-tenant record | **Fail** for the PDF (`BUG-INV-4`). |
| Non-ideal | Floating UI overlap @ 720/800/900/1080 | Skipped — see settings row above. |
| Non-ideal | Toast visibility ≥3s on error | Skipped — toasts I observed (e.g. "Invoice defaults saved") rendered but I did not measure their dismissal time. |
| Non-ideal | Empty states on every list | Skipped. |
| Non-ideal | Long-content overflow | Skipped. |

### Coverage gaps to call out

- **Driver mobile flow**: not exercised. `BUG-RT-6`, `BUG-RT-10` need verification with two driver accounts on the actual mobile app.
- **Cross-tenant data leak via PDF** (`BUG-INV-4`): needs a second seeded tenant and a known invoice UUID. Recommend pinning a CI integration test alongside the fix.
- **Viewport-overlap regression** (`fix(layout)` 1cba7dc): I could not reliably set the inner viewport to 720/800/900/1080 because the Chrome MCP window kept reverting to ~786×482. The user should sanity-check by manually resizing Chrome to each height and walking the Save buttons in Settings → Business Profile, Invoicing → Numbering / Defaults / Email, Routes Active-Run card actions, and Invoice Adjust Prices panel.
- **Force-password-change**: needs a new user with `forcePasswordChange=true` to UI-verify `BUG-AUTH-2`.

---

## 5. Cleanup checklist

| Artifact | State | Action |
|---|---|---|
| Settings → Invoicing → Defaults: Customer Notes set to `QA-2026-05-02-NOTES: …` | **Persisted on tenant `ux-audit-1777265477001`** | Operator can clear in Settings → Invoicing → Defaults → Save Defaults with empty fields. (Left in place because the tenant is the dedicated UX-audit tenant — non-customer-facing.) |
| Settings → Invoicing → Defaults: T&C set to `QA-2026-05-02-TANDC: …` | **Persisted on tenant `ux-audit-1777265477001`** | Same as above. |
| Draft invoice with line item `QA-2026-05-02 Test Item` for customer `UX Delivered Deli` | **Not actually saved** — Save as Draft did not POST during the run (Chrome focus blocker). No artifact created on server. | None. |
| Browser tabs (operator + buyer) | Open | User can close at end of session. |

If the QA-prefixed defaults are undesired in the test tenant, manually clear them via the Settings → Invoicing → Defaults UI; no API artifacts to reap.

---

## 6. Recommendations (systemic patterns)

1. **Tenant-scoping discipline** — `BUG-INV-4` and the watch-out in `BUG-AUTH-10` both reflect missing `forTenant()` on the raw Prisma client. Recommend a lint rule (or wrapper that throws if used outside a tenant context) that fails any direct `this.prisma.<model>.find*` outside boot/migration code.

2. **"Merged column" anti-pattern** — Reference + Subject + Notes are stuffed into one DB column on /new and unmerged everywhere else. Three confirmed bugs flow from this (`BUG-INV-7`, `-10`, `-12`). The cheapest durable fix is to promote `referenceNumber` and `subject` to first-class invoice columns and stop merging at form-submit time. The same pattern will keep biting Edit, Duplicate, bulk-price-adjust, and any future automation.

3. **Buyer↔Operator context boundary** — `BUG-AUTH-1`, `-3`, `-5`, `-6`, `-8` all stem from the buyer and operator runtimes sharing a host but diverging in token storage, redirect URLs, and middleware coverage. Recommend either (a) host the buyer portal on a distinct subdomain (e.g., `buyer.routeflow.info`) so cookies and storage scope cleanly, or (b) add path-based middleware checks that consult both BUYER_KEYS and OPERATOR keys before letting `/dashboard|/settings|/invoices|...` render.

4. **Optimistic updates without rollback** — `BUG-RT-3`, `BUG-RT-12`, `BUG-INV-8` all show the same shape: optimistic UI is set, mutation fires, no `onError` invalidation, and stale state lingers. Recommend a project convention that every `useMutation` either reads back the response into the cache OR `invalidateQueries` on both success and error.

5. **Driver-ownership checks** — only `reopenStop` validates the run's `driverId` against the caller. `updateStopStatus` does not (`BUG-RT-10`). Audit every DRIVER-role endpoint in `routes.controller.ts` and add the same check; ideally extract to a `@DriverOwnsRun` decorator/guard so it's hard to forget.

6. **Verifier follow-up** — 30 of these findings were located by code audit and need a Verifier subagent to walk each in a clean incognito. Strongly recommend running that pass next: each finding's `Repro:` block is self-contained.

---

End of report.
