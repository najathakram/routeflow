# P10-POS-B — Mobile drive-mode + money guardrails (credit limit / short-pick / settlement)

> Branch from `master` **after P10-POS-A** (`feat/p10-pos-a-mobile-pos`) merges. Assumes POS-A's
> files exist and are reused, not recreated: `apps/mobile/lib/api/change-requests.ts`,
> `apps/mobile/lib/at-door-diff.ts`, `apps/mobile/app/(driver)/route/stop/[stopId]/adjust.tsx`,
> `apps/mobile/lib/api/cost-history.ts`. Scope = **P10-POS-4** (drive mode toggle) + the money
> guardrails **P10-POS-6** (credit-limit), **P10-POS-7** (short-pick), **P10-POS-9** (run
> settlement). **P10-POS-2** (minimize/draft dock), **P10-POS-5** (owner-operator home — see §2.4,
> already shipped bar one bug fixed here), **P10-POS-8** (failed-delivery sheet), and **P10-POS-10**
> (offline sync-review) are **NOT** part of this increment — do not touch them beyond the one
> P10-POS-5 bug noted below.

## 1. Source acceptance criteria (quoted)

`docs/design-package/PHASE-5-6-10-PLAN.md` (P10-POS table):

```
| P10-POS-4 | Drive mode toggle + field-first layout | P10 | mobile | role matrix (pos-cost-roles-spec) | L | Toggle switches layout without losing drafts/session; scanner FAB reachable; admin-only areas hidden for pure drivers |
| P10-POS-5 | Owner-operator home | P10 | mobile | P10-POS-4 | S | admin+driver see run card above KPIs; single-role see standard home |
| P10-POS-6 | Operator credit-limit guard (sale sheet) | P10 | mobile | web credit-limit guard (guardrails-spec) | S | Over-limit surfaces guard; Proceed logs override; Collect routes to payment; Cancel aborts |
| P10-POS-7 | Short-pick check (loading) | P10 | mobile | web short-pick guardrail | M | Deliver-short reprices via `pricing.ts`; substitute swaps line; totals reconcile ±$0.01 |
| P10-POS-9 | Run settlement sheet (driver) | P10 | mobile | web run-settlement guardrail | M | Variance highlighted; close blocked until reconciled/overridden; totals match collected ±$0.01 |
```

`docs/design-package/project/specs/guardrails-spec.md` (the underlying wiring spec):

```
§2 Credit limits
- Operator guard at order create when limit would be exceeded — three exits: Collect payment
  first (opens Record Payment, order proceeds if under), Proceed over limit (audit-logged, flags
  account), Cancel.

§3 Short picks / partial fulfillment
- Loading check per run: picked qty vs ordered. Short line → deliver-short (invoice auto-adjusts
  to delivered qty, no credit note needed), substitute (picker, price-memory applies), or
  backorder (auto-adds to customer's next delivery draft).

§11 Run settlement (driver cash reconciliation)
- End of run: expected COD total vs counted cash + checks. Difference != 0 creates a variance
  record tied to run + driver, surfaced in Reports. Payments post to AR at driver-record time.
```

