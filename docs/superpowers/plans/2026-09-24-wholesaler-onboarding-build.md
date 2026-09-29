# Wholesaler onboarding — in-app build (PARKED)

**Status:** **PARKED** by the owner on 2026-09-24 ("playbook only for now"). Nothing here is
scheduled. When the owner picks a time, each slice below becomes its own `dev-pipeline` run,
starting with **S1**.

**Process source of truth:** [`docs/runbooks/wholesaler-onboarding.md`](../../runbooks/wholesaler-onboarding.md).
This spec turns that playbook's 8 stages into software without changing the process. If the two
disagree, fix the playbook first, then this spec.

**Written against** master `025bcdce`. File and line references come from a planning pass. They
are **re-verified at build time**, never trusted blind.

---

## 1. Why build it

The playbook runs by hand. That works for a handful of wholesalers but has three weaknesses that
only software fixes:

1. **Skipping is still possible.** A copied checklist can't stop someone from starting stage 5
   before payment is recorded.
2. **We retype their answers.** The questionnaire comes back as an email or document, and we key
   it into the back office. Every retyped field is a chance for a typo on a legal name, a tax rate
   or a licence number.
3. **Proof lives in inboxes.** Acceptance emails, payment references and sign-offs are scattered.

## 2. Owner decisions this build must honour (2026-09-24)

- **White-glove data load:** we import their data. The build never runs CSV importers from the
  back office (see S3a).
- **Paid from the start.** Payment is **card** (existing Stripe checkout) **or manual**
  bank/Zelle/check (existing `activateManualSubscription`). **Billing starts the day they pay**,
  so no deferred-start billing code is needed.
- **One-time setup fee,** amount per deal, charged with the first payment. **Never counted in
  MRR.**
- **Click-accept** of the order summary + Terms/Privacy **inside the intake link**. The accepted
  order is frozen; a re-quote means a new acceptance.
- **Secrets never pass through the link:** no passwords, bank numbers, API keys or SMTP
  credentials. The tenant admin enters those after login.

## 3. Data model (all platform-level, in `apps/api/prisma/schema/platform.prisma`)

Add every model to `MODEL_DOMAIN` in `apps/api/scripts/split-prisma-schema.mjs`. The migration is
additive only. Enums get `X_VALUES` mirrors in `packages/types/api/onboarding.ts` plus a row in
`enum-parity.spec.ts`.

Enums:

- `OnboardingStage`: FOLLOW_UP, AGREE, ACTIVATE, COLLECT, CONFIGURE, VERIFY_TRAIN, GO_LIVE,
  HYPERCARE
- `OnboardingCaseStatus`: OPEN, ON_HOLD, LIVE, LOST
- `OnboardingStepStatus`: PENDING, DONE, WAIVED
- `IntakeSectionKey`: ACCOUNT, TAX_COMPLIANCE, INVOICING, TEAM, OPERATIONS, DATA_FILES,
  GO_LIVE_PREFS
- `IntakeSectionStatus`: EMPTY, DRAFT, SUBMITTED, CHANGES_REQUESTED, APPROVED, APPLIED, WAIVED

Models:

- **`OnboardingCase`** holds one wholesaler's journey.
  - Links: `tenantId?` (unique, set at Activate), `demoBookingId?` (unique).
  - Prospect: company, name, email, phone.
  - Progress: `stage`, `status`, `catalogVersion`, `ownerAdminId?`, `targetGoLiveOn?`,
    `cutoverAt?`.
  - Deal: `fitNotes Json?`, `dealTerms Json` (planKey, addon SKUs, interval, `setupFeeCents`,
    note).
  - Closing: `lostReason?`, `closedAt?`, `createdById`, timestamps.
  - Indexes: `(stage, status)` and `(ownerAdminId)`. Back-relation on `Tenant` in
    `tenancy.prisma`.
- **`OnboardingStep`**: `caseId`, `key`, `stage`, `status`, `autoResult Json?`
  (`{ok, detail, checkedAt}`), `evidence Json?`, `doneById?`, `doneAt?`, `waivedReason?`,
  `waivedById?`. Unique `(caseId, key)`.
- **`IntakeSection`**: `caseId`, `key`, `schemaVersion`, `status`, `answers Json`,
  `submittedAt?`, `reviewedById?`, `reviewNote?`, `appliedAt?`, `appliedDiff Json?`. Unique
  `(caseId, key)`.
