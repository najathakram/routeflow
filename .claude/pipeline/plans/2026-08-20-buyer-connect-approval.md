# Plan: buyer connect flow — identity-gated auto-connect, real requests, notifications until addressed

> Authored by Fable 5 on 2026-08-20. Status: APPROVED
> This file is the ONLY context the implementation and review agents receive.
> It must stand alone: no references to "the conversation", no "as discussed".

## Objective

Owner-specified behaviour for a buyer connecting to a seller:

1. If the buyer's **sign-in email** matches the email the seller has on the
   customer record → connect **directly** (ACTIVE, no review).
2. If the emails **differ** → create a real **access request**
   (`PENDING_SELLER_APPROVAL`) instead of connecting.
3. The seller gets an **immediate notification** of a request, it **stays in the
   notification bar until addressed**, and opening it routes to an
   **accept/decline** surface.

**This also closes a live account-takeover hole.** Today `requestSeller`
auto-approves whenever the email the buyer _types_ (`emailAtSeller`) matches a
customer — it NEVER compares it to the email the buyer actually authenticated
with. Any buyer can type any customer's email and instantly claim that
account's invoices, orders, and pricing. The identity check in rule 1 is the
security fix; treat it as such in review.

**No migration.** `PENDING_SELLER_APPROVAL` already exists in
`CustomerLinkStatus`; the approve endpoint, pending-list endpoint, a dead
seller-notify email helper, tenant-scoped socket rooms, and the web bell all
exist. This wires them into one coherent flow and adds the missing pieces
(identity check, decline endpoint, sticky bell items).

## Constraints & conventions

- Stack: NestJS 11 + Prisma 7 (`apps/api`), Next.js 14 (`apps/web`). Jest specs
  (`createMockPrisma()` from `apps/api/src/testing/prisma-mock.ts`). Prettier:
  semicolons, double quotes, printWidth 100, trailing commas. No new deps.
- **Do NOT touch these files — a concurrent run owns them:**
  `scripts/feature-smoke.mjs`, `apps/web/playwright.config.ts`,
  `apps/web/e2e/13-*.spec.ts` … `16-*.spec.ts`, `.github/workflows/nightly.yml`,
  `HANDOFF.md`, `docs/testing/**`, root `package.json`.
- Email sends go through the existing `EmailService` (`send()` returns
  `{delivered}`; tenant SMTP falls back to Resend). Never block or fail the
  request on email delivery.

### Facts established by recon (trust these)

- `buyer.service.requestSeller` (~`apps/api/src/buyer/buyer.service.ts:145+`):
  resolves tenant by slug → finds customer by `dto.emailAtSeller` against
  `Customer.email` OR the linked `User.email` → 404 if none ("Contact the
  seller to send you an invite") → existing-link branches (ACTIVE same-buyer
  conflict; ACTIVE other-buyer conflict; PENDING same-buyer upgraded to ACTIVE
  **unconditionally** — same hole) → otherwise upserts the link straight to
  ACTIVE. **It never loads the BuyerAccount row** (verified: zero references to
  the buyer's own email in the function).
- `CustomerLinkStatus`: `INVITED | PENDING_SELLER_APPROVAL | ACTIVE | DISCONNECTED`.
- `CustomerLink.customerId` is `@unique` — ONE link row per customer, ever.
- Dead code that becomes live again: `notifySellerOfRequest` (private helper in
  buyer.service, builds the seller email, never called);
  `GET /customers/pending-portal-approvals` (`customers.controller.ts:105`);
  `POST /customers/:id/portal-approve` (`:364`) + `approveBuyerRequest`
  (`customers.service.ts:~2056`); the "Approve Connection" button on the
  customer page (`apps/web/app/(dashboard)/customers/[id]/page.tsx:~2555`,
  gated on `portalStatus?.status === "PENDING_SELLER_APPROVAL"`).
- There is **no decline endpoint** anywhere.
- Gateway: `RouteFlowGateway` (`apps/api/src/gateways/routeflow.gateway.ts`)
  emits to `this.tenantRoom(tenantId, "operators")` — copy the
  `emitUrgentOrder` shape exactly.
- Web bell: `apps/web/lib/hooks/useNotifications.ts` — socket-fed
  `AppNotification[]` persisted in localStorage; consumed by
  `apps/web/app/(dashboard)/layout.tsx` (`notifications, unreadCount,
markAllRead, clear` at ~478). localStorage persistence is NOT durable enough
  for "until addressed" — the sticky item must be driven by server state.
- The buyer-side `ConnectSellerModal` already renders the server's `message`
  verbatim (fixed earlier today), so new response copy flows through unchanged.

## Design decisions (already made — do not relitigate)

- **"Until addressed" is derived from server state, not stored read-flags.**
  The pending `CustomerLink` rows ARE the notification: the bell renders them
  as pinned, actionable items fetched from `pending-portal-approvals`,
  independent of the localStorage feed. They disappear exactly when approved or
  declined. Socket events provide immediacy; the query provides durability.
- **Decline deletes the link row.** `customerId` is unique — a declined
  stranger must not permanently occupy the customer's one link slot (that would
  block a future legitimate invite). Deletion frees it; a re-request simply
  creates a fresh pending row the seller can decline again. DISCONNECTED stays
  reserved for severing a previously ACTIVE link.