`docs/design-package/project/specs/pos-cost-roles-spec.md` §4 ("Roles: admin-as-driver,
one-person businesses"):

```
- Role = permissions; mode = layout. `canActAsDriver` on any user adds them to rosters and runs.
  A Drive mode toggle (avatar menu, one tap) swaps to the field layout ... without logout,
  permission change, or draft loss.
- Admin tracking: Live Dispatch shows every run including the admin's own; runs started in Drive
  mode emit the same realtime events — nothing special-cased.
```

**Investigation finding, load-bearing for this whole plan:** the literal acceptance text above is
partly unbuildable as written and partly already done. §3 below explains exactly which parts, and
§2 explains why.

## 2. What's shipped vs the real gap (read before touching anything)

### 2.1 Credit-limit guard (P10-POS-6)

- Server: `apps/api/src/orders/orders.service.ts#assertWithinCreditLimit` (line 2526) throws
  `409 {code:"CREDIT_LIMIT_EXCEEDED", limit, exposure, message}`. It is wired into exactly two
  paths: `updateOrderItems` (line 2248, non-DRAFT order edits) and
  `approveChangeRequestAtStop` (line 2938, the P5-09/POS-A at-door change-request resolve).
  **It is NOT wired into `create()`** (order/sale-builder creation, line 926) — grepped, confirmed
  absent. So a brand-new sale from `NewOrderScreen` can never hit this 409 today; only an EDIT of
  an existing order (mobile `edit-items.tsx`) or an at-door adjustment (mobile POS-A's
  `adjust.tsx`) can.
- **There is no server-side bypass/override for this guard, anywhere.** Grepped
  `orders.service.ts`, `update-order-items.dto.ts` (`UpdateOrderItemDto` has `overrideReason` but
  that's for a _price_ override, unrelated), and `change-requests.service.ts` — no
  `creditOverride`/similar field exists. `Customer` has no "flags account" field either. The
  guardrails-spec's "Proceed over limit (audit-logged, flags account)" exit **does not exist
  server-side** — it would need new API surface, out of scope for a mobile-gated plan. **This plan
  builds the two exits that DO have server support (Collect payment / Cancel) and explicitly
  drops "Proceed."**
- Mobile grep for `CREDIT_LIMIT`/`creditLimit`: zero hits outside unrelated DTOs/customer forms.
  Today both `edit-items.tsx`'s `onError` (line 399) and POS-A's `adjust.tsx`'s `submitEntry`
  catch (line 204) fall through to a **generic toast of the raw server message** — functionally
  correct (the block DOES stop the save) but not "surfaced usefully" (no limit/exposure numbers,
  no path forward).
- Web (`apps/web/app/(dashboard)/orders/[id]/page.tsx`) has the SAME gap — its own comment says
  `INSUFFICIENT_STOCK / CREDIT_LIMIT_EXCEEDED carry a server message and surface via the global
mutation toast — no handling needed`. So there's no richer web pattern to mirror here; this
  mobile guard is a net-new UI, not a port.

### 2.2 Short-pick (P10-POS-7)

- The literal "loading check per run: picked qty vs ordered" is a **warehouse pre-dispatch
  pick-list feature that does not exist anywhere in the stack.**
  `apps/mobile/app/(operator)/pick.tsx` is an honest, already-shipped stub: its own comment says
  _"Pick & load verification is not wired to a backend yet — no `/routes/:id/picks` endpoint
  exists."_ Grepped the whole API (`prisma/schema.prisma`, `src/routes/`) for
  `picks`/`Manifest`/`PickList` — nothing. Building this for real needs a new Prisma model +
  endpoint — **out of scope for a mobile-only, `apps/mobile`-gated plan. Do not build it here.**
  A `backorder` mechanism ("auto-adds to a next-delivery draft") also does not exist anywhere
  (grepped API — zero hits beyond an unrelated comment about oversell). Flagged as a follow-up,
  not built.
- **What IS genuinely buildable, mobile-only, and covers the money-correctness intent of
  "deliver-short reprices ... totals reconcile ±$0.01":** the server's delivery/invoicing pipeline
  (`apps/api/src/orders/orders.service.ts:3095-3330`, invoked from
  `apps/api/src/routes/routes.service.ts#completeStop`/`completeWithPayment`) **already fully
  supports per-line PARTIAL/REFUSED delivery** — `deliveredQty` tracking, order status
  `PARTIALLY_DELIVERED`, and a per-batch invoice that bills **only the delivered qty**, prorated
  by the line's own stored subtotal:
  `apps/api/src/orders/orders.service.ts:3321` → `subtotal = roundMoney((li.storedSubtotal *
li.qty) / li.orderQty)`. This is the exact same formula mobile's own
  `apps/mobile/components/SplitInvoiceScreen.tsx#previewLineTotal` already mirrors for a related
  flow. **The gap is that nothing on mobile ever produces anything but a full delivery**:
  `apps/mobile/app/(driver)/route/stop/[stopId]/payment.tsx#closeStop` (line 97-104) hardcodes
  `type: "DELIVERED", quantityDelivered: Math.round(li.qty)` for every line, unconditionally, and
  the stop-detail item checklist (`.../[stopId]/index.tsx`) is read-only (confirmed by POS-A's own
  investigation note). There is genuinely no way today for a driver to complete a stop with less
  than the full ordered qty per line. **This plan builds that** (WP3), reusing the
  already-shipped, already-correct server behavior — no API change.
- "Substitute swaps line" is **already shipped** pre-dispatch on mobile
  (`edit-items.tsx`'s Substitute picker, line ~600, sends `substituteProductId` — server handles it
  at `orders.service.ts:2079-2117`). It is NOT available inside the at-door change-request engine
  (`ChangeRequestType` is only `ADD_ITEM | CHANGE_QTY | REMOVE_ITEM | NOTE` — no substitute type),
  and adding one is an API change. **Not built here** — substitute stays a pre-dispatch-only tool;
  short/refuse is the at-delivery tool this plan adds.

### 2.3 Run settlement (P10-POS-9)

- Grepped API + web + mobile for `settlement`/`reconcile`/`cashCollected`/`RunSettlement` —
  **nothing exists.** No Prisma model, no endpoint, no UI, on any platform.
- No new backend endpoint fits this plan's `apps/mobile`-only gate, so the settlement sheet is
  built entirely from **already-existing, already-role-permitted endpoints**:
  - `PATCH /route-runs/:id` (`RouteRunsController#updateRun`, `@Roles(OPERATOR, DRIVER)`,
    `routes.service.ts:925`) already accepts `{notes?: string}` and a DRIVER caller is explicitly
    allowed to edit their own run's notes (only `driverId` reassignment is blocked for drivers).
    Mobile already has a matching hook: `apps/mobile/lib/api/routes.ts:369 useUpdateRun({id,
notes?, scheduledDate?})` — unused today, confirmed by grep.
  - `PATCH /route-runs/:id/status` (`useUpdateRunStatus`) is the existing run-completion call.
  - Neither the run nor any payment record is fetchable as a per-run aggregate from the server
    (no `GET /route-runs/:id/payments`), so "expected COD total" cannot be pulled from the server.
    **This plan tallies it client-side, locally, in-memory**, as each `completeWithPayment` call
    succeeds during the current run (mirrors `store/podStore.ts`'s existing non-persisted,
    in-memory-scratchpad pattern). This is an accepted, explicitly-documented limitation (a device
    restart or a second device on the same run under-counts) — the honest, minimal thing to build
    without inventing a new backend model. Flagged as a follow-up for a real
    `GET /route-runs/:id/payments` or `Settlement` model.
  - Persistence of the settlement (expected/counted/variance) reuses the existing `notes` field —
    append-only, mirroring the exact pattern `orders.service.ts` already uses for its own revert
    note (`(order.notes ?? "") + revertNote`). No schema change.

### 2.4 Drive mode (P10-POS-4) + owner-operator home (P10-POS-5)

This is **substantially already shipped**, in a different, undocumented form, with one concrete
navigation bug:

- `User.canActAsDriver: Boolean` already exists in the Prisma schema (line 639) and is already
  surfaced on mobile's `AuthUser` (`lib/auth.ts:41`).
- `apps/mobile/lib/auth-store.ts` already has exactly the "role = permissions; mode = layout"
  primitive the spec asks for: `activeRole: "driver" | "operator" | null` +
  `setActiveRole()`, and `apps/mobile/app/_layout.tsx:160-172` already redirects the whole
  navigator between the `(operator)` and `(driver)` route groups based on `activeRole`, with
  **no logout, no permission change** — this already satisfies "swaps to the field layout without
  logout." `(driver)/*` and `(operator)/*` are structurally separate navigators, so
  "admin-only areas hidden for pure drivers" is automatic once `activeRole` flips (server `@Roles`
  guards still enforce independently regardless of client `activeRole`).
- `apps/mobile/app/(operator)/(tabs)/home.tsx` **already has a working Operator/Driver mode
  switcher** (line 140-171, gated on `user?.canActAsDriver`) that renders an inline
  `DriverInlineView` (line 376) — a run card with stops/progress **above the operator's own KPIs
  when in driver mode** — this is **P10-POS-5's literal acceptance criterion, already built.**
- `apps/mobile/app/(driver)/driver-menu.tsx` already has a working "Switch role" row (line 64-76)
  that calls `setActiveRole("operator")` + navigates — proven working code, but it is
  **unconditional** (shown to every driver, even one whose actual JWT role is plain `DRIVER` with
  no operator permissions at all — tapping it would drop them into an operator shell their
  account has no real access to; server `@Roles` guards would then 403 every call).
- `apps/mobile/app/(auth)/role-picker.tsx` is a **fully-built, complete, but entirely orphaned**
  screen (grepped the whole app — zero navigations to `"role-picker"`). It duplicates the same
  choose-a-role UX. **Left alone in this plan** (not wired in, not deleted) — reusing it risks
  interaction with the `(auth)`-segment redirect logic in `_layout.tsx` that hasn't been verified
  here; the smaller, proven-safe fix (mirroring `driver-menu.tsx`'s already-working row) is lower
  risk. Noted as a candidate follow-up, not touched.
- **The one real bug:** `DriverInlineView`'s "Open stop" button (`home.tsx:438`) and its stop-list
  `StopCard` (`home.tsx:485`) both `router.push` straight into `/(driver)/route/stop/:id` **without
  calling `setActiveRole("driver")` first.** Since `_layout.tsx`'s redirect effect fires on every
  segment change and `activeRole` is still `"operator"` at that moment, tapping either button
  bounces the user straight back to `/(operator)/home` — a live, reproducible navigation bug in
  already-shipped code. **Fixed here** (WP2).
- **The missing piece** is a way to fully _enter_ Drive mode (not just preview it inline) from the
  Operator shell — `(operator)/(tabs)/more.tsx` has no such row. **Built here** (WP2), by mirroring
  `driver-menu.tsx`'s exact proven pattern in reverse.

## 3. Adjacent finding — flagged, NOT fixed here (out of scope)

While tracing the "collect payment" money path for WP3/WP4, found that
**driver-collected payments are never actually persisted to an invoice.**
`apps/api/src/routes/dto/complete-with-payment.dto.ts`'s `StopPaymentDto.invoiceId` is
**required** (`@IsString() invoiceId: string`, not optional), and
`routes.service.ts#completeWithPayment` (line 1408) looks the invoice up strictly by that
client-supplied id. But `apps/api/src/routes/routes.service.ts#findOneRun` (the query behind
mobile's `useRouteRun`, which `payment.tsx` reads `stop.orders[0].invoiceId` from) **never selects
an `invoiceId`** (its `orders.select` is `{id, orderNumber, status, urgent, notes, lineItems}`) —
and `Order` has **no `invoiceId` scalar field in the Prisma schema at all** (grepped
`schema.prisma`, zero hits). So `payment.tsx`'s `invoiceId && collected > 0 ? {invoiceId, amount,
method} : undefined` (line 152-155) is **always `undefined`** whenever there's an amount to
collect — meaning **every driver-collected cash/check payment silently never becomes an
`InvoicePayment` row**, even though the stop completes and the customer is told it succeeded. This
is a live, severe, pre-existing money-integrity bug, entirely outside credit-limit/short-pick/
settlement/drive-mode. **Not fixed in this plan** (real fix needs the server to resolve the
invoice by `orderId` — the one it just created/updated in the same transaction — instead of
trusting a client-supplied id; that's its own small PR). Flagged via `spawn_task` after this plan
is filed. It directly undermines WP4's "expected cash" tally being anything more than a
device-local memory aid — call this out honestly in WP4's UI copy, don't pretend otherwise.

## 4. New/changed files

| File                                                           | WP           | Change                                                                       |
| -------------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------- |
| `apps/mobile/lib/credit-limit-error.ts`                        | WP1          | NEW — pure `parseCreditLimitError`                                           |
| `apps/mobile/components/CreditLimitGuardModal.tsx`             | WP1          | NEW — 2-exit guard modal                                                     |
| `apps/mobile/app/(operator)/(tabs)/orders/[id]/edit-items.tsx` | WP1          | EDIT — wire the modal into `onError`                                         |
| `apps/mobile/app/(driver)/route/stop/[stopId]/adjust.tsx`      | WP1          | EDIT — wire the modal into `submitEntry`'s catch                             |
| `apps/mobile/__tests__/credit-limit-error.test.ts`             | WP1          | NEW                                                                          |
| `apps/mobile/app/(operator)/(tabs)/more.tsx`                   | WP2          | EDIT — add "Drive mode" row                                                  |
| `apps/mobile/app/(driver)/driver-menu.tsx`                     | WP2          | EDIT — gate "Switch role" to real operators only                             |
| `apps/mobile/app/(operator)/(tabs)/home.tsx`                   | WP2          | EDIT — fix `DriverInlineView` nav bug                                        |
| `apps/mobile/lib/pricing.ts`                                   | WP3          | EDIT — add `prorateLineSubtotal`                                             |
| `apps/mobile/lib/short-pick.ts`                                | WP3          | NEW — pure delivery-plan/reconciliation helpers                              |
| `apps/mobile/store/delivery-plan-store.ts`                     | WP3          | NEW — in-memory per-stop delivered-qty overrides                             |
| `apps/mobile/app/(driver)/route/stop/[stopId]/short-pick.tsx`  | WP3          | NEW — per-line delivered-qty review screen                                   |
| `apps/mobile/app/(driver)/route/stop/[stopId]/index.tsx`       | WP3          | EDIT — "Complete & collect" routes here first                                |
| `apps/mobile/app/(driver)/route/stop/[stopId]/payment.tsx`     | WP3 then WP4 | EDIT — reconciled deliveries/total; then settlement-recording hook           |
| `apps/mobile/__tests__/short-pick.test.ts`                     | WP3          | NEW                                                                          |
| `apps/mobile/lib/run-settlement.ts`                            | WP4          | NEW — pure summarize/variance/note helpers                                   |
| `apps/mobile/store/runSettlementStore.ts`                      | WP4          | NEW — in-memory per-run collected-payment tally                              |
| `apps/mobile/app/(driver)/route/settlement.tsx`                | WP4          | NEW — run settlement sheet                                                   |
| `apps/mobile/app/(driver)/route/index.tsx`                     | WP4          | EDIT — gate "Mark route complete" through settlement when cash was collected |
| `apps/mobile/__tests__/run-settlement.test.ts`                 | WP4          | NEW                                                                          |
| `.claude/code-map/mobile.md`, `.claude/code-map/_meta.json`    | WP5          | EDIT — surgical map update                                                   |

**Disjointness:** WP1 and WP2 touch fully separate files from everything else and from each other.
WP3 and WP4 **both edit `payment.tsx`** — implement WP3's edit first, WP4's settlement-recording
hook lands as a small addition on top of it (both hunks are called out precisely below so this is
safe to sequence, not parallelize, across those two WPs). WP3's other files (`short-pick.ts`,
`delivery-plan-store.ts`, `short-pick.tsx`, `index.tsx`) and WP4's other files (`run-settlement.ts`,
`runSettlementStore.ts`, `settlement.tsx`, `route/index.tsx`) are otherwise disjoint.

---

## 5. WP1 — Credit-limit guard (P10-POS-6)

### 5.1 `apps/mobile/lib/credit-limit-error.ts` (NEW)

```ts
/**
 * Detects the server's credit-limit block (409 CREDIT_LIMIT_EXCEEDED, thrown by
 * apps/api/src/orders/orders.service.ts#assertWithinCreditLimit) on the order-edit
 * (updateOrderItems) and at-door change-request-resolve (approveChangeRequestAtStop)
 * paths. Pure — no api-client import — unit-testable without RN. Mirrors the shape
 * of lib/authorizations-logic.ts#parseRegulatedAuthError.
 *
 * IMPORTANT: the server has NO bypass/override for this block anywhere (grepped
 * orders.service.ts, update-order-items.dto.ts, change-requests.service.ts — no
 * "creditOverride" field exists, no "flags account" field on Customer). Unlike the
 * regulated-license guard, there is no legal "sell anyway" exit — only "collect a
 * payment to reduce exposure" or "cancel this change." Do not add a client-side
 * override button; there is nothing server-side for it to call.
 */
export interface CreditLimitExceededInfo {
  /** The customer's configured credit_limit (server, Customer.creditLimit). */
  limit: number;
  /** What the customer's AR exposure would become if this change were saved. */
  exposure: number;
  /** Server's own sentence — render verbatim, never reconstruct from limit/exposure. */
  message: string;
}

export function parseCreditLimitError(err: unknown): CreditLimitExceededInfo | null {
  const res = (
    err as {
      response?: {
        status?: number;
        data?: { code?: string; limit?: number; exposure?: number; message?: string };
      };
    }
  )?.response;
  if (res?.status !== 409 || res.data?.code !== "CREDIT_LIMIT_EXCEEDED") return null;
  return {
    limit: Number(res.data.limit ?? 0),
    exposure: Number(res.data.exposure ?? 0),
    message: res.data.message ?? "This would exceed the customer's credit limit.",
  };
}
```

### 5.2 `apps/mobile/components/CreditLimitGuardModal.tsx` (NEW)

Structurally mirrors `components/LicenseGuardModal.tsx`'s overlay/card chrome, but simpler — no
multi-mode state machine, since there are only two exits and neither needs a form.

```tsx
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { ios } from "@routeflow/ui/tokens";
import type { CreditLimitExceededInfo } from "../lib/credit-limit-error";

interface Props {
  open: boolean;
  info: CreditLimitExceededInfo | null;
  /**
   * Operator-only: navigates to the customer's open invoices to collect a
   * payment. Omit on driver-facing screens — DRIVER has no invoices-list
   * access (apps/api/src/invoices/invoices.controller.ts is class-level
   * @Roles(OPERATOR)), so there is nowhere useful to send a driver. When
   * omitted, only "Cancel" renders.
   */
  onCollectPayment?: () => void;
  onCancel: () => void;
}

/**
 * Blocks a save that would exceed the customer's credit limit (409
 * CREDIT_LIMIT_EXCEEDED). Unlike LicenseGuardModal, there is NO "proceed
 * anyway" exit — the server has no override for this guard (see
 * lib/credit-limit-error.ts). The two legal exits are: go collect a payment
 * first (reduces exposure — the caller re-attempts Save manually after
 * returning, this modal does not auto-retry), or cancel this change. Numbers
 * shown are the server's own limit/exposure — never recomputed here.
 */
export function CreditLimitGuardModal({ open, info, onCollectPayment, onCancel }: Props) {
  if (!info) return null;
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={styles.header}>
            <Ionicons name="alert-circle-outline" size={20} color={ios.system.red} />
            <Text style={styles.title}>Credit limit exceeded</Text>
          </View>
          <Text style={styles.message}>{info.message}</Text>

          <View style={styles.statRow}>
            <View style={styles.stat}>
              <Text style={styles.statLabel}>LIMIT</Text>
              <Text style={styles.statValue}>${info.limit.toFixed(2)}</Text>
            </View>
            <View style={styles.stat}>
              <Text style={styles.statLabel}>WOULD BE</Text>
              <Text style={[styles.statValue, styles.statValueOver]}>
                ${info.exposure.toFixed(2)}
              </Text>
            </View>
          </View>

          <View style={styles.btns}>
            <Pressable style={styles.btnGhost} onPress={onCancel}>
              <Text style={styles.btnGhostText}>Cancel</Text>
            </Pressable>
            {onCollectPayment ? (
              <Pressable style={styles.btnFill} onPress={onCollectPayment}>
                <Text style={styles.btnFillText}>Collect payment</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "center", padding: 20 },
  card: { backgroundColor: ios.bgElev, borderRadius: 18, padding: 18, gap: 14 },
  header: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { fontSize: 17, fontFamily: "Inter_700Bold", color: ios.label },
  message: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label2, lineHeight: 20 },
  statRow: { flexDirection: "row", gap: 10 },
  stat: { flex: 1, backgroundColor: ios.fill3, borderRadius: 12, padding: 12 },
  statLabel: { fontSize: 10, fontFamily: "Inter_700Bold", color: ios.label2, letterSpacing: 0.6 },
  statValue: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    marginTop: 2,
    fontVariant: ["tabular-nums"],
  },
  statValueOver: { color: ios.system.red },
  btns: { flexDirection: "row", gap: 10, marginTop: 2 },
  btnGhost: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: ios.fill3,
    alignItems: "center",
  },
  btnGhostText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },
  btnFill: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: ios.brand,
    alignItems: "center",
  },
  btnFillText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: "#fff" },
});
```

### 5.3 `apps/mobile/app/(operator)/(tabs)/orders/[id]/edit-items.tsx` (EDIT)

Add imports (alongside the existing `LicenseGuardModal`/`parseRegulatedAuthError` imports at
lines 41-45):

```ts
import { CreditLimitGuardModal } from "../../../../../components/CreditLimitGuardModal";
import {
  parseCreditLimitError,
  type CreditLimitExceededInfo,
} from "../../../../../lib/credit-limit-error";
```

Add state next to the existing `licenseBlock` state (line 155):

```ts
const [creditBlock, setCreditBlock] = useState<CreditLimitExceededInfo | null>(null);
```

In `save()`'s `onError` (line 399-407), insert the credit check **before** the generic fallback:

```ts
onError: (e: any) => {
  // Regulated-sale block: open the guard, then replay the save on resolve.
  const blocked = parseRegulatedAuthError(e);
  if (blocked && blocked.length > 0) {
    setLicenseBlock(blocked);
    return;
  }
  // Credit-limit block: no server-side bypass exists (see lib/credit-limit-error.ts) —
  // surface it with the real numbers, never auto-retry.
  const creditInfo = parseCreditLimitError(e);
  if (creditInfo) {
    setCreditBlock(creditInfo);
    return;
  }
  showToast(e?.response?.data?.message ?? e?.message ?? "Try again.");
},
```

Render, next to the existing `<LicenseGuardModal .../>` (after line 473):

```tsx
<CreditLimitGuardModal
  open={!!creditBlock}
  info={creditBlock}
  onCollectPayment={() => {
    setCreditBlock(null);
    // router.push (not replace) — the edit screen stays on the stack, so the
    // operator's in-progress draft is intact when they come back and hit
    // Save again after recording the payment. No auto-retry: this screen
    // never re-sends the exact same request it just watched fail.
    router.push(`/(operator)/invoices?customerId=${customerId ?? ""}` as any);
  }}
  onCancel={() => setCreditBlock(null)}
