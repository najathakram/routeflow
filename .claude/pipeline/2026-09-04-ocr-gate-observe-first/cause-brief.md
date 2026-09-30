# Cause brief — OCR-1 / OCR-2 ocr-addon-gate-breaks-scan

> Written by the S1 evidence agent (Sonnet @ low, read-only). Facts with evidence only — every
> claim carries a file:line or quoted source, against `origin/master` (fetched fresh; local
> working tree is on branch `fix/imp-02-order-merge-advisory-lock` and was not used for any of
> the citations below — every `git show`/`git log`/`git blame` below is pinned to `origin/master`
> or an explicit commit sha). The suspected causes are recorded AS CLAIMS. No fix proposals.

## The bug as stated

- **Source** (as given to this brief — no registry id exists yet):
  - **OCR-1 (API)**: `POST /api/v1/vendor-bills/scan-invoice` returns 403 `This feature requires
the "ocr" add-on.` for every tenant without an active `TenantAddon` row `addonKey="ocr"`.
    Before PR #475 (squash `5cb71545`, merged origin/master 2026-08-29) the route had no add-on
    gate and worked for every tenant.
  - **OCR-2 (web)**: `apps/web/components/ScanInvoiceModal.tsx` single-scan error handler
    discards the server's message/code for everything except Anthropic-API-key errors and shows
    "Please check the file and try again."
- **Repro**:
  - OCR-1: input = a tenant with no `ocr` TenantAddon row uploads a valid invoice file to
    `POST /vendor-bills/scan-invoice` → observed: 403 `This feature requires the "ocr" add-on.`
    before the file ever reaches the AI call; expected: reaches the scan path (as it did before
    2026-08-29).
  - OCR-2: input = server 403 with message X (e.g. the AddonGuard message above) → observed: web
    toast "Please check the file and try again."; expected: shows X (or a message derived from
    the server code).
- **Production evidence (as given)**: 6 requests to `scan-invoice` on 2026-09-03 between 15:43Z
  and 17:47Z, all 403 in 17–79 ms, zero 200s on that route in the 7-day log window. (This S1 agent
  has no production log access; the figures are taken as given from the task and not
  independently re-verified here.)
- **Suspected causes (claims, unverified — labels per the task)**:
  - **C1**: "the gate shipped with no grandfathering and outside the existing
    `PLAN_FLAG_ENFORCEMENT` observe-first pattern."
  - **C2**: "the web handler collapses all non-key errors to a generic string."

## Code path — OCR-1

1. **Entry point** — `apps/api/src/vendor-bills/vendor-bills.controller.ts:37-41`:

   ```
   37  @Controller("vendor-bills")
   38  @UseGuards(JwtAuthGuard, RolesGuard, PlanFlagGuard, AddonGuard)
   39  @Roles(UserRole.OPERATOR)
   40  @RequirePlanFlag("flag.ap_bills")
   41  export class VendorBillsController {
   ```

   and the scan handler itself, `vendor-bills.controller.ts:70-79`:

   ```
   70    // AI OCR is entitlement-gated (owner decision 2026-08-28) — OCR_ADDON in
   71    // packages/types is the client-side mirror of this key.
   72    @Post("scan-invoice")
   73    @RequireAddon("ocr")
   74    @UseInterceptors(
   75      // Up to 10 pages, 25MB per file, under the field name `images` (multer
   76      // matches the field name exactly — clients MUST use "images").
   77      FilesInterceptor("images", 10, { limits: uploadLimits(MB(25)) }),
   78    )
   79    scanInvoice(@UploadedFiles() files: Express.Multer.File[], @CurrentUser() user: { id: string }) {
   ```

   Class-level comment at `:35-36`: `// OPERATOR-only end to end. AddonGuard passes handlers
without @RequireAddon metadata — only the AI scan endpoint below is addon-gated.`

2. **Guard order** — both `PlanFlagGuard` and `AddonGuard` run for this route (class-level
   `@UseGuards` at :38, method carries only `@RequireAddon("ocr")` — `RequirePlanFlag` is
   class-level `flag.ap_bills` at :40). Per `getAllAndOverride`, handler metadata wins over class
   metadata only when the SAME decorator is declared at both levels; here the two decorators are
   independent and BOTH guards evaluate on every request to `scan-invoice`:
   - `PlanFlagGuard` checks `flag.ap_bills` (class-level, :40) — but `flag.ap_bills` **is** a
     member of `DARK_PLAN_FLAGS` (see below), so this check is a no-op unless
     `PLAN_FLAG_ENFORCEMENT=on`.
   - `AddonGuard` checks `"ocr"` (method-level, :73) — **not** a plan flag, no kill switch exists
     for `AddonGuard` at all (see next section) — this is the guard that 403s.