- **`IntakeFile`**: `caseId`, `sectionKey`, `kind` (products · customers · suppliers · stock ·
  ar_aging · open_docs · tax_cert · licence · other).
  - Storage: `storageKey` (unique, `onboarding/<caseId>/<uuid>-<safeName>`), `originalName`,
    `contentType`, `sizeBytes`, `sha256`.
  - Custody: `containsPii`, `uploadedBy` (`customer` | admin id), `purgedAt?`.
  - Stored through the existing storage service (no tenant needed) and read only through signed
    URLs.
- **`IntakeAccessToken`**: `caseId`, `tokenHash` (unique), `expiresAt`, `revokedAt?`,
  `lastUsedAt?`, `createdById`.
- **`OrderAcceptance`** is **append-only**.
  - What was accepted: `caseId`, `tenantId?`, `orderSnapshot Json` (computed server-side from
    `dealTerms` + the live catalog), `termsVersion`, `privacyVersion`.
  - Who and when: `acceptedName`, `acceptedEmail`, `acceptedAt`, `ip`, `userAgent`, `tokenId`.
  - Supersession: `supersededAt?` is the only field that may ever change.
- **`OnboardingEvent`**: `caseId`, `type`, `actorType` (ADMIN · CUSTOMER · SYSTEM), `actorId?`,
  `payload`. Holds the activity feed. Anything that touches a tenant also goes through
  `recordAdminAction` with new audit codes (case created, stage advanced, step waived, link
  issued/revoked, section applied, setup fee recorded).

**The step catalog lives in code** (`apps/api/src/onboarding/onboarding-catalog.ts`):
`CATALOG_VERSION` + `STEPS[]`, where each step is
`{key, stage, title, owner: ROUTEFLOW|CUSTOMER, required, autoCheck?, evidenceHint}`. Steps are
**copied into rows when a case is created**, stamped with `catalogVersion`. A later catalog
change never mutates an in-flight case; an explicit "adopt catalog" adds new keys as PENDING and
never deletes DONE rows. The catalog mirrors the playbook's per-client checklist one-to-one.

**Intake answers** are typed JSON per section, validated by one class-validator DTO per
`IntakeSectionKey`. The TypeScript shape is exported from `packages/types/api/onboarding.ts`, so
the public form and the back-office review card render from one field spec.

## 4. API — new `apps/api/src/onboarding/` module

The module imports `BillingModule` (L-113). Because it's a new Nest module it **must pass the
compose boot gate** (`npm run local:up` → `local:validate`) before push.

**Back office** (`JwtAuthGuard` + `SuperAdminGuard`, `platform-admin/onboarding`):

