# Plan: Buyer-connect auth hardening (F1 account-hijack + F2/F3/F4)

> Authored by Opus 4.8 on 2026-08-22 (deepest context lives in the driving session). Status: IMPLEMENTED
> Outcome: pipeline run wf_e9861a38-991 clean — gate 8/8 workspaces typecheck + 4 suites/40 tests pass.
> Review widened WP4 beyond the plan's file list: portal/layout.tsx SellerItem + six [seller]/\* pages
> needed the same null-customer guards, portal/page.tsx needed an ACTIVE click gate (INVITED cards were
> clickable), and WP2's emailVerified:false write is now keyed off the same emailChanging predicate as
> the revocation (admin UI echoes the unchanged email on every save).
> This file is the ONLY context the implementation and review agents receive.
> It must stand alone: no references to "the conversation", no "as discussed".

## Objective

Close a live HIGH-severity buyer-portal account-hijack and three lower-severity issues in the
same auth path, all in the RouteFlow NestJS API (`apps/api`) plus the buyer-portal clients.

- **F1 (HIGH):** A Google sign-in that matches an existing buyer account by email flips
  `emailVerified:true` while leaving a pre-existing password (`passwordSet:true`) and all sessions
  intact. An attacker who registered under a victim's email with a chosen password (registration
  requires no mailbox proof) has their squatted account "verified" the moment the victim signs in
  with Google — the attacker keeps password access and now passes the `requestSeller` verified-gate,
  reaching the seller's invoices/pricing/orders for that customer. Fix: when a Google sign-in is
  about to verify an account that carries an **unproven** password (`passwordSet && !emailVerified`),
  neutralize the credential (reset to an unguessable placeholder, `passwordSet:false`) and revoke all
  buyer refresh tokens **before** linking/verifying.
- **F2 (LOW/MED):** A super-admin email change sets `emailVerified:false` but leaves outstanding
  verification tokens (mailed to the OLD address) redeemable — `verifyEmail` binds a token to
  `buyerAccountId`, not to the address that was mailed. Fix: delete the account's verification tokens
  and revoke its sessions in the same transaction as the email change.
- **F3 (LOW):** The grandfather backfill migration is time-unbounded, so a replay after a DB restore
  would silently re-verify all currently-pending accounts. The migration is already applied to prod
  and MUST NOT be edited (checksum). Deliverable: a strictly read-only audit script the owner can run
  against prod themselves, documenting the hazard.
- **F4 (LOW):** `getSellers` returns customer identity for non-ACTIVE (PENDING/INVITED) links — a
  customer-roster oracle — and `POST /buyer/sellers/request` has only the global throttle. Fix: omit
  customer identity unless the link is ACTIVE, add a tight per-endpoint throttle, and update the two
  buyer-portal clients that render `customer.businessName` unconditionally.

The `requestSeller` verified-gate itself (requiring `emailVerified`) is CORRECT and must stay.

## Constraints & conventions

- **Stack:** NestJS 11, Prisma 7 + Postgres. Tests: Jest (`*.spec.ts`), `Test.createTestingModule`,
  mock at the module boundary with `createMockPrisma()` from `apps/api/src/testing/prisma-mock.ts`.
- **Prettier:** semicolons, double quotes, `printWidth` 100, trailing commas. Match surrounding style.
- **NO Prisma migration** is introduced by any package — every column used already exists
  (`BuyerAccount.passwordSet`, `.emailVerified`, `.googleId`, `.passwordHash`; `BuyerRefreshToken`,
  `BuyerEmailVerificationToken`). **Do not** create or edit any migration, and do not touch
  `apps/api/prisma/migrations/20260824000000_add_buyer_email_verification/migration.sql`.
- **Do NOT touch prod.** WP5 ships a script; it is NOT run here.
- **`createMockPrisma()` facts** (relied on by the specs):
  - Every model exposes `findUnique/findFirst/findMany/create/update/updateMany/delete/deleteMany/
count/upsert/...` as `jest.fn()` with sensible defaults (`update`→`{}`, `deleteMany`→`{count:0}`,
    `findUnique`→`null`).
  - `buyerAccount`, `buyerRefreshToken`, `buyerEmailVerificationToken`, `customerLink` are all present.
  - Default `$transaction(fn)` invokes the callback with a tx object spread from the SAME `models`, so
    `tx.buyerAccount.update` **is** `prisma.buyerAccount.update` (assert on the `prisma.*` fn directly).
    Do NOT override `$transaction` in the F2 spec — the default callback behavior is exactly what's
    needed.
