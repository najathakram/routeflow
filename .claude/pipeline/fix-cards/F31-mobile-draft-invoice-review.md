# F31 · Mobile draft-invoice review before confirm + post-confirm item edit

**Kind:** FEATURE (owner-requested 2026-08-31, board #550) — no register bug IDs; added to the
campaign without disturbing existing waves. **Build slot: after F06 merges** (it rides the FIXED
`updateOrderItems`, not the buggy one) **and after F04** (pricing kernel — regenerated invoice
math must be post-fix). Wave-B position; freely parallel otherwise (mobile UI + one read
endpoint; does not enter the orders/invoices hot-file lanes beyond read-only calls).

## The W's

- **WHO:** tenant operators (and at-counter customers) confirming orders on MOBILE. Frequency:
  every order taken on mobile.
- **WHAT hurts today:** the draft invoice is only seen AFTER confirmation; customers routinely
  ask to add/remove items the moment they see it, and the operator has no in-flow way back —
  they improvise (cancel/re-create, or desktop edit later).
- **WHY now:** owner-reported friction on the primary operator surface (mobile-first program).
- **Success signal:** an operator can, in one mobile flow: review the draft invoice → go back →
  add/remove/update items → see the regenerated draft → confirm. Zero cancel/re-create
  workarounds for "they want one more thing".

## What the repo already gives us (build on, don't rebuild)

- The server ALREADY maintains a DRAFT invoice per order (`reconcileOrderDraftInvoice` —
  invoices.service.ts; forward sync on every order edit). "Regenerate" is therefore **a fetch,
  not a new writer** — editing items re-syncs the draft server-side.
- Item edits = `updateOrderItems` (fixed + authorization-guarded by F06).
- Invoice PDF/preview fetch paths exist (invoice-pdf.service; mobile fetches invoice PDFs
  today in the share flows).
- Mobile mirrors web (house rule): reuse the same endpoints/DTOs; only the UI is new.

## Requirements sketch (S2 firmed at build time)

| R#  | Requirement                                                                                                                                                                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1  | Pre-confirm step on the mobile order flow: "Review draft invoice" prompt showing the order's DRAFT invoice (lines, promos/free units, totals — the fixed renderer basis) before the confirm action commits                                                                                       |
| R2  | From the review, "Edit items" returns to the item list with add/remove/qty update wired through the existing update path; returning to review shows the RE-SYNCED draft (no stale totals — invalidate the draft query on every item mutation)                                                    |
| R3  | Post-confirm, while the invoice is still DRAFT (not SENT/PAID), the order detail keeps an "Edit items & regenerate" affordance with the same loop; it disappears (or demands the proper amend flow) once the invoice leaves DRAFT                                                                |
| R4  | Tenant-level toggle (settings) for the pre-confirm prompt — some tenants will not want the extra step. Default ON only for tenants that opt in (deploy-day answer: nothing changes until a tenant enables it; the gate's writer is the settings UI shipped in the same PR — no writer-less gate) |
| R5  | Offline behavior: the review step requires the server draft; offline ⇒ the prompt degrades honestly ("draft unavailable offline") instead of showing stale numbers                                                                                                                               |

## Non-goals

- No changes to invoice send/status semantics; no new invoice writer (reconcile is the writer).
- No web flow changes (web already shows drafts; parity later if asked).
- Not a fix for the scan-loss bug (F30 — separate, diagnosis-driven).

## Risks / dependencies

- F06 (updateOrderItems guards) and F04 (pricing kernel) MUST be live first — otherwise the
  review screen would faithfully display wrong numbers.
- Client-2 residual "order-edit tier race" lives on this path; F31's spec must re-check it at
  build time and either inherit the fix or fence it explicitly.
- UI: `ui: true` — S3 UX pass + design-system derivation mandatory at build.
