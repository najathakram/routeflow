# Fix ruling — OCR-1 / OCR-2 ocr-gate-observe-first

> Fable @ high rules over the S1 brief ([cause-brief.md](./cause-brief.md)) and the S2 refutation
> ([cause-refutation.md](./cause-refutation.md), quoted in full there — verdicts: OCR-1 **confirmed** at
> `apps/api/src/billing/addon.guard.ts:49`; OCR-2 **confirmed** at
> `apps/web/components/ScanInvoiceModal.tsx:715`). Guardrail choice comes from the verified research
> ([research-summary.md](./research-summary.md), critic's single best method: the checked-in gate registry).
> Status: APPROVED 2026-09-04.

## 1. Cause verdict

- **OCR-1 accepted.** `AddonGuard.canActivate` reaches the unconditional `throw new ForbiddenException(...)`
  (`addon.guard.ts:49`) whenever `getActiveAddons(tenantId)` (a bare, uncached `TenantAddon` read,
  `addon.service.ts:52-57`) lacks the literal row `addonKey === "ocr"`. Nothing writes that row except the
  Platform-Admin toggle (`AddonService.enableAddon`); the plan flag `addon.ocr` and the SKU writer
  (`OCR_PACK_250`) never produce it. PR #475 (squash `5cb71545`, 2026-08-29) added the gate to FOUR routes
  (vendor-bills scan-invoice, bookkeeping, import/batch, supplier-statements) with no grandfathering and
  outside the observe-first mechanism that `PlanFlagGuard` already had (`plan-flag.guard.ts:21-29,64-66`).
  Earlier guards (`TenantStatusGuard`) can also 403 but tenant-wide on every POST; the local repro in §7
  discriminates. The blast-radius unit is the KEY `ocr`, not the route.
- **OCR-2 accepted.** The single-scan branch discards the server message at `ScanInvoiceModal.tsx:715`;
  the batch branch (`:720-724`) and mobile (`scan.tsx:99-105`) surface it. Pre-existing (2026-07-12), not
  introduced by #475 — but it is what turned a legible 403 into "check the file".

## 2. Fix design (minimal diff)

**Principle:** restore scanning for every tenant on deploy with NO data write, keep everything #475 built
(metering, the gate code, the admin grant path), and make the next gate incapable of shipping this way.

1. **New `apps/api/src/billing/addon-gate-registry.ts`** — the single declaration of every `@RequireAddon`
   key with `state: "dark" | "enforced"`, `added`, `routes`, `grantPath`, `backfill`, and `reviewBy` (dark
   rows only). `ocr` is registered **dark**; `tobacco_dealer`, `recurring_routes`, `order_delivery`,
   `developer_mode` are **enforced** (today's behavior, unchanged). `addonGateState(key)` returns
   `"enforced"` for an unregistered key — runtime is never looser than today; the spec (3) is what makes an
   unregistered key impossible to ship.
2. **`apps/api/src/billing/addon.guard.ts`** — after the any-of match fails: if EVERY key in the set is
   registered `dark`, log one `warn` (`addon gate would deny (dark): keys=… tenant=… route=…`) and return
   `true`; otherwise deny exactly as today, with the identical message text, now in a structured body
   `{ statusCode: 403, error: "Forbidden", code: "ADDON_GATE", addonKeys, message }`. Logger is a
   **property initializer** (constructor signature `(reflector, addonService)` is part of the test harness
   and must not change). Mixed sets (any enforced key) keep denying.
3. **New `apps/api/src/billing/addon-gate-registry.spec.ts`** (pin) — scans every `*.controller.ts` under
   `apps/api/src` for `@RequireAddon(...)` string literals: every key found has a registry row; every row
   has a live call site; every dark row's `reviewBy` has not passed; `ocr` is dark. A new gate with no row
   is a red test in `npm run verify`.
4. **`apps/web/components/ScanInvoiceModal.tsx:715`** — `description: isApiKeyError ? … : msg || "Please
check the file and try again."` — mirror the batch branch; one line.
5. **New read-only `apps/api/scripts/report-addon-gate-blast-radius.mjs`** — the owner-run flip
   precondition: for an addon key (default `ocr`), list tenants with prior usage of the gated feature, whether
   they hold an active row, and the count that would be denied on flip. Read-only session
   (`default_transaction_read_only=on`), never run from an implementation session — imitate
   `apps/api/scripts/audit-tenant-entitlements.mjs`.
6. **Docs:** `.github/PULL_REQUEST_TEMPLATE.md` gains one checklist line (gate added/tightened → registry row,
   dark, blast-radius report); `CLAUDE.md` gains a three-line "Entitlement gates" rule next to the merge-lock
   rule.

**Must NOT change:** any-of semantics for enforced sets; SUPER_ADMIN / no-metadata pass-through;
`INTERNAL_ADDON_KEYS` redaction; `recordAiUsage` metering; `AddonService`; the Platform-Admin grant path;
`PlanFlagGuard`; the four controllers; mobile.

**Invariant preserved:** for every key whose registry state is `enforced` (all keys except `ocr`), every
`AddonGuard` allow/deny decision and its message text are identical to `origin/master`; `ocr` decisions
become allow-with-warn; nothing else in the request pipeline changes.

## 3. Regression tests

| T#  | REG token | Fails TODAY on (exact wrong value)                                                                                                               | Passes after fix on                                                                            | Notes                                                                                                                                                                                                                          |
| --- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T1  | REG-OCR-1 | `expect(result).toBe(true)` → received `ForbiddenException: This feature requires the "ocr" add-on.`                                             | resolved `true`                                                                                | reflector `["ocr"]`, `getActiveAddons → []`, `req.user.tenantId = "tenant-1"`                                                                                                                                                  |
| T2  | REG-OCR-1 | `expect(result).toBe(true)` → received the same ForbiddenException (warn count 0)                                                                | `true` and `Logger.warn` called once with a string containing `keys=ocr` and `tenant=tenant-1` | spy `Logger.prototype.warn`                                                                                                                                                                                                    |
| T3  | REG-OCR-1 | `expect(err.getResponse()).toMatchObject({code:"ADDON_GATE",…})` → received the bare string `This feature requires the "tobacco_dealer" add-on.` | object with `code`, `addonKeys: ["tobacco_dealer"]`, unchanged `message`                       | enforced key keeps denying                                                                                                                                                                                                     |
| T5  | REG-OCR-2 | toast description `Please check the file and try again.` visible; server text absent                                                             | server text `This feature requires the "ocr" add-on.` visible; generic text count 0            | Playwright, `apps/web/e2e/02-operator.spec.ts`, mocked 403 via `page.route` — **outside the engine red gate** (web has no unit runner; Playwright is not an engine gate); proven red → green by hand on the local Docker stack |

Pins (no REG token, outside the red gate): P1 registry coverage + `reviewBy` + `ocr` dark
(`addon-gate-registry.spec.ts`); P2 existing `addon.guard.spec.ts` cases (any-of deny, SUPER_ADMIN pass,
no-metadata pass, `developer_mode` never named) must stay green untouched; P3 report script refuses to run
without `DATABASE_URL` and never opens a write transaction
(`apps/api/src/common/report-addon-gate-blast-radius-script.spec.ts`).

## 4. Blast radius (`radiusFiles`)

`apps/api/src/billing/addon.guard.ts`, `apps/api/src/billing/addon-gate-registry.ts`,
`apps/api/src/billing/addon.guard.spec.ts`, `apps/api/src/billing/addon-gate-registry.spec.ts`,
`apps/api/src/billing/require-addon.decorator.ts`, `apps/api/src/billing/plan-flag.guard.ts`,
`apps/api/src/billing/addon.service.ts`, `apps/api/src/routes/dispatch-addon-gate.spec.ts`,
`apps/api/src/vendor-bills/vendor-bills.controller.ts`, `apps/api/src/bookkeeping/bookkeeping.controller.ts`,
`apps/api/src/import/batch.controller.ts`, `apps/api/src/supplier-statements/supplier-statements.controller.ts`,
`apps/web/components/ScanInvoiceModal.tsx`, `apps/web/e2e/02-operator.spec.ts`,
`apps/api/scripts/report-addon-gate-blast-radius.mjs`, `apps/api/scripts/audit-tenant-entitlements.mjs`,
`apps/api/src/common/report-addon-gate-blast-radius-script.spec.ts`.

## 5. Sibling pattern (`siblingPatterns`)

- `@RequireAddon\(` — every hit must resolve to a registry key (19 sites / 4 key sets expected); a key
  absent from the registry is a defect.
- `@RequirePlanFlag\("([^"]+)"\)` — a flag NOT in `DARK_PLAN_FLAGS` enforces immediately (`flag.msrp` is
  intentionally live per the file comment); any OTHER un-dark flag is a finding.
- `"Please check the file and try again\."|Scan failed\. Retry` and `\?\.response\?\.data\?\.message` in
  `apps/web/components` — a catch that reads the server message and then toasts a literal instead is the
  OCR-2 shape; the batch branch of `scanOne` is the correct form.

## 6. Data repair

- No persisted data is corrupted. Three **owner decisions** stay open and ship nowhere in this diff:
  (a) grandfather grants — run `railway run --service postgres node
apps/api/scripts/report-addon-gate-blast-radius.mjs --addon ocr` after deploy; grant the listed tenants in
  Platform Admin (or decide OCR is free) before any flip to `enforced`; (b) the SKU writer stores
  `addonKey = "OCR_PACK_250"` while the guard reads `"ocr"` (`subscription-mutation.service.ts:184-186,
396-398` vs `addon.guard.ts:44-45`) — latent, detonates when OCR becomes self-service; registry/backlog
  entry, not this fix; (c) whether plan `addon.ocr` should auto-grant the row.

## 7. Probe plan

| File                                          | `revertFix`                                                    | REG test that must go red            |
| --------------------------------------------- | -------------------------------------------------------------- | ------------------------------------ |
| `apps/api/src/billing/addon.guard.ts`         | true                                                           | T1 `REG-OCR-1 T1`, T3 `REG-OCR-1 T3` |
| `apps/api/src/billing/addon-gate-registry.ts` | false (new file → standard mutation: flip `ocr` to `enforced`) | T1                                   |

Local repro (hand-run on the Docker stack, before and after): `POST /api/v1/vendor-bills/scan-invoice`
as the `test` tenant operator with one real image under field `images` — today `403 {"message":"This
feature requires the \"ocr\" add-on."}`; after the fix `400 … configure the ANTHROPIC_API_KEY`
(`vendor-bills.service.ts:1450-1453`), i.e. the request passed the gate and reached the scan path. The
seed grants no `ocr` row, so no setup is needed.
