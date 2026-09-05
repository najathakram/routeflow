# Build plan: ocr-gate-observe-first — registry-driven observe-first add-on gates + web error fidelity

> **Stage S5 — "how".** Authored by Fable 5.1 on `2026-09-04`. Mode: **bugfix** (bug-pipeline).
> Status: `APPROVED`
> Inputs: [cause-ruling.md](./cause-ruling.md) (cause + fix design + radius + probes),
> [bug-test-plan.md](./bug-test-plan.md) (`T#`/`P#`), [cause-brief.md](./cause-brief.md) and
> [cause-refutation.md](./cause-refutation.md) (evidence), [research-summary.md](./research-summary.md)
> (why the registry). This file is the ONLY context implementation and review agents receive. It stands alone.
> Every path below is repo-relative to the worktree root `C:/ClaudeCode/routeflow/.claude/worktrees/rf-ocr`
> (branch `fix/ocr-gate-observe-first`, cut from `origin/master` `e39bf9db`). Paths marked **(new)** are
> created by this change.

---

## Objective

Production denies AI document scanning (403 `This feature requires the "ocr" add-on.`) to every tenant that
was never hand-granted the `ocr` add-on — on four routes — since PR #475 (2026-08-29) added
`@RequireAddon("ocr")` with no grandfathering and outside the observe-first pattern `PlanFlagGuard` already
had. The web client then hides the 403 behind "Please check the file and try again." This change (1) restores
scanning for every tenant on deploy with no data write, by making `AddonGuard` read a checked-in gate
registry in which `ocr` is `dark`; (2) keeps every other gate enforcing byte-identically; (3) makes any future
`@RequireAddon` key without a registry row a red test; (4) surfaces the server's message on the web
single-scan toast; (5) ships the read-only blast-radius report the owner runs before ever flipping `ocr` to
`enforced`.

**Requirements**

- `R1` (must) — a tenant with no active `TenantAddon{addonKey:"ocr"}` row passes every `@RequireAddon("ocr")`
  route; `AddonGuard` logs exactly one `warn` per such request containing `keys=ocr`, `tenant=<id>` and the
  route.
- `R2` (must) — for every key registered `enforced` (`tobacco_dealer`, `recurring_routes`, `order_delivery`,
  `developer_mode`) and for any set containing an enforced key, `AddonGuard` denies exactly as on
  `origin/master`, with the identical message text; SUPER_ADMIN (null tenantId) and handlers without
  metadata still pass; `INTERNAL_ADDON_KEYS` are still never named.
- `R3` (must) — the denial body is `{ statusCode: 403, error: "Forbidden", code: "ADDON_GATE",
addonKeys: <named keys>, message }`; `exception.message` still equals `message`.
- `R4` (must) — the web single-scan toast description shows the server's `message` when present and falls
  back to "Please check the file and try again." only when it is empty (batch branch behavior, unchanged).
- `R5` (must) — a `@RequireAddon` string-literal key in any `apps/api/src/**/*.controller.ts` without a
  registry row, a registry row with no call site, a `dark` row whose `reviewBy` has passed, or `ocr` not
  `dark`, fails `jest` in `apps/api` (and therefore `npm run verify`).
- `R6` (should) — `apps/api/scripts/report-addon-gate-blast-radius.mjs` (owner-run, read-only) prints, for an
  add-on key, every tenant with prior usage of the gated feature, whether it holds an active row, and the
  count that would be denied on flip; it refuses to run without `DATABASE_URL` and opens only a read-only
  transaction.
- `R7` (should) — `.github/PULL_REQUEST_TEMPLATE.md` and `CLAUDE.md` state the rule: a new or tightened
  entitlement gate ships as a `dark` registry row and flips only after the blast-radius report.

**In scope:** the files named in the packages below. **Explicitly out of scope:** granting any add-on to any
tenant (owner decision after the report); hiding scan buttons on web/mobile (needed only when `ocr` flips to
`enforced`); the SKU/key mismatch (`OCR_PACK_250` vs `ocr`) in `subscription-mutation.service.ts` — recorded
in the registry `backfill` note and reported to the owner, not fixed here; Sentry capture of 403s;
`PlanFlagGuard`; mobile; any change to `AddonService`, the four controllers, or the decorator.

---

## Constraints & conventions

- **Stack:** NestJS 11 API (`apps/api`, Jest `*.spec.ts` beside the source, `npx jest <path>` from
  `apps/api`), Next.js 14 web (`apps/web`, Playwright e2e in `apps/web/e2e`, NO unit runner — do not add
  one), Prisma 7. ESLint flat config per workspace; Prettier: semicolons, double quotes, printWidth 100,
  trailing commas.