/>
```

`customerId` (line 119, `(order as any)?.customerId`) and `router` (already imported via
`useRouter`) are both already in scope — no new derivations needed.

### 5.4 `apps/mobile/app/(driver)/route/stop/[stopId]/adjust.tsx` (EDIT)

Add imports (alongside the existing `parseRegulatedAuthError` import):

```ts
import { CreditLimitGuardModal } from "../../../../../components/CreditLimitGuardModal";
import {
  parseCreditLimitError,
  type CreditLimitExceededInfo,
} from "../../../../../lib/credit-limit-error";
```

Add state next to `licenseBlock` (line 101):

```ts
const [creditBlock, setCreditBlock] = useState<CreditLimitExceededInfo | null>(null);
```

In `submitEntry`'s catch block (lines 204-220), insert the credit check between the
`CHANGE_REQUEST_ALREADY_RESOLVED` branch and the generic fallback:

```ts
} catch (e: any) {
  const blocked = parseRegulatedAuthError(e);
  if (blocked && blocked.length > 0) {
    setLicenseBlock(blocked);
    return false;
  }
  const code = e?.response?.data?.code;
  if (code === "CHANGE_REQUEST_ALREADY_RESOLVED") {
    showToast("That line changed elsewhere — refreshed.");
    return true; // don't block the rest of the batch on a benign race
  }
  const creditInfo = parseCreditLimitError(e);
  if (creditInfo) {
    setCreditBlock(creditInfo);
    return false;
  }
  // LINE_ALREADY_DELIVERED / STOP_ALREADY_COMPLETED / CHANGE_WINDOW_CLOSED /
  // generic — surface the server message, stop the batch (never a partial
  // silent failure).
  showToast(e?.response?.data?.message ?? e?.message ?? "Couldn't save that change.");
  return false;
}
```

Render, next to the existing `<LicenseGuardModal .../>` (after line 418). **No
`onCollectPayment`** — DRIVER has no invoices-list route to send them to (see §5.2's doc comment):

```tsx
{
  /* Credit-limit guard — Cancel-only. Unlike the license guard there is no
    driver-safe "go fix this" destination (DRIVER can't reach /invoices), and
    no server override exists to record here. The driver's real recourse is
    simply not pushing this line further; office resolves it later. */
}
<CreditLimitGuardModal
  open={!!creditBlock}
  info={creditBlock}
  onCancel={() => {
    setCreditBlock(null);
    pendingRef.current = null;
  }}
/>;
```

### 5.5 `apps/mobile/__tests__/credit-limit-error.test.ts` (NEW)

```ts
import { parseCreditLimitError } from "../lib/credit-limit-error";

