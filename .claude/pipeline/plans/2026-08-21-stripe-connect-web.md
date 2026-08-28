# Plan: Stripe Connect buyer payments — web UI + API specs

> Status: IMPLEMENTED (2026-08-21). This file is the ONLY context the implementation and review
> agents receive. It must stand alone.

## Objective

The API for Stripe Connect buyer payments is built and committed on this branch;
nothing surfaces it yet. Build the screens: a tenant Settings card to link the
tenant's own Stripe account, a tenant review queue for buyer-declared cash
payments, and a buyer-portal "Make a payment" panel that pays by card (Stripe
Checkout) or declares cash. Add Jest specs for the allocation math and webhook
idempotency. Outcome: a buyer with an open balance can pay and see it applied;
an operator can link Stripe and approve cash declarations.

## Constraints & conventions

- Monorepo: `apps/web` = Next.js 14 App Router, `apps/api` = NestJS + Prisma 7.
- Web data access is **TanStack Query hooks in `apps/web/lib/api/<domain>.ts`**.
  Tenant routes use `apiClient` from `@/lib/api-client`; buyer-portal routes use
  `buyerApiClient` from `@/lib/buyer-api-client` (it already injects the buyer
  token and the `X-Tenant-Slug` header). Mirror `apps/web/lib/api/billing.ts`
  for hook/type style.
- Prettier: semicolons, double quotes, printWidth 100, trailing commas.
- Tests: Jest for api (`*.spec.ts`), `Test.createTestingModule`, mock at the
  module boundary. **No snapshot tests, no Vitest.**
- **Do NOT modify** anything under `apps/api/src/payment-requests/*.ts` or
  `apps/api/src/stripe-connect/*.ts` except to ADD the new spec files, and do not
  touch `apps/api/prisma/schema.prisma` or any migration — the API is done and
  verified.
- Money: never re-derive totals in the UI; render what the API returns.

## API already available (do not change; consume as-is)

Tenant (`apiClient`, operator/tenant-admin auth):

- `GET  /settings/stripe-connect` → `{ configured, connected, stripeAccountId,
chargesEnabled, detailsSubmitted, livemode, connectedAt }`
- `POST /settings/stripe-connect/link` → `{ url }` (navigate the browser to it)
- `DELETE /settings/stripe-connect` → `{ disconnected: true }`
- `GET  /payment-requests?status=PENDING` → array of
  `{ id, kind: "CARD"|"CASH", status, amount, note, reference, customerId,
customerName, contactName, createdAt, decidedAt, decidedByName,
allocationPreview?: Array<{ invoiceId, invoiceNumber, issueDate, total,
balanceDue, applied }> }`
- `POST /payment-requests/:id/approve` → `{ approved, paymentGroupId, excess }`
- `POST /payment-requests/:id/reject` body `{ reason?: string }`

Buyer (`buyerApiClient`, buyer auth + active seller):

- `GET  /buyer/payments/context` → `{ balanceDue, cardEnabled, openInvoices:
Array<{ invoiceId, invoiceNumber, issueDate, total, balanceDue, applied }>,
pendingRequests: Array<{ id, kind, status, amount, note, reference, createdAt,
decidedAt, failureReason }> }`
- `GET  /buyer/payments/preview?amount=<number>` → `{ lines: [...same shape with
`applied` > 0...], excess }`
- `GET  /buyer/payments/requests` → the buyer's requests, newest first
- `POST /buyer/payments/card` body `{ amount, fromInvoiceId? }` →
  `{ requestId, url, amount }` — **navigate to `url`**
- `POST /buyer/payments/cash` body `{ amount, note?, reference?, fromInvoiceId? }`
- `POST /buyer/payments/requests/:id/cancel`

After returning from Stripe the buyer lands on
`/buyer/portal/<slug>/payments?payment=processing|cancelled`. Card payments
settle by webhook, so `processing` must NOT claim success — say the payment is
confirming and the balance updates shortly.

The Connect callback returns the operator to `/settings?stripe=connected&charges=enabled|pending`
or `/settings?stripe=error&reason=<text>`.

## Work packages

File lists are DISJOINT.

### WP1 — Tenant API hooks + Settings "Payments" card

- **files:** `apps/web/lib/api/stripe-connect.ts`,
  `apps/web/app/(dashboard)/settings/_components/StripeConnectCard.tsx`