- **Test runner and layout:** API specs `apps/api/src/<module>/<name>.spec.ts`; script specs live in
  `apps/api/src/common/*-script.spec.ts` (imitate `apps/api/src/common/prod-migrate-script.spec.ts`);
  web e2e is `apps/web/e2e/02-operator.spec.ts` for operator flows (Playwright project `operator`).
- **Existing patterns to copy rather than invent:** observe-first switch —
  `apps/api/src/billing/plan-flag.guard.ts:14-29,58-66`; structured 403 body —
  `apps/api/src/billing/plan-gate.ts:21-38`; reflection over `REQUIRE_ADDON_KEY` —
  `apps/api/src/routes/dispatch-addon-gate.spec.ts`; read-only prod report —
  `apps/api/scripts/audit-tenant-entitlements.mjs` (header, `default_transaction_read_only=on`,
  `statement_timeout`, "NEVER RUN FROM AN IMPLEMENTATION SESSION"); the web batch-branch error handling —
  `apps/web/components/ScanInvoiceModal.tsx:719-725`; Playwright scan mock — OP-17b in
  `apps/web/e2e/02-operator.spec.ts:383`.
- **Must NOT change:** `AddonGuard`'s constructor signature `(reflector, addonService)` (the spec harness
  constructs it directly); `AddonService`; `require-addon.decorator.ts`; `plan-flag.guard.ts`; the four
  controllers; any denial message text; `recordAiUsage`; mobile; `packages/types`.
- **Do-not-introduce:** Vitest, Biome, a root test runner, a web unit runner, new dependencies of any kind
  (the registry spec uses `node:fs`/`node:path` only). No `console.log` left in code.
- **Landmines:** `apps/api/tsconfig.build.json` excludes `scripts/` — the report script is plain `.mjs`, not
  type-checked; test it via its spec. `@nestjs/common` `HttpException` sets `exception.message` from
  `response.message` when the response is an object — rely on that, do not pass a second `description` arg.
  Node ≥ 20 for `fs.readdirSync(dir, { recursive: true })`. Never include a live client tenant identifier in
  any file (use `acme`-style placeholders in comments/tests). The API imports nothing from `@routeflow/types`
  at runtime — keep addon keys as string literals in `apps/api`.

---

## Test packages

_Authored FIRST. These agents write tests only — no implementation code._

### TP1 — REG red set in the guard spec

- **writes:** `apps/api/src/billing/addon.guard.spec.ts` (append a new `describe("REG-OCR-1 registry-driven observe-first mode", …)` at the end; do not touch the nine existing cases)
- **tests:** T1, T2, T3
- **brief:** exactly as [bug-test-plan.md](./bug-test-plan.md) §Red set. Reuse the file's existing helpers for
  the reflector mock, the `addonService` mock and the execution-context builder; if the context builder does
  not let you set `method`/`originalUrl`, build the request object inline as
  `{ user: { tenantId: "tenant-1" }, method: "POST", originalUrl: "/api/v1/vendor-bills/scan-invoice" }`.
  Use `const result = await guard.canActivate(ctx).catch((e) => e)` so every test fails on an ASSERTION
  today, never on an uncaught rejection. T2 spies `Logger.prototype.warn` (import `Logger` from
  `@nestjs/common`) and restores it in `afterEach`. T3 asserts `err.getResponse()` with `toMatchObject`.
- **must fail with:** T1/T2 `expected: true, received: [ForbiddenException: This feature requires the "ocr" add-on.]`; T3 `toMatchObject` receiving the bare string `This feature requires the "tobacco_dealer" add-on.`

### TP2 — registry pin spec

- **writes:** `apps/api/src/billing/addon-gate-registry.spec.ts` **(new)**
- **tests:** P1a, P1b, P1c, P1d, P1e
- **brief:** import `{ ADDON_GATE_REGISTRY }` from `./addon-gate-registry` (WP1 creates it; this spec is
  outside the red gate and goes green after WP1). Scan `path.resolve(__dirname, "..")` recursively for files
  ending `.controller.ts`; extract keys with the exact code below; assert per §Pins. Titles are plain (no REG
  token).
- **exact code:**

```ts
import * as fs from "node:fs";
import * as path from "node:path";
import { ADDON_GATE_REGISTRY } from "./addon-gate-registry";

const SRC_ROOT = path.resolve(__dirname, "..");

/** key -> controller files that gate on it (string-literal @RequireAddon sites only, by design). */
function requireAddonSites(): Map<string, string[]> {
  const files = (fs.readdirSync(SRC_ROOT, { recursive: true }) as string[])
    .map(String)
    .filter((f) => f.endsWith(".controller.ts"))
    .map((f) => path.join(SRC_ROOT, f));
  const sites = new Map<string, string[]>();
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const call of text.matchAll(/@RequireAddon\(([^)]*)\)/g)) {
      for (const lit of call[1].matchAll(/"([^"]+)"/g)) {
        const list = sites.get(lit[1]) ?? [];
        list.push(path.relative(SRC_ROOT, file));
        sites.set(lit[1], list);
      }
    }
  }
  return sites;
}
```