- **What must NOT change:** the `requestSeller` `emailVerified` gate; the auto-create path
  (`passwordSet:false`, `emailVerified:true`) for brand-new Google accounts; the tenant/seller branding
  shown for pending sellers (only the customer identity is redacted).

## Work packages

Rules: file lists are DISJOINT across packages → all five run in parallel.

### WP1 — F1: neutralize a squatted password on Google verify

- **files:** `apps/api/src/auth/google-oauth.service.ts`,
  `apps/api/src/auth/google-oauth.buyer-autocreate.spec.ts`
- **brief:** In `handleBuyerPortalAuth`, when a Google sign-in that attests the account's own mailbox
  (`googleAttestsMailbox`) is about to mark an account verified, treat a pre-existing **unproven**
  password (`passwordSet && !emailVerified`) as attacker-controlled: reset the hash to an unguessable
  random placeholder with `passwordSet:false`, set `emailVerified:true` (and link `googleId` on the
  first-link path), and revoke **all** `BuyerRefreshToken` rows for the account — all BEFORE the new
  token pair is issued at the end of the method. Reassign the local `buyer` to each `update`'s returned
  row so the token/response reflect the new `passwordSet`/`emailVerified`/`googleId`. Then rewrite the
  three now-outdated spec cases and add one explicit squat-revocation spec.
- **exact code:** Replace the whole `if (buyer) { ... }` block (currently the block that starts at
  `if (buyer.status === "SUSPENDED") ...` and ends just before the `} else {` auto-create branch) with:

```ts
    if (buyer) {
      if (buyer.status === "SUSPENDED") throw new ForbiddenException("unauthorized");

      // Google attests the mailbox it authenticated — when that's the account's own
      // email, it satisfies the registration verification gate (requestSeller's
      // emailVerified check) exactly like clicking the emailed link would. NOT when
      // the account was found via a previously-linked googleId and the emails
      // differ: Google proved profile.email, not the account email.
      const googleAttestsMailbox = buyer.email.toLowerCase() === profile.email;

      // SECURITY (buyer-connect account-takeover): registration issues tokens with no
      // mailbox proof, so a password sitting on an account whose mailbox was NEVER
      // verified is attacker-controlled by assumption — anyone could have registered
      // under this email and chosen that password. When a Google sign-in is now about
      // to VERIFY the mailbox, the rightful owner is the Google identity, not whoever
      // set the password. Neutralize the squatted credential first: replace the hash
      // with an unguessable placeholder (passwordSet:false, so the true owner can claim
      // a real password via /buyer/auth/set-password) and revoke every existing session.
      const squattedPassword = googleAttestsMailbox && buyer.passwordSet && !buyer.emailVerified;

      if (!buyer.googleId) {
        if (squattedPassword) {
          const placeholderHash = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 10);
          buyer = await this.prisma.buyerAccount.update({
            where: { id: buyer.id },
            data: {
              googleId: profile.googleId,
              emailVerified: true,
              passwordHash: placeholderHash,
              passwordSet: false,
            },
          });
          await this.prisma.buyerRefreshToken.deleteMany({
            where: { buyerAccountId: buyer.id },
          });
          this.logger.warn(
            `Buyer ${buyer.id} had an unverified password neutralized on first Google link ` +
              `(mailbox now attested by Google; prior sessions revoked)`,
          );
        } else {
          buyer = await this.prisma.buyerAccount.update({
            where: { id: buyer.id },
            data: {
              googleId: profile.googleId,
              ...(googleAttestsMailbox ? { emailVerified: true } : {}),
            },
          });
        }
        void this.emailService
          .send({
            to: buyer.email,
            subject: "Google Sign-In linked to your RouteFlow account",
            html: `<p>Your Google account (<strong>${profile.email}</strong>) has been linked to your RouteFlow portal account.</p><p>If you did not authorise this, please contact support immediately.</p>`,
          })
          .catch((e: Error) => this.logger.warn(`Google link notification failed: ${e.message}`));
      } else if (googleAttestsMailbox && !buyer.emailVerified) {
        // Already-linked account whose mailbox was never verified (e.g. password
        // registration followed by Google linking before this gate existed). Same
        // squat exposure as the first-link path — neutralize the unproven password too.
        if (squattedPassword) {
          const placeholderHash = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 10);
          buyer = await this.prisma.buyerAccount.update({
            where: { id: buyer.id },
            data: {
              emailVerified: true,
              passwordHash: placeholderHash,
              passwordSet: false,
            },
          });
          await this.prisma.buyerRefreshToken.deleteMany({
            where: { buyerAccountId: buyer.id },
          });
          this.logger.warn(
            `Buyer ${buyer.id} had an unverified password neutralized on Google sign-in ` +
              `(already-linked; prior sessions revoked)`,
          );
        } else {
          buyer = await this.prisma.buyerAccount.update({
            where: { id: buyer.id },
            data: { emailVerified: true },
          });
        }
      }
    } else {
```