describe("parseCreditLimitError", () => {
  it("extracts limit/exposure/message from a 409 CREDIT_LIMIT_EXCEEDED", () => {
    const err = {
      response: {
        status: 409,
        data: {
          code: "CREDIT_LIMIT_EXCEEDED",
          message:
            "This edit would take the customer's exposure to 1200.00, over their credit limit of 1000.00.",
          limit: 1000,
          exposure: 1200,
        },
      },
    };
    expect(parseCreditLimitError(err)).toEqual({
      limit: 1000,
      exposure: 1200,
      message: err.response.data.message,
    });
  });

  it("returns null for a different 409 code", () => {
    const err = { response: { status: 409, data: { code: "REGULATED_AUTH_REQUIRED" } } };
    expect(parseCreditLimitError(err)).toBeNull();
  });

  it("returns null for a non-409 error", () => {
    expect(parseCreditLimitError({ response: { status: 500, data: {} } })).toBeNull();
  });

  it("returns null for a network error with no response", () => {
    expect(parseCreditLimitError(new Error("Network Error"))).toBeNull();
  });

  it("defaults a missing message", () => {
    const err = {
      response: { status: 409, data: { code: "CREDIT_LIMIT_EXCEEDED", limit: 500, exposure: 600 } },
    };
    expect(parseCreditLimitError(err)?.message).toBe(
      "This would exceed the customer's credit limit.",
    );
  });
});
```

### 5.6 WP1 acceptance criteria

- [ ] Editing an order past its credit limit (`edit-items.tsx`) shows the guard with the server's
      real limit/exposure numbers and message — not a bare toast.
- [ ] "Collect payment" navigates to the customer's invoice list; the edit draft is untouched on
      return (push, not replace); "Cancel" dismisses with no side effect.
- [ ] The at-door adjust screen (`adjust.tsx`) shows the same guard on a blocked change-request
      resolve, Cancel-only, and correctly aborts the remaining batch (mirrors the existing
      license-guard abort pattern via `pendingRef`).
- [ ] No "Proceed anyway" / override control exists anywhere in this guard — confirmed there is no
      server endpoint for it to call.
- [ ] `npx jest --selectProjects mobile __tests__/credit-limit-error.test.ts` passes.

---

## 6. WP2 — Drive mode toggle + owner-operator home fix (P10-POS-4, P10-POS-5)

### 6.1 `apps/mobile/app/(operator)/(tabs)/more.tsx` (EDIT)

Add `setActiveRole` to the existing store destructure (line 13):

```ts
const { user, logout, setActiveRole } = useAuthStore();
```

Insert a new row into the existing `ACCOUNT` `ListGroup` (after "Change password", before the
group closes at line 269):

```tsx
{
  user?.canActAsDriver ? (
    <ListRow
      icon={<Ionicons name="car-outline" size={16} color={ios.system.orangeInk} />}
      iconBg={ios.system.orangeWash}
      title="Drive mode"
      subtitle="Switch to the field layout"
      onPress={() => {
        setActiveRole("driver");
        router.replace("/(driver)/route");
      }}
      chevron
    />
  ) : null;
}
```

This mirrors `driver-menu.tsx`'s already-proven "Switch role" row exactly (same
`setActiveRole` + `router.replace` pattern), in reverse, gated on `canActAsDriver` so a pure
operator with no driver capability never sees it.

### 6.2 `apps/mobile/app/(driver)/driver-menu.tsx` (EDIT — bug fix)

The existing "Switch role" row (lines 64-76) is currently unconditional, shown even to a plain
`DRIVER`-role user with no operator permissions. Gate it on the user's real base role:

```tsx
{
  user?.role === "OPERATOR" || user?.role === "TENANT_ADMIN" ? (
    <ListRow
      icon={<Ionicons name="swap-horizontal-outline" size={16} color={ios.system.orangeInk} />}
      iconBg={ios.system.orangeWash}
      title="Switch role"
      subtitle="Go to operator view"
      onPress={() => {
        setActiveRole("operator");
        router.replace("/(operator)/home");
      }}
      chevron
    />
  ) : null;
}
```

(Same `ListRow` body as today — only the surrounding conditional is new. A user only ever reaches
`activeRole === "driver"` via `defaultRoleForUser` when their JWT role IS `DRIVER`, or via §6.1's
new toggle when their JWT role is `OPERATOR`/`TENANT_ADMIN` with `canActAsDriver` — so this
condition correctly distinguishes "an operator currently previewing Drive mode" from "an actual
driver with no operator permissions.")

### 6.3 `apps/mobile/app/(operator)/(tabs)/home.tsx` (EDIT — bug fix)

Inside `DriverInlineView` (starts line 376), add the store hook:

```ts
function DriverInlineView() {
  const router = useRouter();
  const setActiveRole = useAuthStore((s) => s.setActiveRole);
  const { data: activeData, isLoading: activeLoading } = useActiveRouteRun();
  // ...unchanged...
```

Fix both navigation points that push into `(driver)/*` without first flipping `activeRole` — the
root layout's redirect guard (`app/_layout.tsx:160-172`) otherwise bounces the user straight back
to `/(operator)/home` before the target screen ever renders:

At line 438 (the "UP NEXT" hero card's "Open stop" button):

```tsx
<Pressable
  style={[styles.heroBtnGhost, { flex: 1, alignItems: "center" }]}
  onPress={() => {
    setActiveRole("driver");
    router.push(`/(driver)/route/stop/${nextStop.id}` as any);
  }}
>
  <Text style={styles.heroBtnGhostText}>Open stop</Text>
</Pressable>
```

At line 485 (each `StopCard` in the stops list):

```tsx
onPress={() => {
  setActiveRole("driver");
  router.push(`/(driver)/route/stop/${stop.id}` as any);
}}
```

`useAuthStore` is already imported at the top of `home.tsx` (line 32) — only the new hook call
inside `DriverInlineView` and the two `onPress` bodies change.

### 6.4 WP2 acceptance criteria

- [ ] An operator with `canActAsDriver: true` sees a "Drive mode" row in More; tapping it flips
      `activeRole` to `"driver"` and lands on `/(driver)/route` — no logout, no permission change,
      cart/draft state untouched (nothing in `activeRole`'s flip path touches `cartStore`/
      `podStore`/any draft state).
- [ ] A plain `DRIVER`-role user (no operator permissions) no longer sees "Switch role" in
      `driver-menu.tsx`. An operator who switched into Drive mode still sees it and can switch back.
- [ ] From the operator Home tab's inline Driver mode-switcher, tapping "Open stop" or any stop
      card in the list now actually opens the stop (previously bounced back to `/(operator)/home`
      due to the `activeRole` mismatch) — this is P10-POS-5's run-card-above-KPIs feature, already
      built, now actually reachable.
- [ ] Admin-only operator screens remain unreachable from the `(driver)` navigator for a pure
      driver (structural — no new code needed, confirmed by the existing route-group split).

---

## 7. WP3 — At-delivery short/refuse reconciliation (P10-POS-7 delta)

### 7.1 `apps/mobile/lib/pricing.ts` (EDIT — add one exported pure function)

Insert directly after `computeLineSubtotal` (after line 108):

```ts
/**
 * Prorate an order line's STORED subtotal by delivered-vs-ordered qty.
 * Mirrors the server's per-batch invoice line total EXACTLY —
 * apps/api/src/orders/orders.service.ts:3321
 *   `subtotal = roundMoney((li.storedSubtotal * li.qty) / li.orderQty)`
 * — proportional-of-stored-subtotal, NOT a fresh qty×unitPrice recompute, so
 * boxed/overridden/promo lines prorate correctly. Returns 0 when there's no
 * stored subtotal yet or nothing was delivered.
 */
export function prorateLineSubtotal(
  storedSubtotal: number | null | undefined,
  deliveredQty: number,
  orderQty: number,
): number {
  if (storedSubtotal == null || orderQty <= 0 || deliveredQty <= 0) return 0;
  return roundMoney((storedSubtotal * deliveredQty) / orderQty);
}
```

### 7.2 `apps/mobile/lib/short-pick.ts` (NEW, pure logic)

```ts
/**
 * At-delivery short/refuse reconciliation. The server
 * (apps/api/src/orders/orders.service.ts:3095-3330, invoked from
 * routes.service.ts#completeStop/completeWithPayment) already fully supports
 * per-line PARTIAL/REFUSED delivery with correct proration — this module only
 * builds the client-side delivery plan + a matching ESTIMATED total; it never
 * invents new server behavior. Pure — no RN/api-client import — Jest-testable.
 */
import { prorateLineSubtotal, roundMoney } from "./pricing";

export type DeliveryType = "DELIVERED" | "PARTIAL" | "REFUSED";

export interface ShortPickLine {
  orderItemId: string;
  productId: string | null;
  /** The order line's original qty (piece-equivalent). */
  orderedQty: number;
  /** Stored line subtotal — the agreed money for the FULL ordered qty. */
  subtotal: number | null;
}

/** DELIVERED at the full ordered qty, REFUSED at 0, else PARTIAL. */
export function deliveryTypeForQty(deliveredQty: number, orderedQty: number): DeliveryType {
  if (deliveredQty <= 0) return "REFUSED";
  if (deliveredQty >= orderedQty) return "DELIVERED";
  return "PARTIAL";
}

export interface PlannedDelivery {
  orderItemId: string;
  productId: string;
  type: DeliveryType;
  qty: number;
}

/**
 * Build the `deliveries` array for useCompleteStop/useCompleteWithPayment.
 * `deliveredQtyById` holds only the lines the driver actually changed from
 * the default (full ordered qty) — matches the diff-only convention the rest
 * of the app uses (buildOrderItemDiff, buildAtDoorChangeRequests). Lines with
 * no productId are skipped defensively (order lines always have one by the
 * time they're deliverable).
 */
export function buildDeliveries(
  lines: ShortPickLine[],
  deliveredQtyById: Record<string, number>,
): PlannedDelivery[] {
  const out: PlannedDelivery[] = [];
  for (const li of lines) {
    if (!li.productId) continue;
    const raw = deliveredQtyById[li.orderItemId] ?? li.orderedQty;
    const clamped = Math.max(0, Math.min(raw, li.orderedQty));
    out.push({
      orderItemId: li.orderItemId,
      productId: li.productId,
      type: deliveryTypeForQty(clamped, li.orderedQty),
      qty: clamped,
    });
  }
  return out;
}

/**
 * The reconciled ESTIMATE shown on the payment screen — sum of each line's
 * stored subtotal prorated by delivered/ordered qty (server-exact formula,
 * see pricing.ts#prorateLineSubtotal). REFUSED lines contribute $0. Display
 * estimate only; the server computes the real invoice total independently
 * via the identical formula.
 */
export function reconciledTotal(
  lines: ShortPickLine[],
  deliveredQtyById: Record<string, number>,
): number {
  let sum = 0;
  for (const li of lines) {
    const raw = deliveredQtyById[li.orderItemId] ?? li.orderedQty;
    const clamped = Math.max(0, Math.min(raw, li.orderedQty));
    sum += prorateLineSubtotal(li.subtotal, clamped, li.orderedQty);
  }
  return roundMoney(sum);
}

/** True when every line is still at its default (fully delivered) qty. */
export function isFullyDelivered(
  lines: ShortPickLine[],
  deliveredQtyById: Record<string, number>,
): boolean {
  return lines.every((li) => (deliveredQtyById[li.orderItemId] ?? li.orderedQty) >= li.orderedQty);
}
```

### 7.3 `apps/mobile/store/delivery-plan-store.ts` (NEW)

```ts
import { create } from "zustand";

interface DeliveryPlanState {
  /** stopId -> { orderItemId -> delivered qty (piece-equivalent) }. Only touched lines are present. */
  plansByStop: Record<string, Record<string, number>>;
  setQty: (stopId: string, orderItemId: string, qty: number) => void;
  clearStop: (stopId: string) => void;
}

/**
 * In-memory (non-persisted, matches store/podStore.ts) scratchpad for the
 * short-pick screen's per-line delivered-qty overrides, handed off to
 * payment.tsx's closeStop(). Cleared once the stop is completed.
 */
export const useDeliveryPlanStore = create<DeliveryPlanState>((set) => ({
  plansByStop: {},
  setQty: (stopId, orderItemId, qty) =>
    set((s) => ({
      plansByStop: {
        ...s.plansByStop,
        [stopId]: { ...(s.plansByStop[stopId] ?? {}), [orderItemId]: qty },
      },
    })),
  clearStop: (stopId) =>
    set((s) => {
      const next = { ...s.plansByStop };
      delete next[stopId];
      return { plansByStop: next };
    }),
}));
```

### 7.4 `apps/mobile/app/(driver)/route/stop/[stopId]/short-pick.tsx` (NEW)

Structure mirrors the sibling `adjust.tsx` (same param resolution: `stopId` + optional `runId` →
`useActiveRouteRun`/`useRouteRun` → find the stop → `stop.orders[0]`), but reads the richer
`useOrder(orderId)` (from `lib/api/orders.ts`, already DRIVER-accessible — `GET /orders/:id` has
no `@Roles` decorator, confirmed by POS-A's own investigation) instead of the route-run's narrow
embedded `lineItems`, because only `useOrder` exposes `subtotal`/`deliveredQty` needed for correct
proration.

```tsx
import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavBackButton, NavBar } from "@routeflow/ui/mobile/ios";
import { useActiveRouteRun, useRouteRun } from "../../../../../lib/api/routes";
import { useOrder, type OrderItem } from "../../../../../lib/api/orders";
import { useDeliveryPlanStore } from "../../../../../store/delivery-plan-store";
import {
  buildDeliveries,
  reconciledTotal,
  deliveryTypeForQty,
  type ShortPickLine,
} from "../../../../../lib/short-pick";
import { sanitizeIntInput, parseIntQty } from "../../../../../lib/qty";

