# UI-865 — tests report

## Command

```
npm test -w apps/web -- EnableAddonModal --maxWorkers=2
```

## Result: GREEN (not RED) — behavior already present in source

The one new RTL case added (`SA-277a: a no-catalog-SKU 400 renders that exact message, keeps
the modal open, and re-enables Confirm`) **passed on the first run**. It did not fail, because
`EnableAddonModal.tsx`'s `handleConfirm` catch block (~lines 91-101) already renders
`err.response.data.message` verbatim in the error region, and the modal already stays on the
confirm step with the Confirm button re-enabled (`submitting` is reset to `false` in `finally`).

Per the task brief: "If the modal already passes (it renders `response.data.message`,
:94-103), change NO source file." — so no source file was modified. Only the test file
(`EnableAddonModal.test.tsx`) was edited, adding the one new case to the existing "Stripe
configured" describe block, next to the existing generic-error-message test.

## Verbatim runner output

```
> @routeflow/web@0.1.0 test
> jest EnableAddonModal --maxWorkers=2

PASS app/(platform-admin)/admin/tenants/[id]/_features/EnableAddonModal.test.tsx
  EnableAddonModal — Stripe configured
    ✓ disables Continue until an explicit choice is made — never a silent default (74 ms)
    ✓ bill-via-Stripe path: confirm sends the addonKey and price, names the tenant, states a Stripe item will be created (25 ms)
    ✓ grant-without-billing is its own explicit choice: confirm omits stripePriceId and states no Stripe item will be created (21 ms)
    ✓ a failed enable surfaces the server message and keeps the confirm step open (17 ms)
    ✓ SA-277a: a no-catalog-SKU 400 renders that exact message, keeps the modal open, and re-enables Confirm (21 ms)
  EnableAddonModal — Stripe NOT configured
    ✓ states this will be a free grant and proceeds without asking for a choice (14 ms)
  EnableAddonModal — unmet requirement (B519 warning, B524 ack prep)
    ✓ Confirm stays disabled until the amber warning's checkbox is ticked, then sends acknowledgeUnmetRequires: true (14 ms)
    ✓ never sends acknowledgeUnmetRequires when there is no unmet requirement to acknowledge (9 ms)

Test Suites: 1 passed, 1 total
Tests:       8 passed, 8 total
Snapshots:   0 total
Time:        0.98 s
Ran all test suites matching EnableAddonModal.
```

## Scope

Edited only `apps/web/app/(platform-admin)/admin/tenants/[id]/_features/EnableAddonModal.test.tsx`
(the sole file in this task's `tests` list). No implementation file, and nothing under
`packages/`, was created, edited, or deleted.