Notes for the implementer:

- `bcrypt` and `crypto` are already imported at the top of the file — do not re-import.
- `buyer` is declared with `let` at the top of `handleBuyerPortalAuth` — reassigning it is safe and
  intended; keep the rest of the method (invite handling, `sellerCount`, `issueBuyerTokenPair`,
  the returned object) exactly as-is. The revocation runs before `issueBuyerTokenPair`, so the fresh
  Google session survives and only pre-existing (attacker) sessions are killed.
- Do NOT change the `} else {` auto-create branch or anything after the `if (buyer) {...} else {...}`.

- **spec changes** in `google-oauth.buyer-autocreate.spec.ts` (this file does NOT mock bcrypt — real
  bcrypt runs, which is fine):
  1. Rewrite the test titled **"auto-link with a MATCHING email also flips emailVerified (Google
     attested the mailbox)"**. Its account is `{ googleId:null, passwordSet:true, emailVerified:false,
email:"new-buyer@example.com" }` (matches `profile.email`). It is now a squat → assert
     neutralization instead of a bare verify:
     `ts
     expect(prisma.buyerAccount.update).toHaveBeenCalledWith({
       where: { id: "buyer-1" },
       data: expect.objectContaining({
         googleId: "google-1",
         emailVerified: true,
         passwordSet: false,
         passwordHash: expect.any(String),
       }),
     });
     expect(prisma.buyerRefreshToken.deleteMany).toHaveBeenCalledWith({
       where: { buyerAccountId: "buyer-1" },
     });
     `
     Have `prisma.buyerAccount.update.mockResolvedValue({ id:"buyer-1", email:"new-buyer@example.com",
name:"Existing", passwordSet:false, emailVerified:true, googleId:"google-1", status:"ACTIVE" })`
     so the reassigned `buyer` is well-formed, and mock `prisma.buyerRefreshToken.deleteMany`.
  2. Rewrite the test titled **"an already-linked unverified account gets verified on a matching
     Google sign-in"** (`{ googleId:"google-1", passwordSet:true, emailVerified:false }`) — now also a
     squat → assert:
     ```ts
     expect(prisma.buyerAccount.update).toHaveBeenCalledWith({
       where: { id: "buyer-1" },
       data: expect.objectContaining({
         emailVerified: true,
         passwordSet: false,
         passwordHash: expect.any(String),
       }),
     });
     expect(prisma.buyerRefreshToken.deleteMany).toHaveBeenCalledWith({
       where: { buyerAccountId: "buyer-1" },
     });
     ```
  3. The test **"an existing buyer keeps their passwordSet value (no downgrade on Google link)"**
     stays PASSING as-is: its account email `existing@example.com` ≠ `profile.email`
     `new-buyer@example.com`, so `googleAttestsMailbox` is false, `squattedPassword` false — it still
     asserts `update({ where:{id:"buyer-1"}, data:{ googleId:"google-1" } })` and `hasPassword:true`.
     Leave it unchanged (confirm it still passes). `buyerRefreshToken.deleteMany` must NOT be called.
  4. The test **"an already-linked VERIFIED account triggers no account write at all"** stays as-is
     (verified → no squat, no write). Also assert `prisma.buyerRefreshToken.deleteMany` was NOT called.
  5. ADD a new test **"a Google merge into an unverified password account revokes credentials"** that
     documents the fix explicitly: account `{ googleId:null, passwordSet:true, emailVerified:false,
email:"victim@corp.com" }`, `profile.email:"victim@corp.com"` → assert `passwordSet:false` +
     `passwordHash` random (`expect.any(String)`, and capture it is NOT the account's prior hash) +
     `emailVerified:true` + `googleId` linked + `buyerRefreshToken.deleteMany` called with
     `{ where:{ buyerAccountId } }`. Use a `profile` with `email:"victim@corp.com"` for this case.

### WP2 — F2: kill stale verification tokens + sessions on admin email change

- **files:** `apps/api/src/buyer/buyer-admin.service.ts`, `apps/api/src/buyer/buyer-admin.service.spec.ts` (NEW)
- **brief:** In `BuyerAdminService.updateBuyer`, when the email actually changes, run the update inside
  a `$transaction` that also `deleteMany`s the account's `BuyerEmailVerificationToken` rows and its
  `BuyerRefreshToken` rows. Preserve the existing conflict check and the returned `select` shape.
- **exact code:** Replace the body of `updateBuyer` (from the `const buyer = ...` line through
  `return updated;`) with:

```ts
const buyer = await this.prisma.buyerAccount.findUnique({ where: { id } });
if (!buyer) throw new NotFoundException("Buyer account not found");

