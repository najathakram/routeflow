# RouteFlow bug-signature catalogue

Empirical bug patterns — every one of these caused at least one REAL confirmed finding in this
repo (B## = bug-register id). The automated scanner lives at
[`../scripts/scan-signatures.mjs`](../scripts/scan-signatures.mjs):

```bash
node .claude/skills/bug-hunt/scripts/scan-signatures.mjs           # default (tuned) pass
node .claude/skills/bug-hunt/scripts/scan-signatures.mjs --list    # all signature ids
node .claude/skills/bug-hunt/scripts/scan-signatures.mjs --only unscoped-tenant --max 500
```

Exit code 1 = a HIGH-signal pattern hit (CI gate). Suppress a triaged hit with
`// scan-ok: <id> — <reason>` on the line above, or a path substring in
`.claude/skills/bug-hunt/scan-ignore.json` (`{ "<id>": ["path/substring"] }`).

**Legend per signature** — `scanner: auto` (runs by default), `auto (noisy-excluded)` (runs only
via `--only`; too noisy to gate), `human` (the scanner's heuristic is a lead-generator at best;
each hit needs a person or an agent to read the code).

---

## 1. `dead-hook` — Dead backend capability *(scanner: auto, HIGH-signal)*

**Caused:** B13, B21, B29, B36, B37, B41, B42 — the single highest-yield signature in the project.

An exported React-Query hook in `apps/{web,mobile}/lib/api/*.ts` with **zero call sites in either
app**. The server endpoint exists, is tested, and works — but no screen ever calls it, so the
capability silently doesn't exist for users.

```ts
// lib/api/drivers.ts — built, typed, dead:
export function useChangeDriverStatus() { ... }   // grep finds only this line
```

⚠️ **Always check BOTH apps before declaring a hook dead.** A hook unused in web may be the
mobile app's only path to the feature (this exact mistake produced two wrong claims — B13/B24).
The scanner collects definitions from both `lib/api` trees and requires zero callers across both.

Manual hunt:

```bash
rg -o "export (function|const) (use[A-Z]\w*)" -r '$2' apps/{web,mobile}/lib/api | sort -u \
  | while read h; do n=$(rg -c "\b$h\b" apps/web apps/mobile | wc -l); [ "$n" -le 1 ] && echo "DEAD: $h"; done
```

Fix: wire a screen to it, or delete hook + endpoint together (never just the hook).

## 2. `confirm-navigate` — Confirm-then-navigate *(scanner: auto, HIGH-signal)*

**Caused:** B34 (driver "Skip stop" confirmed → navigated away → stop never marked SKIPPED).

A `confirm()` / `Alert.alert` whose accept callback **only** calls `router.replace/push/back` and
never a mutation. The user believes they changed state; only the screen changed.

```tsx
// BEFORE (B34): nothing records the skip
confirm("Skip stop", "Mark this stop as skipped?", () => router.replace("/(driver)/route"));
// AFTER
confirm("Skip stop", "Mark this stop as skipped?", () =>
  skipStop.mutate({ stopId }, { onSuccess: () => router.replace("/(driver)/route") }));
```

Tuned exclusions: discard/unsaved-changes prompts and "continue elsewhere" prompts ("Your scanned
data will be lost", "Stay in app") — there navigation IS the correct whole action.

```bash
rg -U -A6 "(confirm|Alert\.alert)\(" apps/mobile | rg -B3 "\(\) => router\."
```

## 3. `impossible-enum` — Impossible enum branch *(scanner: auto, currently clean)*

**Caused:** B10, B16, B18.

UI comparing `.status`/`.type` against a SCREAMING_CASE string that appears **nowhere** in
`apps/api` or `schema.prisma` — the server can never emit it, so the branch (badge color, filter,
empty state) is dead.

```tsx
if (order.status === "AWAITING_PICKUP") ...   // Prisma enum has no such value
```

The scanner builds the server vocabulary (all caps tokens in api + schema) plus the set of
client-declared union members (local state machines like `"UNRESOLVED" | "DELIVERED"` are
legitimate), and flags comparisons against tokens in neither set.

```bash
rg -o '\.(status|type)\s*===?\s*"([A-Z_]+)"' -r '$2' apps/{web,mobile} | sort -u \
  | while read v; do rg -q "\b$v\b" apps/api/prisma/schema.prisma apps/api/src || echo "IMPOSSIBLE: $v"; done
```

## 4. `inert-form` — Inert form *(scanner: auto, HIGH-signal)*

**Caused:** B06 (marketing "request a demo" form submitted to nowhere).

A `<form>` in `apps/web` with **no `onSubmit` and no `action`**. Enter-to-submit reloads the page;
the data goes nowhere.

```tsx
// BEFORE (B06 — still live at apps/web/app/contact/page.tsx)
<form className="space-y-6"> ... <Button>Send</Button> </form>
// AFTER
<form onSubmit={handleSubmit(onSubmit)} className="space-y-6"> ...
```

```bash
rg -U "<form(?![^>]*(onSubmit|action))" --multiline apps/web --glob "*.tsx"
```

## 5. `decorative-label` — Decorative action label *(scanner: auto, HIGH-signal)*

**Caused:** B23 (`SectionRow action="+ Add"` rendered as plain `<Text>` — looks tappable, is not).

An `action`/`actionLabel` prop rendered as bare `<Text>`/`<span>` with no
`Pressable`/`onPress`/`onClick` wrapper anywhere near it.

```tsx
// BEFORE (B23 — live at apps/mobile .../return/index.tsx)
{action ? <Text style={styles.sectionLink}>{action}</Text> : null}
// AFTER
{action ? <Pressable onPress={onAction}><Text style={styles.sectionLink}>{action}</Text></Pressable> : null}
```

```bash
rg -n "<Text[^>]*>\{action\}</Text>" apps/mobile
```

## 6. `money-rederive` — Money re-derivation *(scanner: auto, HIGH-signal, CRITICAL)*

**Caused:** B49, B50, B60 — and the scanner's current hits include the two still-open boxed-
overcharge criticals in `orders.service.ts` (edit-items fresh add + substitute).

Any `qty * unitPrice` (or `price * quantity`) arithmetic outside
`apps/{api/src/common,web/lib,mobile/lib}/pricing.ts`. Boxed lines store per-piece proration, so
the naive multiply overcharges by `unitsPerBox`. `roundMoney(qty * unitPrice)` is still wrong —
rounding does not fix the wrong quantity basis.

```ts
// BEFORE — overcharges a boxed line by unitsPerBox×
subtotal: roundMoney(data.qty * data.unitPrice)
// AFTER
subtotal: computeLineSubtotal({ qty: data.qty, unitPrice: data.unitPrice, unitsPerBox, ... })
```

Tuned exclusions: `pricing.ts` itself, `apps/web/mocks/`, `prisma/seed.ts`, comment lines.

```bash
rg -n "(qty|quantity)\w*\s*\*\s*\w*[uU]nit[Pp]rice|unitPrice\s*\*\s*(qty|quantity)" apps --glob "!**/pricing.ts"
```

## 7. `raw-tofixed` — Raw money formatting *(scanner: auto, noisy-excluded)*

`x.toFixed(2)` on a money value in a component instead of `formatMoney`. **213 hits** — it is,
for better or worse, the repo-wide display idiom, so per-line reports are not actionable. Run
`--only raw-tofixed` when doing a dedicated formatMoney migration; do not gate on it.

```bash
rg -n '\$\{?\w*\.(total|amount|price|balance)\w*\.toFixed\(2\)' apps/{web,mobile} --glob "*.tsx"
```

## 8. `calendar-date` — Calendar date through a local formatter *(scanner: auto)*

**Caused:** B91, B59 (and B20-adjacent).

`toLocaleDateString()` / `getDate()` applied to a UTC-midnight **calendar** date
(`scheduledDate`, `issueDate`, `dueDate`, `expiryDate`, licence dates). A viewer west of UTC sees
the previous day — routes scheduled "tomorrow" show "today".

```tsx
// BEFORE — Aug 29 renders as Aug 28 in New York
new Date(run.scheduledDate).toLocaleDateString()
// AFTER — pin the calendar date to UTC
new Date(run.scheduledDate).toLocaleDateString(undefined, { timeZone: "UTC" })
```

Deliberately NOT flagged: `periodStart`/`periodEnd` and other true instants — local rendering is
correct for those. The judgment call "is this field a calendar date or an instant?" is the human
part; the scanner's field list encodes the answer for the known fields.

```bash
rg -n "new Date\(\w+\.(scheduledDate|issueDate|dueDate|expiryDate)[^)]*\)\.toLocale" apps/{web,mobile}
```

## 9. `swallowed-write` — Swallowed write failure *(scanner: auto)*

**Caused:** B83 (and the whole `…Safe` wrapper family).

`catch {}` / `.catch(() => {})` / `.catch(() => null)` wrapping or adjacent to a prisma write,
payment, or stock movement. The write fails, nobody hears it, data quietly diverges.

```ts
// BEFORE — a failed conversion disappears
await this.maybeConvertToVendorBill(expense).catch(() => {});
// AFTER — at minimum, make it loud
await this.maybeConvertToVendorBill(expense)
  .catch((e) => this.logger.error(`vendor-bill conversion failed for ${expense.id}: ${e.message}`));
```

Tuned exclusions: best-effort side channels (notifications, email, storage deletes,
presignedUrl fallbacks) and any swallow with an explicit `best-effort` / `fire-and-forget`
comment above it — those are accepted decisions. What remains needs a human verdict per hit:
"is this failure actually safe to lose?"

```bash
rg -n -B3 "\.catch\(\(\) => (\{\}|null)\)" apps/api/src | rg -v "notifications|email|storage|presigned"
```

## 10. `unimported-component` — Unimported component *(scanner: auto, HIGH-signal)*

**Caused:** B31.

A `.tsx` component under `components/` or `_components/` that nothing imports. Built UI that
never renders — someone believes it shipped.

Tuned exclusion: platform-resolved variants (`Foo.web.tsx` beside `Foo.tsx`) are imported
implicitly by the bundler — never dead just because unimported.

```bash
for f in $(fd -e tsx . apps/web/components); do b=$(basename $f .tsx); rg -q "/$b[\"']" apps/web || echo $f; done
```

Fix: wire it in or delete it. If it's an intentional work-in-progress, suppress with a dated
`scan-ok` comment.

## 11. `hardcoded-threshold` — Hardcoded threshold *(scanner: auto)*

**Caused:** B25 (`currentStock <= 5` everywhere while `product.reorderPoint` exists per record).

A magic number duplicating a configurable per-record field. Every hit's question is in the note:
"is there a per-record field this should read instead?"

```tsx
// BEFORE                                   // AFTER
if (p.currentStock <= 5) return "LOW";      if (p.currentStock <= (p.reorderPoint ?? 5)) return "LOW";
```

```bash
rg -n "(currentStock|onHand|available)\w*\s*<=?\s*[2-9]" apps
```

## 12. `fetch-cap-aggregate` — Fetch-cap + client aggregate *(scanner: auto)*

**Caused:** B12. See also the `limit=0` fetch-all sentinel trap memory.

`useX({ limit: 999 })` (or 100/200/500) whose result is `.reduce()`'d client-side into a KPI.
The number is silently wrong the day the tenant has more rows than the cap. The scanner requires
limit ≥ 90 with a `reduce()` within 60 lines, filtering out benign dropdown fills.

```ts
// BEFORE — "total outstanding" caps out at 999 invoices
const { data: allData } = useInvoices({ limit: 999 });
const outstanding = allData?.data.reduce((s, i) => s + i.amountDue, 0);
// AFTER — the server aggregates
const { data } = useInvoiceSummary();   // GET /invoices/summary
```

```bash
rg -n "limit:\s*(9{2,3}|[125]00|500)" apps/{web,mobile}/app | rg -v lib/api
```

## 13. `coming-soon` — Coming-soon placeholder *(scanner: auto)*

**Caused:** B07, B37, B38, B39, B43 — and this is the standing NEVER-demo list (messages, cash,
pick, live tracking map, warehouse scanning).

A screen rendering hardcoded "coming soon" / "isn't live yet" copy while navigation still routes
to it. Each hit is either (a) a nav entry to hide, or (b) a feature to finish. Marketing pages
announcing the app launch are excluded (intentional copy).

```bash
rg -in "coming soon|isn't live yet|not live yet" apps/{web,mobile}/app apps/mobile/components
```

## 14. `unscoped-tenant` — Unscoped tenant query *(scanner: auto, noisy-excluded)*

**Caused:** B52-adjacent findings; the class behind the #446 cross-tenant findUnique-echo fixes.

`prisma.<model>.update/delete(...)` on a tenant-scoped model (any model with a `tenantId` column)
without a `tenantId` condition and without `forTenant()`. **Security class** — but even
restricted to writes it produces ~300 hits, because the codebase idiom is
"fetch tenant-scoped → write by unique id inside the same tx", which a grep cannot distinguish
from a genuine hole. Run it module-by-module during a dedicated security audit:

```bash
node .claude/skills/bug-hunt/scripts/scan-signatures.mjs --only unscoped-tenant --max 500
```

Human judgment per hit: trace where the `id` in the `where` came from. If it wasn't produced by a
tenant-scoped read in the same request, it's a hole.

## 15. `phantom-copy` — Message pointing at nothing *(scanner: auto → human verify)*

**Caused:** B42 ("Add a rate in Settings" — no such setting existed), B05.

User-facing copy naming a screen or control ("configured in the web portal",
"Settings → Business profile"). The scanner finds the copy; a **human must walk the referenced
path** and confirm the control exists. Every hit's note says exactly that.

```bash
rg -in "(in|from) the web (portal|dashboard)|in Settings" apps/mobile
```

## 16. `edit-form-omission` — Edit-form omission *(scanner: heuristic, noisy-excluded — human)*

**Caused:** B09 (standing-order edit modal rendered item rows but its submit dropped the items).

An edit modal rendering child-item controls whose submit branch omits those items from the
payload — save wipes the children. The heuristic (Edit/Order modal + `items` in scope + a
`mutate({...})` payload without an `items` key) re-finds B09's `StandingOrderModal`, but every
hit needs a human to read the submit path: the items may legitimately ride a separate mutation.
The general class — **diff every field the form renders against every field the submit sends** —
is human/agent work.

```bash
rg -l "Edit\w*Modal" apps/{web,mobile} | xargs rg -L -U "mutate\w*\(\{[^}]*items"
```

## 17. `validation-asymmetry` — Validation asymmetry *(scanner: auto for lengths; human for the rest)*

**Caused:** B03.

A client zod rule stricter or looser than the server class-validator DTO for the same field —
the user passes the client check and gets an opaque 400, or is blocked from something the server
allows. The scanner cross-references `z.string().min/max(n)` against `@MinLength/@MaxLength(n)`
by field name (current live hit: `businessName` min 1 vs server MinLength 2). Regex asymmetries,
enum subsets, and optionality differences still need a human diff of schema vs DTO.

```bash
rg -n "@(Min|Max)Length\(" apps/api/src/**/dto | sort   # then compare to the web zod schema
```

## 18. `mutation-before-test` — Mutation before test *(scanner: auto)*

**Caused:** B46 — the worst critical found (daily duplicate invoices).

A value mutated with a **literal** (e.g. `d.setDate(1)`) before the condition that tests it,
making the branch constant. Current live hit: `recurring-invoices.service.ts:33` —
`d.setDate(1)` then `if (d.getDate() > dom)` — after `setDate(1)`, `getDate()` is always 1, so
the month never advances and a mid-month `dayOfMonth` can resolve to a date already past.

```ts
// BEFORE — dead condition                       // AFTER — test before mutating
d.setDate(1);                                    const today = d.getDate();
if (d.getDate() > dom) d.setMonth(...);          d.setDate(1);
                                                 if (today > dom) d.setMonth(d.getMonth() + 1);
```

Relative walking (`setDate(getDate() + 1)`) is excluded — only literal resets count.

```bash
rg -n -A5 "\.set(Date|Month)\(\s*\d+\s*\)" apps/api/src | rg "if.*\.get(Date|Month)\("
```

## 19. `denomination-merge` — Denomination-blind merge *(scanner: heuristic, noisy-excluded — human)*

**Caused:** B47.

Summing quantities from two sources without reconciling box-vs-piece units — boxes + pieces added
as raw numbers double- or under-counts. The heuristic flags `qty + qty` in boxed-aware modules
(files mentioning `unitsPerBox`), but whether the two sides share a unit is invisible to a grep —
a human must trace both operands to `normalizeBoxesPieces` or a common basis.

```bash
rg -n "(quantity|qty)\w*\s*\+\s*\w*\.(quantity|qty)" apps --glob "!**/pricing.ts"
```

## 20. `dead-model-guard` — Guard on a dead model *(scanner: auto)*

**Caused:** B54 (at-door cash survived a stop reopen because the guard queried a table nothing
writes any more).

A safety check reading a Prisma model that **nothing in `apps/api` writes** — the guard always
passes (or always fails) the same way. The scanner counts reads vs writes per model, crediting
writes through `forTenant()` chains, aliased clients (`db.model.create`), and schema-level nested
creates (`relationField: { create ... }`). Current live hit: `rfInvoice` is read in
`subscription.service.ts` but never written — platform-billing invoices are never generated, so
whatever that read gates is inert.

Caveat: rows written only by SQL migrations, seeds, or `$executeRaw` look write-less — confirm
before filing.

```bash
rg -o "prisma\.(\w+)\.(create|update|upsert|delete)" -r '$1' apps/api/src | sort -u > /tmp/written
rg -o "prisma\.(\w+)\.find" -r '$1' apps/api/src | sort -u | comm -23 - /tmp/written
```

---

## Scanner state after tuning (2026-08-29)

| id | signal | hits | reading |
|---|---|---|---|
| dead-hook | high | 70 | real by construction; baseline the accepted ones, gate new ones |
| confirm-navigate | high | 1 | the live B34 skip-stop handler |
| impossible-enum | medium | 0 | historical instances fixed; guard stays armed |
| inert-form | high | 1 | the live B06 contact form |
| decorative-label | high | 1 | the live B23 SectionRow action |
| money-rederive | high | 4 | incl. the 2 known-open boxed-overcharge CRITs |
| raw-tofixed | noisy-excluded | 213 | repo idiom; migration project, not a gate |
| calendar-date | medium | 4 | scheduledDate through toLocaleDateString |
| swallowed-write | medium | 4 | each needs a "safe to lose?" verdict |
| unimported-component | high | 9 | dead components in both apps |
| hardcoded-threshold | medium | 4 | the B25 `stock <= 5` family |
| fetch-cap-aggregate | medium | 6 | limit:100–999 feeding KPIs |
| coming-soon | medium | 10 | the NEVER-demo placeholder list |
| unscoped-tenant | noisy-excluded | ~294 | security audit mode only (`--only`) |
| phantom-copy | medium | 5 | copy → human walks the referenced path |
| edit-form-omission | noisy-excluded | 3 | heuristic re-finds B09; human confirms |
| validation-asymmetry | medium | 1 | businessName min 1 vs 2 |
| mutation-before-test | medium | 1 | live dead-condition in recurring invoices |
| denomination-merge | noisy-excluded | 4 | unit tracing is human work |
| dead-model-guard | medium | 1 | rfInvoice read-but-never-written |