3. **`AddonGuard.canActivate`** — `apps/api/src/billing/addon.guard.ts` (full file, 57 lines):

   ```
   1   import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
   2   import { Reflector } from "@nestjs/core";
   3   import { AddonService } from "./addon.service";
   4   import { REQUIRE_ADDON_KEY } from "./require-addon.decorator";
   5
   6   /**
   7    * Addon keys that are internal platform-admin switches rather than purchasable add-ons.
   8    * They are honoured as any-of keys but NEVER named in the 403 message — the web toasts
   9    * that message verbatim (MutationCache.onError), so echoing them would leak a hidden flag
   10   * and give tenants upgrade guidance they cannot act on. String literals on purpose: API
   11   * source never imports @routeflow/types at runtime.
   12   */
   13  const INTERNAL_ADDON_KEYS = new Set(["developer_mode"]);
   14
   15  /**
   16   * Enforces @RequireAddon(key). Guard order matters:
   17   * `@UseGuards(JwtAuthGuard, RolesGuard, AddonGuard)` — guards run BEFORE the
   18   * TenantInterceptor, so the tenant AsyncLocalStorage is NOT initialized here;
   19   * read the tenantId from `req.user` (populated by JwtAuthGuard), never from
   20   * `prisma.getTenantId()`.
   21   */
   22  @Injectable()
   23  export class AddonGuard implements CanActivate {
   24    constructor(
   25      private readonly reflector: Reflector,
   26      private readonly addonService: AddonService,
   27    ) {}
   28
   29    async canActivate(context: ExecutionContext): Promise<boolean> {
   30      // Metadata is either the legacy single string (from a call site that hasn't been
   31      // touched) or the current string[] from the variadic @RequireAddon(...keys).
   32      const raw = this.reflector.getAllAndOverride<string | string[] | undefined>(REQUIRE_ADDON_KEY, [
   33        context.getHandler(),
   34        context.getClass(),
   35      ]);
   36      const keys = typeof raw === "string" ? [raw] : raw;
   37      if (!keys || keys.length === 0) return true;
   38
   39      const request = context.switchToHttp().getRequest<{ user?: { tenantId?: string | null } }>();
   40      const tenantId = request.user?.tenantId ?? null;
   41      // SUPER_ADMIN operates without a tenant — never addon-gated
   42      if (tenantId == null) return true;
   43
   44      const active = await this.addonService.getActiveAddons(tenantId); // one query for any-of
   45      if (keys.some((k) => active.includes(k))) return true;
   46      // Name only the purchasable keys; internal flags stay out of tenant-facing text.
   47      const named = keys.filter((k) => !INTERNAL_ADDON_KEYS.has(k));
   48      const quoted = named.map((k) => `"${k}"`).join(", ");
   49      throw new ForbiddenException(
   50        named.length === 0
   51          ? "This feature is not enabled for your account."
   52          : named.length === 1
   53            ? `This feature requires the ${quoted} add-on.`
   54            : `This feature requires one of these add-ons: ${quoted}.`,
   55      );
   56    }
   57  }
   ```

   **This is the exact code path producing the observed 403.** There is NO env-var / kill-switch
   read anywhere in this file — `AddonGuard.canActivate` unconditionally enforces the moment a
   `@RequireAddon` key is present and the tenant lacks it (lines 44-55). Compare to
   `PlanFlagGuard` below, which DOES have such a switch.

4. **`AddonService.getActiveAddons`** — `apps/api/src/billing/addon.service.ts:51-58`:

   ```ts
   async getActiveAddons(tenantId: string): Promise<string[]> {
     const addons = await this.prisma.tenantAddon.findMany({
       where: { tenantId, active: true },
       select: { addonKey: true },
     });
     return addons.map((a) => a.addonKey);
   }
   ```

   Direct, uncached DB read of `TenantAddon` rows (no in-memory cache, unlike
   `EntitlementsService`'s 30s cache noted in `.claude/code-map/api.md:892` for the plan-flag
   path). `enableAddon`/`disableAddon` (`addon.service.ts:81-152, 156-176`) upsert/update that
   same `TenantAddon` row and call `this.entitlements.invalidate(tenantId)` — invalidating the
   UNRELATED `EntitlementsService` cache, not anything `AddonGuard` itself caches (it has none).

5. **`RequireAddon` decorator** — `apps/api/src/billing/require-addon.decorator.ts` (full file):
   ```ts
   import { SetMetadata } from "@nestjs/common";
   export const REQUIRE_ADDON_KEY = "requireAddon";
   /**
    * Gate a controller/handler on a tenant addon (e.g. "tobacco_dealer"), or on ANY of several
    * addons (e.g. `@RequireAddon("recurring_routes", "order_delivery", "developer_mode")`).
    * Must be paired with AddonGuard AFTER JwtAuthGuard in @UseGuards.
    */
   export const RequireAddon = (...addonKeys: string[]) =>
     SetMetadata(REQUIRE_ADDON_KEY, addonKeys);
   ```

## The contrasting mechanism — `PlanFlagGuard` / `DARK_PLAN_FLAGS` / `PLAN_FLAG_ENFORCEMENT`

`apps/api/src/billing/plan-flag.guard.ts` (full file, 89 lines; key excerpt lines 1-70):

```
1   import {
2     CanActivate,
3     ExecutionContext,
4     ForbiddenException,
5     Injectable,
6     Logger,
7   } from "@nestjs/common";
8   import { Reflector } from "@nestjs/core";
9   import { EntitlementsService } from "./entitlements.service";
10  import { PlanCatalogService } from "./plan-catalog.service";
11  import { REQUIRE_PLAN_FLAG_KEY } from "./require-plan-flag.decorator";
12  import { buildPlanGateBody } from "./plan-gate";
13
14  /**
15   * Flags whose server-side enforcement the 2026-08-23 rollout introduces — these,
16   * and ONLY these, are muted by the PLAN_FLAG_ENFORCEMENT kill switch. Any gate
17   * not listed here was already live before the switch existed (flag.msrp, shipped
18   * in #411) and must keep enforcing regardless of the env. REMOVE this set along
19   * with the switch by 2026-10-01.
20   */
21  const DARK_PLAN_FLAGS = new Set([
22    "flag.analytics",
23    "flag.ap_bills",
24    "flag.import_integrations",
25    "flag.forecasting",
26    "flag.pricing_tiers",
27    "flag.reports",
28    "flag.returns",
29  ]);
...
41  export class PlanFlagGuard implements CanActivate {
...
51    async canActivate(context: ExecutionContext): Promise<boolean> {
52      const flagKey = this.reflector.getAllAndOverride<string | undefined>(REQUIRE_PLAN_FLAG_KEY, [
53        context.getHandler(),
54        context.getClass(),
55      ]);
56      if (!flagKey) return true;
57
58      // Release toggle (REMOVE by 2026-10-01): the gates added by the 2026-08-23
59      // rollout ship dark. "on" = enforce; anything else = allow. Scoped to
60      // DARK_PLAN_FLAGS so gates that were already live (flag.msrp) keep enforcing.
61      // The owner flips this on only after the prod entitlement audit
62      // (scripts/audit-tenant-entitlements.mjs) proves no live tenant loses a
63      // surface it uses today.
64      if (DARK_PLAN_FLAGS.has(flagKey) && (process.env.PLAN_FLAG_ENFORCEMENT ?? "off") !== "on") {
65        return true;
66      }
67
68      const request = context.switchToHttp().getRequest<{ user?: { tenantId?: string | null } }>();
69      const tenantId = request.user?.tenantId ?? null;
70      // SUPER_ADMIN operates without a tenant — never plan-gated.
```