const emailChanging = dto.email !== undefined && dto.email !== buyer.email;
if (emailChanging) {
  const existing = await this.prisma.buyerAccount.findUnique({ where: { email: dto.email! } });
  if (existing) throw new ConflictException("Email is already in use by another account");
}

const updated = await this.prisma.$transaction(async (tx) => {
  const u = await tx.buyerAccount.update({
    where: { id },
    data: {
      ...(dto.name !== undefined && { name: dto.name }),
      ...(dto.email !== undefined && { email: dto.email, emailVerified: false }),
      ...(dto.phone !== undefined && { phone: dto.phone }),
      ...(dto.mobile !== undefined && { mobile: dto.mobile }),
    },
    select: {
      id: true,
      email: true,
      name: true,
      phone: true,
      mobile: true,
      status: true,
      emailVerified: true,
    },
  });
  if (emailChanging) {
    // The new address is unverified; any verification token already mailed to the
    // OLD address must die — verifyEmail binds a token to buyerAccountId, not to the
    // address that was mailed, so a stale token could otherwise verify the NEW
    // address. Revoke sessions too: the identity anchor just changed.
    await tx.buyerEmailVerificationToken.deleteMany({ where: { buyerAccountId: id } });
    await tx.buyerRefreshToken.deleteMany({ where: { buyerAccountId: id } });
  }
  return u;
});

return updated;
```

- **spec** `buyer-admin.service.spec.ts` (NEW): build the service with `createMockPrisma()`, a stub
  `JwtService`, and a stub `ConfigService` (`{ get: () => ({ secret:"s" }) }`). Do NOT override
  `$transaction`. Cases:
  - **email change** → `updateBuyer("b1", { email:"new@x.com" })` with
    `prisma.buyerAccount.findUnique` first resolving the account `{ id:"b1", email:"old@x.com" }` then
    `null` for the conflict check (use `mockResolvedValueOnce` twice). Assert
    `prisma.buyerAccount.update` called with `data` containing `email:"new@x.com", emailVerified:false`,
    AND `prisma.buyerEmailVerificationToken.deleteMany` called `{ where:{ buyerAccountId:"b1" } }`, AND
    `prisma.buyerRefreshToken.deleteMany` called `{ where:{ buyerAccountId:"b1" } }`.
  - **no email change** → `updateBuyer("b1", { name:"New Name" })` (findUnique resolves the account).
    Assert `deleteMany` on BOTH token models was NOT called.
  - **email conflict** → second `findUnique` resolves an existing account → expect `ConflictException`,
    and neither `update` nor any `deleteMany` called.

### WP3 — F4 (API): redact non-ACTIVE customer identity + throttle request-seller

- **files:** `apps/api/src/buyer/buyer.service.ts`, `apps/api/src/buyer/buyer.controller.ts`,
  `apps/api/src/buyer/buyer-connect.spec.ts`
- **brief (buyer.service.ts):** In `getSellers`, only expose the customer record for ACTIVE links; for
  INVITED / PENDING_SELLER_APPROVAL links return `customer: null`. Keep everything else identical.
  Change the returned `customer: link.customer` line to:

```ts
          // SECURITY (F4 roster oracle): a buyer's own un-approved request must not
          // confirm the seller's customer identity back to them. Reveal customer
          // identity only once the link is ACTIVE; pending/invited rows show the
          // seller branding + status badge only.
          customer: link.status === "ACTIVE" ? link.customer : null,
