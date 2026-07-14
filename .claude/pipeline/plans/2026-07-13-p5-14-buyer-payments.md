## Status

PLANNED — 2026-07-13

## Context

P5-14 delivers the buyer "Payments & credits" page (web) plus the two small API surfaces it needs. Mobile parity deferred to P10 (P5-16). **NO database migration** — the how-to-pay card is a JSON blob in the existing `SystemConfig` key-value store; the payments table reads existing `InvoicePayment` rows (P5-12 already added `checkStatus`/`status`/`nsfFeeAmount`).

Verified ground truth (read before editing):

- `apps/api/src/system-config/system-config.service.ts` — `get(key): Promise<string|null>` (:49, tenant-scoped `forTenant().systemConfig.findFirst`), `set(key, value): Promise<void>` (:56, findFirst + create/update), `getAll(prefix)` (:72). **`getMarginConfig`/`setMarginConfig` (:103-145) store per-key strings, NOT one JSON blob — the remittance design deliberately uses ONE JSON document under a single key; the "mirror" is the accessor + controller/@Roles pattern, not the storage layout.** Remittance is intentionally NOT in `SECRET_KEYS` — seller's own remit-to info, buyer-visible by design (same data printed on an invoice).
- `apps/api/src/system-config/settings.controller.ts` — class `@Controller(["settings","tenant/settings"])` + `@UseGuards(JwtAuthGuard, RolesGuard)` + `@Roles(UserRole.OPERATOR)` (:27-29). Margin: `@Get("margin")` :364 (OPERATOR read), `@Patch("margin")` :370 (`@Roles(TENANT_ADMIN)`). RolesGuard hierarchy: TENANT_ADMIN satisfies OPERATOR. Global `ValidationPipe({whitelist,transform,forbidNonWhitelisted})` in `main.ts:160` — no per-method `@UsePipes`.
- `apps/api/src/buyer/buyer.controller.ts` — seller-scoped endpoints use `@UseGuards(BuyerSellerContextGuard)` + `@UseInterceptors(BuyerTenantInterceptor)` + `@ApiHeader({name:"X-Tenant-Slug",required:true})`, read `ctx.customerId` from `@CurrentBuyerCustomer()`. Interceptor sets tenant ALS so `prisma.forTenant()` (and `SystemConfigService.get`) resolve the SELLER config. Analytics `recentPayments` join (:721-732): `db.invoicePayment.findMany({where:{invoice:{customerId}}, include:{invoice:{select:{invoiceNumber:true}}}, orderBy:{paidAt:"desc"}})` — WITHOUT checkStatus/status/nsfFeeAmount; the new endpoint returns them. Query-param idiom: `getProducts` :252-279 (`Number()`+`Number.isFinite` guards).
- `apps/api/src/buyer/buyer.module.ts` — does NOT import `SystemConfigModule` yet (`system-config.module.ts` exports `SystemConfigService`). WP2 adds it. **Injecting SystemConfigService into BuyerController breaks `buyer.controller.spec.ts` DI unless its providers are updated (WP2c).**
- Prisma: `enum CheckStatus {RECORDED DEPOSITED CLEARED BOUNCED}`, `enum PaymentStatus {DRAFT PAID VOID}`, `InvoicePayment`: `amount Decimal`, `method PaymentMethod`, `paidAt DateTime @default(now())` (non-null), `status PaymentStatus @default(PAID)`, `checkStatus CheckStatus?`, `nsfFeeAmount Decimal?`.
- Web P5-13: `apps/web/lib/api/buyer.ts` has `useBuyerStatement()`/`BuyerStatement` (availableCredit, transactions type CREDIT_NOTE + runningBalance + expiresAt) ~:699-737, shared `Paginated<T>` (`meta:{total,page,limit,totalPages}`) :163.
- Web P5-12 badge: `checkBadgeFor` in `buyer/portal/[seller]/invoices/[id]/page.tsx` :42-71 (Bounced=danger; VOID amount struck :264-287). WP3 extracts it to a shared module.
- Buyer live invalidation: `apps/web/lib/hooks/useBuyerNotifications.ts` `onInvoiceUpdated` :93-102 invalidates `["buyer","invoice"]` — WP3 adds `["buyer","payments"]`+`["buyer","statement"]`.
- Buyer nav: `apps/web/app/buyer/portal/layout.tsx` `navItems` :164-217 (P5-06 added "Your Shelf" the same way).
- Page idioms: `finances/page.tsx` (StatCard + wallet tile + Active Credits :50-77/:177-241), `invoices/page.tsx` (paginated table + loading/empty/error + pagination footer :128-259).
- Operator settings: `apps/web/app/(dashboard)/settings/page.tsx` — local `TabTrigger` :80-102, tab functions local to the file (`CostingTab` :2600 using `useMarginConfig`/`useUpdateMarginConfig` + `useAuth` isAdmin gate), registration in `<Tabs.List>` :2929-2962 + `<Tabs.Content>` :2964-3004. Hook pattern: `apps/web/lib/api/margin.ts` (queryKey `["margin-config"]`).
- Specs: `system-config.service.spec.ts` (uses `createMockPrisma`, which has `systemConfig`+`invoicePayment` proxies + forTenant()); `buyer.controller.spec.ts` (all deps as `useValue` mocks; currently `{provide:PrismaService, useValue:{}}`).