**Exact env var semantics**: `process.env.PLAN_FLAG_ENFORCEMENT ?? "off"` — any value other than
the literal string `"on"` is treated as off (allow). Default (unset) = `"off"` = allow. Read
inline at request time (no caching of the env value itself). Scope: the switch mutes ONLY the
seven flags in `DARK_PLAN_FLAGS` (lines 21-29) — `flag.ap_bills` (VendorBillsController's own
class-level flag, `vendor-bills.controller.ts:40`) is one of them, so that gate is dark by default
today. A flag NOT in the set (e.g. `flag.msrp`, shipped in #411 per the comment) always enforces
regardless of the env var. **`AddonGuard`/`@RequireAddon("ocr")` has no equivalent set and no env
read anywhere in its file** — see full-file excerpt above; there is nothing to add `"ocr"` to.

**Origin of `PLAN_FLAG_ENFORCEMENT`**: local plan doc
`.claude/pipeline/plans/2026-08-23-enforce-plan-flags.md` (uncommitted/local-only path, read from
the working tree since it isn't part of `origin/master`'s history subject here, but it documents
the same commit `0a0aef12`) states the objective verbatim:

> "The plan catalog defines 11 entitlement flags; NONE is enforced server-side (the only live
> gate is `@RequireAddon("tobacco_dealer")`). Plan tiers do not exist at runtime. This PR wires
> enforcement — **shipping INERT**: a `PLAN_FLAG_ENFORCEMENT` env (default `off`) makes every new
> gate a no-op, so merging can never break a live tenant. The owner flips it on only after
> running the WP4 audit against prod."

and WP1 of that plan (the literal code later landed) instructs adding, verbatim:

```ts
// Release toggle (REMOVE by 2026-10-01): plan-flag enforcement ships dark.
// "on" = enforce; anything else = allow everything. The owner flips this on
// only after the prod entitlement audit (scripts/audit-tenant-entitlements.mjs)
// proves no live tenant loses a surface it uses today.
if ((process.env.PLAN_FLAG_ENFORCEMENT ?? "off") !== "on") return true;
```

— i.e. even the ORIGINAL WP1 design covered every `@RequirePlanFlag` gate unconditionally; the
narrower `DARK_PLAN_FLAGS`-scoped version (excluding `flag.msrp`) is what actually shipped in
`plan-flag.guard.ts` above.

**How a "dark" flag denial is logged**: nothing is logged when `DARK_PLAN_FLAGS.has(flagKey) &&
enforcement !== "on"` short-circuits to `return true` at line 64-66 above — no `Logger` call, no
audit trail of "would have denied." The guard's only `Logger` usage
(`plan-flag.guard.ts` — visible past line 70, not reproduced above) is on entitlement-resolution
failure (fail-closed 503) and on a plan-definition fallback, not on a muted-gate pass-through.

## Code path — OCR-2

**`ScanInvoiceModal.tsx`, single-scan (`singleFlow=true`) AND batch-scan handler — same
function, `scanOne`** — `apps/web/components/ScanInvoiceModal.tsx:686-726`:

```
686   /**
687    * Scan one invoice group. `singleFlow` keeps today's exact single-invoice
688    * UX: full-screen processing spinner, toast + back-to-upload on failure.
689    * In batch mode a failure only marks that invoice failed (retryable).
690    */
691   const scanOne = async (inv: InvoiceGroup, runId: number, singleFlow = false) => {
692     const controller = new AbortController();
693     abortersRef.current.set(inv.id, controller);
694     try {
695       // A document already in the archive comes back instantly with its stored
696       // extraction and a `priorScan` block — same shape, no second AI call.
697       const result = (await scanInvoice(inv.files, controller.signal)) as ArchivedScanResult;
698       if (runId !== runIdRef.current) return;
699       applyScan(inv.id, result);
700       if (singleFlow) {
701         setStep("review");
702         setShowPreview(true);
703       }
704     } catch (err: any) {
705       if (runId !== runIdRef.current || controller.signal.aborted) return;
706       console.error(err);
707       const msg: string = err?.response?.data?.message ?? "";
708       const code: string | undefined = err?.response?.data?.code;
709       const isApiKeyError = code === "AI_KEY_INVALID" || /api key|anthropic/i.test(msg);
710       if (singleFlow) {
711         toast({
712           title: isApiKeyError ? "Anthropic API key not configured" : "Failed to scan invoice",
713           description: isApiKeyError
714             ? "Go to Settings → AI & Integrations to add your Claude API key."
715             : "Please check the file and try again.",
716           variant: "error",
717         });
718         setStep("upload");
719       } else {
720         patchInvoiceById(inv.id, {
721           status: "failed",
722           error: isApiKeyError
723             ? "Anthropic API key not configured — see Settings → AI & Integrations."
724             : msg || "Scan failed. Retry, or check the file.",
725         });
726       }
```