```

- **brief (buyer.controller.ts):** Add a tight per-endpoint throttle to `requestSeller`. Add the import
  `import { Throttle } from "@nestjs/throttler";` (alongside the other imports) and decorate the
  `@Post("sellers/request")` handler:

```ts
  @Post("sellers/request")
  @HttpCode(HttpStatus.OK)
  // F4: this endpoint is an email-enumeration surface (a matching customer at the
  // seller is a connect request; a non-match is a 404). Tighten beyond the global
  // throttle. 10/min still comfortably covers a buyer connecting to several sellers.
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @ApiOperation({ summary: "Request to connect with a seller by slug" })
  requestSeller(@CurrentBuyer() buyer: BuyerJwtPayload, @Body() dto: RequestSellerDto) {
    return this.buyerService.requestSeller(buyer.sub, dto);
  }
```

- **spec (buyer-connect.spec.ts):** Add a new `describe("BuyerService.getSellers — non-ACTIVE customer
redaction (security)")` block (reuse the same providers wiring as the existing describe — copy the
  `beforeEach` construction). Two cases, driven by `prisma.customerLink.findMany`:
  - ACTIVE link → returned entry has `customer` populated (`{ id, businessName, email }`).
  - PENDING_SELLER_APPROVAL link (and separately INVITED) → returned entry has `customer: null`, while
    `tenant.name`/`linkStatus` are still present.
    Mock `prisma.tenantConfig.findFirst` to resolve `null` (so tenant fallback name is used). Example row
    shape for `findMany`:
  ```ts
  { id:"l1", status:"ACTIVE", linkedAt:new Date(), tenantId:"t1",
    tenant:{ id:"t1", name:"Acme", slug:"acme" },
    customer:{ id:"c1", businessName:"Retail Corner", email:"c@x.com" } }
  ```

### WP4 — F4 (clients): tolerate null customer on pending sellers `effort: low`

- **files:** `apps/web/lib/buyer-auth.ts`, `apps/web/app/buyer/portal/page.tsx`,
  `apps/mobile/lib/buyer-auth.ts`, `apps/mobile/app/(customer)/sellers.tsx`
- **brief:** The API now returns `customer: null` for non-ACTIVE sellers. Update both `BuyerSeller`
  types and guard both render sites so nothing dereferences a null customer.
  - `apps/web/lib/buyer-auth.ts`: change
    `customer: { id: string; businessName: string; email: string | null };`
    to `customer: { id: string; businessName: string; email: string | null } | null;`
  - `apps/web/app/buyer/portal/page.tsx` (~line 84): the line renders
    `<p ...>{seller.customer.businessName}</p>`. Render it only when a customer is present:
    ```tsx
    {
      seller.customer ? (
        <p className="text-sm text-navy/70 truncate">{seller.customer.businessName}</p>
      ) : null;
    }
    ```
    (Keep the exact existing className.) Grep this file for any other `seller.customer.` /
    `.customer.` access and guard each with optional chaining.
  - `apps/mobile/lib/buyer-auth.ts`: change the `customer: { id; businessName; email } ` shape (the
    `BuyerSeller` interface) to `customer: { id: string; businessName: string; email: string | null } | null;`
  - `apps/mobile/app/(customer)/sellers.tsx` (~line 118): the line renders
    `as {seller.customer.businessName}`. Guard it, e.g.:
    ```tsx
    {
      seller.customer ? `as ${seller.customer.businessName}` : "Pending approval";
    }
    {
      isCurrent ? " · Current" : "";
    }
    ```
    Confirm the switch/open path already filters to ACTIVE (`canOpenSeller`) so a null-customer row is
    never opened; grep the file for other `seller.customer.` accesses and guard them.
  - `apps/mobile/lib/seller-directory-logic.ts` only reads `linkStatus` (not customer) — leave it and
    its test untouched.