- P1c compares `new Date(row.reviewBy + "T00:00:00Z").getTime()` with today's UTC midnight
  (`Date.UTC(y, m, d)` from `new Date()`); the assertion message must name the key.
- P1e: `expect(sites.get("ocr")?.length ?? 0).toBeGreaterThanOrEqual(4)`, `tobacco_dealer ≥ 8`,
  `recurring_routes ≥ 6`, `order_delivery ≥ 7`, `developer_mode ≥ 7` (counts are per file occurrence).
- **must fail with:** module not found `./addon-gate-registry` until WP1 lands (outside the red gate; acceptable).

### TP3 — Playwright REG-OCR-2

- **writes:** `apps/web/e2e/02-operator.spec.ts` (append the new `test(...)` directly after OP-17b's block,
  inside the same `describe`)
- **tests:** T5
- **brief:** exactly as [bug-test-plan.md](./bug-test-plan.md) T5. Copy OP-17b's navigation and single-file
  upload steps verbatim (same fixture file, same selectors); register the `page.route` 403 fulfil BEFORE the
  click that triggers the scan; assert the server text is visible and the generic text has count 0. Title:
  `OP-17g REG-OCR-2 single scan surfaces the server's error message instead of the generic file hint`.
- **must fail with:** the first `toBeVisible` times out (toast shows `Please check the file and try again.`).
  Not run by the engine; proven by hand on the local Docker stack.

### TP4 — report-script pins

- **writes:** `apps/api/src/common/report-addon-gate-blast-radius-script.spec.ts` **(new)**
- **tests:** P3a, P3b
- **brief:** imitate `apps/api/src/common/prod-migrate-script.spec.ts`'s mechanism for exercising a script
  (spawn `node apps/api/scripts/report-addon-gate-blast-radius.mjs` with `DATABASE_URL` deleted from `env`,
  assert non-zero exit and stderr/stdout mentions `DATABASE_URL`; no network). P3b reads the script file as
  text and asserts it contains `default_transaction_read_only` and matches none of
  `/\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)\b/i`.
- **must fail with:** script file missing (ENOENT / non-zero exit without the `DATABASE_URL` text) until WP3
  lands (outside the red gate).

**Red gate command** _(runs only the REG tests; every one must fail on an assertion, none may pass)_:

```bash
cd apps/api && npx jest src/billing/addon.guard.spec.ts -t "REG-OCR-1" --silent
```

---

## Work packages

### WP1 — gate registry + registry-driven AddonGuard

- **files:** `apps/api/src/billing/addon-gate-registry.ts` **(new)**, `apps/api/src/billing/addon.guard.ts`
- **satisfies:** R1, R2, R3, R5
- **provenBy:** T1, T2, T3, P1a, P1b, P1c, P1d, P1e, P2
- **dependsOn:** none
- **effort:** high (auth/permissions)
- **brief:** create the registry exactly as below, then edit `addon.guard.ts` exactly as below. For the
  `added` dates of the existing keys, do not guess: run `git log --format=%ad --date=short -S '"<key>"' --
apps/api/src | tail -1` in the worktree for each key (`tobacco_dealer`, `recurring_routes`, `order_delivery`,
  `developer_mode`) and record the earliest date; `ocr` is `2026-08-29`. For `routes`, grep
  `@RequireAddon(` and list `METHOD /path` per key (informational strings). Keep `INTERNAL_ADDON_KEYS` and the
  message construction verbatim.
- **exact code — `apps/api/src/billing/addon-gate-registry.ts`:**