**Important nuance**: `scanOne` handles BOTH flows in one function. The single-scan branch
(`singleFlow` true, lines 710-718 — the modal's normal single-invoice upload) hard-codes the
description string `"Please check the file and try again."` for every non-key error, discarding
`msg` entirely. The **batch-scan branch** (lines 719-725, used when scanning multiple PDFs at
once) DOES surface the server's `msg` (`error: ... : msg || "Scan failed. Retry, or check the
file."`) — it falls back to a generic string only when `msg` is empty. So OCR-2 as stated
("discards the server's message/code for everything except… key errors") is accurate for the
**single-scan** path specifically; the batch path already threads `msg` through.

`isApiKeyError` special-case: `code === "AI_KEY_INVALID" || /api key|anthropic/i.test(msg)` (line 709) — the regex fallback exists because `getDuplicateVendorBillError`-style typed-code checks are
inconsistent across this file's several catch blocks (see below); some blocks only have `msg`,
not `code`.

For contrast, the second `catch` block later in the same file (`handleCreateAll`'s
create/receive/expense flow, NOT the scan call) — `ScanInvoiceModal.tsx:1374-1394`:

```
1374   } catch (err: any) {
1375     // The pre-flight probe can't see a bill created moments ago by an earlier
1376     // invoice in this same batch, so the server's 409 is the only signal that
1377     // the number repeats within the batch. Stamp it and let the loop go on.
1378     const dup = getDuplicateVendorBillError(err);
1379     if (dup) {
1380       patchInvoiceById(invoiceId, {
1381         duplicate: dup.duplicate,
1382         duplicateCheckPending: false,
1383         error: null,
1384       });
1385       return { ok: false, duplicate: true, notes };
1386     }
1387     const msg =
1388       err?.response?.data?.message ||
1389       err?.message ||
1390       "Failed to create records. Please try again.";
1391     // Keep status "scanned" so the invoice stays editable + creatable.
1392     patchInvoiceById(invoiceId, { error: msg });
1393     return { ok: false, duplicate: false, notes };
1394   }
```

This block (creating the bill, AFTER a successful scan) always surfaces `msg`. Only the
`scanOne` single-scan branch (lines 710-718) hard-codes the generic fallback string.

**Web API client error normalization** — `apps/web/lib/api-client.ts`:

- Axios instance created at `:17-24`; `apiClient.interceptors.response.use(...)` at `:163` only
  handles (a) a `PLAN_GATE`-shaped 403 on **GET** requests (fires a `planGateListener`, doesn't
  change the rejected error) and (b) 401 → refresh-token retry logic. **Nothing in the interceptor
  normalizes or rewrites `error.response.data.message`/`.code` for a plain `ForbiddenException`
  on a POST** (comment at `:132-138`: "Mutations are NOT routed through this bridge:
  `MutationCache.onError` in `app/providers.tsx` already toasts every mutation error's `message`… "
  — that generic app-wide toast is separate from and NOT what `ScanInvoiceModal` uses; the modal
  has its own bespoke catch blocks as shown above).
- `AddonGuard`'s `ForbiddenException(string)` body (thrown as a bare string, not
  `{message, code}`) — per Nest's default exception body shape, this serializes as
  `{statusCode: 403, message: "This feature requires the \"ocr\" add-on.", error: "Forbidden"}`.
  **`err.response.data.code` is `undefined`** for this specific error (there is no `code` field on
  a plain `ForbiddenException`), unlike the AI-scan-service errors below which ARE thrown as
  `{message, code}` objects. So `msg` at `ScanInvoiceModal.tsx:707` would in fact resolve to the
  server's exact 403 message string, and `code` at :708 would be `undefined` (not
  `"AI_KEY_INVALID"`, so `isApiKeyError` is `false` unless the message text happens to match the
  `/api key|anthropic/i` regex — the AddonGuard message does not).
- No `AI_KEY_INVALID`-adjacent shared error-code constants exist in `packages/types` — confirmed
  by `git grep -n "AI_KEY_INVALID|AI_SCAN_REJECTED|AI_UNAVAILABLE|AI_PARSE_FAILED" -- packages/types`
  returning zero hits. The four typed codes are string literals duplicated ad hoc inside
  `apps/api/src/vendor-bills/vendor-bills.service.ts` and (separately) inside
  `apps/api/src/supplier-statements/supplier-statements.service.ts`, and consumed ad hoc inside
  each web page's own catch block — there is no shared type or enum.
- `.claude/code-map/web.md:629` (existing map note, written 2026-08-20 for a _different_,
  newer scan surface) already documents this exact gap for `ScanInvoiceModal`:

  > "**Error handling branches on all four typed AI codes** — `AI_KEY_INVALID` links to the
  > Anthropic settings section, `AI_UNAVAILABLE` is the ONLY one offered a Retry,
  > `AI_SCAN_REJECTED` / `AI_PARSE_FAILED` get their own copy (this is the gap the older
  > `ScanInvoiceModal` still has — it special-cases only `AI_KEY_INVALID`)."

- **`packages/types/index.ts:177-181`** — `OCR_ADDON` constant and its doc comment (this is the
  client-side mirror of the `"ocr"` `TenantAddon.addonKey`, referenced by the controller comment
  at `vendor-bills.controller.ts:70-71`):
  ```
  /**
   * TenantAddon.addonKey gating the AI document-reading features (owner decision
   * 2026-08-28): vendor-bill scan, batch invoice scan, supplier-statement scan,
   * and expense-receipt extraction. Server-enforced via @RequireAddon("ocr") on
   * those endpoints (403 without it). Granted from the platform-admin tenant page
   * or via the OCR_PACK_250 SKU bridge. ⚠️ Web/mobile entry surfaces are NOT yet
   * hidden behind `useHasAddon(OCR_ADDON)` — follow-up owed; until then, tenants
   * without the addon still see scan buttons and get 403s. Route insights are NOT
   * covered by this key.
   */
  export const OCR_ADDON = "ocr";
  ```
  This confirms, in the codebase's own words, that the web scan button is shown unconditionally
  today and the resulting 403 is an acknowledged-but-undone follow-up, not something OCR-1
  discovered fresh.