### WP5 — F3: read-only prod audit script (documents the replay hazard) `effort: low`

- **files:** `apps/api/scripts/audit-buyer-verification-grandfather.mjs` (NEW)
- **brief:** A strictly READ-ONLY Node ESM script (Prisma findMany only — no writes anywhere) that the
  owner runs against prod via `railway run --service postgres node apps/api/scripts/audit-buyer-verification-grandfather.mjs`.
  It lists buyer accounts that the unbounded grandfather backfill may have silently verified: accounts
  created before the cutoff, `emailVerified=true`, that never held a verification token, whose email
  matches a Customer (or linked User) email, and cross-references their ACTIVE CustomerLinks. Its header
  comment documents that the migration's `UPDATE ... WHERE emailVerified=false` is time-unbounded and
  must never be replayed (a DB restore relies on `_prisma_migrations`; never re-run the data step).
- **exact code:** create the file with exactly:

```js
#!/usr/bin/env node
/**
 * READ-ONLY audit — buyer-connect email-verification grandfather backfill (F3).
 *
 * The migration 20260824000000_add_buyer_email_verification grandfathered every
 * then-existing buyer account to emailVerified=true with a TIME-UNBOUNDED
 * statement:  UPDATE "BuyerAccount" SET "emailVerified" = true WHERE "emailVerified" = false;
 * That is correct once, at deploy. But it is NOT idempotent-by-intent: replaying
 * it (e.g. a hand-run of the data step after a DB restore) would silently verify
 * EVERY currently-pending account. Prisma will not re-run an applied migration on
 * `migrate deploy` (it tracks `_prisma_migrations`), so the guard is operational:
 * never re-run the data step by hand; let restores replay through the migrations
 * table only.
 *
 * This script makes NO writes. It flags accounts the backfill MAY have verified
 * without any mailbox proof: created before the cutoff, emailVerified=true, that
 * never held a verification token, whose email matches a customer/user record, and
 * shows their ACTIVE CustomerLinks (the #378→#386 auto-connect exposure window).
 *
 * Run against prod (read-only):
 *   railway run --service postgres node apps/api/scripts/audit-buyer-verification-grandfather.mjs
 */
import { PrismaClient } from "@prisma/client";

const CUTOFF = new Date("2026-08-24T00:00:00.000Z");
const prisma = new PrismaClient();

async function main() {
  const suspects = await prisma.buyerAccount.findMany({
    where: {
      emailVerified: true,
      createdAt: { lt: CUTOFF },
      emailVerificationTokens: { none: {} },
      deletedAt: null,
    },
    select: {
      id: true,
      email: true,
      createdAt: true,
      googleId: true,
      passwordSet: true,
      customerLinks: {
        where: { status: "ACTIVE" },
        select: {
          id: true,
          tenantId: true,
          customer: { select: { id: true, businessName: true, email: true } },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  const flagged = [];
  for (const acc of suspects) {
    const email = acc.email.toLowerCase();
    // Does this buyer's email match any customer record (own email or linked user email)?
    const match = await prisma.customer.findFirst({
      where: { OR: [{ email }, { user: { email } }] },
      select: { id: true, tenantId: true, businessName: true },
    });
    if (!match && acc.customerLinks.length === 0) continue;
    flagged.push({
      buyerId: acc.id,
      email: acc.email,
      createdAt: acc.createdAt.toISOString(),
      googleLinked: !!acc.googleId,
      passwordSet: acc.passwordSet,
      matchedCustomer: match
        ? { id: match.id, tenantId: match.tenantId, businessName: match.businessName }
        : null,
      activeLinks: acc.customerLinks.map((l) => ({
        linkId: l.id,
        tenantId: l.tenantId,
        customerId: l.customer?.id ?? null,
        businessName: l.customer?.businessName ?? null,
      })),
    });
  }

  console.log(
    `\nBuyer verification grandfather audit — cutoff ${CUTOFF.toISOString()}\n` +
      `Scanned ${suspects.length} tokenless pre-cutoff verified accounts; ` +
      `${flagged.length} match a customer record and/or hold ACTIVE links.\n`,
  );
  console.log(JSON.stringify(flagged, null, 2));
  console.log(
    `\nREAD-ONLY: no rows were modified. Review flagged accounts whose password ` +
      `was never mailbox-proven (passwordSet=true, googleLinked=false) and that hold ` +
      `ACTIVE links — those are the highest-risk grandfathered auto-connects.\n`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
```