```ts
/**
 * Add-on gate registry — the ONE place every `@RequireAddon(key)` key is declared with its rollout state.
 *
 * `addon-gate-registry.spec.ts` fails `npm run verify` when a key used in a controller has no row here,
 * when a row has no live call site, when a `dark` row has passed its `reviewBy` date without a decision,
 * or when `ocr` is not `dark` (deploy-day decision 2026-09-04). `AddonGuard` reads `state`:
 *   - `dark`     → allow the request and log ONE warn ("addon gate would deny (dark) …") so the blast
 *                  radius is readable in the API logs before anyone is denied;
 *   - `enforced` → deny with 403 `{ code: "ADDON_GATE", addonKeys, message }`.
 * A NEW gate is added as `dark`. Flipping a row to `enforced` is a separate, reviewed diff, made only
 * after the owner has run the read-only blast-radius report against production
 * (`railway run --service postgres node apps/api/scripts/report-addon-gate-blast-radius.mjs --addon <key>`)
 * and either it lists zero live tenants or the grants it lists have been applied in Platform Admin.
 * Unregistered keys are treated as `enforced` at runtime — never looser than today; the spec is what makes
 * shipping an unregistered key impossible.
 *
 * Why this exists: PR #475 (2026-08-29) added `@RequireAddon("ocr")` to four routes with no grant for the
 * tenants already using them; every one of them was denied for five days before a client reported it.
 */
export type AddonGateState = "dark" | "enforced";

export interface AddonGateEntry {
  /** `dark` = allow + warn; `enforced` = deny. */
  state: AddonGateState;
  /** YYYY-MM-DD the gate first shipped (git history, not memory). */
  added: string;
  /** Informational: the routes that carry this key today (`METHOD /path`). */
  routes: readonly string[];
  /** The UI or script that writes THIS exact `TenantAddon.addonKey` — a gate nothing can grant is an outage. */
  grantPath: string;
  /** The deploy-day decision for tenants that already use the feature, in writing. */
  backfill: string;
  /** `dark` rows only — YYYY-MM-DD by which the row must be flipped to `enforced` or this date extended. */
  reviewBy?: string;
}

export const ADDON_GATE_REGISTRY: Readonly<Record<string, AddonGateEntry>> = {
  ocr: {
    state: "dark",
    added: "2026-08-29",
    routes: [
      // fill from grep: vendor-bills scan-invoice, bookkeeping, import/batch, supplier-statements
    ],
    grantPath:
      'Platform Admin → Tenants → [tenant] → add-ons (AddonService.enableAddon writes addonKey "ocr")',
    backfill:
      "OPEN — restore scanning for every tenant (dark) on 2026-09-04; before any flip: run the blast-radius " +
      "report and grant the listed tenants, or decide OCR stays included. Known gaps: the plan flag " +
      '"addon.ocr" and the SKU writer ("OCR_PACK_250", subscription-mutation.service.ts) never write this key.',
    reviewBy: "2026-10-15",
  },
  tobacco_dealer: {
    state: "enforced",
    added: "<from git>",
    routes: [/* fill from grep */],
    grantPath: 'Platform Admin → Tenants → [tenant] → add-ons (addonKey "tobacco_dealer")',
    backfill: "Live before the registry existed (regulated program); no change.",
  },
  recurring_routes: {
    state: "enforced",
    added: "<from git>",
    routes: [/* fill from grep */],
    grantPath: 'Platform Admin → Tenants → [tenant] → add-ons (addonKey "recurring_routes")',
    backfill:
      "Live before the registry existed; any-of with order_delivery/developer_mode; no change.",
  },
  order_delivery: {
    state: "enforced",
    added: "<from git>",
    routes: [/* fill from grep */],
    grantPath: 'Platform Admin → Tenants → [tenant] → add-ons (addonKey "order_delivery")',
    backfill: "Live before the registry existed; no change.",
  },
  developer_mode: {
    state: "enforced",
    added: "<from git>",
    routes: [/* fill from grep */],
    grantPath:
      "Platform Admin internal switch (never named in tenant-facing text — see INTERNAL_ADDON_KEYS).",
    backfill: "Internal flag; no change.",
  },
};

/** Runtime state for a key; unregistered keys enforce (the spec keeps them from ever shipping). */
export function addonGateState(key: string): AddonGateState {
  return ADDON_GATE_REGISTRY[key]?.state ?? "enforced";
}
```

- **exact code — `apps/api/src/billing/addon.guard.ts`** (whole file; the only behavior added is the
  dark branch and the structured body):