**Mobile — `apps/mobile/app/(operator)/vendor-bills/scan.tsx:99-106`** (scan-mutation
`onError`):

```
99      onError: (e: any) => {
100       setStep("upload");
101       showToast(
102         e?.response?.data?.message ??
103           e?.message ??
104           "Could not read invoice. Try a clearer photo.",
105       );
106     },
```

Mobile's scan-mutation error handler DOES surface `e.response.data.message` (server message)
directly, falling back to a generic string only when no server message exists at all. This
differs from web's single-scan branch, which hard-codes the generic string even when a server
message IS present. (Mobile's create-bill `onError`, `scan.tsx:157-160`, follows the same
message-first pattern.)

## History

### OCR-1 — `apps/api/src/vendor-bills/vendor-bills.controller.ts`

`git log origin/master --format='%h %ad %s' --date=short -8 -- apps/api/src/vendor-bills/vendor-bills.controller.ts`:

```
8a51790d 2026-09-01 fix(api): actually mitigate the multer field-parser DoS (#590)
5cb71545 2026-08-29 feat(api): wire AI usage metering; unify Anthropic key resolution (#475)
0a0aef12 2026-08-23 feat(billing): enforce plan entitlement flags behind a default-off switch (#420)
661191a5 2026-08-20 feat(finance): supplier payment allocation, on-account credit, bulk mark-paid (#375)
67b049e3 2026-08-18 fix(api): tax rate is a percent, and product mappings stay in their tenant (#356)
bbcb58ea 2026-08-12 Costing accuracy: AVCO valuation, skip-dup scan batches, case-to-piece receiving, partial receipts (#335)
4f5ed09b 2026-08-07 feat: duplicate invoice detection, backdated orders, payment bank date, mobile scan rework (#322)
ef21ef04 2026-07-17 fix(api): authz + input-validation hardening batch (SEC-1) (#285)
```

`git blame origin/master -- apps/api/src/vendor-bills/vendor-bills.controller.ts` for the two
lines in question:

```
98e5b846a (Najath Akram 2026-03-30 14:14:09 -0500  72)   @Post("scan-invoice")
5cb715458 (najathakram  2026-08-29 06:06:26 -0500  73)   @RequireAddon("ocr")
```

— the route itself (`@Post("scan-invoice")`) dates to 2026-03-30 (commit `98e5b846a`, pre-existing
long before this incident); the `@RequireAddon("ocr")` line was added by `5cb71545` on 2026-08-29.

**`AddonGuard` itself, `apps/api/src/billing/addon.guard.ts`** — separate, narrower history:

```
28cb0a25 2026-08-29 fix: honor dispatch feature toggles (narrow developer_mode, enforce addons) + impersonation identity + no auto admin drivers (#491)
df92cd5c 2026-07-04 feat(tobacco): tobacco dealer compliance — addon, separate tracking, monthly tax reports (#113)
```

Only two commits ever touched this file: its creation (`df92cd5c`, tobacco addon) and `28cb0a25`
(2026-08-29, #491 — the variadic/any-of + `INTERNAL_ADDON_KEYS` rework documented in
`.claude/code-map/api.md:878`). **Neither commit, nor `5cb71545` which only edited the
controller, ever added an env-driven kill switch to `AddonGuard`.**

**`PlanFlagGuard`, `apps/api/src/billing/plan-flag.guard.ts`** — separate history:

```
0a0aef12 2026-08-23 feat(billing): enforce plan entitlement flags behind a default-off switch (#420)
441ad492 2026-07-08 feat(billing): plans-as-data engine, entitlements + JWT claims, plan-gate primitive (#137)
```

The `DARK_PLAN_FLAGS`/`PLAN_FLAG_ENFORCEMENT` pattern was introduced by `0a0aef12` on 2026-08-23 —
**six days before** `5cb71545` added `@RequireAddon("ocr")` to the scan route. The pattern existed
and was already live in the codebase (on the very same controller, gating `flag.ap_bills`) at the
time the ocr gate was added; `5cb71545` did not reuse or extend it for the new `AddonGuard` check.

### Full commit message of `5cb71545` (squash of PR #475)