- **A request against an INVITED link must not clobber the invite.** Set
  `status: PENDING_SELLER_APPROVAL` + `buyerAccountId`, but PRESERVE
  `inviteToken`/`inviteExpiresAt` so the true invitee's token still works
  (acceptInvite flips the row to ACTIVE with their account).
- **Auto-connect also notifies** — informational only. The owner's first
  question was "why didn't we get a notification"; even the happy path should
  leave a trace in the bar (non-sticky, regular feed item).

## Work packages

Files are DISJOINT.

### WP1 — API: identity-gated requestSeller + notifications out

- **files:** `apps/api/src/buyer/buyer.service.ts`, `apps/api/src/buyer/buyer.module.ts`, `apps/api/src/gateways/routeflow.gateway.ts`, `apps/api/src/buyer/buyer-connect.spec.ts` (NEW)
- **brief:** Rework `requestSeller` around the identity rule.

  **exact logic:**

  ```ts
  const account = await this.prisma.buyerAccount.findUnique({
    where: { id: buyerAccountId },
    select: { email: true, name: true },
  });
  if (!account) throw new UnauthorizedException();
  const signInEmail = account.email.toLowerCase();
  const claimedEmail = dto.emailAtSeller.toLowerCase();
  // ... tenant + customer lookup by claimedEmail exactly as today (incl. the
  // user.email OR-clause and the existing 404 when nothing matches) ...

  // Ownership is proven ONLY by the email the buyer AUTHENTICATED with.
  // `emailAtSeller` is a claim; auto-approving on it let any buyer type any
  // customer's email and instantly read their invoices and pricing.
  const customerEmails = [customer.email, customer.user?.email]
    .filter(Boolean)
    .map((e) => String(e).toLowerCase());
  const emailProven = customerEmails.includes(signInEmail);
  ```

  (the customer lookup must therefore `include: { user: { select: { email: true } } }`.)

  Branches:
  - `emailProven` → today's ACTIVE upsert, unchanged, PLUS
    `gateway.emitBuyerAutoLinked(tenant.id, { customerId, customerName:
customer.businessName, buyerName: account.name, buyerEmail: account.email })`
    (informational). Response message unchanged ("Connected! …").
  - NOT proven → the link becomes a REQUEST:
    - no existing link → `customerLink.create` with
      `status: "PENDING_SELLER_APPROVAL"`, `buyerAccountId`, `tenantId`,
      `customerId` (NOT nested — direct create).
    - existing INVITED → `update` to PENDING + buyerAccountId, **preserving
      inviteToken/inviteExpiresAt** (see design decisions).
    - existing PENDING, same buyer → idempotent: return the
      "request already pending" message, no new writes, NO re-notification.
    - existing PENDING, other buyer → 409 "This customer account already has a
      pending request from another buyer. Contact the seller."
    - existing ACTIVE branches → keep today's two 409s verbatim.
    - Then notify, both channels, both fire-and-forget (never fail the request):
      `void this.notifySellerOfRequest(...)` — the existing dead helper, wired
      up (adjust its args to what it actually needs; it already builds the
      email) — and `gateway.emitBuyerConnectRequest(tenant.id, { customerId,
customerName, buyerName, buyerEmail, requestedAt })`.
    - Response: `{ message: "Request sent — <seller name> will review it. You'll
see them in your seller list once approved.", linkId, pending: true }`.
  - **The unconditional PENDING→ACTIVE upgrade branch is the same hole — gate
    it on `emailProven` too.** Un-proven retry of an own pending request hits
    the idempotent branch above instead.

  **Gateway:** add `emitBuyerConnectRequest` and `emitBuyerAutoLinked`, both to
  `tenantRoom(tenantId, "operators")`, event names `buyer.connect.requested`
  and `buyer.connect.autolinked`, payload typed like the existing payloads.
  **Module:** inject `RouteFlowGateway` into `BuyerService` (import whatever
  module exports it — check how `OrdersModule` gets it and copy that).