Constraints: no migration; no money math beyond display (`Number(decimal)` of stored values, mirrors analytics); Conventional Commits; `npm run verify`.

## Acceptance

From PHASE-5-6-10-PLAN.md:115: "Live check status per row; wallet balance matches P5-13; how-to-pay card renders tenant remittance config."

1. `GET /buyer/payments?page&limit` → buyer payments newest-first `{id, invoiceId, invoiceNumber, amount, method, status, checkStatus, nsfFeeAmount, paidAt}` + `meta{total,page,limit,totalPages}`, scoped `invoice.customerId = ctx.customerId`.
2. Web payments page shows a check-lifecycle badge per CHECK row (Bounced=danger+struck+NSF shown; VOID struck), live on `invoice.updated`.
3. Wallet tile reads `useBuyerStatement().availableCredit` — the SAME P5-13 value the Finances page shows (no recompute).
4. `GET/PATCH /settings/remittance` (PATCH admin-only) round-trip the remittance JSON; `GET /buyer/remittance` returns the seller config; the how-to-pay card renders configured fields, hides empty, shows a friendly empty state.
5. Jest passes incl. new remittance service specs + buyer controller payments/remittance specs; existing suites compile (buyer controller spec gains the new dep).

## Work Packages

### WP1 — api: SystemConfigService remittance get/set + DTO + operator GET/PATCH /settings/remittance + spec

files:

- `apps/api/src/system-config/system-config.service.ts` (edit)
- `apps/api/src/system-config/dto/remittance-config.dto.ts` (new)
- `apps/api/src/system-config/settings.controller.ts` (edit)
- `apps/api/src/system-config/system-config.service.spec.ts` (edit)

brief: Store remittance as ONE JSON doc under SystemConfig key `remittance.config` (tenant-scoped via get/set; NO migration); operator read (any operator) + admin-only write mirroring margin.

**1a. `system-config.service.ts` — before the `@Injectable()` class (after imports):**

```ts
/**
 * Seller remit-to / how-to-pay info shown to buyers (P5-14). Stored as ONE JSON
 * document under `remittance.config` (no migration). Buyer-visible BY DESIGN —
 * the seller's own remit-to info, same data printed on an invoice — so it is
 * intentionally NOT in SECRET_KEYS.
 */
export const REMITTANCE_FIELDS = [
  "payToName",
  "bankName",
  "accountName",
  "accountNumber",
  "routingNumber",
  "achInstructions",
  "wireInstructions",
  "checkInstructions",
  "mailingAddress",
  "notes",
] as const;
export type RemittanceField = (typeof REMITTANCE_FIELDS)[number];
export type RemittanceConfig = Partial<Record<RemittanceField, string>>;
```

Then inside the class, after `setMarginConfig`:

```ts
  // ─── Remittance / how-to-pay config (P5-14) ─────────────────────────────────
  // ONE JSON blob under `remittance.config`. PATCH semantics: undefined =
  // untouched, "" = cleared. Reads/writes via get()/set() (tenant scoped).
  private static readonly REMITTANCE_KEY = "remittance.config";

  async getRemittanceConfig(): Promise<RemittanceConfig> {
    const raw = await this.get(SystemConfigService.REMITTANCE_KEY);
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const out: RemittanceConfig = {};
      for (const field of REMITTANCE_FIELDS) {
        const value = parsed[field];
        if (typeof value === "string" && value.length > 0) out[field] = value;
      }
      return out;
    } catch {
      this.logger.error("Corrupt remittance.config JSON — returning empty config");
      return {};
    }
  }

  async setRemittanceConfig(dto: RemittanceConfig): Promise<void> {
    const current = await this.getRemittanceConfig();
    const next: RemittanceConfig = { ...current };
    for (const field of REMITTANCE_FIELDS) {
      const value = dto[field];
      if (value === undefined) continue;
      if (value === "") delete next[field];
      else next[field] = value;
    }
    await this.set(SystemConfigService.REMITTANCE_KEY, JSON.stringify(next));
  }
```