```
commit 5cb715458d42ae7ea763c8a5a30b6316f4153c6a
Author: najathakram <43218355+najathakram@users.noreply.github.com>
Date:   Sat Aug 29 06:06:26 2026 -0500

feat(api): wire AI usage metering; unify Anthropic key resolution (#475)

* feat(api): wire AI usage metering; unify Anthropic key resolution

recordAiUsage had zero callers while four AI features ran unmetered, so the
platform-admin AI panel read 0 scans/tokens/spend. Every Anthropic call now
records a tenant-tagged AiUsageEvent: vendor-bill scan (ocr.vendor_bill),
supplier-statement scan (ocr.supplier_statement), expense-receipt extraction
(ocr.expense_receipt), route insights (insights.route). Tokens are recorded
from the response right after a successful call (a later parse failure still
books the real spend), success:false on call failure, nothing on cache hits.

The three OCR paths' hand-rolled storedKey/env key lookup is replaced with
platformConfig.resolveAnthropicKey(tenantKey) — tenant key, then platform
key, then env — so platform-stored keys now work for OCR too. getAiUsage
classifies the new feature slugs and returns insightRuns; the admin settings
usage panel gains a Route insights row. No schema change (AiUsageEvent
auto-creates in onModuleInit).

Flagged to owner, not implemented: addon.ocr exists in the plan catalog but
no scan endpoint enforces it.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

* feat(api): gate AI document scans behind the ocr addon

Owner decision 2026-08-28: now that AI usage is metered per tenant,
document-reading endpoints require the `ocr` tenant addon (403 without it):
vendor-bill scan-invoice, batch invoice scan, supplier-statement scan, and
expense-receipt extract-items. Route insights deliberately NOT covered.

Listing/reviewing/applying existing scans stays ungated — AddonGuard passes
handlers without @RequireAddon metadata. OCR_ADDON in packages/types is the
client-side mirror; web entry-surface hiding is a follow-up.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

* fix: make the ocr addon grantable; refresh AI pricing (review follow-ups)

Adversarial review of the gate found it enforced a key nothing could
grant: the platform-admin tenant page's AVAILABLE_ADDONS had no "ocr"
entry and SKU activation writes the SKU code, so deploying would have
403'd every scan endpoint for every tenant with no way to turn them
back on. Now grantable from admin/tenants/[id], and bridged
ocr -> OCR_PACK_250 in LEGACY_ADDON_KEY_TO_SKU so SKU billing and the
admin toggle converge on the same TenantAddon key.

Also from review: AI_MODEL_PRICING refreshed to current Anthropic rates
(opus 15/75 -> 5/25, sonnet 3/15 -> 2/10, haiku 0.8/4 -> 1/5) — the
metering panel's Est. spend was 3x overstated on the Opus receipt path;
packages/types OCR_ADDON comment now states web/mobile scan-button
hiding is a follow-up (not yet implemented); branch code map updated to
reflect the gate (it asserted the opposite).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

---------

Co-authored-by: Claude Fable 5 <noreply@anthropic.com>
```

The pre-squash notes embedded in this message ("Flagged to owner, not implemented…", then "Owner
decision 2026-08-28: … 403 without it", then the review follow-up about the addon being
"grantable") are exactly the notes the task description referenced. **No sub-commit or review note
here mentions grandfathering existing tenants, a rollout/kill-switch, or any deferred/follow-up
item for the enforcement itself** — the only two explicitly named deferred follow-ups in this
commit are (a) web/mobile scan-button hiding (`OCR_ADDON`/`useHasAddon`) and (b) making the addon
grantable from the admin UI (which WAS done in the third sub-commit). Enforcement timing/rollout
is not discussed.

### `ScanInvoiceModal.tsx` — history

`git log origin/master --format='%h %ad %s' --date=short -8 -- apps/web/components/ScanInvoiceModal.tsx`:

```
7e13fbf3 2026-08-23 fix(invoices): honour sale terms and due date; stop calendar date day-shift (#416)
de557140 2026-08-22 feat(payments): add Zelle, share method constants, surface customer price tier (#408)
ca43c601 2026-08-18 feat(scanner): remember supplier line matches, and bill them in the right unit (#359)
bbcb58ea 2026-08-12 Costing accuracy: AVCO valuation, skip-dup scan batches, case-to-piece receiving, partial receipts (#335)
4f5ed09b 2026-08-07 feat: duplicate invoice detection, backdated orders, payment bank date, mobile scan rework (#322)
4fc2d2ec 2026-07-19 refactor(scan): fetch variant siblings on demand, drop catalog preload (#298)
616307c1 2026-07-18 feat: advance wallet restore + mobile scan/credit parity follow-ups (#297)
09cfcb30 2026-07-18 feat(scan): accurate product matching, async pickers with preview, create-from-line (#295)
```

`git blame origin/master -L 700,720 -- apps/web/components/ScanInvoiceModal.tsx` (the `scanOne`
catch block, lines 704-720 above):

```
2001c2819 (najathakram 2026-07-12 06:56:26 +0530 700) ... through 720
```

Every line of the current `scanOne` catch block traces to commit `2001c2819`, dated
**2026-07-12** — **seven weeks before** `5cb71545` (2026-08-29) added the `ocr` addon gate that
started producing this particular 403. None of the eight commits listed above (2026-07-18 through
2026-08-23, all of which post-date `2001c2819` and touch this file) modified the catch block's
error-message logic — i.e. OCR-2's generic-string behavior is a pre-existing property of the
handler, not something introduced alongside OCR-1's gate.

## Existing tests around this behavior

### `AddonGuard` unit spec — `apps/api/src/billing/addon.guard.spec.ts`

Covers (excerpted `it(` names, all present, `git show origin/master:…`):

- `"allows requests with no @RequireAddon metadata"`
- `"allows SUPER_ADMIN (null tenantId) through any addon gate"`
- `"allows tenants with the addon active (legacy single-string metadata)"`
- `"throws Forbidden when the addon is not active (legacy single-string metadata)"`
- `"allows when the tenant has any one of several listed addons (any-of)"`
- `"throws Forbidden when the tenant has none of several listed addons"`
- `"never names internal-only keys (developer_mode) in the 403 message"` (and more, not fully
  enumerated here — the file continues past what was read).

None of these tests use the literal `"ocr"` key, none assert anything about a rollout/kill-switch
(there is none to test), and none simulate the `vendor-bills.controller.ts` route specifically —
this spec tests `AddonGuard` generically against synthetic metadata, not the real
`scan-invoice` wiring.

### `PlanFlagGuard` unit spec — `apps/api/src/billing/plan-flag.guard.spec.ts` (not read in full

in this brief, but its existence + the WP1 plan text above establish that `PLAN_FLAG_ENFORCEMENT`
on/off and `DARK_PLAN_FLAGS` membership ARE unit-tested for `PlanFlagGuard` — there is no
equivalent spec surface for `AddonGuard` to test since `AddonGuard` carries no such switch).

### Every spec anywhere referencing the `"ocr"` addon key

`git grep -n '"ocr"' origin/master -- apps/api/src apps/web apps/mobile packages` restricted to
`*.spec.ts` returns exactly ONE hit in the whole repo:

```
apps/api/src/billing/entitlements.service.spec.ts:147:  addons: [{ addonKey: "ocr", sku: "OCR_PACK_250", quantity: 2 }],
```

— this tests `EntitlementsService`'s SKU→flag resolution (a different subsystem: it resolves the
catalog's `addon.ocr` **flag key**, consumed only by `PlanFlagGuard`/`@RequirePlanFlag`, NOT the
raw `TenantAddon.addonKey === "ocr"` row that `AddonGuard`/`AddonService.getActiveAddons` reads).
**Zero specs anywhere assert that `POST /vendor-bills/scan-invoice` 403s without the `ocr`
addon, or 200s (reaches the AI call) with it.** The `dispatch-addon-gate.spec.ts` pattern (a
reflection-based spec asserting decorator/guard-order for 5 dispatch controllers, per
`.claude/code-map/api.md:880`) has no counterpart for any of the 4 `@RequireAddon("ocr")`
endpoints (`vendor-bills.controller.ts:73`, `bookkeeping.controller.ts:194`,
`import/batch.controller.ts:55`, `supplier-statements.controller.ts:52`).

### `vendor-bills.service.spec.ts` / `vendor-bills.security.spec.ts`

`git grep -n "ocr|AddonGuard|RequireAddon"` against both files returns only two hits, both in
`vendor-bills.service.spec.ts` (lines 1272, 1286), and both are the AI-usage-metering **feature
string** `"ocr.vendor_bill"` (the `recordAiUsage` feature tag), unrelated to the addon gate.
`vendor-bills.security.spec.ts` mentions neither `ocr` nor `AddonGuard` at all.

**Harness note (what would be affected if `AddonGuard` gained an env-driven mode, mirroring
`PLAN_FLAG_ENFORCEMENT`)**: `vendor-bills.security.spec.ts:16-60` builds
`VendorBillsService`/`VendorBillsController` via `Test.createTestingModule` at the **service**
level, injecting mocked `PrismaService`, `PlatformConfigService`, `DuplicateMatchService`,
`StorageService`, `InventoryService`, `ProductAliasService` directly — it does not wire
`AddonGuard`/`AddonService`/`Reflector` at all and does not go through HTTP, so it neither
exercises nor would need updating for any `AddonGuard` behavior change. No spec in the
`vendor-bills` directory instantiates `AddonGuard`, mocks `AddonService`, or calls
`overrideGuard`. Any new test asserting the addon-gate's request/response behavior would need to
be net-new (there is no existing scaffold to extend), and any change to `AddonGuard`'s
`canActivate` signature/behavior touches zero currently-passing specs in `vendor-bills/*.spec.ts`,
`bookkeeping/*.spec.ts`, `import/*.spec.ts`, or `supplier-statements/*.spec.ts` (none of them
mock or assert on `AddonGuard`/`AddonService`).

### Web e2e (Playwright)

`git ls-tree -r origin/master --name-only apps/web/e2e | grep -iE "vendor|scan|bill|expense"`
returns **no results** — no dedicated e2e spec file for vendor-bills/scan/expense flows.
`git grep -ln "OP-17" -- apps/web/e2e` (the scan-related test-id prefix documented in
`.claude/code-map/web.md:947`, "e2e: OP-17b (single, unchanged) + OP-17c/d/e") resolves to a
single file, `apps/web/e2e/02-operator.spec.ts`, where those cases live alongside the rest of the
operator suite (not isolated). This spec was not opened in full for this brief; its OP-17 cases
are the only e2e coverage of `ScanInvoiceModal` scan flows that could exist.

## Smoke / post-deploy-check coverage

`package.json` (origin/master) script wiring:

```
"smoke": "node scripts/smoke.mjs",
"post-deploy-check": "node scripts/post-deploy-check.mjs",
"feature-smoke": "node scripts/feature-smoke.mjs",
"local:validate": "node scripts/local-env.mjs --smoke --db -- \"npm run smoke && npm run post-deploy-check && npm run local:drift\"",
"local:validate:features": "node scripts/local-env.mjs --smoke -- \"npm run feature-smoke\"",
```

Both `scripts/post-deploy-check.mjs:22-23` and `scripts/feature-smoke.mjs:36` default
`SMOKE_TENANT_SLUG` to `"e2e-routeflow"` (overridable by env), run through `assertTestTenant`.

- `git grep -n "vendor-bill|scan-invoice|RequireAddon|ocr|addon"` against `scripts/smoke.mjs` and
  `scripts/post-deploy-check.mjs` returns **zero hits** — neither script touches vendor-bills or
  any addon-gated route at all.
- `scripts/feature-smoke.mjs` DOES exercise `/api/v1/vendor-bills` extensively (create, record
  payment, statement, void, bulk-delete — lines 466-628) but **never calls
  `POST /vendor-bills/scan-invoice`** (`git grep -n "scan-invoice|scanInvoice|/scan"` against all
  three smoke scripts finds no match in `feature-smoke.mjs` for the vendor-bills scan route).
- `feature-smoke.mjs:778-781` DOES call a _different_ OCR-gated endpoint,
  `POST /api/v1/supplier-statements/scan`, but with an empty body specifically to test the
  no-files 400 case:
  ```
  778   const scan = await post("/api/v1/supplier-statements/scan", {});
  779   ...
  781     `POST /supplier-statements/scan with no files — expected 4xx (not 404), got ${scan.status}`,
  ```
  The assertion only checks that the status is _some_ 4xx, not specifically 400 — **a 403 from
  `AddonGuard` (if the smoke tenant lacked the `ocr` addon) would satisfy this assertion just as
  well as the intended 400 "no files" response**, meaning this check cannot distinguish "addon
  gate blocked the request" from "the missing-files validation fired as designed." (Whether the
  `e2e-routeflow` tenant actually has the `ocr` addon is addressed next — if it does not, this
  smoke check would be silently checking the wrong thing.)