- **spec (`buyer-connect.spec.ts`, NEW — this is the security pin):**
  1. sign-in email matches `customer.email` → ACTIVE, `emitBuyerAutoLinked`
     fired, no email helper call.
  2. sign-in email matches the linked `user.email` (not customer.email) → ACTIVE.
  3. **typed email matches a customer but sign-in email does not → link created
     PENDING, never ACTIVE** — assert `customerLink.create` payload AND that no
     upsert-to-ACTIVE happened. Both notification paths fired.
  4. Case-insensitivity both directions.
  5. Existing PENDING same buyer + still unproven → idempotent, zero writes,
     zero notifications.
  6. Existing PENDING same buyer + NOW proven (buyer changed their sign-in
     email? — simulate) → upgraded ACTIVE.
  7. Existing INVITED + unproven request → PENDING, `inviteToken` preserved.
  8. Existing PENDING other buyer → 409.
  9. Email helper rejection does not fail the request (mock it rejecting).

### WP2 — API: decline endpoint + richer pending payloads

- **files:** `apps/api/src/customers/customers.controller.ts`, `apps/api/src/customers/customers.service.ts`, `apps/api/src/customers/portal-approvals.spec.ts` (NEW)
- **brief:**
  - `POST /customers/:id/portal-decline` (same guards/roles as
    `portal-approve`): loads the link; 404 if none; 409 unless status is
    `PENDING_SELLER_APPROVAL`; **deletes** the row (see design decisions —
    deletion frees the unique customer slot; comment this in code); returns
    `{ declined: true }`.
  - `approveBuyerRequest`: keep semantics (PENDING → ACTIVE + `linkedAt`); make
    it 409 on non-pending states rather than silently succeeding, if it doesn't
    already.
  - `listPendingPortalApprovals`: enrich each row with the requesting buyer —
    join through `buyerAccountId` → `{ customerId, customerName, buyerName,
buyerEmail, requestedAt: link.updatedAt }`. Additive only.
  - Whatever endpoint feeds the customer page's Buyer Portal card
    (`portalStatus`) must also carry `buyerName`/`buyerEmail` when pending, so
    the card can say WHO is asking. Additive only.
- **spec:** decline deletes only a PENDING link (404/409 otherwise); approve
  409s on non-pending; pending list carries buyer identity.

### WP3 — web: the bell shows requests until addressed

- **files:** `apps/web/lib/hooks/useNotifications.ts`, `apps/web/app/(dashboard)/layout.tsx`, `apps/web/lib/api/portal-approvals.ts` (NEW)
- **brief:**
  - `lib/api/portal-approvals.ts`: `usePendingPortalApprovals()` — query on
    `GET /customers/pending-portal-approvals`, `refetchInterval: 60_000`, plus
    `useApprovePortalRequest()` / `useDeclinePortalRequest()` mutations
    invalidating it.
  - `useNotifications.ts`: subscribe to `buyer.connect.requested` and
    `buyer.connect.autolinked` wherever the existing socket events are wired
    (read the hook; copy its pattern). Requested → push an AppNotification
    ("New buyer request — <buyer> wants to connect to <customer>") AND
    invalidate the pending query. Autolinked → informational feed item only
    ("<buyer> connected to <customer>").
  - `layout.tsx` bell: render a pinned **"Action needed"** section ABOVE the
    regular feed, one row per pending approval — buyer name/email → customer
    name, clicking navigates to `/customers/<customerId>` (where
    approve/decline live) and closes the dropdown. These rows are NOT part of
    the localStorage feed, are NOT cleared by "mark all read"/"clear", and the
    bell badge count = `unreadCount + pendingApprovals.length`. That is what
    "in the bar until addressed" means: server-derived, immune to local
    clears, gone exactly when someone acts.