(Verify `this.logger` exists on the service; if not, use the existing logging idiom.)

**1b. `dto/remittance-config.dto.ts` (new):** a `RemittanceConfigDto` class with all 10 fields `@IsOptional @IsString @MaxLength(...)` (200 for the short id fields; 2000 for achInstructions/wireInstructions/checkInstructions/mailingAddress/notes).

**1c. `settings.controller.ts`:** import `RemittanceConfigDto`; add at the END of the class (global ValidationPipe validates — no `@UsePipes`):

```ts
  @Get("remittance")
  getRemittanceConfig() {
    return this.svc.getRemittanceConfig();
  }

  @Patch("remittance")
  @Roles(UserRole.TENANT_ADMIN)
  async updateRemittanceConfig(@Body() dto: RemittanceConfigDto) {
    await this.svc.setRemittanceConfig(dto);
    return this.svc.getRemittanceConfig();
  }
```

**1d. `system-config.service.spec.ts`:** append a `describe("SystemConfigService — remittance config (P5-14)")` (self-contained setup mirroring the file) asserting: `{}` when none stored; parse drops unknown/empty/non-string fields; `{}` (never throws) on corrupt JSON; set merges over existing + clears `""` fields (assert `systemConfig.update` payload); set creates the row when none (plaintext, `encrypt` NOT called).

### WP2 — api: buyer GET /buyer/remittance + GET /buyer/payments (paginated, with checkStatus) + spec

files:

- `apps/api/src/buyer/buyer.module.ts` (edit)
- `apps/api/src/buyer/buyer.controller.ts` (edit)
- `apps/api/src/buyer/buyer.controller.spec.ts` (edit — REQUIRED or DI breaks the suite)

**2a. `buyer.module.ts`:** import `SystemConfigModule` and add to `imports` (e.g. after `StockAlertsModule`).
**2b. `buyer.controller.ts`:** import `SystemConfigService`; add constructor param `private readonly systemConfigService: SystemConfigService,`; add after `getStatement`:

```ts
  @Get("payments")
  @UseGuards(BuyerSellerContextGuard)
  @UseInterceptors(BuyerTenantInterceptor)
  @ApiHeader({ name: "X-Tenant-Slug", required: true })
  @ApiOperation({ summary: "Paginated payment history across the buyer's invoices (P5-14)" })
  async getPayments(
    @CurrentBuyerCustomer() ctx: any,
    @Query("page") page?: string,
    @Query("limit") limit?: string,
  ) {
    const parsedPage = Number(page);
    const parsedLimit = Number(limit);
    const pageNum = Number.isFinite(parsedPage) && parsedPage >= 1 ? Math.floor(parsedPage) : 1;
    const limitNum =
      Number.isFinite(parsedLimit) && parsedLimit >= 1 ? Math.min(Math.floor(parsedLimit), 100) : 20;

    const db = this.prisma.forTenant();
    const where = { invoice: { customerId: ctx.customerId } };
    const [rows, total] = await Promise.all([
      db.invoicePayment.findMany({
        where,
        include: { invoice: { select: { invoiceNumber: true } } },
        orderBy: { paidAt: "desc" },
        skip: (pageNum - 1) * limitNum,
        take: limitNum,
      }),
      db.invoicePayment.count({ where }),
    ]);

    return {
      // Stored money only — amounts read back, never computed here.
      data: rows.map((p) => ({
        id: p.id,
        invoiceId: p.invoiceId,
        invoiceNumber: p.invoice.invoiceNumber,
        amount: Number(p.amount),
        method: p.method,
        status: p.status,
        checkStatus: p.checkStatus ?? null,
        nsfFeeAmount: p.nsfFeeAmount != null ? Number(p.nsfFeeAmount) : null,
        paidAt: p.paidAt.toISOString(),
      })),
      meta: {
        total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.max(1, Math.ceil(total / limitNum)),
      },
    };
  }

  @Get("remittance")
  @UseGuards(BuyerSellerContextGuard)
  @UseInterceptors(BuyerTenantInterceptor)
  @ApiHeader({ name: "X-Tenant-Slug", required: true })
  @ApiOperation({ summary: "Seller's how-to-pay / remittance instructions (P5-14)" })
  getRemittance() {
    // Tenant set by BuyerTenantInterceptor → SystemConfigService.get()'s
    // forTenant() resolves the SELLER's config. Buyer-visible by design.
    return this.systemConfigService.getRemittanceConfig();
  }
```