/**
 * Per-line "how much did you actually deliver" review, interposed between the
 * stop detail screen and payment.tsx. Defaults every line to the full ordered
 * qty (zero taps for the common fully-delivered case — never adds friction to
 * the happy path). Persists overrides into useDeliveryPlanStore for
 * payment.tsx to consume.
 */
export default function ShortPickScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ stopId: string; runId?: string }>();
  const stopId = params.stopId;

  const { data: activeData, isLoading: activeLoading } = useActiveRouteRun();
  const runId = params.runId ?? activeData?.data?.[0]?.id;
  const { data: run, isLoading: runLoading } = useRouteRun(runId ?? "");
  const stop = useMemo(() => run?.stops?.find((s) => s.id === stopId), [run, stopId]);
  const orderId = stop?.orders?.[0]?.id;
  const { data: order, isLoading: orderLoading } = useOrder(orderId ?? "");

  // Same adjustability gate as adjust.tsx: not cancelled, nothing already
  // delivered (a reopened, partially-completed stop shouldn't re-offer
  // already-settled lines).
  const lines: OrderItem[] = useMemo(
    () =>
      (order?.lineItems ?? []).filter(
        (li) => li.status !== "CANCELLED" && Number(li.deliveredQty ?? 0) === 0,
      ),
    [order],
  );

  const shortPickLines: ShortPickLine[] = useMemo(
    () =>
      lines.map((li) => ({
        orderItemId: li.id,
        productId: li.productId,
        orderedQty: Number(li.qty),
        subtotal: li.subtotal ?? null,
      })),
    [lines],
  );

  const [qtyById, setQtyById] = useState<Record<string, number>>({});
  const setPlanQty = useDeliveryPlanStore((s) => s.setQty);

  const total = useMemo(() => reconciledTotal(shortPickLines, qtyById), [shortPickLines, qtyById]);
  const orderedTotal = useMemo(() => reconciledTotal(shortPickLines, {}), [shortPickLines]);
  const anyShort = total < orderedTotal - 0.005;

  function handleContinue() {
    if (!stopId) return;
    for (const [orderItemId, qty] of Object.entries(qtyById)) {
      setPlanQty(stopId, orderItemId, qty);
    }
    router.push(`/route/stop/${stopId}/payment` as any);
  }

  if (activeLoading || runLoading || orderLoading) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar
          inlineTitle="Review delivery"
          leading={<NavBackButton label="Stop" onPress={() => router.back()} />}
        />
        <View style={styles.center}>
          <ActivityIndicator color={ios.brand} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Review delivery"
        leading={<NavBackButton label="Stop" onPress={() => router.back()} />}
      />
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 24 }}
      >
        <Text style={styles.hint}>
          Everything defaults to fully delivered. Only adjust a line if you're short or the customer
          refused it.
        </Text>
        {lines.map((li) => (
          <ShortPickRow
            key={li.id}
            li={li}
            qty={qtyById[li.id] ?? li.qty}
            onChangeQty={(q) => setQtyById((m) => ({ ...m, [li.id]: q }))}
          />
        ))}

        <View style={styles.totalBlock}>
          <Text style={styles.totalLabel}>
            EST. TOTAL{anyShort ? " (short — see office invoice for final)" : ""}
          </Text>
          <Text style={styles.totalValue}>${total.toFixed(2)}</Text>
        </View>

        <View style={{ paddingHorizontal: 16 }}>
          <Pressable style={styles.continueBtn} onPress={handleContinue}>
            <Text style={styles.continueBtnText}>Continue to payment</Text>
          </Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function ShortPickRow({
  li,
  qty,
  onChangeQty,
}: {
  li: OrderItem;
  qty: number;
  onChangeQty: (qty: number) => void;
}) {
  const ordered = Number(li.qty);
  const type = deliveryTypeForQty(qty, ordered);
  const [draft, setDraft] = useState(String(qty));

  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.cardName} numberOfLines={2}>
            {li.product?.name ?? li.name ?? "Item"}
          </Text>
          <Text style={styles.cardMeta}>Ordered {ordered}</Text>
        </View>
        {type !== "DELIVERED" ? (
          <View
            style={[styles.badge, type === "REFUSED" ? styles.badgeRefused : styles.badgeShort]}
          >
            <Text style={styles.badgeText}>{type === "REFUSED" ? "Refused" : "Short"}</Text>
          </View>
        ) : null}
      </View>
      <View style={styles.stepperRow}>
        <Text style={styles.stepperLabel}>Delivered</Text>
        <View style={styles.stepper}>
          <Pressable
            style={styles.stepBtn}
            onPress={() => {
              const n = Math.max(0, qty - 1);
              onChangeQty(n);
              setDraft(String(n));
            }}
            hitSlop={6}
          >
            <Text style={styles.stepText}>−</Text>
          </Pressable>
          <TextInput
            style={styles.qtyInput}
            value={draft}
            onChangeText={(txt) => {
              const clean = sanitizeIntInput(txt);
              setDraft(clean);
              if (clean === "") return;
              onChangeQty(Math.min(ordered, parseIntQty(clean, qty)));
            }}
            onBlur={() => setDraft(String(qty))}
            keyboardType="number-pad"
            returnKeyType="done"
            maxLength={5}
            selectTextOnFocus
          />
          <Pressable
            style={styles.stepBtn}
            onPress={() => {
              const n = Math.min(ordered, qty + 1);
              onChangeQty(n);
              setDraft(String(n));
            }}
            hitSlop={6}
          >
            <Text style={styles.stepText}>+</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  hint: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    marginHorizontal: 16,
    marginTop: 12,
    lineHeight: 18,
  },
  card: {
    marginHorizontal: 16,
    marginTop: 10,
    backgroundColor: ios.bgElev,
    borderRadius: 14,
    padding: 14,
    gap: 10,
  },
  cardHeader: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  cardName: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },
  cardMeta: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  badge: { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 },
  badgeShort: { backgroundColor: "#FEF3C7" },
  badgeRefused: { backgroundColor: "#FEE2E2" },
  badgeText: { fontSize: 11, fontFamily: "Inter_700Bold", color: ios.label },
  stepperRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  stepperLabel: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.label2 },
  stepper: { flexDirection: "row", alignItems: "center" },
  stepBtn: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: ios.fill3,
    alignItems: "center",
    justifyContent: "center",
  },
  stepText: { fontSize: 18, fontFamily: "Inter_600SemiBold", color: ios.label },
  qtyInput: {
    minWidth: 40,
    textAlign: "center",
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
    paddingHorizontal: 6,
  },
  totalBlock: {
    marginHorizontal: 16,
    marginTop: 18,
    marginBottom: 12,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
  },
  totalLabel: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    letterSpacing: 0.6,
  },
  totalValue: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  continueBtn: {
    backgroundColor: ios.system.green,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: "center",
  },
  continueBtnText: { color: "#fff", fontSize: 17, fontFamily: "Inter_600SemiBold" },
});
```

Add `TextInput` to the `react-native` import line at the top (`ActivityIndicator, Pressable,
ScrollView, StyleSheet, Text, TextInput, View`).

No `_layout.tsx` edit needed — `route/stop/[stopId]/_layout.tsx` is a bare `<Stack>` that
auto-registers every sibling file (same as `adjust.tsx`/`new-order.tsx`).

### 7.5 `apps/mobile/app/(driver)/route/stop/[stopId]/index.tsx` (EDIT)

Change the green "Complete & collect →" button (line 368-373) to route through the review screen
first instead of straight to payment:

```tsx
<Pressable style={styles.greenBtn} onPress={() => router.push(`/route/stop/${stopId}/short-pick`)}>
  <Text style={styles.greenBtnText}>Complete & collect →</Text>