```ts
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AddonService } from "./addon.service";
import { REQUIRE_ADDON_KEY } from "./require-addon.decorator";
import { addonGateState } from "./addon-gate-registry";

/**
 * Addon keys that are internal platform-admin switches rather than purchasable add-ons.
 * They are honoured as any-of keys but NEVER named in the 403 message — the web toasts
 * that message verbatim (MutationCache.onError), so echoing them would leak a hidden flag
 * and give tenants upgrade guidance they cannot act on. String literals on purpose: API
 * source never imports @routeflow/types at runtime.
 */
const INTERNAL_ADDON_KEYS = new Set(["developer_mode"]);

/** Stable machine-readable code for an add-on denial — clients branch on this, never on the text. */
export const ADDON_GATE_CODE = "ADDON_GATE";

/**
 * Enforces @RequireAddon(key) through the gate registry (addon-gate-registry.ts). Guard order matters:
 * `@UseGuards(JwtAuthGuard, RolesGuard, AddonGuard)` — guards run BEFORE the TenantInterceptor, so the
 * tenant AsyncLocalStorage is NOT initialized here; read the tenantId from `req.user` (populated by
 * JwtAuthGuard), never from `prisma.getTenantId()`.
 */
@Injectable()
export class AddonGuard implements CanActivate {
  // Property-initialised on purpose: the constructor signature is part of the spec harness.
  private readonly logger = new Logger(AddonGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly addonService: AddonService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Metadata is either the legacy single string (from a call site that hasn't been
    // touched) or the current string[] from the variadic @RequireAddon(...keys).
    const raw = this.reflector.getAllAndOverride<string | string[] | undefined>(REQUIRE_ADDON_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const keys = typeof raw === "string" ? [raw] : raw;
    if (!keys || keys.length === 0) return true;

    const request = context.switchToHttp().getRequest<{
      user?: { tenantId?: string | null };
      method?: string;
      originalUrl?: string;
      url?: string;
    }>();
    const tenantId = request.user?.tenantId ?? null;
    // SUPER_ADMIN operates without a tenant — never addon-gated
    if (tenantId == null) return true;

    const active = await this.addonService.getActiveAddons(tenantId); // one query for any-of
    if (keys.some((k) => active.includes(k))) return true;

    // Observe-first, registry-driven: a key set whose EVERY key is registered `dark` is not enforced yet —
    // allow, and log the would-deny so the blast radius is readable before the flip. Any enforced (or
    // unregistered) key in the set keeps today's deny.
    if (keys.every((k) => addonGateState(k) === "dark")) {
      const route = `${request.method ?? "?"} ${request.originalUrl ?? request.url ?? "?"}`;
      this.logger.warn(
        `addon gate would deny (dark): keys=${keys.join(",")} tenant=${tenantId} route=${route}`,
      );
      return true;
    }

    // Name only the purchasable keys; internal flags stay out of tenant-facing text.
    const named = keys.filter((k) => !INTERNAL_ADDON_KEYS.has(k));
    const quoted = named.map((k) => `"${k}"`).join(", ");
    const message =
      named.length === 0
        ? "This feature is not enabled for your account."
        : named.length === 1
          ? `This feature requires the ${quoted} add-on.`
          : `This feature requires one of these add-ons: ${quoted}.`;
    throw new ForbiddenException({
      statusCode: 403,
      error: "Forbidden",
      code: ADDON_GATE_CODE,
      addonKeys: named,
      message,
    });
  }
}
```

### WP2 — web single-scan toast shows the server message

- **files:** `apps/web/components/ScanInvoiceModal.tsx`
- **satisfies:** R4
- **provenBy:** T5
- **dependsOn:** none
- **effort:** low
- **brief:** in `scanOne`'s catch, single-flow branch (line ~715), change ONLY the description fallback so it
  mirrors the batch branch. Nothing else in the file changes.
- **exact code:**

```ts
          description: isApiKeyError
            ? "Go to Settings → AI & Integrations to add your Claude API key."
            : msg || "Please check the file and try again.",
```

### WP3 — read-only blast-radius report script