### Does the smoke/e2e tenant have the `ocr` addon?

`apps/api/scripts/e2e-seed.js:44-50` grants exactly three `TenantAddon` rows via its
`ensureAddon()` helper (`git show origin/master:apps/api/scripts/e2e-seed.js` lines 146-148,
250-252):

```js
const DEVELOPER_MODE_ADDON = "developer_mode";
const RECURRING_ROUTES_ADDON = "recurring_routes";
const ORDER_DELIVERY_ADDON = "order_delivery";
...
await ensureAddon(existing.id, DEVELOPER_MODE_ADDON);
await ensureAddon(existing.id, RECURRING_ROUTES_ADDON);
await ensureAddon(existing.id, ORDER_DELIVERY_ADDON);
```

**`"ocr"` is not among them.** So unless the `e2e-routeflow` tenant separately carries the `addon.
ocr` plan-tier flag AND that flag actually creates a matching `TenantAddon` row (see Open
Unknowns — evidence below says it does NOT automatically), the `e2e-routeflow` smoke/feature-smoke
tenant itself would 403 on `scan-invoice` today, same as the production tenants in the incident
evidence.

## Two distinct "ocr" gating primitives (observed, not yet reconciled — flag for S2)

Two separate mechanisms both use variants of the string `"ocr"`:

1. **`AddonGuard` / `AddonService.getActiveAddons`** — reads `TenantAddon` rows directly
   (`prisma.tenantAddon.findMany({tenantId, active:true})`, `addon.service.ts:51-58`) for the
   literal key `"ocr"`. This is what `@RequireAddon("ocr")` on the controller checks.
2. **`EntitlementsService.compute()`** (`apps/api/src/billing/entitlements.service.ts:120-165`) —
   resolves a `flags: Set<string>` from (a) the tenant's plan-definition `featureFlags` (SCALE
   plan's flag list includes `"addon.ocr"` per `apps/api/prisma/publish-plan-catalog-v11.ts:147`,
   confirmed also present in v8/v9/v10) UNION (b) SKU-derived flags from active `TenantAddon`
   rows (`tenant.addons` relation, same query shape, `entitlements.service.ts:122-126`). This is
   what `PlanFlagGuard`/`@RequirePlanFlag` would check, and is a DIFFERENT string
   (`"addon.ocr"`, with the `"addon."` prefix) from what `AddonGuard` checks (`"ocr"`, no prefix).

Evidence gathered does not show any code path that, upon a tenant being on the SCALE plan (thus
having the `"addon.ocr"` **flag** true via entitlements), automatically creates the literal
`TenantAddon{addonKey:"ocr"}` **row** that `AddonGuard` needs. `entitlements.service.ts`'s
`compute()` only READS `tenant.addons`; nothing in the reviewed files WRITES a `TenantAddon` row
from a plan-tier grant. This means a SCALE-plan tenant that has never explicitly had the `ocr`
add-on toggled on the platform-admin tenant page (or bridged via `OCR_PACK_250` SKU purchase,
`addon.service.ts:99-108` `LEGACY_ADDON_KEY_TO_SKU`) may ALSO 403 on `scan-invoice` despite its
plan nominally including OCR — this is offered as an observed fact from the two services' code,
not a conclusion; S2 should verify whether any other write path bridges the two.

## Open unknowns (for S2)

1. Whether the two `"ocr"` primitives (raw `TenantAddon` key vs. plan-flag `"addon.ocr"`) are
   reconciled anywhere at write time (tenant upgrade/downgrade, catalog publish, or a cron) — if
   not, a SCALE-plan tenant who never explicitly toggled the addon is ALSO broken by OCR-1, not
   just tenants who used to scan under the pre-2026-08-29 ungated regime.
   `apps/api/src/billing/plan-catalog.constants.ts:243` ("Bridges the `@RequireAddon("ocr")` scan
   gate to the catalog's OCR pack SKU…") was found via grep but not opened in full in this
   brief — it likely documents the `LEGACY_ADDON_KEY_TO_SKU` bridge direction (SKU → TenantAddon
   row on `enableAddon`), which is the OPPOSITE direction from what a plan-included flag would
   need (flag → auto-create TenantAddon row) — worth reading in full.
2. Whether ANY currently-active tenant (production) had been scanning invoices successfully
   between the route's creation (2026-03-30) and the gate's addition (2026-08-29) — i.e. how many
   tenants are newly broken vs. never-worked. Out of scope for this read-only, non-DB-access
   brief; the given production evidence (6 requests, all 403, zero 200s in 7 days) only proves
   current-state breakage, not a before/after tenant count.
3. Why `DARK_PLAN_FLAGS` (`plan-flag.guard.ts:21-29`) includes `flag.ap_bills` specifically
   (dark by default on `VendorBillsController`'s class-level gate) while the same PR family
   (`5cb71545`, six days later) added an unconditionally-enforcing `AddonGuard` gate to a method
   on the SAME controller — whether this was a deliberate scoping decision (OCR treated as
   independent of the AP-bills plan-flag rollout) or an oversight is exactly the C1 question for
   S2 to resolve, not this brief.
4. The full text of `apps/web/e2e/02-operator.spec.ts`'s OP-17b/c/d/e cases (not read in full
   here) — whether they run against a tenant/mocked-network state where the `ocr` addon is
   present, and whether they would currently be red on `origin/master` given OCR-1 (the code map
   note at `web.md:947` says "OP-17b (single, unchanged)… all write-routes mocked", which if
   accurate for the scan call too would mean this suite mocks around the addon gate and would NOT
   currently catch OCR-1 as a red test).