## Acceptance criteria

1. In `handleBuyerPortalAuth`, when `buyer.email.toLowerCase() === profile.email`, `buyer.passwordSet`
   is true and `buyer.emailVerified` is false, the account update sets `passwordSet:false` with a fresh
   random `passwordHash`, sets `emailVerified:true` (and `googleId` on the first-link path), and
   `prisma.buyerRefreshToken.deleteMany({ where:{ buyerAccountId } })` is called BEFORE
   `issueBuyerTokenPair`.
2. When the mailbox is NOT attested (account email ≠ profile email), no password neutralization and no
   token revocation occur — the first-link path still only sets `googleId` (test 3 in WP1 unchanged).
3. A brand-new Google account (no existing buyer row) is still auto-created with `passwordSet:false`,
   `emailVerified:true` — unchanged.
4. `google-oauth.buyer-autocreate.spec.ts` passes with the two rewritten cases, the two unchanged
   cases, and the new explicit squat-revocation case.
5. `BuyerAdminService.updateBuyer` deletes the account's `BuyerEmailVerificationToken` rows AND its
   `BuyerRefreshToken` rows in the same transaction as the update **iff** the email changed; a
   name/phone-only update touches neither token model. `buyer-admin.service.spec.ts` proves all three
   cases (change / no-change / conflict).
6. `getSellers` returns `customer: null` for INVITED and PENDING_SELLER_APPROVAL links and the full
   customer object for ACTIVE links; tenant branding and `linkStatus` are unchanged for all statuses.
   `buyer-connect.spec.ts` proves ACTIVE-populated and non-ACTIVE-null.
7. `POST /buyer/sellers/request` carries `@Throttle({ default: { ttl: 60_000, limit: 10 } })` and the
   `Throttle` import resolves.
8. Web `BuyerSeller.customer` and mobile `BuyerSeller.customer` are typed `... | null`; neither
   `apps/web/app/buyer/portal/page.tsx` nor `apps/mobile/app/(customer)/sellers.tsx` dereferences a null
   customer (guarded render), and both apps typecheck.
9. `apps/api/scripts/audit-buyer-verification-grandfather.mjs` exists, performs only reads
   (`findMany`/`findFirst`, no `update`/`create`/`delete`/`$executeRaw`), and its header documents the
   replay hazard.
10. No Prisma migration file is added or modified anywhere in the diff.

## Verification commands

Run from the repo root:

- `npm run check-types` — typechecks api + web + mobile + packages (covers the F4 client type changes).
- `cd apps/api && npx jest src/auth/google-oauth.buyer-autocreate.spec.ts src/buyer/buyer-connect.spec.ts src/buyer/buyer-email-verification.spec.ts src/buyer/buyer-admin.service.spec.ts`
  — the four touched/added specs must pass (buyer-email-verification.spec is a regression guard on the
  same service; it must stay green).

## Risks & rollback

- **F1 collateral:** a legitimate user who registered with a password, never verified, then signs in
  with Google loses that password (must reset) and any active sessions. This is the accepted,
  safe-side trade-off — the mailbox owner reclaims the account and can set a new password via
  `/buyer/auth/set-password` (now enabled by `passwordSet:false`) or the reset flow. Watch that the
  revocation runs BEFORE `issueBuyerTokenPair` so the current Google login is not itself logged out.
- **F1 correctness:** the `else if` (already-linked) branch now also neutralizes — verify the normal
  auto-created account (`passwordSet:false`) is untouched there (it fails the `passwordSet` guard).
- **F4 client crash:** the real risk is an unguarded `seller.customer.businessName`. The reviewer must
  confirm both portals guard every customer dereference; a missed one throws at runtime for any buyer
  with a pending/invited seller.
- **F2 transaction shape:** the callback-form `$transaction` must be used (matches `acceptInvite` in
  the same service and the default mock). Do not switch to the array form.
- **Rollback:** all changes are additive/local and migration-free; revert the branch to undo.