- **brief:** New hooks file exporting `useStripeConnectStatus()`,
  `useStartStripeConnect()` (mutation → on success `window.location.href = url`),
  `useDisconnectStripe()`. Then a card component:
  - Not `configured` → muted "Card payments aren't enabled on this platform yet."
    and no connect button.
  - `configured && !connected` → explain that connecting lets customers pay by
    card straight into the tenant's own Stripe account, RouteFlow takes no fee;
    primary "Connect Stripe" button.
  - `connected && chargesEnabled` → green "Active" badge, masked account id,
    connected date, "Disconnect" (confirm first).
  - `connected && !chargesEnabled` → amber "Finishing setup" badge and a plain
    line that Stripe still needs details before cards can be accepted.
  - `livemode === false` → a small "Test mode" chip.
  - Read the `?stripe=` querystring with `useSearchParams()` and render an inline
    success/error banner. Component must be a client component.
- **exact code** (mask helper + querystring banner):

```tsx
const maskAccount = (id: string) => (id.length > 8 ? `${id.slice(0, 7)}…${id.slice(-4)}` : id);

const params = useSearchParams();
const flag = params.get("stripe");
const reason = params.get("reason");
// `connected` here means the OAuth leg returned — charges may still be pending.
const banner =
  flag === "connected"
    ? {
        tone: "success" as const,
        text:
          params.get("charges") === "enabled"
            ? "Stripe connected — you can now accept card payments."
            : "Stripe connected. Finish your details in Stripe before cards work.",
      }
    : flag === "error"
      ? { tone: "error" as const, text: reason ?? "Could not connect Stripe." }
      : null;
```

### WP2 — Tenant payment-requests review UI

- **files:** `apps/web/lib/api/payment-requests.ts`,
  `apps/web/app/(dashboard)/finance/payment-requests/page.tsx`
- **brief:** Hooks `usePaymentRequests(status?)`, `useApprovePaymentRequest()`,
  `useRejectPaymentRequest()` (both invalidate `["payment-requests"]`, plus
  `["invoices"]` and `["customers"]` so balances refresh). Page lists requests
  newest-first with a PENDING filter default. Each pending CASH row shows
  customer, amount, note/reference, age, and an **allocation preview table**
  (`allocationPreview`: invoice number, issue date, balance due, "applies") with
  a one-line explainer that payments settle the oldest invoices first. Approve →
  confirm dialog restating the amount and target invoices; on success toast the
  `paymentGroupId` result and any `excess` as "left on account". Reject → prompt
  for an optional reason. CARD rows are read-only history (they settle from
  Stripe) — show status, never approve/reject controls.
- Follow the existing dashboard page shell/table styling used by sibling pages
  under `apps/web/app/(dashboard)/finance/`.

### WP3 — Buyer "Make a payment" panel

- **files:** `apps/web/lib/api/buyer-payments.ts`,
  `apps/web/app/buyer/portal/[seller]/payments/_components/MakePaymentPanel.tsx`