- No pure-logic worth extracting beyond what the files already do; keep the
  section markup consistent with the existing dropdown styling.

### WP4 — web: accept/decline surface + honest pending states

- **files:** `apps/web/app/(dashboard)/customers/[id]/page.tsx`, `apps/web/app/buyer/portal/page.tsx`
- **brief:**
  - Customer page, Buyer Portal card: the pending state shows WHO is asking
    ("<buyerName> (<buyerEmail>) wants to connect as this customer") with
    **Approve** (existing button/mutation — now reachable again) and a new
    **Decline** (destructive-styled, one confirm dialog: "Decline <buyer>'s
    request? They will not be connected to this account.") wired to the WP2
    endpoint. Both refresh the card and invalidate
    `pending-portal-approvals` so the bell row disappears immediately.
  - Buyer portal seller list: a `PENDING_SELLER_APPROVAL` card is currently
    fully clickable and dumps the buyer into 403s. Render it
    **non-clickable** (no onClick, no hover arrow) with the existing warning
    badge and a one-liner: "Waiting for <seller> to approve your request."
    ACTIVE cards unchanged.
- Note: `apps/web/app/buyer/portal/page.tsx` was modified earlier today
  (logo/public-endpoint + ConnectSellerModal server-message fixes) — build ON
  the current working-tree version; do not revert anything in it.

## Acceptance criteria

1. A buyer whose **sign-in** email matches the customer's email (or its linked
   user's email) connects directly to ACTIVE — and the seller's feed gets an
   informational "connected" notification.
2. A buyer typing a matching `emailAtSeller` while signed in under a
   DIFFERENT email can **never** reach ACTIVE — the link is created
   PENDING_SELLER_APPROVAL. A spec pins this exact scenario as the security
   regression test.
3. On a new request the seller immediately receives: a socket-driven bell
   notification AND an email (fire-and-forget; email failure never fails the
   request).
4. Pending requests render as pinned "Action needed" rows in the bell,
   counted in the badge, surviving "mark all read"/"clear"/localStorage loss,
   and disappearing exactly when approved or declined.
5. Clicking a pending row lands on the customer page, where Approve and
   Decline both work; decline requires a confirm, deletes the link, and frees
   the customer for future invites.
6. A repeat request from the same buyer is idempotent (no duplicate
   notifications); a request for a customer already pending under another
   buyer 409s; ACTIVE conflicts keep today's messages.
7. A request against an INVITED link preserves the outstanding invite token.
8. The buyer-side pending seller card is non-clickable with honest copy.
9. No migration; no new dependencies; the concurrent run's files (listed in
   constraints) are untouched.
10. `npm run verify` green, 0 lint errors — EXCEPT failures originating in
    `apps/web/e2e/13-16*.spec.ts` / `scripts/feature-smoke.mjs`, which belong
    to a concurrent run and must be ignored, not fixed.

## Verification commands

- `npm run verify` (subject to criterion 10's carve-out)

## Risks & rollback

- **The security fix can lock out a legitimate edge case:** a buyer whose
  seller-side record holds an old email they can no longer sign in with. They
  land in the request path — which is exactly the intended fallback; the
  seller vouches. Acceptable by design.
- **Do not notify on the idempotent re-request path** or a buyer can spam the
  seller's bell by resubmitting the form.
- **The gateway injection must not create a module cycle** — copy however the
  orders module consumes `RouteFlowGateway`; if a cycle appears, emit through
  whatever indirection that module uses rather than forcing the import.
- Rollback: every change is additive or behaviour-gating inside
  `requestSeller`; reverting the branch restores today's behaviour (including,
  note, the account-takeover hole — so don't).