- Cases and steps: list/create/read/patch cases; `advance` (409 with the blocker list when a
  gate isn't met); per step complete / waive (reason required) / reopen; run auto-checks.
- Intake: issue the intake link (rotates the token, returns the URL with `#token=` once); revoke
  it; review a section (approve or request changes, with a note); apply a section (`?dry=1`
  returns the diff).
- Activate and pay: activate; record a manual payment.
- Files and acceptances: file upload and signed read URL; list acceptances.
- Demo bookings: `GET platform-admin/demo-bookings`. No admin list of them exists today.

**Public intake** (`public/onboarding`, no auth, per-route `@Throttle` like
`public-demo-booking.controller.ts`):

- `POST session` returns the case summary, sections, the live-catalog order summary and the
  terms versions.
- Section draft save and submit.
- `POST accept`: the snapshot is computed **server-side**; IP and user agent come from the
  request.
- File upload (25 MB; csv/xlsx/pdf/png/jpg) and delete.
- **The token travels only in POST bodies (L-188).** Every failure returns the same 404 "Link
  not found or expired." (L-178).

**Token lifecycle:** lift the demo-booking manage-token helpers (`<random>.<hmac>`, only the hash
stored, constant-time compare) into `apps/api/src/common/signed-token.ts` and reuse them.

- Own secret `ONBOARDING_TOKEN_SECRET`; boot fails if unset.
- Valid for 30 days. One active token per case: issuing revokes the prior one.
- Revoked when the case goes LOST or LIVE. `lastUsedAt` bumped on use.

**Auto-checks** run without an ambient tenant (L-124). Each checker is wrapped in
`tenantContext.run(tenantId, …)`, so scoped services and `forTenant()` behave. An hourly
`@LeaderCron(…, "onboarding.refreshAutoChecks")` covers OPEN cases that have a tenant.

Checks:

- **Payment and money:** payment recorded; setup fee recorded.
- **Workspace settings:** profile complete; email sending connected; numbering continuity (only
  meaningful after B861).
- **Catalog:** 0 products missing price or pack size; no SKU collisions.
- **Customers:** customers geocoded; tax-exempt customers have a certificate; retailer tobacco
  licences not expired; opening balance within the credit limit (or agreed).
- **People:** drivers exist and have logged in (needs `User.lastLoginAt`, added in S1).
- **Go-live:** a first order delivered → invoice sent → payment recorded.

## 5. Web

- **Back office:** `admin/onboarding` (a counter per stage + a filterable table; "New case" /
  "From demo booking") and `admin/onboarding/[id]`. The case page has these tabs:
  - Overview: stepper, gate blockers, Advance, owner, target date, deal terms + live order
    preview.
  - Intake: per-section cards with Approve / Send back, and Apply → diff modal.
  - Files, Steps (complete/waive modal), Activity.

  Reuse the existing `(platform-admin)/_components` (tabs, cards, badges, modals).

- **Public intake page:** a bare layout. It reads `#token=`, keeps the token in session storage,
  and strips it from the address bar. Vertical stepper, debounced save-as-you-go, drop-zone
  uploads, and an Agreement step (order summary, Terms/Privacy, typed name). **Mobile-first**:
  one column at 390 px, 44 px targets. Errors show fixed generic copy.
- **Tenant side (S4):** a "Getting started" page + dashboard banner, and a mobile-web card
  linking to the same. It shows the customer-owned steps and the **sign-off**
  (`POST /onboarding/me/sign-off`, TENANT_ADMIN only), which feeds the case.

## 6. Slices (each one dev-pipeline run)

| Slice   | Scope                                                                                                                                                                                                               | Risk             | Depends on             |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ---------------------- |
| **S1**  | Cases, step catalog, stage gating, waive-with-reason, auto-checks, back-office list/detail, demo-bookings list, `User.lastLoginAt`                                                                                  | schema           | —                      |
| **S2**  | Intake token, sections, files, acceptance with server-side snapshot, public page, review/send-back, emails                                                                                                          | auth + schema    | S1                     |
| **S3a** | Activate from intake: `createTenantForOnboarding` (set-password link, no temp password, no trial wording), widened back-office config DTO, apply profile / numbering / staff / drivers with a dry-run diff, audited | **HIGH** tenancy | S2 + driver-invite fix |
| **S3b** | Setup fee on both payment paths + ledger event + MRR guard                                                                                                                                                          | **HIGH** money   | S2                     |
| **S4**  | Tenant "Getting started" (web + mobile web) + sign-off                                                                                                                                                              | low              | S1                     |
| **S5**  | Reminders (`onboarding.sendReminders`), raw-file purge 30 days after LIVE (`onboarding.purgeIntakeFiles`), funnel metrics (demo → signed → paid → live, days per stage)                                             | low              | S2                     |

**S1 alone is the smallest build that makes skipping impossible.** It's the right first slice
when this is unparked.

**Hours, though, are lost to the importers, not to tracking.** The product and customer CSV
importers drop most commercial columns (B858, B859), so pack sizes, tier prices, barcodes,
costs, terms, credit limits, exemptions and licences are keyed by hand per record. If the owner
unparks only one thing before a large-catalog customer, make it the B858/B859 importer fix. It's
a bug-pipeline run, not part of this spec, and it saves more hours per onboarding than any slice
here.

### S3a — why the back office never runs the CSV importers

The importers run against the ambient tenant. They have no dry-run and skip bad rows silently.
Driving them cross-tenant from the back office would multiply tenancy risk for no gain, so data
loads stay on impersonation (as the playbook says). The case records reconciliation counts, and
the auto-checks prove the result.

### S3b — setup fee (HIGH money; Senior Architect review before build)

- **Quote:** the fee comes from `dealTerms.setupFeeCents`. It's shown in the order summary and
  frozen in `orderSnapshot`.
- **Card:** `createCheckoutSession` gains an optional one-time line item. Stripe bills a
  non-recurring `price_data` line on the first invoice of a subscription-mode session. The
  checkout-completed webhook emits `BillingEvent { type: "setup_fee.charged", amountDelta: null }`.
- **Manual:** the manual-payment action runs `activateManualSubscription` and emits
  `setup_fee.recorded` (amount, method, reference) **in the same transaction**.
- **MRR is safe by construction.** MRR sums `amountDelta`, and a fee event carries `null`. A
  guard test pins that `setup_fee.*` events can never carry a delta, and the MRR total is
  identical before and after a fee.
- **No `RfInvoice` writes.** A platform statement feature is a separate project.
- **HIGH-risk files:** `billing.service.ts`, `billing-event.service.ts`,
  `plan-catalog.constants.ts`, `mrr.service.ts` (tests), and the new payment service.

## 7. Defects to clear before or during the build

These are filed in the bug registry. The build does not fix them silently.

| Defect                                                                                        | Where it's fixed                                                                                                                               |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Invoice prefix / payment-due days are dead controls in Settings → Invoicing (TEN-M9)          | own bug-pipeline run (wire to the numbering tool or remove)                                                                                    |
| Business name can't be edited after creation (TEN-M8)                                         | the S3a super-admin path sidesteps it; the tenant form gets its own bug-pipeline run                                                           |
| Drivers get no invite email                                                                   | own bug-pipeline run **before S3a** (reuse the set-password invite)                                                                            |
| Welcome email sends a temp password and trial wording to paid, sales-led tenants              | onboarding path fixed inside S3a; the legacy create path is a follow-up                                                                        |
| Trial length can't be set from the create form (API supports 1–90 days)                       | small UI fix, any time                                                                                                                         |
| Manual Activation / Change Plan can't pick GROWTH (hardcoded plan list, B857)                 | own bug-pipeline run **before S3b**, since bank payers on GROWTH can't be activated correctly                                                  |
| Product CSV import drops pack size, tier prices, barcode, category, cost, tobacco flag (B858) | **highest-leverage fix for white-glove onboarding.** Own run (extend the importer with a preview), candidate to unpark first                   |
| Customer CSV import drops terms, tier, credit limit, tax-exempt, licence; no geocoding (B859) | same run as B858                                                                                                                               |
| Supplier CSV import has no screen (B860)                                                      | small UI fix                                                                                                                                   |
| The numbering card's "continue from your old system" never reaches live invoices (B861)       | own run. Until it lands, S1's "numbering set" auto-check is meaningless and the playbook tells clients new invoices start at `INV-<year>-0001` |
| "Extend Trial" demotes a paid ACTIVE tenant to TRIAL (B558/B560)                              | own run. The playbook forbids the button on paid workspaces meanwhile                                                                          |

## 8. Proof per slice

- **S1:**
  - Catalog: keys are unique and every `autoCheck` has a checker.
  - Gating: advance is refused with blockers, strictly in order; waive rejects an empty reason
    and records the actor.
  - DB specs: steps are materialised at `catalogVersion`; "adopt catalog" only adds; checks never
    read another tenant (two-tenant fixture).
  - Plumbing: enum parity + split-schema check; Playwright at 1440 / 768 / 390; compose boot
    gate.
- **S2:**
  - Tokens: a forged HMAC is rejected before any DB read; expired, revoked and unknown tokens
    all return the same 404 body; issuing a new token revokes the old; no route reads a token
    from the query string; throttles present.
  - Acceptance: rows are immutable, and the snapshot is unchanged after a catalog price change.
  - Uploads: type and size limits enforced.
  - Public page: fixed error copy; a full walk at 390 px.
- **S3a:** the dry-run diff equals the actual write; writes are idempotent; audit rows carry
  before/after; two-tenant isolation holds; the onboarding create email has a set-password link
  and no password or trial wording.
- **S3b:**
  - Checkout has exactly one recurring line + one one-time line with the exact amount.
  - The webhook emits the fee event with a null delta.
  - The MRR total is unchanged.
  - The manual path records method and reference in the same transaction as activation.
- **S4:** sign-off is TENANT_ADMIN only and marks the case step; Playwright at 390 + the Expo web
  export.

## 9. Not now

- Back-office-driven importers.
- E-signature or PDF contracts.
- Self-serve customer data import.
- Automatic buyer-portal invites (retailers are invited only after go-live, deliberately).
- `RfInvoice` for the fee.
- Business-type profiles: feature-grants v2 owns presets. When they land, "apply the agreed
  package" becomes one click in S3a.
- Plane sync.