- **brief:** Hooks: `useBuyerPaymentContext()`, `useBuyerPaymentPreview(amount)`
  (debounced ~350ms, `enabled: amount > 0`, `keepPreviousData`),
  `useStartCardPayment()`, `useDeclareCashPayment()`, `useCancelPaymentRequest()`.
  Panel renders:
  - Balance due, large.
  - Amount input defaulting to the full balance; validation ≥ 0.50 and ≤ balance
    for card (cash may exceed — surplus goes on account).
  - Live allocation preview listing which invoices the amount settles, in order,
    with the partially-covered one marked "partial". Always show the sentence
    "Payments are applied to your oldest invoices first."
  - `[Pay by card]` — hidden entirely when `cardEnabled` is false, with a muted
    "This seller doesn't accept card payments yet." On success
    `window.location.href = url`.
  - `[I've paid cash]` — opens a small form (optional note + reference), submits,
    then shows the pending state.
  - When a PENDING request exists, replace the actions with its status
    ("Waiting for <seller> to confirm your cash payment" / "Card payment in
    progress") plus a Cancel button.
  - Accept an optional `defaultAmount` prop (used by WP4).
- **exact code** (debounced preview hook — keeps the input responsive):

```ts
export function useBuyerPaymentPreview(amount: number) {
  const [debounced, setDebounced] = useState(amount);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(amount), 350);
    return () => clearTimeout(t);
  }, [amount]);
  return useQuery({
    queryKey: ["buyer", "payment-preview", debounced],
    queryFn: () =>
      buyerApiClient
        .get("/buyer/payments/preview", { params: { amount: debounced } })
        .then((r) => r.data),
    enabled: Number.isFinite(debounced) && debounced >= 0.5,
    placeholderData: (prev) => prev,
  });
}
```

### WP4 — Wire the panel into the buyer pages

- **files:** `apps/web/app/buyer/portal/[seller]/payments/page.tsx`,
  `apps/web/app/buyer/portal/[seller]/invoices/[id]/page.tsx`
- **brief:** On the payments page, mount `<MakePaymentPanel />` ABOVE the
  existing wallet/how-to-pay/history content — it is the primary action and must
  be the first thing seen. Also read `?payment=` and render a banner:
  `processing` → "Your card payment is confirming — your balance updates in a
  moment." (never "paid"); `cancelled` → neutral "Payment cancelled."
  On the invoice detail page add a "Pay this invoice" button, shown only when
  that invoice has a balance due, which routes to
  `/buyer/portal/<seller>/payments?amount=<balanceDue>`; the payments page reads
  `?amount=` and seeds the panel's `defaultAmount`. Keep every existing section
  on both pages intact.

### WP5 — API specs (allocation + webhook idempotency)

- **files:** `apps/api/src/payment-requests/payment-requests.service.spec.ts`
- **effort:** (normal)
- **brief:** Jest specs against `PaymentRequestsService` with all collaborators
  mocked at the module boundary (`PrismaService`, `InvoicesService`,
  `StripeConnectService`, `StripeService`, `TenantContextService`,
  `RouteFlowGateway`). Cover:
  1. `buildOldestFirstAllocation` orders by `issueDate` then `invoiceNumber`,
     caps each invoice at its balance due, and stops when the amount runs out —
     the last reached invoice is partially covered.
  2. An amount exceeding the total balance returns `excess` equal to the
     remainder and allocates every open invoice in full.
  3. Invoices with no balance left are excluded from allocation.
  4. `settleCardBySession` writes the money exactly once: the second call with
     the same session object performs NO further `recordStandalonePayment`
     (the atomic PENDING claim returns count 0 on replay).
  5. `settleCardBySession` ignores a session whose `payment_status` is not
     `"paid"`.
  6. `approve` refuses a CARD request (cash-only path) and refuses a request
     already decided.
- Mock `prisma.buyerPaymentRequest.updateMany` to return `{ count: 1 }` first and
  `{ count: 0 }` on the replay call to drive test 4.

## Acceptance criteria

1. `apps/web/lib/api/stripe-connect.ts`, `payment-requests.ts` and
   `buyer-payments.ts` exist and use `apiClient` for tenant routes and
   `buyerApiClient` for `/buyer/*` routes — no raw `fetch`, no crossed clients.
2. The Settings card renders all five states in WP1 and never shows a Connect
   button when `configured` is false.
3. The tenant page shows an allocation preview for each PENDING CASH request and
   offers approve/reject only on PENDING CASH rows (never on CARD).
4. The buyer panel is the first block on the payments page, defaults the amount
   to the full balance, and always states that payments apply to oldest invoices
   first.
5. `Pay by card` is absent when `cardEnabled` is false; when present, success
   navigates to the returned Stripe `url`.
6. `?payment=processing` never asserts the payment succeeded.
7. The invoice-detail Pay button appears only when that invoice has a balance and
   seeds the panel amount with it.
8. A PENDING request replaces the payment actions with its status and a Cancel.
9. `payment-requests.service.spec.ts` covers all six cases in WP5 and passes.
10. No file outside the listed package files is modified; schema and migrations
    untouched.

## Verification commands

Run from the repo root:

- `cd apps/api && npx tsc -p tsconfig.build.json --noEmit`
- `npm run check-types` (turbo, all workspaces — this is what covers web)
- `cd apps/api && npx jest payment-requests` — jest's `rootDir` is `src`, so a
  `src/…` prefix matches NOTHING and reports a false "no tests found". The
  original plan had this wrong and failed its own gate on it.
- Web lint: `npm run lint` (turbo, per-workspace). Do NOT hand-roll
  `npx eslint … --ext`: the repo is on flat config where `--ext` is not a valid
  flag, and `apps/web` resolves eslint 8.57 against a root 9.39 (pre-existing,
  unrelated to this change), so a direct `npx eslint` there crashes loading
  rules.

## Risks & rollback

- **Never claim a card payment succeeded from the redirect** — settlement is
  webhook-only. Criterion 6 exists for this.
- Crossing `apiClient` and `buyerApiClient` sends the wrong token and 401s.
- The buyer panel must not compute allocations itself; render the API preview or
  the two sides will disagree.
- Rollback: the whole change is additive on branch
  `feat/stripe-connect-buyer-payments`; revert the web commits and the API keeps
  working headlessly.