(No route collision — `payments`/`remittance` are new static segments.)
**2c. `buyer.controller.spec.ts` (REQUIRED):** import `SystemConfigService` + `createMockPrisma`; in beforeEach create `const prisma = createMockPrisma()` + a `systemConfigService = { getRemittanceConfig: jest.fn().mockResolvedValue({ payToName: "Acme Wholesale" }) }`; replace `{provide:PrismaService, useValue:{}}` with `useValue: prisma` and add `{ provide: SystemConfigService, useValue: systemConfigService }`; hoist both to `let` so tests can reference them. Append tests: getPayments scopes `where.invoice.customerId`, maps the check-lifecycle fields (BOUNCED row: amount 125.5, checkStatus BOUNCED, nsfFeeAmount 25), paginates (page 2 → skip 20, meta totalPages 3); defaults page/limit on garbage; getRemittance delegates to the service.

### WP3 — web buyer: payments page + hooks/types + shared check badge + nav + live invalidation

files:

- `apps/web/lib/check-badge.ts` (new — extracted P5-12 helper)
- `apps/web/app/buyer/portal/[seller]/invoices/[id]/page.tsx` (edit — import the extracted helper)
- `apps/web/lib/api/buyer.ts` (edit — hooks + types)
- `apps/web/app/buyer/portal/[seller]/payments/page.tsx` (new)
- `apps/web/app/buyer/portal/layout.tsx` (edit — nav entry)
- `apps/web/lib/hooks/useBuyerNotifications.ts` (edit — invalidation)

**3a. `apps/web/lib/check-badge.ts` (new):** move the P5-12 `checkBadgeFor` verbatim (CHECK-only; null checkStatus on a non-void check ⇒ RECORDED; a voided-not-bounced check ⇒ no badge; RECORDED=neutral/DEPOSITED=info/CLEARED=success/BOUNCED=danger), returning `{label, variant}`. In `invoices/[id]/page.tsx` delete the local function and `import { checkBadgeFor } from "@/lib/check-badge";`.
**3b. `apps/web/lib/api/buyer.ts`:** append after `useBuyerStatement` — `BuyerPayment` interface `{id, invoiceId, invoiceNumber, amount, method, status:"DRAFT"|"PAID"|"VOID", checkStatus:"RECORDED"|"DEPOSITED"|"CLEARED"|"BOUNCED"|null, nsfFeeAmount:number|null, paidAt:string}`; `useBuyerPayments({page?,limit?})` → `Paginated<BuyerPayment>` (GET /buyer/payments); `BuyerRemittance` interface (10 optional strings); `useBuyerRemittance()` → GET /buyer/remittance (staleTime 5min).
**3c. `payments/page.tsx` (new):** `"use client"` page mirroring `finances/page.tsx` + `invoices/page.tsx`. Copy the `fmt`/`fmtDate`/`formatPaymentMethod`/`StatCard` idioms + the auth/redirect guards + spinner. State: `page` + `useBuyerPayments({page,limit:20})`; `useBuyerStatement()` + `useBuyerRemittance()` as independent fetches (do NOT gate load/error on them). Layout: (1) header "Payments" + seller subtitle; (2) wallet row: a "Store Credit" StatCard `value={fmt(statement?.availableCredit ?? 0)}` + sub `${activeCredits.length} active` where `activeCredits = (statement?.transactions ?? []).filter(t => t.type==="CREDIT_NOTE" && t.runningBalance > 0.001)` (this matching Finances IS the "wallet matches P5-13" check — same cache entry, never recompute); optional "Outstanding" StatCard from `statement?.outstandingAmount`; (3) payments table (invoices/page.tsx idiom: loading spinner / error banner / dashed empty-state "No payments yet"): columns Date, Invoice # (link to `/buyer/portal/${slug}/invoices/${p.invoiceId}`), Method, Status (badge cell: `const badge = checkBadgeFor(p)`; render `<Badge variant={badge.variant}>{badge.label}</Badge>`; BOUNCED+nsfFeeAmount → a `+ {fmt(nsfFeeAmount)} NSF fee` danger line), Amount (right, `voided = status==="VOID"` → `text-danger line-through` else `text-success`); pagination footer from invoices/page.tsx with `meta = payments?.meta`; (4) how-to-pay card: `Landmark` header "How to pay {seller name}"; `hasRemittance = remittance && Object.values(remittance).some(v => v && String(v).trim())`; empty-state when false; else a local `Field({label,value})` returning null when empty, rendering non-empty fields (`whitespace-pre-line` for multi-line) in the label order Pay to/Bank/Account name/Account number/Routing number (2-col grid) then Mail checks to/Paying by check/ACH/wire/Notes (stacked). No money computed on the page.
**3d. `layout.tsx`:** add `CreditCard` to lucide import; insert a "Payments" navItem (href `/buyer/portal/${sellerSlug}/payments`, icon CreditCard) between Invoices and Finances.
**3e. `useBuyerNotifications.ts`:** in `onInvoiceUpdated`, after the existing `["buyer","invoice"]` invalidate, add `qc.invalidateQueries({queryKey:["buyer","payments"]})` + `qc.invalidateQueries({queryKey:["buyer","statement"]})`.

