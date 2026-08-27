# Plan: Audit P0/P1 batch — trust repairs, impersonation integrity, delete demotion, format kit

**Status:** IMPLEMENTED — all 9 packages + Opus review fixes landed on `fix/audit-p0-batch` (PR #457);
verify green (18/18 tasks, 0 lint errors); demo scrub executed against prod (2 customers + 1 user,
sentinels exempt, 1 buyer account report-only). Awaiting owner merge.
**Date:** 2026-08-26
**Branch:** `fix/audit-p0-batch` (worktree `C:/ClaudeCode/routeflow/.claude/worktrees/audit-batch`)
**Context:** A full UX audit of the tenant-admin dashboard (routeflow-demo, production) found five
trust-level defects and a set of convention drifts. This batch fixes the P0s and the highest-leverage
P1s. Every root cause below was verified live against production before planning — treat the stated
mechanics as fact, but always re-read the touched region before editing.

## House rules (all packages)

- Monorepo: npm workspaces + Turbo. Web = Next.js 14 App Router (`apps/web`), API = NestJS 11
  (`apps/api`). Prettier: semicolons, double quotes, printWidth 100. No new deps, no Vitest, no
  snapshot tests.
- Match surrounding code style exactly. Comments only for non-obvious constraints.
- NEVER touch `apps/{api/src/common,web/lib,mobile/lib}/pricing.ts` or any money _math_ — this batch
  changes money _display_ only.
- Web has NO unit-test runner (Playwright only) — web packages are verified by typecheck/lint.
  API changes get Jest specs.

---

## WP1 — API: `GET /customers/:id/orders` 403s for everyone

**Files:** `apps/api/src/customers/customers.controller.ts`,
`apps/api/src/customers/customers.controller.roles.spec.ts` (NEW)

**Verified root cause:** `RolesGuard` (`apps/api/src/auth/guards/roles.guard.ts` line 35) fails
closed when a route has no `@Roles` metadata. `@Get(":id/orders")` (line ~183) is the ONLY customer
read route without a `@Roles` decorator → the endpoint returns 403 for every caller, including
TENANT_ADMIN (reproduced against prod: login 200, endpoint 403 "Forbidden resource", while the DB
holds 13 correctly-linked orders for the probed customer). This is why the customer profile shows
"ORDERS 0" and an empty Orders tab.

**Change:** add to the route, matching its siblings:

```ts
@Get(":id/orders")
@Roles(UserRole.OPERATOR, UserRole.CUSTOMER)
findOrders(@Param("id") id: string, @CurrentUser() user: JwtPayload) {
  return this.customersService.findOrders(id, user);
}
```

`UserRole.CUSTOMER` is included because `customers.service.ts findOrders` (line ~723) already
implements the own-data restriction (`customer.userId !== user.sub` → Forbidden). TENANT_ADMIN
satisfies OPERATOR via the role hierarchy.

**New spec** `customers.controller.roles.spec.ts` — a metadata regression test so no customer route
can silently lose its roles again:

```ts
import { Reflector } from "@nestjs/core";
import { UserRole } from "@prisma/client";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";
import { CustomersController } from "./customers.controller";

describe("CustomersController @Roles coverage", () => {
  const reflector = new Reflector();

  it("declares roles on findOrders (RolesGuard fails closed without them)", () => {
    const roles = reflector.get<UserRole[]>(ROLES_KEY, CustomersController.prototype.findOrders);
    expect(roles).toEqual(expect.arrayContaining([UserRole.OPERATOR, UserRole.CUSTOMER]));
  });

  it("every handler on the controller declares @Roles", () => {
    const proto = CustomersController.prototype as Record<string, any>;
    const handlers = Object.getOwnPropertyNames(proto).filter(
      (n) => n !== "constructor" && typeof proto[n] === "function",
    );
    for (const name of handlers) {
      const roles = reflector.get<UserRole[]>(ROLES_KEY, proto[name]);
      expect({ name, hasRoles: Array.isArray(roles) && roles.length > 0 }).toEqual({
        name,
        hasRoles: true,
      });
    }
  });
});
```

If a second handler legitimately lacks `@Roles`, fix IT (add the decorator its service logic
implies) rather than weakening the spec. Check `ROLES_KEY` is exported from
`../auth/decorators/roles.decorator` (it is imported by roles.guard.ts).

**Accept:** `npx jest customers.controller.roles` passes in `apps/api`; the two spec cases above
exist verbatim in intent; route decorated.

---

## WP2 — Web: dashboard "Overdue Invoices" uses the derived-overdue filter

**Files:** `apps/web/lib/api/invoices.ts`, `apps/web/app/(dashboard)/dashboard/page.tsx`

**Verified:** dashboard queries `useInvoices({ status: "OVERDUE", limit: 5, sortBy: "dueDate",
sortOrder: "asc" })` (page.tsx line ~572) — the status ENUM only, which misses past-due
SENT/VIEWED/PARTIAL invoices (demo shows 5 while 6+ are actually past due). The API already
implements the correct derived filter: `invoices.service.ts findAll` `isOverdue` → status in
SENT/VIEWED/PARTIAL/OVERDUE AND dueDate < now, and `list-invoices.dto.ts` accepts it.

**Change:**

1. `lib/api/invoices.ts`: the list-params type used by `useInvoices` gains `isOverdue?: boolean`.
   Confirm in `list-invoices.dto.ts` how the DTO transforms it (it exists there — mirror whatever
   the web client does for other boolean params, e.g. `shipped`, if any; axios will serialize
   `isOverdue: true` as `?isOverdue=true`).
2. `dashboard/page.tsx` line ~572: replace `{ status: "OVERDUE", ... }` with
   `{ isOverdue: true, limit: 5, sortBy: "dueDate", sortOrder: "asc" }`. Everything downstream
   (`overdueCount = meta.total`, panel list) stays as-is. Do NOT change the
   `/invoices?status=OVERDUE` links.

**Accept:** no remaining `status: "OVERDUE"` in dashboard/page.tsx queries; `isOverdue` typed on
the web params; typecheck passes.

---

## WP3 — Web: Finance Overview "Overdue" card tells the truth

**Files:** `apps/web/app/(dashboard)/finance/dashboard/page.tsx`

**Verified:** line ~149 `const overdue30plus = (ar?.days31_45 ?? 0) + (ar?.days45plus ?? 0);`
renders as "Overdue / $0.00 / Past 30 days" — i.e. only 31+ days past due, directly above an aging
bar showing $18.6k past due in the 1–30d buckets. Reads as a contradiction.

**Change:**

1. Replace with the full past-due sum:

```ts
const pastDueTotal =
  (ar?.days1_15 ?? 0) + (ar?.days16_30 ?? 0) + (ar?.days31_45 ?? 0) + (ar?.days45plus ?? 0);
```

2. The KPI card renders `pastDueTotal`; change its sublabel "Past 30 days" → "Past due — all ages".
   Keep the red styling keyed on `pastDueTotal > 0`.
3. The separate "Overdue (>30 days)" breakdown row (~line 460) keeps its own math but keep its
   explicit "(>30 days)" label — that one is honest.
4. Page-title consistency: the page h1 renders "Receivables Overview" while the top-bar title is
   "Finance Overview" and the nav label is "Overview". Change the h1 to "Finance Overview" (leave
   the subtitle line as-is).

**Accept:** card shows the sum of all four past-due buckets; sublabel updated; h1 = "Finance
Overview"; typecheck passes.

---

## WP4 — Web: invoices list — KPI formula, duration copy, delete demotion

**Files:** `apps/web/app/(dashboard)/invoices/page.tsx` (only this file)

Three independent edits:

**4a. Overdue KPI excludes DRAFT / WRITTEN_OFF.** In the KPI memo (~line 271):

```ts
if (
  inv.status === "OVERDUE" ||
  (due && due < today && inv.status !== "PAID" && inv.status !== "VOID")
) {
```

→

```ts
const openForCollection =
  inv.status !== "PAID" &&
  inv.status !== "VOID" &&
  inv.status !== "DRAFT" &&
  inv.status !== "WRITTEN_OFF";
if (inv.status === "OVERDUE" || (due && due < today && openForCollection)) {
```

(Draft pending-mirror invoices and written-off balances must not count as collectible overdue.
`dueToday`/`dueIn30` arms below it: add the same two exclusions to their conditions.)

**4b. Duration copy consistency.** In the status meta helper (~lines 101–116) the PARTIAL branch
renders "Overdue by 5d" / "Due in 4d" while the plain branch renders "Overdue by 5 days". Unify on
full words everywhere: `by ${overdueDays} day${overdueDays !== 1 ? "s" : ""}` and
`Due in ${n} day${n !== 1 ? "s" : ""}`. No abbreviation form remains in the file.

**4c. Delete only for drafts.** The row delete affordance (trash trigger that sets
`confirmDeleteId`, and its two-tap confirm block ~line 847) must render ONLY when
`inv.status === "DRAFT"`. Non-draft rows keep just the View button (Void/Write-off live on the
detail page). Search the row-actions JSX for where the trash button is rendered (`!isCustomer`
guard) and add the status condition at the trigger, not inside the confirm.

**Accept:** all three edits present; grep finds no `by ${...}d\`` abbreviation left; trash trigger
gated on DRAFT; typecheck passes.

---

## WP5a — Web: format kit + worst money/qty offenders

**Files:** `apps/web/lib/format.ts` (NEW), `apps/web/app/(dashboard)/orders/[id]/page.tsx`,
`apps/web/app/(dashboard)/inventory/page.tsx`, `apps/web/app/(dashboard)/orders/page.tsx`

**5a-1. Create `apps/web/lib/format.ts`** exactly:

```ts
/**
 * Display formatting — the ONE place money, quantities, dates, and enum labels
 * are turned into strings for the UI. Never re-derive with toFixed/
 * toLocaleDateString inline; import from here. Display only — money MATH stays
 * in lib/pricing.ts.
 */
const moneyFmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function formatMoney(value: number | string | null | undefined): string {
  const n = Number(value ?? 0);
  return moneyFmt.format(Number.isFinite(n) ? n : 0);
}

/** Whole numbers render bare ("61"), fractional quantities keep up to 2 dp ("1.5"). */
export function formatQty(value: number | string | null | undefined): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return "0";
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
}

/** App-standard date: "Aug 27, 2026". */
export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** "PARTIALLY_DELIVERED" → "Partially Delivered". */
export function humanizeEnum(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .toLowerCase()
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
```

**5a-2. `orders/[id]/page.tsx`** — audit finding: renders `$3487.76`, `$1120.00` (no thousands
separators) and "Total quantity 61.0". Grep the file for `toFixed(2)` and replace **display-only**
money renders (line totals ~line 1151, header/summary totals, the `totalFmt` at ~line 112) with
`formatMoney(...)`. ⚠️ Do NOT touch:

- the MoneyInput draft/lens logic around lines ~760–824 (input editing — a previous `toFixed` echo
  there caused a "type 2.50, get 2.05" bug; leave every input-value path alone),
- anything feeding a payload or calculation.
  Find the summary "Total quantity" value (search case-insensitively for "quantity") and wrap with
  `formatQty(...)`.

**5a-3. `inventory/page.tsx`** — the "Stock Value (cost)" KPI (~line 2748) renders an unformatted
number (`$585351.73`). Replace its value render with `formatMoney(totalInventoryValue)`. Sweep the
same file for other `$${...}`/`toFixed(2)` KPI-level displays and convert those too (display only).

**5a-4. `orders/page.tsx`** — the row status badge renders the raw enum (`PARTIALLY_DELIVERED`
appears verbatim in the UI). Find the row's status Badge/chip render; pass the label through
`humanizeEnum(status)` (the filter-pill options array at ~lines 56–61 already has nice labels —
if a label map is easily reusable, prefer it and fall back to `humanizeEnum`).

**Accept:** `lib/format.ts` exists with the four exports; order detail shows no `toFixed(2)` on
display-only money paths; inventory KPI uses formatMoney; orders list badge cannot render an
underscore; typecheck passes.

---

## WP5b — Web: routes & dispatch — dates + delete-after-cancel (dependsOn WP5a)

**Files:** `apps/web/app/(dashboard)/routes/page.tsx`, `apps/web/app/(dashboard)/dispatch/page.tsx`

**routes/page.tsx:**

1. Run-card scheduled date (~line 487): the helper returns `d.toLocaleDateString()` → "8/27/2026".
   Keep any Today/Tomorrow special cases; the fallback becomes `formatDate(d)` (import from
   `@/lib/format` — match the file's existing import alias style).
2. Route-templates "Created" cell (~line 203): `new Date(...).toLocaleDateString()` →
   `formatDate(row.original.createdAt)`.
3. **Delete demotion.** Current per-card actions: View · Edit · Cancel · Delete, with Delete offered
   on SCHEDULED runs (comment at ~line 520). New policy — delete only what is already cancelled:
   - SCHEDULED / IN_PROGRESS runs: show Cancel (existing dialog), no Delete.
   - CANCELLED runs: show Delete (existing dialog), no Cancel.
     Adjust the JSX conditions only; both confirm dialogs stay untouched. If the page doesn't render
     CANCELLED runs at all, Delete simply disappears from cards — that is acceptable and intended
     (bulk-select delete and dialogs remain for cleanup).

**dispatch/page.tsx:** 4. "Active Now" cards show route + driver + progress but NO date, so today's and tomorrow's runs
look like duplicates (verified on demo: 4 cards for 2 runs). In the card body (near the
`{done} / {total} completed` row ~line 106), add a muted line rendering the run's scheduled
date: `formatDate(<runDateField>)` — read the run type used by this page (grep its data hook)
for the actual field name (`scheduledDate`/`scheduledFor`/`date`). Style it like the sibling
muted text (`text-xs text-navy/70`). 5. Rename the section title `<CardShell title="Active Now">` → `title="Active & Upcoming Runs"`.

**Accept:** no `toLocaleDateString()` remains in either file; Delete gated to CANCELLED runs;
dispatch cards show a date; section retitled; typecheck passes.

---

## WP6 — Web: impersonation integrity + refresh-race fix

**Files:** `apps/web/lib/impersonation.ts` (NEW), `apps/web/lib/api-client.ts`,
`apps/web/lib/auth.ts`, `apps/web/app/(dashboard)/layout.tsx`,
`apps/web/app/(platform-admin)/admin/tenants/page.tsx`

**Verified mechanics (from source + live repro):**

- Impersonation = `localStorage.impersonationToken` + `impersonationTenantSlug`, preferred over the
  operator token by both `api-client.ts` (lines ~102–117) and `auth.ts getStoredUser()` (~line 70).
- Bug 1 (hijack): `login()`/`logout()` never clear those keys → a fresh tenant login lands inside a
  stale impersonation.
- Bug 2 (vanishing banner): `ImpersonationBanner` in `(dashboard)/layout.tsx` (~line 974) reads
  localStorage once in a mount effect, never re-checks, never checks token expiry.
- Bug 3 (identity switch): when the impersonation token expires and 401s, the response interceptor
  refreshes with the OPERATOR refresh token and retries — silently switching who the user is.
- Bug 4 (false "signed out" sheet): concurrent refreshes race the rotated refresh token; the loser
  opens the ReAuth sheet even though a fresh access token was just stored.

**6-1. Create `apps/web/lib/impersonation.ts`:**

```ts
/**
 * Super-admin impersonation state — THE single reader/writer for the
 * impersonation localStorage keys. Nothing else may touch these keys directly:
 * stale impersonation state hijacking fresh logins is exactly the bug this
 * module exists to prevent.
 */
const TOKEN_KEY = "impersonationToken";
const SLUG_KEY = "impersonationTenantSlug";
const CHANGE_EVENT = "rf-impersonation-change";

export interface ImpersonationState {
  token: string;
  slug: string;
  expired: boolean;
}

function parseExp(token: string): number | null {
  try {
    const payload = JSON.parse(atob(token.split(".")[1] ?? ""));
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}

export function getImpersonation(): ImpersonationState | null {
  if (typeof window === "undefined") return null;
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) return null;
  const slug = localStorage.getItem(SLUG_KEY) ?? "unknown";
  const exp = parseExp(token);
  return { token, slug, expired: exp !== null && exp * 1000 < Date.now() };
}

export function setImpersonation(token: string, slug: string): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(SLUG_KEY, slug);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function clearImpersonation(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(SLUG_KEY);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** Re-render hook for the banner: fires on set/clear in this tab and on storage from others. */
export function subscribeImpersonation(onChange: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}
```

**6-2. `api-client.ts` request interceptor** (~lines 102–117) — replace the raw localStorage reads:

```ts
apiClient.interceptors.request.use((config) => {
  if (typeof window !== "undefined") {
    const imp = getImpersonation();
    // An EXPIRED impersonation token must never fall through to the operator
    // token — that silently switches identities. End the impersonation instead.
    if (imp?.expired) {
      clearImpersonation();
      if (!window.location.pathname.startsWith("/admin")) {
        window.location.assign("/admin/tenants?impersonation=expired");
      }
    }
    const active = imp && !imp.expired ? imp : null;
    const token = active?.token ?? localStorage.getItem(OP_KEYS.accessToken);
    if (token) config.headers.Authorization = `Bearer ${token}`;
    const slug = active?.slug ?? getTenantSlugFromCookie();
    if (slug) config.headers["X-Tenant-Slug"] = slug;
  }
  return config;
});
```

**6-3. `api-client.ts` response interceptor** — two additions:
(a) At the top of the 401 branch (right after the early-reject conditions, before `isRefreshing`):
if an impersonation is active, the token is not refreshable — end it, don't identity-switch:

```ts
if (typeof window !== "undefined" && getImpersonation()) {
  clearImpersonation();
  if (!window.location.pathname.startsWith("/admin")) {
    window.location.assign("/admin/tenants?impersonation=expired");
  }
  return Promise.reject(error);
}
```

(b) In the refresh `catch` block, BEFORE the ReAuth sheet is considered — the concurrent-rotation
race guard:

```ts
// Concurrent-refresh race: another request/tab may have already rotated the
// pair. If a fresh access token exists that differs from the one this request
// sent, retry with it instead of declaring the session dead.
const raced = typeof window !== "undefined" ? localStorage.getItem(OP_KEYS.accessToken) : null;
const sent = String(original.headers.Authorization ?? "").replace(/^Bearer\s+/, "");
if (raced && raced !== sent) {
  original.headers.Authorization = `Bearer ${raced}`;
  processQueue(null, raced);
  return apiClient(original);
}
```

Mind `isRefreshing`/`failedQueue` bookkeeping: the race guard must reset `isRefreshing = false`
exactly the way the existing catch path does (read the surrounding finally/flag handling and keep
it consistent).

**6-4. `auth.ts`:** in `login()` immediately after a successful response, and in `logout()`
unconditionally, call `clearImpersonation()` (import from `./impersonation`). Also update
`getStoredUser()` (~line 70): use `getImpersonation()` and prefer the impersonation token only when
`!expired`, keeping the rest identical.

**6-5. `(dashboard)/layout.tsx` `ImpersonationBanner`** (~lines 974–1008) — rewrite to live state:

```tsx
function ImpersonationBanner() {
  const router = useRouter();
  const pathname = usePathname();
  const [imp, setImp] = React.useState<ImpersonationState | null>(null);

  React.useEffect(() => {
    const read = () => setImp(getImpersonation());
    read();
    return subscribeImpersonation(read);
  }, []);
  React.useEffect(() => {
    setImp(getImpersonation());
  }, [pathname]);

  if (!imp) return null;

  const exit = () => {
    clearTenantCookie();
    clearImpersonation();
    router.push("/admin/tenants");
  };

  return (
    <div className="flex items-center justify-between bg-red-600 px-4 py-2 text-sm text-white">
      <span>
        {imp.expired ? (
          <>
            ⚠️ Impersonation of <strong>{imp.slug}</strong> has expired
          </>
        ) : (
          <>
            ⚠️ Impersonating <strong>{imp.slug}</strong> — acting as Tenant Admin
          </>
        )}
      </span>
      <button
        onClick={exit}
        className="rounded bg-white/20 px-3 py-1 text-xs font-semibold hover:bg-white/30 transition-colors"
      >
        {imp.expired ? "Return to admin" : "Exit impersonation"}
      </button>
    </div>
  );
}
```

(`usePathname` — check the file's existing next/navigation imports and extend them.)

**6-6. `(platform-admin)/admin/tenants/page.tsx`:** find where the Impersonate action writes
`localStorage.setItem("impersonationToken", ...)` / `impersonationTenantSlug` and replace with
`setImpersonation(token, slug)`. ⚠️ `admin/buyers/[id]/page.tsx` has a separate BUYER impersonation
flow — leave it alone. Also check `admin/tenants/[id]/page.tsx` for a second Impersonate button
and swap it the same way if present.

**Accept:** no file outside `lib/impersonation.ts` reads/writes the two localStorage keys directly
(grep `"impersonationToken"` — only impersonation.ts remains); login/logout clear impersonation;
banner subscribes + handles expiry; 401-with-impersonation never enters the operator refresh path;
race guard present; typecheck passes.

---

## WP7 — Scripts: demo-tenant contact scrub + seed guard

**Files:** `apps/api/scripts/scrub-demo-contacts.mjs` (NEW), `apps/api/scripts/demo-seed.js`

**Verified:** prod `routeflow-demo` customers include `najathakram1@gmail.com` (owner's personal
email — hardcoded as `OWNER_EMAIL` at demo-seed.js line ~92) and
`ali@affamerchantservices.com` + phone `7187754019` on "ABC Wholesale" (a runtime-created row, id
`4b53feb1-96c9-48b4-a509-d721cfc3f577`). Policy: demo tenant carries fictional
`*.example.com` contacts only.

**7-1. New script `scrub-demo-contacts.mjs`** — follow the house pattern EXACTLY as in
`apps/api/scripts/audit-buyer-verification-grandfather.mjs`: Prisma 7 needs
`new PrismaClient({ adapter: new PrismaPg(pool) })` with the `resolveDbUrl()` proxy-env helper
(copy that function verbatim — a bare `new PrismaClient()` throws). Requirements:

- First: read `scripts/lib/test-tenants.cjs` and call its exported guard for slug
  `"routeflow-demo"` before ANY write (it's CJS; from an .mjs use
  `createRequire(import.meta.url)`; resolve the path relative to the script:
  `../../../scripts/lib/test-tenants.cjs`).
- Dry-run by default: print each offending customer (id, businessName, email, phone) and the
  planned replacement; write only with `--execute`.
- Scope: customers of tenant slug `routeflow-demo` where email is NOT null and NOT ending in
  `example.com`, or phone matches `7187754019`. Replacements: email →
  `<slugified businessName>@<slugified businessName>.example.com` truncated sensibly (e.g.
  `ali@abcwholesale.example.com`), phone → `(512) 555-0190` style (increment last two digits per
  row to keep them unique).
- Print a summary line: `scrubbed N customers (dry-run|executed)`.
- Header comment with the run command:
  `railway run --service postgres node apps/api/scripts/scrub-demo-contacts.mjs [--execute]`.

**7-2. `demo-seed.js`:** find every place `OWNER_EMAIL` (or any non-example.com address) is written
to a CUSTOMER-facing field (customer email, contact email). Replace with
`"najath@najathstrading.example.com"` for the Najath's Trading Co. customer record. `OWNER_EMAIL`
may remain ONLY if used for the demo login user account/notification identity — judge from usage.
Then add a guard near the CUSTOMERS definition (fail fast at seed start):

```js
for (const c of CUSTOMERS) {
  if (c.email && !c.email.endsWith("example.com")) {
    throw new Error(
      `demo-seed: customer "${c.name ?? c.key}" has a non-example.com email (${c.email}) — demo data must be fictional`,
    );
  }
}
```

(Adapt field names to the actual CUSTOMERS array shape.)

**Accept:** script exists, guard-first, dry-run default; `node apps/api/scripts/scrub-demo-contacts.mjs --help`
or bare run does not write; demo-seed contains no gmail address in customer-facing fields and has
the guard. (Do NOT run against prod in this pipeline — close-out step does that manually.)

---

## WP8 — Web: customer Orders tab — honest empty/error states

**Files:** `apps/web/app/(dashboard)/customers/[id]/page.tsx`

**Verified:** line ~1926 `const { data: ordersResult } = useCustomerOrders(params.id);` swallows
errors — the 403 rendered as an empty list with copy "No orders match the selected filter." even
with no filter applied.

**Change:**

1. Capture the error: `const { data: ordersResult, isError: ordersError } = useCustomerOrders(params.id);`
2. The Orders tab table (~line 3222) `emptyState` prop becomes:

```tsx
emptyState={
  ordersError
    ? "Couldn't load this customer's orders. Refresh to try again."
    : orderStatusFilter
      ? "No orders match the selected filter."
      : "No orders yet."
}
```

3. The "Orders" stat card (~line 2375, `value={allOrders.length}`) renders `"—"` instead of `0`
   when `ordersError` is true (a wrong zero is worse than a dash).

**Accept:** all three edits present; typecheck passes.

---

## Out of scope (do NOT do in this batch)

Nav single-pass render / hydration pop-in, Expenses–Bills&Purchasing dual-home merge,
`/deliveries/new` order picker, analytics pie replacement, StatusChip component extraction,
copy de-jargon pass, responsive grid overflow. They are planned for a follow-up batch.

## Verification

- Per round: `npm run check-types` (from the worktree root).
- Final: `npm run verify` (turbo: check-types + lint + test; API Jest includes the new WP1 spec).
- Prisma client is already generated in the worktree (`apps/api`); if a package hits
  "@prisma/client did not initialize", run `npx prisma generate` in `apps/api` and retry.