</Pressable>
```

(Only the `onPress` target changes, from `.../payment` to `.../short-pick`; label and styling stay
identical — the driver's tap target and expectation don't change.)

### 7.6 `apps/mobile/app/(driver)/route/stop/[stopId]/payment.tsx` (EDIT)

Add imports:

```ts
import { useOrder } from "../../../../../lib/api/orders";
import { useDeliveryPlanStore } from "../../../../../store/delivery-plan-store";
import {
  buildDeliveries,
  reconciledTotal,
  type ShortPickLine,
} from "../../../../../lib/short-pick";
```

After the existing `stop`/`invoiceLabel` derivation (around line 62-67), replace the
`totalForStop`-based total with the reconciled one, sourced from `useOrder` (so short-pick.tsx and
payment.tsx compute from the identical data and always agree):

```tsx
const orderId = stop?.orders?.[0]?.id;
const { data: order } = useOrder(orderId ?? "");
const deliveredQtyById = useDeliveryPlanStore((s) => (stopId ? (s.plansByStop[stopId] ?? {}) : {}));
const clearPlan = useDeliveryPlanStore((s) => s.clearStop);

const shortPickLines: ShortPickLine[] = useMemo(
  () =>
    (order?.lineItems ?? [])
      .filter((li) => li.status !== "CANCELLED" && Number(li.deliveredQty ?? 0) === 0)
      .map((li) => ({
        orderItemId: li.id,
        productId: li.productId,
        orderedQty: Number(li.qty),
        subtotal: li.subtotal ?? null,
      })),
  [order],
);

// Reconciled (post-short-pick) total when the richer order has loaded; falls
// back to the old full-order total only for the brief window before `order`
// resolves, so the screen never flashes $0.00.
const invoiceTotal =
  shortPickLines.length > 0
    ? reconciledTotal(shortPickLines, deliveredQtyById)
    : totalForStop(stop!);
```

(`totalForStop` — the pre-existing raw `qty * unitPrice` helper at the top of the file — is left
in place ONLY as this brief-loading-window fallback; it is a known, pre-existing, narrower
approximation for boxed lines, out of scope to fully fix here since `RouteRunOrderItem`
[`lib/api/routes.ts`] doesn't carry `unitsPerBox`/`boxes`/`pieces` at all. Once `order` loads, the
screen always uses the correct `reconciledTotal` path.)

Remove the old `const invoiceTotal = stop ? totalForStop(stop) : 0;` line (it's superseded by the
block above — the `stop ? ... : 0` guard becomes part of the ternary's fallback branch instead).

In `closeStop()` (lines 84-161), replace the `deliveries` construction (lines 97-104):

```ts
const deliveries =
  shortPickLines.length > 0
    ? buildDeliveries(shortPickLines, deliveredQtyById).map((d) => ({
        orderItemId: d.orderItemId,
        productId: d.productId,
        type: d.type,
        quantityDelivered: d.qty,
      }))
    : (stop.orders ?? []).flatMap((o) =>
        (o.lineItems ?? []).map((li) => ({
          orderItemId: li.id,
          productId: li.productId,
          type: "DELIVERED" as const,
          quantityDelivered: Math.round(Number(li.qty ?? 0)),
        })),
      );
```

After the successful completion (`clearPod(stopId);` at line 163), add the plan cleanup — this
hunk is WP3's; WP4 adds one more line directly below it (§8.4):

```ts
clearPod(stopId);
if (stopId) clearPlan(stopId);
showToast("Stop completed");
```

### 7.7 `apps/mobile/__tests__/short-pick.test.ts` (NEW)

```ts
import {
  deliveryTypeForQty,
  buildDeliveries,
  reconciledTotal,
  isFullyDelivered,
} from "../lib/short-pick";

const lines = [
  { orderItemId: "li-1", productId: "p-1", orderedQty: 10, subtotal: 100 }, // $10/unit
  { orderItemId: "li-2", productId: "p-2", orderedQty: 2, subtotal: 60 }, // $30/unit
];

describe("deliveryTypeForQty", () => {
  it("classifies full/partial/refused", () => {
    expect(deliveryTypeForQty(10, 10)).toBe("DELIVERED");
    expect(deliveryTypeForQty(6, 10)).toBe("PARTIAL");
    expect(deliveryTypeForQty(0, 10)).toBe("REFUSED");
  });
});

describe("buildDeliveries", () => {
  it("defaults untouched lines to the full ordered qty, DELIVERED", () => {
    expect(buildDeliveries(lines, {})).toEqual([
      { orderItemId: "li-1", productId: "p-1", type: "DELIVERED", qty: 10 },
      { orderItemId: "li-2", productId: "p-2", type: "DELIVERED", qty: 2 },
    ]);
  });

  it("marks a short line PARTIAL at the reduced qty", () => {
    const out = buildDeliveries(lines, { "li-1": 7 });
    expect(out[0]).toEqual({ orderItemId: "li-1", productId: "p-1", type: "PARTIAL", qty: 7 });
  });

  it("marks a zeroed line REFUSED", () => {
    const out = buildDeliveries(lines, { "li-2": 0 });
    expect(out[1]).toEqual({ orderItemId: "li-2", productId: "p-2", type: "REFUSED", qty: 0 });
  });

  it("clamps an out-of-range override to the ordered qty", () => {
    const out = buildDeliveries(lines, { "li-1": 999 });
    expect(out[0]!.qty).toBe(10);
    expect(out[0]!.type).toBe("DELIVERED");
  });
});

describe("reconciledTotal", () => {
  it("sums the full order when nothing is short (cent-parity with subtotal sum)", () => {
    expect(reconciledTotal(lines, {})).toBe(160);
  });

  it("prorates a short line by the SERVER's formula (subtotal * delivered / ordered)", () => {
    // li-1: 100 * 7/10 = 70; li-2 unchanged: 60. Total 130.
    expect(reconciledTotal(lines, { "li-1": 7 })).toBe(130);
  });

  it("a refused line contributes $0", () => {
    expect(reconciledTotal(lines, { "li-2": 0 })).toBe(100);
  });

  it("cent-parity for a boxed line's stored subtotal (not a fresh qty*unitPrice)", () => {
    // A boxed line's unitPrice is the BOX price; stored subtotal already accounts
    // for that. Delivering 1 of 2 boxes (qty 12 of 24 pieces) must prorate the
    // STORED subtotal, never recompute qty*unitPrice against the box unitPrice.
    const boxed = [{ orderItemId: "li-3", productId: "p-3", orderedQty: 24, subtotal: 48 }];
    expect(reconciledTotal(boxed, { "li-3": 12 })).toBe(24);
  });
});

describe("isFullyDelivered", () => {
  it("true when no overrides are present", () => {
    expect(isFullyDelivered(lines, {})).toBe(true);
  });
  it("false once any line is reduced", () => {
    expect(isFullyDelivered(lines, { "li-1": 5 })).toBe(false);
  });
});
```

### 7.8 WP3 acceptance criteria

- [ ] The stop's "Complete & collect →" button now opens a "Review delivery" screen first, with
      every line defaulted to fully delivered (zero taps needed for the common case).
- [ ] Reducing a line's delivered qty visibly tags it Short (or Refused at 0); the EST. TOTAL
      recomputes live using the server's own proration formula
      (`storedSubtotal * delivered / ordered`), never a fresh `qty × unitPrice`.
- [ ] "Continue to payment" carries the adjusted amounts to `payment.tsx`, which now charges the
      RECONCILED total, not the full order total, and sends a `deliveries` array with the correct
      per-line `PARTIAL`/`REFUSED`/`DELIVERED` types — reusing the server's existing, already-correct
      handling (no API change).
- [ ] Skipping the review screen entirely (e.g. a stale deep link straight to `payment.tsx`) still
      works exactly as before — falls back to full-qty/DELIVERED for every line.
- [ ] `npx jest --selectProjects mobile __tests__/short-pick.test.ts` passes.

---

## 8. WP4 — Run settlement (P10-POS-9)

### 8.1 `apps/mobile/lib/run-settlement.ts` (NEW, pure logic)

```ts
/**
 * Run-end cash/check reconciliation. No backend model exists for this (see
 * plan §2.3) — this is a DEVICE-LOCAL tally of what THIS device recorded
 * during THIS run session, persisted only as an appended note on the run via
 * the existing PATCH /route-runs/:id (notes) — same append pattern
 * orders.service.ts already uses for its own edit-revert note. Pure — no RN
 * import — Jest-testable.
 */
import { roundMoney } from "./pricing";

export type CollectedMethod = "CASH" | "CHECK" | "CREDIT_CARD" | "ADVANCE" | "OTHER";

export interface CollectionEntry {
  stopId: string;
  method: CollectedMethod;
  /** Already-final, server-accepted collected amount for that stop. */
  amount: number;
  collectedAt: number; // epoch ms
}

export interface SettlementSummary {
  byMethod: Partial<Record<CollectedMethod, number>>;
  /** CASH + CHECK — the physical money a driver must reconcile at end of run. */
  cashTotal: number;
  /** All methods, informational only. */
  total: number;
  count: number;
}

/**
 * Summarize a run's locally-recorded collections. Each entry.amount is
 * already a final, server-accepted number (the same `collected` value
 * payment.tsx sent to completeWithPayment) — this only SUMS already-final
 * amounts for display, it never re-derives a line price.
 */
export function summarizeCollections(entries: CollectionEntry[]): SettlementSummary {
  const byMethod: Partial<Record<CollectedMethod, number>> = {};
  for (const e of entries) {
    byMethod[e.method] = roundMoney((byMethod[e.method] ?? 0) + e.amount);
  }
  const cashTotal = roundMoney((byMethod.CASH ?? 0) + (byMethod.CHECK ?? 0));
  const total = roundMoney(entries.reduce((s, e) => s + e.amount, 0));
  return { byMethod, cashTotal, total, count: entries.length };
}

/** counted - expected, cents-rounded. Positive = over, negative = short. */
export function computeVariance(expectedCash: number, countedCash: number): number {
  return roundMoney(countedCash - expectedCash);
}

/** Matches the acceptance criteria's "±$0.01" tolerance. */
export function isReconciled(variance: number): boolean {
  return Math.abs(variance) <= 0.01;
}

/**
 * Structured line appended to RouteRun.notes — the only persistence
 * primitive available without a new API endpoint (PATCH /route-runs/:id
 * already accepts {notes}, DRIVER-callable for their own run).
 */