- **files:** `apps/api/scripts/report-addon-gate-blast-radius.mjs` **(new)**
- **satisfies:** R6
- **provenBy:** P3a, P3b
- **dependsOn:** none
- **effort:** medium
- **brief:** imitate `apps/api/scripts/audit-tenant-entitlements.mjs` for the header ("READ-ONLY —
  NEVER RUN FROM AN IMPLEMENTATION SESSION; run via `railway run --service postgres node …`"), the `pg`
  connection, `SET default_transaction_read_only = on`, `SET statement_timeout`, and output style. Args:
  `--addon <key>` (default `ocr`), `--json`. Refuse with a clear message and exit 1 when `DATABASE_URL` is
  unset — BEFORE any connection. Read `apps/api/prisma/schema.prisma` and `apps/api/src/vendor-bills/
vendor-bills.service.ts` (the archive write in `scanInvoice` — the "priorScan" store) to find the
  per-tenant usage evidence for `ocr`: the scan-archive model (count + max createdAt per tenant) and, if the
  `AiUsageEvent` model carries a feature/kind column, scan events per tenant. Query 1: tenants holding an
  active `TenantAddon` row for the key. Query 2: usage per tenant. Print a table — `slug | usage | lastUsedAt
| activeRow` — then `N tenant(s) with prior usage and no active row would be denied on flip`. For keys other
  than `ocr` the usage query may be unavailable: print the active-row list and say usage evidence is not
  modelled for that key. Tenant slugs are fine in the owner's terminal output; none in code/comments.
  Only SELECT statements; no writes of any kind.

### WP4 — docs: PR template + CLAUDE.md rule

- **files:** `.github/PULL_REQUEST_TEMPLATE.md`, `CLAUDE.md`
- **satisfies:** R7
- **provenBy:** P1a (the mechanical form of the rule the docs state)
- **dependsOn:** none
- **effort:** low
- **brief:** PR template — add one checklist line after "Migration included if schema changed":
  `- [ ] Adds or tightens an entitlement gate on an existing route? → registry row in
apps/api/src/billing/addon-gate-registry.ts (state dark), blast-radius report attached, grant path named`.
  CLAUDE.md — directly after the "Customer-level order merges … withAdvisoryLock" paragraph in
  "## Money discipline", add a short paragraph titled in bold **Entitlement gates**: every `@RequireAddon`
  key is declared in `apps/api/src/billing/addon-gate-registry.ts`; a new gate ships `dark`
  (allow + would-deny warn) and flips to `enforced` only in a separate diff after the owner runs
  `apps/api/scripts/report-addon-gate-blast-radius.mjs` against prod; the registry spec makes an
  unregistered key a red `npm run verify`. Keep it to four lines. Do not reformat anything else.

### Package map

| WP  | satisfies      | provenBy                | dependsOn | Wave |
| --- | -------------- | ----------------------- | --------- | ---- |
| WP1 | R1, R2, R3, R5 | T1, T2, T3, P1a–P1e, P2 | —         | 1    |
| WP2 | R4             | T5                      | —         | 1    |
| WP3 | R6             | P3a, P3b                | —         | 1    |
| WP4 | R7             | P1a                     | —         | 1    |

Cross-check: R1–R7 all covered; T1–T3, T5, P1–P3 all claimed.

---

## Acceptance criteria

1. `R1` — with the shipped registry, `AddonGuard.canActivate` resolves `true` for `["ocr"]` and an empty
   active list, and `Logger.warn` receives exactly one message containing `keys=ocr` and `tenant=<id>`.
2. `R2` — for `["tobacco_dealer"]`, `["recurring_routes","order_delivery","developer_mode"]` and every
   other enforced set, the guard rejects with `ForbiddenException` whose `message` equals the
   `origin/master` text character for character; the nine pre-existing spec cases pass unedited.
3. `R3` — `err.getResponse()` is an object with `code: "ADDON_GATE"` and `addonKeys` (internal keys excluded).
4. `R4` — the single-scan toast renders the server `message` when present (T5 green on the local stack);
   the batch branch is untouched.
5. `R5` — adding `@RequireAddon("nope")` to any controller makes `addon-gate-registry.spec.ts` fail with a
   message naming `nope`; removing every `ocr` site makes P1b fail; setting `ocr` to `enforced` fails P1d;
   a `reviewBy` in the past fails P1c.
6. `R6` — `node apps/api/scripts/report-addon-gate-blast-radius.mjs` without `DATABASE_URL` exits 1 naming the
   variable; the file contains no write SQL.
7. Negative: `SUPER_ADMIN` (null tenantId) and handlers without metadata still pass; an unregistered key
   still denies at runtime.
8. Deploy day: every tenant regains all four ocr routes the moment the API deploys; tenants already granted
   are unaffected; no migration, no data write; the API log shows `addon gate would deny (dark)` lines for
   ungranted tenants that scan.

---

## Verification commands

Per round:

```bash
cd apps/api && npx tsc -p tsconfig.build.json --noEmit
cd apps/api && npx eslint src/billing
```

Final:

```bash
cd apps/api && npx jest src/billing src/routes src/common/report-addon-gate-blast-radius-script.spec.ts --silent
cd apps/api && npx eslint src/billing src/common scripts/report-addon-gate-blast-radius.mjs
cd apps/web && npx tsc --noEmit
cd apps/web && npx next lint --file components/ScanInvoiceModal.tsx --file e2e/02-operator.spec.ts
```

T5 (Playwright) and the end-to-end 403 → 400 probe run by hand on the local Docker stack after the engine
finishes (see [bug-test-plan.md](./bug-test-plan.md) §Commands) — never as an engine gate.

---

## UI verification

Not run by the engine (no `uiVerify`). The one-line web change is proven by T5 on the local stack.

---

## Risks & rollback

| Risk                                                                  | Likelihood         | Blast radius                 | Mitigation / what the reviewer should watch                                                         |
| --------------------------------------------------------------------- | ------------------ | ---------------------------- | --------------------------------------------------------------------------------------------------- |
| Dark branch loosens a gate other than `ocr`                           | low                | cross-boundary (entitlement) | `keys.every(dark)`; only `ocr` is dark; unregistered → enforced; P1d/P2/T3 pin it                   |
| Structured 403 body changes `exception.message` or the web toast text | low                | cosmetic                     | Nest sets `message` from the object; T3 asserts the exact text; MutationCache toasts `data.message` |
| `reviewBy` expiry turns CI red on 2026-10-15                          | certain, by design | tooling                      | the failing test names the key; the fix is a one-line reviewed diff (flip or extend)                |
| Report script touches prod data                                       | very low           | data                         | read-only session + P3b keyword scan; owner-run only                                                |
| Playwright T5 flaky against the local stack                           | medium             | none (hand-run)              | copy OP-17b's exact setup; re-run once before concluding                                            |

- **Rollback:** revert the squash commit — the gate returns to `enforced` behavior; or set `ocr.state` to
  `enforced` in a one-line diff (P1d must be updated in the same diff).
- **Migration reversibility:** no migration.
- **Feature flag / entitlement:** gate key `ocr`; granting path Platform Admin → Tenants → [tenant] →
  add-ons → `AddonService.enableAddon` writes `addonKey: "ocr"` — the exact key the guard reads (verified
  in the S2 refutation); the plan flag `addon.ocr` and the SKU `OCR_PACK_250` do NOT (recorded, not fixed).
- **Deploy day:** all tenants regain the four ocr routes; no backfill required for that; the grandfather
  decision happens before any flip, on the report's numbers.
- **Observability:** `addon gate would deny (dark)` warn lines in the API log (Railway) name key, tenant and
  route; a flip that denies live tenants shows as 403 `code: "ADDON_GATE"` on those routes.

---

## Pipeline args

```js
{
  planPath: 'C:/ClaudeCode/routeflow/.claude/worktrees/rf-ocr/.claude/pipeline/2026-09-04-ocr-gate-observe-first/build-plan.md',
  testPlanPath: 'C:/ClaudeCode/routeflow/.claude/worktrees/rf-ocr/.claude/pipeline/2026-09-04-ocr-gate-observe-first/bug-test-plan.md',
  lessonsPath: 'C:/ClaudeCode/routeflow/.claude/worktrees/rf-ocr/.claude/lessons/LESSONS.md',
  startedAt: '<ISO at launch>',
  mode: 'bugfix',
  scale: 'major',
  workdir: 'C:/ClaudeCode/routeflow/.claude/worktrees/rf-ocr',
  context: 'OCR-1/OCR-2: registry-driven observe-first AddonGuard (ocr dark), coded 403 body, web single-scan toast shows server message, read-only blast-radius report, docs rule',
  formatCommand: 'npx prettier --write --no-error-on-unmatched-pattern "apps/api/src/billing/addon-gate-registry.ts" "apps/api/src/billing/addon-gate-registry.spec.ts" "apps/api/src/billing/addon.guard.ts" "apps/api/src/billing/addon.guard.spec.ts" "apps/api/scripts/report-addon-gate-blast-radius.mjs" "apps/api/src/common/report-addon-gate-blast-radius-script.spec.ts" "apps/web/components/ScanInvoiceModal.tsx" "apps/web/e2e/02-operator.spec.ts"',
  radiusFiles: [
    'apps/api/src/billing/addon.guard.ts', 'apps/api/src/billing/addon-gate-registry.ts',
    'apps/api/src/billing/addon.guard.spec.ts', 'apps/api/src/billing/addon-gate-registry.spec.ts',
    'apps/api/src/billing/require-addon.decorator.ts', 'apps/api/src/billing/plan-flag.guard.ts',
    'apps/api/src/billing/addon.service.ts', 'apps/api/src/routes/dispatch-addon-gate.spec.ts',
    'apps/api/src/vendor-bills/vendor-bills.controller.ts', 'apps/api/src/bookkeeping/bookkeeping.controller.ts',
    'apps/api/src/import/batch.controller.ts', 'apps/api/src/supplier-statements/supplier-statements.controller.ts',
    'apps/web/components/ScanInvoiceModal.tsx', 'apps/web/e2e/02-operator.spec.ts',
    'apps/api/scripts/report-addon-gate-blast-radius.mjs', 'apps/api/scripts/audit-tenant-entitlements.mjs',
    'apps/api/src/common/report-addon-gate-blast-radius-script.spec.ts',
  ],
  siblingPatterns: [
    { pattern: '@RequireAddon\\(', note: 'every hit must resolve to a registry key (19 sites / 4 key sets expected); a key absent from addon-gate-registry.ts is a defect' },
    { pattern: '@RequirePlanFlag\\("([^"]+)"\\)', note: 'a flag NOT in DARK_PLAN_FLAGS (plan-flag.guard.ts) enforces immediately; flag.msrp is intentionally live; any other un-dark flag is a finding' },
    { pattern: '"Please check the file and try again\\."|Scan failed\\. Retry', note: 'web: a catch that reads err.response.data.message and then toasts a literal instead is the OCR-2 shape; the batch branch of scanOne is the correct form' },
  ],
  testPackages: [
    { id: 'TP1', title: 'REG red set in the guard spec', files: ['apps/api/src/billing/addon.guard.spec.ts'], brief: 'Append describe("REG-OCR-1 registry-driven observe-first mode") with T1, T2, T3 exactly as bug-test-plan.md §Red set; reuse the file\'s existing mocks/context helpers; every test fails on an ASSERTION today via `const result = await guard.canActivate(ctx).catch((e) => e)`; T2 spies Logger.prototype.warn and restores in afterEach; do not touch the nine existing cases.', effort: 'high' },
    { id: 'TP2', title: 'registry pin spec', files: ['apps/api/src/billing/addon-gate-registry.spec.ts'], brief: 'New spec: P1a–P1e per bug-test-plan.md §Pins using the exact requireAddonSites() code in build-plan.md TP2; imports ./addon-gate-registry (created by WP1); plain titles, no REG token.' },
    { id: 'TP3', title: 'Playwright REG-OCR-2', files: ['apps/web/e2e/02-operator.spec.ts'], brief: 'Append test "OP-17g REG-OCR-2 single scan surfaces the server\'s error message instead of the generic file hint" after OP-17b, copying OP-17b\'s navigation and single-file upload verbatim; page.route the scan-invoice call with the 403 ADDON_GATE body before the scan click; assert server text visible and generic text count 0. Not run by the engine.' },
    { id: 'TP4', title: 'report-script pins', files: ['apps/api/src/common/report-addon-gate-blast-radius-script.spec.ts'], brief: 'New spec imitating prod-migrate-script.spec.ts: P3a spawns the script with DATABASE_URL removed and asserts exit != 0 and output naming DATABASE_URL; P3b reads the script text and asserts default_transaction_read_only present and no INSERT/UPDATE/DELETE/ALTER/CREATE/DROP/TRUNCATE keyword.', effort: 'low' },
  ],
  redGate: { commands: ['cd apps/api && npx jest src/billing/addon.guard.spec.ts -t "REG-OCR-1" --silent'], expect: 'fail' },
  packages: [
    { id: 'WP1', title: 'gate registry + registry-driven AddonGuard', files: ['apps/api/src/billing/addon-gate-registry.ts', 'apps/api/src/billing/addon.guard.ts'], brief: 'Create the registry and rewrite addon.guard.ts EXACTLY as the code blocks in build-plan.md WP1; fill added dates from git log -S (never guess) and routes from grep; constructor signature unchanged; Logger as a property initializer; ocr dark, all other keys enforced; unregistered keys enforce.', satisfies: ['R1','R2','R3','R5'], provenBy: ['T1','T2','T3','P1a','P1b','P1c','P1d','P1e','P2'], effort: 'high' },
    { id: 'WP2', title: 'web single-scan toast shows the server message', files: ['apps/web/components/ScanInvoiceModal.tsx'], brief: 'Change only the single-flow description fallback in scanOne\'s catch to `msg || "Please check the file and try again."` (exact code in build-plan.md WP2). Nothing else.', satisfies: ['R4'], provenBy: ['T5'], effort: 'low' },
    { id: 'WP3', title: 'read-only blast-radius report script', files: ['apps/api/scripts/report-addon-gate-blast-radius.mjs'], brief: 'New read-only owner-run script per build-plan.md WP3, imitating apps/api/scripts/audit-tenant-entitlements.mjs (header, pg connection, default_transaction_read_only=on, statement_timeout); --addon <key> default ocr, --json; refuse without DATABASE_URL before connecting; SELECT only; usage evidence from the scan archive model found in vendor-bills.service.ts scanInvoice and schema.prisma.', satisfies: ['R6'], provenBy: ['P3a','P3b'] },
    { id: 'WP4', title: 'docs: PR template + CLAUDE.md rule', files: ['.github/PULL_REQUEST_TEMPLATE.md', 'CLAUDE.md'], brief: 'One checklist line in the PR template and a four-line bold "Entitlement gates" paragraph in CLAUDE.md after the withAdvisoryLock paragraph, exactly as build-plan.md WP4; no other edits, no reformatting.', satisfies: ['R7'], provenBy: ['P1a'], effort: 'low' },
  ],
  verifyCommands: {
    perRound: ['cd apps/api && npx tsc -p tsconfig.build.json --noEmit', 'cd apps/api && npx eslint src/billing'],
    final: [
      'cd apps/api && npx jest src/billing src/routes src/common/report-addon-gate-blast-radius-script.spec.ts --silent',
      'cd apps/api && npx eslint src/billing src/common scripts/report-addon-gate-blast-radius.mjs',
      'cd apps/web && npx tsc --noEmit',
      'cd apps/web && npx next lint --file components/ScanInvoiceModal.tsx --file e2e/02-operator.spec.ts',
    ],
  },
  mutationProbe: { targets: [
    { file: 'apps/api/src/billing/addon.guard.ts', behavior: 'a key set whose every key is registered dark is allowed with one warn; any enforced key denies with code ADDON_GATE and the unchanged message', test: 'cd apps/api && npx jest src/billing/addon.guard.spec.ts -t "REG-OCR-1" --silent', revertFix: true },
    { file: 'apps/api/src/billing/addon-gate-registry.ts', behavior: 'ocr is registered dark; addonGateState returns enforced for unknown keys', test: 'cd apps/api && npx jest src/billing/addon.guard.spec.ts -t "REG-OCR-1" --silent' },
  ] },
}
```