### WP4 — web operator: Remittance settings tab + hooks

files:

- `apps/web/lib/api/remittance.ts` (new)
- `apps/web/app/(dashboard)/settings/page.tsx` (edit — new tab component + registration)

**4a. `apps/web/lib/api/remittance.ts` (new, mirror `margin.ts`):** `RemittanceConfig` interface (10 optional strings); `useRemittanceConfig()` (queryKey `["remittance-config"]`, GET /settings/remittance, staleTime 5min); `useUpdateRemittanceConfig()` (PATCH /settings/remittance, invalidate `["remittance-config"]`).
**4b. `settings/page.tsx`:** import the hooks + `Landmark`. Add a local `RemittanceTab()` after `CostingTab` (mirror its shape: `useToast`, `useAuth` + `isAdmin = role==="TENANT_ADMIN"`, `useRemittanceConfig` + `useUpdateRemittanceConfig`; ONE `form` state hydrated from `config` via useEffect; `set(k)` change handler; save sends the WHOLE form [server merge treats `""` as clear]; toasts on success/error). Render (all inputs `disabled={!isAdmin}`, `Input`/`Textarea`/`Button` from `@routeflow/ui/web`): heading "How buyers pay you" + subtitle; Card 1 "Remit-to details" (2-col Inputs: Pay to/Bank/Account name/Account number/Routing number + a Textarea "Mailing address (for checks)"); Card 2 "Payment instructions" (Textareas: Check/ACH/Wire + Notes); footer Save button (admin) or the "Only admins…" note; `if (isLoading) return Loading…`. Register a `<TabTrigger value="remittance" icon={<Landmark/>}>How to Pay</TabTrigger>` after the costing trigger + a `<Tabs.Content value="remittance">...<RemittanceTab/></Tabs.Content>` after the costing content. (Acceptable to move RemittanceTab to `_components/` if file-size lint complains.)

### WP5 — code-map + verify

files: `.claude/code-map/api.md`, `.claude/code-map/web.md`, `.claude/code-map/_meta.json`

brief: api.md → system-config section (REMITTANCE_FIELDS/RemittanceConfig + get/set as ONE `remittance.config` blob, NOT in SECRET_KEYS; GET/PATCH /settings/remittance PATCH @Roles(TENANT_ADMIN); DTO) + buyer controller (`GET /buyer/payments` paginated w/ status/checkStatus/nsfFeeAmount; `GET /buyer/remittance`; BuyerModule imports SystemConfigModule). web.md → buyer `payments/page.tsx` (wallet tile off useBuyerStatement, useBuyerPayments table w/ shared `lib/check-badge.ts`, how-to-pay off useBuyerRemittance), nav Payments, useBuyerNotifications invalidations, settings `RemittanceTab` + `lib/api/remittance.ts`. Bump `_meta` generatedAt + prepend a P5-14 note. `npm run verify`.

## Assumptions to double-check

1. Storage-shape deviation: margin=per-key strings, remittance=ONE JSON blob under `remittance.config`. Confirm nothing else reads a `remittance.` prefix.
2. `SystemConfigService.get/set` signatures (get(key):Promise<string|null> :49; set(key,value):Promise<void> :56).
3. Settings tab registration: radix Tabs.Root + local TabTrigger; tab funcs are local to `settings/page.tsx` except `RegulatedSettingsTab` (in `_components/`). Keep RemittanceTab local (majority pattern).
4. Global ValidationPipe validates the PATCH DTO (no @UsePipes). Buyer GETs take no body.
5. **`buyer.controller.spec.ts` DI: the new SystemConfigService constructor param MUST be added to the spec providers or the whole suite fails to compile — WP2c is not optional.**
6. `Badge` from `@routeflow/ui/web` supports the `info` variant (P5-12 invoice detail already uses it).

### Critical Files

- apps/api/src/system-config/system-config.service.ts
- apps/api/src/buyer/buyer.controller.ts
- apps/web/lib/api/buyer.ts
- apps/web/app/buyer/portal/[seller]/payments/page.tsx (new)
- apps/web/app/(dashboard)/settings/page.tsx