export function buildSettlementNote(args: {
  expectedCash: number;
  countedCash: number;
  variance: number;
  overridden: boolean;
  driverLabel: string;
  when?: Date;
}): string {
  const { expectedCash, countedCash, variance, overridden, driverLabel, when = new Date() } = args;
  const status = isReconciled(variance) ? "reconciled" : overridden ? "override" : "variance";
  const sign = variance > 0 ? "+" : "";
  const stamp = `${when.toLocaleDateString()} ${when.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
  return (
    `\n[${stamp} – Settlement: expected $${expectedCash.toFixed(2)}, ` +
    `counted $${countedCash.toFixed(2)}, variance ${sign}$${variance.toFixed(2)} ` +
    `(${status}) — ${driverLabel}]`
  );
}
```

### 8.2 `apps/mobile/store/runSettlementStore.ts` (NEW)

```ts
import { create } from "zustand";
import type { CollectionEntry } from "../lib/run-settlement";

interface RunSettlementState {
  collectionsByRun: Record<string, CollectionEntry[]>;
  recordCollection: (runId: string, entry: CollectionEntry) => void;
  clearRun: (runId: string) => void;
}

/**
 * In-memory (non-persisted, matches store/podStore.ts) local tally of cash/
 * check collected during the CURRENT run session. This is a DEVICE-LOCAL
 * record, not a server aggregate — no backend endpoint exists to fetch "all
 * payments for run X" independent of what THIS device recorded (see plan
 * §2.3 and the adjacent §3 finding: driver payments don't even reliably
 * persist server-side today), so an app kill mid-run or a second device on
 * the same run will under-count. Accepted, documented limitation for a
 * mobile-only, additive-only increment.
 */
export const useRunSettlementStore = create<RunSettlementState>((set) => ({
  collectionsByRun: {},
  recordCollection: (runId, entry) =>
    set((s) => ({
      collectionsByRun: {
        ...s.collectionsByRun,
        [runId]: [...(s.collectionsByRun[runId] ?? []), entry],
      },
    })),
  clearRun: (runId) =>
    set((s) => {
      const next = { ...s.collectionsByRun };
      delete next[runId];
      return { collectionsByRun: next };
    }),
}));
```

### 8.3 `apps/mobile/app/(driver)/route/settlement.tsx` (NEW)

```tsx
import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavBackButton, NavBar } from "@routeflow/ui/mobile/ios";
import { useRouteRun, useUpdateRun, useUpdateRunStatus } from "../../../lib/api/routes";
import { useAuthStore } from "../../../lib/auth-store";
import { useRunSettlementStore } from "../../../store/runSettlementStore";
import {
  summarizeCollections,
  computeVariance,
  isReconciled,
  buildSettlementNote,
  type CollectedMethod,
} from "../../../lib/run-settlement";
import { showToast } from "../../../lib/toast";

function methodLabel(m: CollectedMethod): string {
  if (m === "CASH") return "Cash";
  if (m === "CHECK") return "Check";
  if (m === "CREDIT_CARD") return "Card";
  if (m === "ADVANCE") return "On account";
  return "Other";
}

/**
 * End-of-run cash/check reconciliation (P10-POS-9). Reached from
 * route/index.tsx's "Mark route complete" ONLY when this device recorded at
 * least one cash/check collection this run — a run with nothing physical to
 * reconcile completes directly, unchanged (never adds friction for no reason).
 */
export default function RunSettlementScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ runId: string }>();
  const runId = params.runId;
  const { data: run, isLoading } = useRouteRun(runId ?? "");
  const user = useAuthStore((s) => s.user);

  const collections = useRunSettlementStore((s) =>
    runId ? (s.collectionsByRun[runId] ?? []) : [],
  );
  const clearRun = useRunSettlementStore((s) => s.clearRun);
  const summary = useMemo(() => summarizeCollections(collections), [collections]);

  const [counted, setCounted] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const countedNum = Number(counted) || 0;
  const variance = computeVariance(summary.cashTotal, countedNum);
  const reconciled = counted !== "" && isReconciled(variance);
  const needsReason = counted !== "" && !isReconciled(variance);

  const updateRun = useUpdateRun();
  const updateStatus = useUpdateRunStatus();

  async function closeRun() {
    if (!runId || !run) return;
    if (counted === "") {
      setError("Enter the cash & checks you counted.");
      return;
    }
    if (needsReason && reason.trim() === "") {
      setError("Enter a reason for the variance before closing.");
      return;
    }
    setError(null);
    setSaving(true);
    const driverLabel = user?.username ?? "Driver";
    const note =
      buildSettlementNote({
        expectedCash: summary.cashTotal,
        countedCash: countedNum,
        variance,
        overridden: needsReason,
        driverLabel,
      }) + (needsReason ? ` Reason: ${reason.trim()}` : "");
    try {
      await updateRun.mutateAsync({ id: runId, notes: (run.notes ?? "") + note } as any);
      await updateStatus.mutateAsync({ id: runId, status: "COMPLETED" });
      clearRun(runId);
      router.replace("/(driver)/route");
    } catch (e: any) {
      setSaving(false);
      showToast(e?.response?.data?.message ?? e?.message ?? "Couldn't close the run. Try again.");
    }
  }

  if (isLoading || !run) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar
          inlineTitle="Run settlement"
          leading={<NavBackButton label="Route" onPress={() => router.back()} />}
        />
        <View style={styles.center}>
          <ActivityIndicator color={ios.brand} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Run settlement"
        leading={<NavBackButton label="Route" onPress={() => router.back()} />}
      />
      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.caption}>
          Collected on this device during this run — {summary.count} payment
          {summary.count === 1 ? "" : "s"}.
        </Text>

        <View style={styles.card}>
          {(["CASH", "CHECK", "CREDIT_CARD", "ADVANCE", "OTHER"] as const)
            .filter((m) => summary.byMethod[m])
            .map((m) => (
              <View key={m} style={styles.row}>
                <Text style={styles.rowLabel}>{methodLabel(m)}</Text>
                <Text style={styles.rowValue}>${(summary.byMethod[m] ?? 0).toFixed(2)}</Text>
              </View>
            ))}
          <View style={[styles.row, styles.rowTotal]}>
            <Text style={styles.rowTotalLabel}>Cash & checks to reconcile</Text>
            <Text style={styles.rowTotalValue}>${summary.cashTotal.toFixed(2)}</Text>
          </View>
        </View>

        <Text style={styles.fieldLabel}>Counted cash & checks</Text>
        <TextInput
          style={styles.input}
          placeholder="0.00"
          placeholderTextColor={ios.label3}
          keyboardType="decimal-pad"
          value={counted}
          onChangeText={setCounted}
        />

        {counted !== "" ? (
          <View style={[styles.varianceBox, reconciled ? styles.varianceOk : styles.varianceOff]}>
            <Text style={styles.varianceText}>
              {reconciled
                ? "Reconciled"
                : `Variance ${variance > 0 ? "+" : ""}$${variance.toFixed(2)}`}
            </Text>
          </View>
        ) : null}

        {needsReason ? (
          <>
            <Text style={styles.fieldLabel}>Reason for the variance</Text>
            <TextInput
              style={[styles.input, styles.inputMultiline]}
              placeholder="e.g. gave $5 change from my own pocket"
              placeholderTextColor={ios.label3}
              value={reason}
              onChangeText={setReason}
              multiline
            />
          </>
        ) : null}

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <Pressable
          style={[styles.closeBtn, saving && styles.closeBtnDisabled]}
          onPress={saving ? undefined : closeRun}
          disabled={saving}
        >
          <Text style={styles.closeBtnText}>{saving ? "Closing…" : "Close run"}</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  caption: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginBottom: 10 },
  card: { backgroundColor: ios.bgElev, borderRadius: 14, padding: 14, gap: 8, marginBottom: 18 },
  row: { flexDirection: "row", justifyContent: "space-between" },
  rowLabel: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.label2 },
  rowValue: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  rowTotal: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
    paddingTop: 8,
    marginTop: 4,
  },
  rowTotalLabel: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: ios.label },
  rowTotalValue: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  fieldLabel: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: ios.label2, marginBottom: 6 },
  input: {
    backgroundColor: ios.fill3,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    marginBottom: 14,
  },
  inputMultiline: {
    minHeight: 70,
    textAlignVertical: "top",
    fontFamily: "Inter_400Regular",
    fontSize: 14,
  },
  varianceBox: { borderRadius: 10, padding: 10, marginBottom: 14, alignItems: "center" },
  varianceOk: { backgroundColor: ios.system.greenWash },
  varianceOff: { backgroundColor: "#FEE2E2" },
  varianceText: { fontSize: 14, fontFamily: "Inter_700Bold", color: ios.label },
  error: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.system.red, marginBottom: 10 },
  closeBtn: {
    backgroundColor: ios.system.green,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: "center",
  },
  closeBtnDisabled: { opacity: 0.55 },
  closeBtnText: { color: "#fff", fontSize: 17, fontFamily: "Inter_600SemiBold" },
});
```

No `_layout.tsx` edit needed — `route/_layout.tsx` is a bare `<Stack>`.

### 8.4 `apps/mobile/app/(driver)/route/stop/[stopId]/payment.tsx` (EDIT — second hunk, on top of §7.6)

Add the settlement-recording hook right after §7.6's `clearPlan(stopId)` line, still inside
`closeStop()`, after the `completeWithPaymentMut.mutateAsync(...)` call succeeds:

```ts
import { useRunSettlementStore } from "../../../../../store/runSettlementStore";
```

```ts
clearPod(stopId);
if (stopId) clearPlan(stopId);
if (collected > 0 && runId) {
  useRunSettlementStore.getState().recordCollection(runId, {
    stopId,
    method: apiMethod,
    amount: collected,
    collectedAt: Date.now(),
  });
}
showToast("Stop completed");
```

(`collected` and `apiMethod` are already computed earlier in `closeStop()`, lines 129-135 — no new
derivation needed. Using `.getState().recordCollection(...)` directly, not the `useRunSettlementStore`
hook form, since this is an imperative call inside an event handler, not a render — same pattern
already used for `usePodStore`'s `clearPod`/`setRegulated` calls elsewhere in this file's sibling
screens.)

### 8.5 `apps/mobile/app/(driver)/route/index.tsx` (EDIT)

Add the import:

```ts
import { useRunSettlementStore } from "../../../store/runSettlementStore";
```

Inside `TodaysRoute` (line 223), add a local `router` (not currently present in this component —
`useRouter` is already imported at the top of the file for `NoRoute`) and read the settlement
store:

```ts
function TodaysRoute({ run, onOpenStop }: { run: RouteRun; onOpenStop: (id: string) => void }) {
  const router = useRouter();
  const stops = run.stops ?? [];
  const optimize = useOptimizeRouteRun();
  const updateStatus = useUpdateRunStatus();
  const collections = useRunSettlementStore((s) => s.collectionsByRun[run.id] ?? []);
  const hasCashToReconcile = collections.some((c) => c.method === "CASH" || c.method === "CHECK");
  // ...unchanged...
```

Change the "Mark route complete" button's `onPress` (lines 304-321) to route through settlement
first when there's something to reconcile — a run with no cash/check collections skips it
entirely and completes exactly as before:

```tsx
<Pressable
  style={[styles.heroBtnGhost, { alignSelf: "stretch", justifyContent: "center" }]}
  disabled={updateStatus.isPending}
  onPress={() => {
    if (hasCashToReconcile) {
      router.push(`/(driver)/route/settlement?runId=${run.id}` as any);
      return;
    }
    confirm(
      "Complete route?",
      "This will mark the run as finished and lock all stops.",
      () =>
        updateStatus.mutate(
          { id: run.id, status: "COMPLETED" },
          {
            onError: (e: any) => showToast(e?.response?.data?.message ?? e.message ?? "Try again."),
          },
        ),
      { confirmText: "Complete" },
    );
  }}
>
  <Text style={styles.heroBtnGhostText}>
    {updateStatus.isPending ? "Completing…" : "Mark route complete"}
  </Text>
</Pressable>
```

### 8.6 `apps/mobile/__tests__/run-settlement.test.ts` (NEW)

```ts
import {
  summarizeCollections,
  computeVariance,
  isReconciled,
  buildSettlementNote,
} from "../lib/run-settlement";

const entries = [
  { stopId: "s1", method: "CASH" as const, amount: 40, collectedAt: 1 },
  { stopId: "s2", method: "CASH" as const, amount: 25.5, collectedAt: 2 },
  { stopId: "s3", method: "CHECK" as const, amount: 100, collectedAt: 3 },
  { stopId: "s4", method: "CREDIT_CARD" as const, amount: 60, collectedAt: 4 },
];

describe("summarizeCollections", () => {
  it("groups by method and sums cash+check separately from card", () => {
    const s = summarizeCollections(entries);
    expect(s.byMethod.CASH).toBe(65.5);
    expect(s.byMethod.CHECK).toBe(100);
    expect(s.byMethod.CREDIT_CARD).toBe(60);
    expect(s.cashTotal).toBe(165.5);
    expect(s.total).toBe(225.5);
    expect(s.count).toBe(4);
  });

  it("handles an empty run", () => {
    expect(summarizeCollections([])).toEqual({ byMethod: {}, cashTotal: 0, total: 0, count: 0 });
  });
});

describe("computeVariance / isReconciled", () => {
  it("is reconciled at exact match", () => {
    expect(computeVariance(100, 100)).toBe(0);
    expect(isReconciled(computeVariance(100, 100))).toBe(true);
  });

  it("flags an over/short variance beyond a penny", () => {
    expect(computeVariance(100, 95)).toBe(-5);
    expect(isReconciled(-5)).toBe(false);
    expect(computeVariance(100, 105.5)).toBe(5.5);
  });

  it("tolerates a sub-penny rounding difference", () => {
    expect(isReconciled(computeVariance(100.005, 100))).toBe(true);
  });
});

describe("buildSettlementNote", () => {
  it("includes the status and both numbers, reconciled case", () => {
    const note = buildSettlementNote({
      expectedCash: 100,
      countedCash: 100,
      variance: 0,
      overridden: false,
      driverLabel: "J. Diaz",
      when: new Date("2026-07-14T18:30:00"),
    });
    expect(note).toContain("expected $100.00");
    expect(note).toContain("counted $100.00");
    expect(note).toContain("variance +$0.00");
    expect(note).toContain("(reconciled)");
    expect(note).toContain("J. Diaz");
  });

  it("marks an overridden variance", () => {
    const note = buildSettlementNote({
      expectedCash: 100,
      countedCash: 90,
      variance: -10,
      overridden: true,
      driverLabel: "J. Diaz",
    });
    expect(note).toContain("variance -$10.00");
    expect(note).toContain("(override)");
  });
});
```

### 8.7 WP4 acceptance criteria

- [ ] A run with no cash/check collections completes exactly as before — no new screen, no added
      friction.
- [ ] A run with at least one cash/check collection routes "Mark route complete" through the
      settlement sheet, which shows the device-local collected breakdown by method and the
      cash+check total to reconcile.
- [ ] Entering a counted amount within a penny of expected shows "Reconciled" and closes with one
      tap; a mismatch requires a typed reason before "Close run" is allowed (closes ONLY once
      reconciled or a reason is given — matches "close blocked until reconciled/overridden").
- [ ] Closing the run appends a structured settlement note to `RouteRun.notes` (via the existing
      `useUpdateRun`) and then marks the run `COMPLETED` (via the existing `useUpdateRunStatus`);
      the local tally for that run is cleared after a successful close, kept on failure so the
      driver can retry without re-entering anything.
- [ ] `npx jest --selectProjects mobile __tests__/run-settlement.test.ts` passes.

---

## 9. WP5 — Code-map update (apply after implementation, surgical — not a regen)

`.claude/code-map/mobile.md`:

- Add a "Where to find" row: **Credit-limit guard (P10-POS-6)** →
  `lib/credit-limit-error.ts` (`parseCreditLimitError` — no server bypass exists, 2-exit modal
  only) + `components/CreditLimitGuardModal.tsx`, wired into `edit-items.tsx`'s `onError` and
  POS-A's `adjust.tsx` `submitEntry` catch (driver screen omits the Collect-payment exit — no
  invoices-list access).
- Add a row: **Drive mode toggle (P10-POS-4/5)** → `(operator)/(tabs)/more.tsx`'s "Drive mode" row
  (`canActAsDriver`-gated) mirrors `driver-menu.tsx`'s pre-existing "Switch role" row (now itself
  gated to real operators only — fixed a bug where a plain DRIVER saw it too); both use
  `useAuthStore`'s pre-existing `activeRole`/`setActiveRole`. Note `(operator)/(tabs)/home.tsx`'s
  `DriverInlineView` (already-shipped P10-POS-5 run-card-above-KPIs) had its "Open stop"/`StopCard`
  navigation fixed to call `setActiveRole("driver")` first — was bouncing back to `/(operator)/home`
  via the root layout's `activeRole` redirect guard. `(auth)/role-picker.tsx` remains orphaned,
  deliberately not wired in this pass.
- Add a row: **At-delivery short/refuse reconciliation (P10-POS-7 delta)** →
  `lib/short-pick.ts` (`buildDeliveries`/`reconciledTotal`, mirrors the server's per-batch invoice
  proration formula exactly — `orders.service.ts:3321`) + `store/delivery-plan-store.ts` +
  `app/(driver)/route/stop/[stopId]/short-pick.tsx` (interposed between the stop screen and
  `payment.tsx` via the "Complete & collect" button) + `lib/pricing.ts`'s new
  `prorateLineSubtotal`. `payment.tsx` now reads `useOrder(orderId)` (not the narrower
  `useRouteRun`-embedded lineItems) for its total/deliveries. Note the true "warehouse loading
  pick-list" (P10-POS-7's literal `pick.tsx`) remains an honest stub — needs a new API endpoint,
  out of scope.
- Add a row: **Run settlement (P10-POS-9)** → `lib/run-settlement.ts` +
  `store/runSettlementStore.ts` (device-local, in-memory, non-persisted tally of collections this
  run — no server aggregate exists) + `app/(driver)/route/settlement.tsx`, gated from
  `route/index.tsx`'s "Mark route complete" only when cash/check was collected this run.
  Persistence is an appended note via the pre-existing `useUpdateRun` (no schema change).
- Note in the row for driver payment collection (or a new short callout): **known issue** —
  `payment.tsx`'s `completeWithPayment` payment attach silently no-ops (`StopPaymentDto.invoiceId`
  required but never populated by `findOneRun`; `Order` has no such Prisma field) — flagged
  separately, not fixed by this increment.
- `_meta.json`: bump `mappedSha` to the branch's `git rev-parse HEAD` and `generatedAt` after the
  PR lands.

## 10. Gate

```
npx turbo run check-types lint test --filter=./apps/mobile
```

Mobile cannot be device-tested in this environment — rely on typecheck + lint + the four new Jest
suites (§5.5, §7.7, §8.6, plus WP2's manual-review-only acceptance criteria since it has no pure
logic to unit test) + a careful re-read of every diff against this plan's exact code before
declaring any WP done.

## 11. Money discipline recap (why each WP stays server-authoritative)

- **WP1 (credit-limit):** shows only the server's own `limit`/`exposure`/`message` from the 409
  body, verbatim. Zero client-side money computation. No override exists to build a button for.
- **WP2 (drive-mode):** no money surface at all — pure navigation/role-view wiring.
- **WP3 (short-pick):** the ONE new formula (`prorateLineSubtotal`) is copied verbatim from the
  server's own already-shipped per-batch invoice line total
  (`orders.service.ts:3321`) — not invented. The on-screen total is explicitly an ESTIMATE; the
  server independently computes and persists the real invoice total from the same `deliveries`
  payload via the same formula. Boxed lines are never re-derived as `qty × unitPrice` — proration
  is always proportional-of-stored-subtotal.
- **WP4 (settlement):** every number summed is an already-final, already-server-accepted
  `collected` amount (the same value `payment.tsx` sent to `completeWithPayment`) — summing
  already-posted amounts for display, never re-deriving a line price. The persisted "record" is a
  plain text note (an honest, explicitly-labeled device-local tally), not a claim of a
  server-computed ledger entry — the UI copy says so ("Collected on this device during this run").
