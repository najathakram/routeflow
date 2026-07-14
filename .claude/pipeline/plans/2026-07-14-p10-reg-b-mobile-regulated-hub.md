# P10-REG-B — Mobile Regulated Items hub (REG-1) + driver-POD wiring verification (REG-7)

## Status

PLANNED — 2026-07-14

## Goal

Mirror web's operator "Regulated Items" hub (`/compliance` + `/compliance/[categoryId]`) on
mobile — KPI overview, a per-section list, and a per-section dashboard with YTD ledger figures,
subcategory chips, filings, and a "Prepare filing" action that shares a CSV. Reuse the already
-shipped `/regulated/*` and `/tracked-categories/*` API 1:1 — no server changes. Separately,
close out REG-7 by verifying (and, where a gap exists, fixing) that the driver app's already
-built age/ID capture actually reaches the server on stop completion, and add the missing
pure-logic test coverage for that gating.

## Scope

**In scope:**

1. **REG-1** — new mobile screens `app/(operator)/compliance/{index,[id]}.tsx` (+ `_layout.tsx`),
   a new API client `lib/api/regulated.ts` (filings + ledger hooks), a shared
   `components/RegulatedFilingsList.tsx`, two small additions to the already-shipped
   `lib/regulated-format.ts` (`lastCompletedPeriod`, `fmtMoney`), a new `shareCsv()` in
   `lib/share-pdf.ts`, and a More-menu nav row.
2. **REG-7** — verification pass over the driver POD flow + payload wiring (found: **already
   fully wired**, see "Key facts" below) plus a small **behavior-preserving refactor**: extract
   the inline regulated-POD gating check in `payment.tsx` into a pure, tested helper
   `lib/pod-gating.ts` (the actual gap — the logic existed only inline, untested).

**Out of scope (do NOT build):** REG-2 (Tracked Categories manager / section create-edit-toggle)
and REG-3 (product-form section picker) — these belong to the separate, not-yet-implemented
`2026-07-14-p10-reg-a-mobile-regulated-config.md` plan (its WP1 `lib/api/tracked-categories.ts`
and WP4 `lib/regulated-format.ts` + `__tests__/regulated-format.test.ts` **have already shipped**
on `master` — this plan reuses and extends those two files; do not recreate them). Also out of
scope: buyer licenses, the license guard, REG-6 scope filter, any driver POD **UI** rebuild, any
API/Prisma change, PDF generation for filings (server hasn't shipped it — CSV only, matching web).

## Key facts established by reading the code (do not re-derive)

- **`apps/mobile/lib/api/tracked-categories.ts` and `apps/mobile/lib/regulated-format.ts` +
  `apps/mobile/__tests__/regulated-format.test.ts` already exist on `master`**, exactly matching
  P10-REG-A's WP1/WP4 (verified by reading both files in full). They export
  `TrackedCategory`/`TrackedSubcategory`/`ReportCadence`/`InvoiceTreatment` types,
  `useTrackedCategories`/`useTrackedCategory`/`useTrackedSubcategories` query hooks, and
  `sectionPickerOptions`/`subcategoryPickerOptions`/`taxRuleLabel`/`treatmentLabel`. This plan
  **reuses `useTrackedCategory`/`useTrackedCategories`/`useTrackedSubcategories` as-is** and
  **extends `regulated-format.ts`** (append two functions, do not touch the existing ones).
  There is **no `apps/mobile/app/(operator)/regulated/` folder yet** — REG-2's screens haven't
  been built. Do not link to `/(operator)/regulated` anywhere in this plan's code (it 404s today).
- **REG-7 finding — already fully wired, verified end-to-end by reading every hop:**
  1. `app/(driver)/route/stop/[stopId]/index.tsx` (L272-323) renders the age/ID capture UI when
     `stop.ageCheckRequired`/`stop.identityCheckRequired`, writing to `usePodStore().setRegulated`
     (`store/podStore.ts` — `PodEntry.ageVerified?/identityVerified?/identityType?`).
  2. `app/(driver)/route/stop/[stopId]/payment.tsx` (`closeStop()`, L111-131) reads `pod` from the
     store and — for a regulated stop — inline-validates signature → age → identity →
     identity-type (client-side UX shortcut; the server re-validates independently) before
     calling `completeWithPaymentMut.mutateAsync({ …, ageVerified: pod?.ageVerified,
identityVerified: pod?.identityVerified, identityType: pod?.identityType, … })` (L154-156).
  3. `lib/api/routes.ts` `useCompleteWithPayment` (L299+) posts those three fields verbatim to
     `POST /route-runs/:runId/stops/:stopId/complete-with-payment`; the sibling `useCompleteStop`
     (L230-271, posts to `.../complete`) also forwards them — both hooks are correct.
  4. `apps/api/src/routes/dto/complete-with-payment.dto.ts` → `CompleteWithPaymentDto extends
CompleteStopDto`; `apps/api/src/routes/dto/complete-stop.dto.ts` (`CompleteStopDto`, L42-44)
     validates `ageVerified?: boolean`, `identityVerified?: boolean`,
     `identityType?: string` (`@IsIn(IDENTITY_TYPES)`) via class-validator.
  5. Server enforcement is a shared pure module, `apps/api/src/common/regulated-delivery.ts`
     `assertRegulatedDeliverySatisfied()`, used by every completion path per its own header
     comment. It re-derives requirements from the DB (never trusts the persisted
     `ageCheckRequired`/`identityCheckRequired` hint) and enforces the same ladder: safe-drop
     forbidden → signature required → age check → identity check → identity type, throwing
     `BadRequestException({code:"REGULATED_POD_REQUIRED", reason, message})`.
     **Conclusion: nothing is missing in the payload/DTO/enforcement chain.** The one real gap is
     that the mobile-side pre-check (step 2) is untested inline logic, not a pure/testable helper —
     WP4 below extracts and tests it, then rewires `payment.tsx` to call it (behavior-preserving:
     same four checks, same order, same message strings — verified against the current inline code).
     Mobile's version intentionally omits the server's safe-drop check because mobile has no
     safe-drop UI at all (`safeDropEnabled` is never set from `payment.tsx`) — matches reality, not
     a gap.
- **Web hub (`compliance/page.tsx`) is NOT addon-gated** — it always renders for
  OPERATOR/TENANT_ADMIN; only one KPI cell conditionally shows tobacco-addon data
  (`hasTobacco && overview ? fmt(overview.sales.totalTax) : "—"`). **Decision: the mobile hub
  mirrors this exactly** — the whole screen and its More-menu nav row are unconditional; only the
  "Tax (this month)" KPI cell is gated on `useHasAddon(TOBACCO_ADDON)`.
- **Web's "Manage sections" header link goes to `/settings?tab=regulated`, which has no mobile
  equivalent** (mobile Settings is General|Users|Branding|Integrations, no Regulated tab; REG-2's
  dedicated `/regulated` manager screens are a separate, unbuilt plan). **Decision: omit this
  link entirely on mobile** rather than point at a route that doesn't exist yet — flagged for the
  reviewer, not a bug to silently work around later.
- **Mobile's `useTobaccoOverview(month?)` (`lib/api/tobacco.ts`) has no `enabled` option** — unlike
  web's `useTobaccoOverview(undefined, {enabled: hasTobacco})`. The existing
  `app/(operator)/tobacco/index.tsx` already calls it unconditionally (before its own
  `if (!enabled) return …` early-return) and only _displays_ the result when the addon is on.
  **This plan follows that exact existing precedent** — call the hook unconditionally in the hub,
  gate only the display. Not introducing a new pattern; not fixing the pre-existing one either
  (out of scope, matches an established codebase convention).
- **`lib/share-pdf.ts`'s `sharePdf()`/`sanitizeFilename()` are hardcoded to `application/pdf` /
  `.pdf`** (mimeType, UTI, default extension). A filing's downloadable artifact is a **CSV**
  (`GET /regulated/filings/:id/csv`; PDF isn't generated server-side — mirrors web's
  `RegulatedFilingsTable` comment "Only CSV is offered; PDF generation hasn't shipped"). Rather
  than touch the existing, widely-depended-on `sharePdf()` (many callers, cross-app), **WP1 adds
  a standalone sibling `shareCsv()`** in the same file with its own tiny filename sanitizer — zero
  risk to existing PDF-sharing behavior anywhere else in the app.
- **Web has a recharts bar chart** for the per-section monthly trend. Mobile has **no charting
  library** and the established mobile convention for finance-style screens explicitly avoids one
  (code map, Reports P10-PAR-6: "KPI cards + tables, **no charts**"). **Decision: render the
  monthly net-sales/tax series as a plain reverse-chronological list row-per-month inside a
  `ListGroup`**, not a chart. Do not add a charting dependency.
- Money: `RegulatedLedgerRow.netSales`/`.categoryTax` arrive as **numbers** (server casts them);
  `RegulatedFiling.totalNetSales`/`.totalCategoryTax` arrive as **Prisma-Decimal strings** (must
  `Number()` before formatting — mirrors web's `fmt(Number(f.totalNetSales))`). The new
  `fmtMoney()` helper handles both (`typeof n === "string" ? Number(n) : n`). Mobile only
  **displays** these pre-computed server values — no client-side sum/derive anywhere in this plan.
- Mobile query-key convention for this feature (**per the task spec, use exactly these — do not
  invent variants**): `useRegulatedFilings` → `["regulated-filings", categoryId ?? null]`;
  `useRegulatedLedger` → `["regulated-ledger", params ?? {}]`. (Contrast web's nested
  `["regulated","filings",categoryId]`/`["regulated","ledger",params]` — mobile stays flat
  dash-style, matching `credit-notes`/`recurring-invoices`/`buyer` conventions per the code map.)
- Route/file naming: the web dynamic segment is `[categoryId]`; mobile's own precedent for the
  _same_ TrackedCategory id elsewhere (P10-REG-A's unbuilt `regulated/[id].tsx`) uses `[id]`.
  **Decision: use `app/(operator)/compliance/[id].tsx`** for consistency with mobile's own
  routing idiom (`products/[id].tsx`, `credit-notes/[id].tsx`, etc.) — the URL param name is an
  internal detail, not a contract.
- iOS mobile-kit primitives confirmed by reading their source (`packages/ui/src/mobile/ios/`):
  `KpiCard{icon,iconBg,value,label,delta?,deltaTone?,highlighted?}`,
  `Pill{variant,dot?,small?,children}` (variants: brand/green/orange/red/gray/yellow/purple),
  `NavBar{largeTitle?,subtitle?,inlineTitle?,leading?,trailing?,transparent?,tint?}` +
  `NavBackButton{label?,onPress?}` + `NavAction{label,onPress?,bold?}`,
  `ListGroup{children,header?,footer?}` + `ListRow{icon?,iconBg?,title,subtitle?,value?,trailing?,
onPress?,chevron?,padY?}`. All imported from `@routeflow/ui/mobile/ios`; tokens from
  `@routeflow/ui/tokens` (`ios.brand`, `ios.brandWash`, `ios.system.{green,orange,purple,red}
{Ink,Wash}`, `ios.bg`, `ios.bgElev`, `ios.label`/`label2`/`label3`, `ios.separator`).

## New / changed files

| Path                                                       | Change | Purpose                                                                                     |
| ---------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------- |
| `apps/mobile/lib/api/regulated.ts`                         | NEW    | Filings + ledger hooks (WP1)                                                                |
| `apps/mobile/lib/regulated-format.ts`                      | EDIT   | Append `lastCompletedPeriod`, `fmtMoney` (WP1)                                              |
| `apps/mobile/__tests__/regulated-format.test.ts`           | EDIT   | Append test coverage for the two new helpers (WP1)                                          |
| `apps/mobile/lib/share-pdf.ts`                             | EDIT   | Append `shareCsv()` + private CSV sanitizer (WP1)                                           |
| `apps/mobile/components/RegulatedFilingsList.tsx`          | NEW    | Shared filings list + CSV share (WP1)                                                       |
| `apps/mobile/app/(operator)/compliance/_layout.tsx`        | NEW    | Stack layout (WP2)                                                                          |
| `apps/mobile/app/(operator)/compliance/index.tsx`          | NEW    | Hub screen — KPIs + section list + filings roll-up (WP2)                                    |
| `apps/mobile/app/(operator)/(tabs)/more.tsx`               | EDIT   | "Regulated Items" nav row under INSIGHTS (WP2)                                              |
| `apps/mobile/app/(operator)/compliance/[id].tsx`           | NEW    | Per-section detail — KPIs, monthly ledger, subcategory chips, filings, Prepare filing (WP3) |
| `apps/mobile/lib/pod-gating.ts`                            | NEW    | Pure `regulatedPodGateError()` (WP4)                                                        |
| `apps/mobile/__tests__/pod-gating.test.ts`                 | NEW    | Jest coverage for the gate helper (WP4)                                                     |
| `apps/mobile/app/(driver)/route/stop/[stopId]/payment.tsx` | EDIT   | Replace inline gate with `regulatedPodGateError()` call (WP4)                               |
| `.claude/code-map/mobile.md`                               | EDIT   | Record the new hub/screens/hooks + REG-7 finding (WP5)                                      |
| `.claude/code-map/_meta.json`                              | EDIT   | Bump `mappedSha`/`generatedAt` (WP5)                                                        |

**Execution order:** WP1 first (no dependents). Then WP2, WP3, and WP4 in parallel — WP2/WP3 both
depend only on WP1; WP3 additionally reuses WP2's `RegulatedFilingsList` (from WP1) but not
anything WP2-screen-specific; WP4 is fully independent of WP1-3. WP5 last.

---

## WP1 — API client, format helpers, CSV share, shared filings list

### WP1.1 — `apps/mobile/lib/api/regulated.ts` (NEW)

Mirrors `apps/web/lib/api/tracked-categories.ts`'s Filings (W5b) + Ledger sections (verified by
reading both in full — types below are copied 1:1 from the web source except the query keys,
which use this plan's mandated flat dash-style form). Write the complete file exactly as follows:

```ts
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";
import type { ReportCadence } from "./tracked-categories";

// ─── Filings — mirrors apps/web/lib/api/tracked-categories.ts (Filings, W5b) ────

export type RegulatedFilingStatus = "GENERATED" | "FAILED";

export interface RegulatedFiling {
  id: string;
  trackedCategoryId: string;
  reportTemplate: string;
  cadence: ReportCadence;
  periodKey: string;
  periodStart: string;
  periodEnd: string;
  status: RegulatedFilingStatus;
  totalQty: string; // Prisma Decimal serialized as a string
  totalUnitBasisQty: string;
  totalNetSales: string;
  totalCategoryTax: string;
  csvKey: string | null;
  generationCount: number;
  generatedAt: string;
}

export interface PrepareFilingInput {
  trackedCategoryId: string;
  cadence?: ReportCadence;
  year: number;
  index?: number; // month 1-12 (MONTHLY) or quarter 1-4 (QUARTERLY); ignored ANNUAL
}

export function useRegulatedFilings(categoryId?: string) {
  return useQuery<RegulatedFiling[]>({
    queryKey: ["regulated-filings", categoryId ?? null],
    queryFn: () =>
      apiClient
        .get("/regulated/filings", { params: categoryId ? { category: categoryId } : {} })
        .then((r) => r.data),
  });
}

export function usePrepareFiling() {
  const qc = useQueryClient();
  return useMutation<RegulatedFiling, Error, PrepareFilingInput>({
    mutationFn: (dto) => apiClient.post("/regulated/filings/prepare", dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["regulated-filings"] }),
  });
}

/**
 * Fetch a short-lived presigned URL for a filing's stored artifact. Only "csv" is
 * ever actually generated server-side today (mirrors web's RegulatedFilingsTable
 * comment) — "pdf" is accepted by the signature for parity but callers in this
 * codebase should not request it; it may 404.
 */
export async function fetchRegulatedFilingUrl(id: string, format: "csv" | "pdf" = "csv") {
  const { data } = await apiClient.get(`/regulated/filings/${id}/${format}`);
  return data.url as string;
}

// ─── Ledger (per-section net sales / tax by period) ──────────────────────────────

export interface RegulatedLedgerRow {
  trackedCategoryId: string;
  categoryName: string;
  periodBucket: string; // "YYYY-MM" (UTC month)
  qty: number;
  unitBasisQty: number;
  netSales: number; // signed net (reversals net it down)
  categoryTax: number; // signed net — snapshot 0 until the W3 tax engine lands
}

export interface RegulatedLedgerResponse {
  rows: RegulatedLedgerRow[];
  /** Note: `totals` intentionally omits `unitBasisQty` (sum the rows for that). */
  totals: { qty: number; netSales: number; categoryTax: number };
}

/**
 * Net-sales / tax grouped by (section, month). `to` is INCLUSIVE on this endpoint.
 * Amounts come back as numbers (the ledger endpoint Number()-casts, unlike filings).
 */
export function useRegulatedLedger(
  params?: { category?: string; from?: string; to?: string },
  options?: { enabled?: boolean },
) {
  return useQuery<RegulatedLedgerResponse>({
    queryKey: ["regulated-ledger", params ?? {}],
    queryFn: () =>
      apiClient
        .get("/regulated/ledger", {
          params: {
            ...(params?.category ? { category: params.category } : {}),
            ...(params?.from ? { from: params.from } : {}),
            ...(params?.to ? { to: params.to } : {}),
          },
        })
        .then((r) => r.data),
    enabled: options?.enabled ?? true,
  });
}
```

**Acceptance:** file compiles standalone; every hook's `queryKey`/endpoint matches exactly;
`useRegulatedFilings`/`usePrepareFiling`/`fetchRegulatedFilingUrl`/`useRegulatedLedger` are the
only exports (no sections/subcategories — those stay in `tracked-categories.ts`).

### WP1.2 — `apps/mobile/lib/regulated-format.ts` (EDIT — append only)

First, widen the existing type-only import at the top of the file from:

```ts
import type {
  InvoiceTreatment,
  TrackedCategory,
  TrackedSubcategory,
} from "./api/tracked-categories";
```

to:

```ts
import type {
  InvoiceTreatment,
  ReportCadence,
  TrackedCategory,
  TrackedSubcategory,
} from "./api/tracked-categories";
```

Then **append** these two functions at the end of the file (do not touch
`sectionPickerOptions`/`subcategoryPickerOptions`/`taxRuleLabel`/`treatmentLabel` — they're
unrelated and already shipped/tested):

```ts
/**
 * The most recent COMPLETED period for a cadence, as {year, index} — mirrors
 * apps/web/lib/regulated-format.ts#lastCompletedPeriod exactly. Used by the
 * mobile section-detail screen's "Prepare filing" action (WP3) to default the
 * filing to the last full month/quarter/year rather than the still-in-progress
 * current one.
 */
export function lastCompletedPeriod(cadence: ReportCadence): { year: number; index: number } {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1; // 1-12
  if (cadence === "ANNUAL") return { year: y - 1, index: 1 };
  if (cadence === "QUARTERLY") {
    const q = Math.floor((m - 1) / 3) + 1; // current quarter 1-4
    return q === 1 ? { year: y - 1, index: 4 } : { year: y, index: q - 1 };
  }
  return m === 1 ? { year: y - 1, index: 12 } : { year: y, index: m - 1 }; // MONTHLY: prev month
}

/**
 * Format a money amount (a plain number, or a Prisma-Decimal serialized as a
 * string) as "$X.XX". Mirrors the local `fmt()` idiom already duplicated in
 * several mobile screens (e.g. app/(operator)/tobacco/index.tsx) — mobile has no
 * shared currency helper — centralized here since both the hub and per-section
 * detail screens (WP2/WP3) need it for both numeric ledger rows and
 * Decimal-string filing totals.
 */
export function fmtMoney(n: number | string | undefined): string {
  const v = typeof n === "string" ? Number(n) : (n ?? 0);
  return `$${(Number.isFinite(v) ? v : 0).toFixed(2)}`;
}
```

### WP1.3 — `apps/mobile/__tests__/regulated-format.test.ts` (EDIT — append only)

Widen the existing import line:

```ts
import {
  sectionPickerOptions,
  subcategoryPickerOptions,
  taxRuleLabel,
  treatmentLabel,
} from "../lib/regulated-format";
```

to:

```ts
import {
  fmtMoney,
  lastCompletedPeriod,
  sectionPickerOptions,
  subcategoryPickerOptions,
  taxRuleLabel,
  treatmentLabel,
} from "../lib/regulated-format";
```

Then **append** at the end of the file (after the existing `treatmentLabel` describe block):

```ts
describe("lastCompletedPeriod", () => {
  afterEach(() => {
    jest.useRealTimers();
  });
  const at = (iso: string) => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(iso));
  };

  it("MONTHLY mid-year (2026-07-14) → previous month {year:2026, index:6}", () => {
    at("2026-07-14T12:00:00.000Z");
    expect(lastCompletedPeriod("MONTHLY")).toEqual({ year: 2026, index: 6 });
  });

  it("MONTHLY in January → previous December, prior year", () => {
    at("2026-01-15T00:00:00.000Z");
    expect(lastCompletedPeriod("MONTHLY")).toEqual({ year: 2025, index: 12 });
  });

  it("QUARTERLY in Q1 (Feb) → Q4 of the prior year", () => {
    at("2026-02-01T00:00:00.000Z");
    expect(lastCompletedPeriod("QUARTERLY")).toEqual({ year: 2025, index: 4 });
  });

  it("QUARTERLY in Q3 (Jul) → Q2 same year", () => {
    at("2026-07-14T00:00:00.000Z");
    expect(lastCompletedPeriod("QUARTERLY")).toEqual({ year: 2026, index: 2 });
  });

  it("ANNUAL → prior year, index 1, regardless of month", () => {
    at("2026-07-14T00:00:00.000Z");
    expect(lastCompletedPeriod("ANNUAL")).toEqual({ year: 2025, index: 1 });
  });
});

describe("fmtMoney", () => {
  it.each([
    [12.5, "$12.50"],
    ["7.489", "$7.49"],
    [0, "$0.00"],
    [undefined, "$0.00"],
    ["not-a-number", "$0.00"],
  ])("%p → %s", (input, expected) => {
    expect(fmtMoney(input as any)).toBe(expected);
  });
});
```

**Acceptance:** `npx jest --selectProjects mobile regulated-format` passes, all new + existing
cases green.

### WP1.4 — `apps/mobile/lib/share-pdf.ts` (EDIT — append only)

Append at the end of the file (after the existing `sanitizeFilename` function; do not modify
`sharePdf`/`sharePdfWeb`/`sanitizeFilename`):

```ts
export interface ShareCsvOptions {
  /** Fully-qualified (signed) CSV URL, e.g. from `fetchRegulatedFilingUrl(id, "csv")`. */
  url: string;
  /** Suggested file name, e.g. "regulated-filing-2026-06.csv". */
  filename: string;
  /** Share-sheet title. */
  dialogTitle?: string;
}

/**
 * Share a CSV straight to the OS / browser share sheet, mirroring {@link sharePdf}
 * but for `text/csv` artifacts (e.g. a regulated filing's presigned CSV URL). Kept
 * as a standalone sibling rather than a generic parameter on `sharePdf` so the
 * existing, widely-used PDF path is untouched.
 */
export async function shareCsv({ url, filename, dialogTitle }: ShareCsvOptions): Promise<void> {
  if (Platform.OS === "web") {
    await shareCsvWeb(url, filename, dialogTitle);
    return;
  }

  const target = (FileSystem.cacheDirectory ?? "") + sanitizeCsvFilename(filename);
  const { uri } = await FileSystem.downloadAsync(url, target);
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error("Sharing isn't available on this device.");
  }
  await Sharing.shareAsync(uri, {
    mimeType: "text/csv",
    dialogTitle: dialogTitle ?? filename,
    UTI: "public.comma-separated-values-text",
  });
}

async function shareCsvWeb(url: string, filename: string, dialogTitle?: string): Promise<void> {
  const nav: any = typeof navigator !== "undefined" ? navigator : undefined;

  if (nav?.share && nav?.canShare) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`CSV fetch failed (${res.status})`);
      const blob = await res.blob();
      const file = new File([blob], sanitizeCsvFilename(filename), { type: "text/csv" });
      if (nav.canShare({ files: [file] })) {
        await nav.share({ files: [file], title: dialogTitle ?? filename });
        return;
      }
    } catch (err: any) {
      if (err?.name === "AbortError") return;
    }
  }

  if (typeof window !== "undefined") {
    window.open(url, "_blank", "noopener");
  }
}

function sanitizeCsvFilename(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  const base = cleaned || "export";
  return base.toLowerCase().endsWith(".csv") ? base : `${base}.csv`;
}
```

**Acceptance:** file still exports `sharePdf`/`SharePdfOptions` unchanged; new
`shareCsv`/`ShareCsvOptions` exported; no behavior change to any existing `sharePdf` caller
(tobacco, invoices, buyer statement, etc.).

### WP1.5 — `apps/mobile/components/RegulatedFilingsList.tsx` (NEW)

Shared filings list for the hub roll-up (WP2, `showCategory`) and the per-section detail (WP3,
single-section) — mirrors `apps/web/components/RegulatedFilingsTable.tsx` (verified by reading
it in full): same empty-state copy, same "only CSV, PDF not offered" behavior, same
Generated/Failed status pill. Translated from a `<table>` to `ListGroup`/`ListRow`.

```tsx
import { useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { ios } from "@routeflow/ui/tokens";
import { ListGroup, ListRow, Pill } from "@routeflow/ui/mobile/ios";
import { fetchRegulatedFilingUrl, type RegulatedFiling } from "../lib/api/regulated";
import { shareCsv } from "../lib/share-pdf";
import { fmtMoney } from "../lib/regulated-format";
import { showToast } from "../lib/toast";

interface Props {
  filings: RegulatedFiling[];
  /** Show the section name in each row's title (hub roll-up across all sections). */
  showCategory?: boolean;
  /** Resolve a section id → display name. Required when showCategory. */
  categoryName?: (id: string) => string;
  /** Optional copy for the empty state. */
  emptyHint?: string;
  header?: string;
}

/**
 * Shared filings list for the mobile regulated surfaces — the /compliance hub
 * (all sections, showCategory) and the per-section dashboard (one section).
 * Only CSV is offered; PDF generation hasn't shipped server-side (csvKey is the
 * only populated artifact key today — do not add a PDF affordance here).
 */
export function RegulatedFilingsList({
  filings,
  showCategory = false,
  categoryName,
  emptyHint,
  header = "FILINGS",
}: Props) {
  const [sharingId, setSharingId] = useState<string | null>(null);

  const onShare = async (f: RegulatedFiling) => {
    if (!f.csvKey || sharingId) return;
    setSharingId(f.id);
    try {
      const url = await fetchRegulatedFilingUrl(f.id, "csv");
      await shareCsv({
        url,
        filename: `regulated-filing-${f.periodKey}.csv`,
        dialogTitle: "Share filing CSV",
      });
    } catch (e: any) {
      showToast(e?.message ?? "Could not share the CSV.");
    } finally {
      setSharingId(null);
    }
  };

  if (filings.length === 0) {
    return (
      <ListGroup header={header}>
        <View style={styles.emptyRow}>
          <Text style={styles.emptyText}>
            {emptyHint ??
              "No filings prepared yet. Use Prepare filing to generate one for the last completed period."}
          </Text>
        </View>
      </ListGroup>
    );
  }

  return (
    <ListGroup header={header}>
      {filings.map((f) => (
        <ListRow
          key={f.id}
          icon={
            <Ionicons
              name={f.status === "GENERATED" ? "document-text-outline" : "alert-circle"}
              size={16}
              color={f.status === "GENERATED" ? ios.brand : ios.system.redInk}
            />
          }
          iconBg={f.status === "GENERATED" ? ios.brandWash : ios.system.redWash}
          title={
            showCategory && categoryName
              ? `${f.periodKey} · ${categoryName(f.trackedCategoryId)}`
              : f.periodKey
          }
          subtitle={`Net sales ${fmtMoney(f.totalNetSales)} · Tax ${fmtMoney(f.totalCategoryTax)}`}
          trailing={
            sharingId === f.id ? (
              <ActivityIndicator size="small" color={ios.brand} />
            ) : (
              <Pill variant={f.status === "GENERATED" ? "green" : "orange"} small>
                {f.status === "GENERATED" ? "Generated" : "Failed"}
              </Pill>
            )
          }
          onPress={f.csvKey ? () => void onShare(f) : undefined}
          chevron={!!f.csvKey}
        />
      ))}
    </ListGroup>
  );
}

const styles = StyleSheet.create({
  emptyRow: { padding: 16 },
  emptyText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    textAlign: "center",
  },
});
```

**Acceptance:** renders an empty state matching web's copy when `filings.length === 0`; tapping a
row with `csvKey` shares the CSV (spinner while in flight, disabled re-entrancy via `sharingId`
guard); a `FAILED` row (no `csvKey`) has no `onPress`/chevron.

---

## WP2 — Hub screen (REG-1 index)

### WP2.1 — `apps/mobile/app/(operator)/compliance/_layout.tsx` (NEW)

```tsx
import { Stack } from "expo-router";
export default function ComplianceLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
```

### WP2.2 — `apps/mobile/app/(operator)/compliance/index.tsx` (NEW)

Mirrors `apps/web/app/(dashboard)/compliance/page.tsx` (verified by reading it in full): 4 KPI
cards (Tracked Sections / Regulated Products / Tax this month / Filings), a per-section list
linking to the detail screen (WP3), and the filings roll-up via `RegulatedFilingsList`. No addon
gate on the screen itself — only the tax KPI cell is gated (see "Key facts").

```tsx
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { KpiCard, ListGroup, ListRow, NavBar, Pill } from "@routeflow/ui/mobile/ios";
import { useTrackedCategories } from "../../../lib/api/tracked-categories";
import { useRegulatedFilings } from "../../../lib/api/regulated";
import { useHasAddon, useTobaccoOverview, TOBACCO_ADDON } from "../../../lib/api/tobacco";
import { fmtMoney, taxRuleLabel, treatmentLabel } from "../../../lib/regulated-format";
import { RegulatedFilingsList } from "../../../components/RegulatedFilingsList";

export default function ComplianceHubScreen() {
  const router = useRouter();
  const { data: sections = [], isLoading } = useTrackedCategories();
  const hasTobacco = useHasAddon(TOBACCO_ADDON);
  // Mirrors the existing app/(operator)/tobacco/index.tsx precedent: this hook has
  // no `enabled` option on mobile, so it's called unconditionally — only the
  // *display* below is gated on hasTobacco.
  const { data: overview } = useTobaccoOverview();
  const { data: filings = [] } = useRegulatedFilings();

  const activeCount = sections.filter((s) => s.active).length;
  const regulatedProducts = sections.reduce((sum, s) => sum + (s.productCount ?? 0), 0);
  const categoryName = (id: string) => sections.find((s) => s.id === id)?.name ?? "—";

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar largeTitle="Regulated Items" />
      <ScrollView showsVerticalScrollIndicator={false}>
        {isLoading ? (
          <View style={styles.center}>
            <ActivityIndicator color={ios.brand} />
          </View>
        ) : (
          <>
            <View style={styles.kpiRow}>
              <KpiCard
                icon={<Ionicons name="layers-outline" size={18} color={ios.brand} />}
                iconBg={ios.brandWash}
                value={
                  sections.length > activeCount
                    ? `${activeCount} / ${sections.length}`
                    : String(activeCount)
                }
                label="Tracked Sections"
              />
              <KpiCard
                icon={<Ionicons name="cube-outline" size={18} color={ios.system.greenInk} />}
                iconBg={ios.system.greenWash}
                value={String(regulatedProducts)}
                label="Regulated Products"
              />
            </View>
            <View style={[styles.kpiRow, { marginTop: 12 }]}>
              <KpiCard
                icon={<Ionicons name="receipt-outline" size={18} color={ios.system.orangeInk} />}
                iconBg={ios.system.orangeWash}
                value={hasTobacco && overview ? fmtMoney(overview.sales.totalTax) : "—"}
                label="Tax (this month)"
              />
              <KpiCard
                icon={
                  <Ionicons name="document-text-outline" size={18} color={ios.system.purpleInk} />
                }
                iconBg={ios.system.purpleWash}
                value={String(filings.length)}
                label="Filings"
              />
            </View>

            <ListGroup header="SECTIONS">
              {sections.map((s) => (
                <ListRow
                  key={s.id}
                  icon={<Ionicons name="shield-checkmark-outline" size={16} color={ios.brand} />}
                  iconBg={ios.brandWash}
                  title={s.name}
                  subtitle={`${taxRuleLabel(s)} · ${treatmentLabel(s.invoiceTreatment)} · ${s.productCount} ${s.productCount === 1 ? "product" : "products"}`}
                  trailing={
                    !s.active ? (
                      <Pill variant="gray" small>
                        Off
                      </Pill>
                    ) : s.requiresLicense ? (
                      <Pill variant="orange" small>
                        License
                      </Pill>
                    ) : undefined
                  }
                  onPress={() => router.push(`/(operator)/compliance/${s.id}`)}
                  chevron
                />
              ))}
              {sections.length === 0 ? (
                <View style={styles.emptyRow}>
                  <Text style={styles.emptyText}>
                    No regulated sections yet. Tobacco is added automatically for tenants that sell
                    it.
                  </Text>
                </View>
              ) : null}
            </ListGroup>

            <RegulatedFilingsList filings={filings} showCategory categoryName={categoryName} />

            <View style={{ height: 32 }} />
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center", gap: 10 },
  kpiRow: { flexDirection: "row", gap: 12, paddingHorizontal: 16, marginTop: 8 },
  emptyRow: { padding: 16 },
  emptyText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    textAlign: "center",
  },
});
```

**Acceptance:** loads with 0 sections (empty state, no crash), N sections (KPIs + list correct,
tapping a row navigates to `/(operator)/compliance/<id>`), tax KPI shows "—" when `!hasTobacco`.

### WP2.3 — `apps/mobile/app/(operator)/(tabs)/more.tsx` (EDIT)

Add one `ListRow` to the existing `INSIGHTS` `ListGroup` (the block starting
`<ListGroup header="INSIGHTS">`), right after the "Reports" row and before the conditional
Tobacco row:

```tsx
<ListRow
  icon={<Ionicons name="shield-checkmark-outline" size={16} color={ios.brand} />}
  iconBg={ios.brandWash}
  title="Regulated Items"
  subtitle="Sections, tax rollup & filings"
  onPress={() => router.push("/(operator)/compliance")}
  chevron
/>
```

Unconditional (no addon gate — matches "Key facts": web hub itself isn't addon-gated).

**Acceptance:** row visible for every operator regardless of `hasTobacco`; navigates to the hub.

---

## WP3 — Per-section detail (REG-1 detail)

### WP3.1 — `apps/mobile/app/(operator)/compliance/[id].tsx` (NEW)

Mirrors `apps/web/app/(dashboard)/compliance/[categoryId]/page.tsx` (verified by reading it in
full): header + KPIs (Net Sales this month / Tax this month / Regulated Products / Filings),
monthly YTD series (list instead of web's bar chart — see "Key facts"), active-subcategory chips,
"Prepare filing" action (mirrors web's `handlePrepare`, shares the resulting CSV instead of
`window.open`), and the filings list via `RegulatedFilingsList` (single-section, no
`showCategory`).

```tsx
import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { KpiCard, ListGroup, NavBackButton, NavBar, Pill } from "@routeflow/ui/mobile/ios";
import { useTrackedCategory, useTrackedSubcategories } from "../../../lib/api/tracked-categories";
import {
  fetchRegulatedFilingUrl,
  useRegulatedFilings,
  useRegulatedLedger,
  usePrepareFiling,
} from "../../../lib/api/regulated";
import {
  fmtMoney,
  lastCompletedPeriod,
  taxRuleLabel,
  treatmentLabel,
} from "../../../lib/regulated-format";
import { RegulatedFilingsList } from "../../../components/RegulatedFilingsList";
import { shareCsv } from "../../../lib/share-pdf";
import { showToast } from "../../../lib/toast";

export default function RegulatedSectionDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: section, isLoading } = useTrackedCategory(id);
  const { data: subs = [] } = useTrackedSubcategories(id);
  const { data: filings = [] } = useRegulatedFilings(id);
  const prepare = usePrepareFiling();
  const [preparing, setPreparing] = useState(false);

  // Year-to-date ledger for this section. `to` is left unbounded so today's sales
  // are included (the endpoint treats `to` as inclusive, which would otherwise
  // clip the current day) — mirrors web exactly.
  const now = new Date();
  const year = now.getUTCFullYear();
  const currentMonth = now.getUTCMonth() + 1; // 1-12
  const from = `${year}-01-01`;
  const ledger = useRegulatedLedger({ category: id, from }, { enabled: !!id });

  const ledgerRows = ledger.data?.rows;
  const monthKey = `${year}-${String(currentMonth).padStart(2, "0")}`;
  const thisMonth = ledgerRows?.find((r) => r.periodBucket === monthKey);

  // Reverse-chronological month list (most recent first) — mobile has no chart
  // lib, so this replaces web's bar chart (see plan "Key facts").
  const monthlyRows = useMemo(() => {
    const byMonth = new Map((ledgerRows ?? []).map((r) => [r.periodBucket, r]));
    const out: { key: string; label: string; netSales: number; categoryTax: number }[] = [];
    for (let m = currentMonth; m >= 1; m--) {
      const key = `${year}-${String(m).padStart(2, "0")}`;
      const r = byMonth.get(key);
      out.push({
        key,
        label: new Date(Date.UTC(year, m - 1, 1)).toLocaleDateString(undefined, {
          month: "short",
        }),
        netSales: r?.netSales ?? 0,
        categoryTax: r?.categoryTax ?? 0,
      });
    }
    return out;
  }, [ledgerRows, year, currentMonth]);

  const activeSubs = subs.filter((s) => s.active);

  if (isLoading || !section) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar
          inlineTitle="Section"
          leading={<NavBackButton label="Regulated" onPress={() => router.back()} />}
        />
        <View style={styles.center}>
          <ActivityIndicator color={ios.brand} />
        </View>
      </SafeAreaView>
    );
  }

  const handlePrepare = () => {
    const { year: py, index } = lastCompletedPeriod(section.reportCadence);
    setPreparing(true);
    prepare.mutate(
      { trackedCategoryId: section.id, cadence: section.reportCadence, year: py, index },
      {
        onSuccess: async (filing) => {
          showToast(`Filing prepared · ${filing.periodKey}`);
          try {
            const url = await fetchRegulatedFilingUrl(filing.id, "csv");
            await shareCsv({
              url,
              filename: `${section.name}-${filing.periodKey}.csv`,
              dialogTitle: "Share filing",
            });
          } catch {
            /* saved; the filing row below still offers the CSV share */
          }
        },
        onError: (e: any) =>
          showToast(e?.response?.data?.message ?? e?.message ?? "Failed to prepare filing"),
        onSettled: () => setPreparing(false),
      },
    );
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle={section.name}
        leading={<NavBackButton label="Regulated" onPress={() => router.back()} />}
      />
      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={styles.headBlock}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <Ionicons name="shield-checkmark-outline" size={18} color={ios.brand} />
            <Text style={styles.headName}>{section.name}</Text>
            {section.requiresLicense ? (
              <Pill variant="orange" small>
                License
              </Pill>
            ) : null}
            {!section.active ? (
              <Pill variant="gray" small>
                Off
              </Pill>
            ) : null}
          </View>
          <Text style={styles.headSub}>
            {taxRuleLabel(section)} · {treatmentLabel(section.invoiceTreatment)} ·{" "}
            {section.reportCadence.toLowerCase()} filings
          </Text>
        </View>

        <View style={styles.kpiRow}>
          <KpiCard
            icon={<Ionicons name="cash-outline" size={18} color={ios.system.greenInk} />}
            iconBg={ios.system.greenWash}
            value={ledger.isLoading ? "…" : fmtMoney(thisMonth?.netSales ?? 0)}
            label="Net sales (month)"
          />
          <KpiCard
            icon={<Ionicons name="receipt-outline" size={18} color={ios.system.orangeInk} />}
            iconBg={ios.system.orangeWash}
            value={ledger.isLoading ? "…" : fmtMoney(thisMonth?.categoryTax ?? 0)}
            label="Tax (month)"
          />
        </View>
        <View style={[styles.kpiRow, { marginTop: 12 }]}>
          <KpiCard
            icon={<Ionicons name="cube-outline" size={18} color={ios.brand} />}
            iconBg={ios.brandWash}
            value={String(section.productCount)}
            label="Regulated Products"
          />
          <KpiCard
            icon={<Ionicons name="document-text-outline" size={18} color={ios.system.purpleInk} />}
            iconBg={ios.system.purpleWash}
            value={String(filings.length)}
            label="Filings"
          />
        </View>

        <ListGroup header={`MONTHLY · ${year}`}>
          {monthlyRows.map((r) => (
            <View key={r.key} style={styles.monthRow}>
              <Text style={styles.monthLabel}>{r.label}</Text>
              <View style={{ alignItems: "flex-end" }}>
                <Text style={styles.monthNet}>{fmtMoney(r.netSales)}</Text>
                <Text style={styles.monthTax}>Tax {fmtMoney(r.categoryTax)}</Text>
              </View>
            </View>
          ))}
        </ListGroup>

        {activeSubs.length > 0 ? (
          <View style={styles.chipSection}>
            <Text style={styles.chipHeader}>SUBCATEGORIES</Text>
            <View style={styles.chipWrap}>
              {activeSubs.map((s) => (
                <View key={s.id} style={styles.chip}>
                  <Ionicons name="pricetag-outline" size={12} color={ios.brand} />
                  <Text style={styles.chipText}>{s.name}</Text>
                  <Text style={styles.chipCount}>{s.productCount}</Text>
                </View>
              ))}
            </View>
          </View>
        ) : null}

        <View style={styles.prepareRow}>
          <Text style={styles.prepareText}>Prepare a filing for the last completed period.</Text>
          <Pressable style={styles.prepareBtn} onPress={handlePrepare} disabled={preparing}>
            {preparing ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Text style={styles.prepareBtnText}>Prepare filing</Text>
            )}
          </Pressable>
        </View>

        <RegulatedFilingsList
          filings={filings}
          emptyHint="No filings prepared yet. Use Prepare filing above to generate one for the last completed period."
        />

        <View style={{ height: 32 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center", gap: 10 },
  headBlock: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4, gap: 4 },
  headName: { fontSize: 22, fontFamily: "Inter_700Bold", color: ios.label, letterSpacing: -0.4 },
  headSub: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2 },
  kpiRow: { flexDirection: "row", gap: 12, paddingHorizontal: 16, marginTop: 12 },
  monthRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: ios.bgElev,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: ios.separator,
  },
  monthLabel: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.label },
  monthNet: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  monthTax: { fontSize: 11, fontFamily: "Inter_400Regular", color: ios.label2 },
  chipSection: { marginHorizontal: 16, marginBottom: 20 },
  chipHeader: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    textTransform: "uppercase",
    letterSpacing: 0.78,
    paddingHorizontal: 4,
    paddingBottom: 6,
  },
  chipWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: ios.bgElev,
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  chipText: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.label },
  chipCount: { fontSize: 11, fontFamily: "Inter_400Regular", color: ios.label3 },
  prepareRow: {
    marginHorizontal: 16,
    marginBottom: 16,
    backgroundColor: ios.bgElev,
    borderRadius: 14,
    padding: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  prepareText: { flex: 1, fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2 },
  prepareBtn: {
    backgroundColor: ios.brand,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 10,
    minWidth: 120,
    alignItems: "center",
  },
  prepareBtnText: { color: "#fff", fontSize: 13, fontFamily: "Inter_600SemiBold" },
});
```

**Acceptance:** loading state while `!section`; KPIs read `thisMonth` from the ledger (or "…"
while loading); monthly list has exactly `currentMonth` rows, most-recent first, zero-filled for
months with no ledger row; subcategory chip block hidden when `activeSubs.length === 0`; Prepare
filing calls `usePrepareFiling` with `{trackedCategoryId, cadence, year, index}` from
`lastCompletedPeriod(section.reportCadence)`, shows a toast on success/error, and best-effort
shares the CSV (swallowed failure, matching web).

---

## WP4 — REG-7: extract + test the driver POD gate (verification WP)

**Finding (restated from "Key facts"): the payload wiring is already fully correct end-to-end.**
No DTO, API client, or store change is needed. The only gap is that the mobile pre-check exists
only as untested inline logic in `payment.tsx`. This WP extracts it verbatim (same 4 checks, same
order, same message strings) into a pure, tested helper.

### WP4.1 — `apps/mobile/lib/pod-gating.ts` (NEW)

```ts
export interface RegulatedPodGateInput {
  ageCheckRequired: boolean;
  identityCheckRequired: boolean;
  hasSignature: boolean;
  ageVerified?: boolean;
  identityVerified?: boolean;
  identityType?: string | null;
}

/**
 * Client-side pre-check for the W7b regulated-delivery POD requirements —
 * extracted verbatim (same checks, same order, same message strings) from the
 * inline validation that used to live in
 * app/(driver)/route/stop/[stopId]/payment.tsx's closeStop(). Returns a friendly
 * inline error string when a regulated stop's capture is incomplete, else null.
 *
 * This is a UX shortcut only, to avoid a wasted network round-trip — the server
 * is the sole source of truth and re-validates independently, from a fresh DB
 * read, in apps/api/src/common/regulated-delivery.ts#assertRegulatedDeliverySatisfied
 * (never trusting this client-side result). Mobile has no safe-drop UI
 * (`safeDropEnabled` is never set from payment.tsx), so — unlike the server
 * ladder — this intentionally has no safe-drop check.
 */
export function regulatedPodGateError(input: RegulatedPodGateInput): string | null {
  const {
    ageCheckRequired,
    identityCheckRequired,
    hasSignature,
    ageVerified,
    identityVerified,
    identityType,
  } = input;

  if (!ageCheckRequired && !identityCheckRequired) return null;

  if (!hasSignature) {
    return "A signature is required for this regulated delivery.";
  }
  if (ageCheckRequired && !ageVerified) {
    return "Confirm the recipient's age before completing this regulated delivery.";
  }
  if (identityCheckRequired && !identityVerified) {
    return "Verify the recipient's ID before completing this regulated delivery.";
  }
  if (identityCheckRequired && !identityType) {
    return "Record which type of ID was checked.";
  }
  return null;
}
```

### WP4.2 — `apps/mobile/__tests__/pod-gating.test.ts` (NEW)

```ts
import { regulatedPodGateError } from "../lib/pod-gating";

describe("regulatedPodGateError", () => {
  it("not a regulated stop → null regardless of capture", () => {
    expect(
      regulatedPodGateError({
        ageCheckRequired: false,
        identityCheckRequired: false,
        hasSignature: false,
      }),
    ).toBeNull();
  });

  it("regulated stop, no signature → signature message", () => {
    expect(
      regulatedPodGateError({
        ageCheckRequired: true,
        identityCheckRequired: false,
        hasSignature: false,
      }),
    ).toBe("A signature is required for this regulated delivery.");
  });

  it("age required + signed, age not verified → age message", () => {
    expect(
      regulatedPodGateError({
        ageCheckRequired: true,
        identityCheckRequired: false,
        hasSignature: true,
        ageVerified: false,
      }),
    ).toBe("Confirm the recipient's age before completing this regulated delivery.");
  });

  it("age required + verified, no identity required → null", () => {
    expect(
      regulatedPodGateError({
        ageCheckRequired: true,
        identityCheckRequired: false,
        hasSignature: true,
        ageVerified: true,
      }),
    ).toBeNull();
  });

  it("identity required + signed, not verified → identity message", () => {
    expect(
      regulatedPodGateError({
        ageCheckRequired: false,
        identityCheckRequired: true,
        hasSignature: true,
        identityVerified: false,
      }),
    ).toBe("Verify the recipient's ID before completing this regulated delivery.");
  });

  it("identity verified but no identityType recorded → id-type message", () => {
    expect(
      regulatedPodGateError({
        ageCheckRequired: false,
        identityCheckRequired: true,
        hasSignature: true,
        identityVerified: true,
        identityType: null,
      }),
    ).toBe("Record which type of ID was checked.");
  });

  it("both age + identity required and fully satisfied → null", () => {
    expect(
      regulatedPodGateError({
        ageCheckRequired: true,
        identityCheckRequired: true,
        hasSignature: true,
        ageVerified: true,
        identityVerified: true,
        identityType: "DRIVERS_LICENSE",
      }),
    ).toBeNull();
  });

  it("both required, neither verified → age message wins (ladder order)", () => {
    expect(
      regulatedPodGateError({
        ageCheckRequired: true,
        identityCheckRequired: true,
        hasSignature: true,
        ageVerified: false,
        identityVerified: false,
      }),
    ).toBe("Confirm the recipient's age before completing this regulated delivery.");
  });
});
```

**Acceptance:** `npx jest --selectProjects mobile pod-gating` passes; every ladder branch covered,
including the ordering case (age is checked before identity when both fail).

### WP4.3 — `apps/mobile/app/(driver)/route/stop/[stopId]/payment.tsx` (EDIT)

Add the import (grouped with the other `lib/` imports near the top):

```tsx
import { regulatedPodGateError } from "../../../../../lib/pod-gating";
```

Replace the inline block (currently lines ~111-131, inside `closeStop()`):

```tsx
// W7b: a regulated delivery must carry the demanded age/ID checks + a signature
// (the server enforces this too — check here for a clear inline message and to
// avoid a wasted round-trip).
if (stop.ageCheckRequired || stop.identityCheckRequired) {
  if (!pod?.signatureUri) {
    setAmountError("A signature is required for this regulated delivery.");
    return;
  }
  if (stop.ageCheckRequired && !pod?.ageVerified) {
    setAmountError("Confirm the recipient's age before completing this regulated delivery.");
    return;
  }
  if (stop.identityCheckRequired && !pod?.identityVerified) {
    setAmountError("Verify the recipient's ID before completing this regulated delivery.");
    return;
  }
  if (stop.identityCheckRequired && !pod?.identityType) {
    setAmountError("Record which type of ID was checked.");
    return;
  }
}
```

with:

```tsx
// W7b: a regulated delivery must carry the demanded age/ID checks + a signature
// (the server enforces this too — this is a UX shortcut to avoid a wasted
// round-trip; see lib/pod-gating.ts for the tested pure logic).
const podGateError = regulatedPodGateError({
  ageCheckRequired: !!stop.ageCheckRequired,
  identityCheckRequired: !!stop.identityCheckRequired,
  hasSignature: !!pod?.signatureUri,
  ageVerified: pod?.ageVerified,
  identityVerified: pod?.identityVerified,
  identityType: pod?.identityType,
});
if (podGateError) {
  setAmountError(podGateError);
  return;
}
```

Everything after this point in `closeStop()` (the deliveries build, `completeWithPaymentMut.mutateAsync(...)` call with `ageVerified`/`identityVerified`/`identityType` already wired) is **unchanged** — verified already correct in "Key facts".

**Acceptance:** `npx tsc -p apps/mobile --noEmit` (or the workspace check-types) passes; behavior is
byte-identical to before for every input (same messages, same order) — this is a pure refactor,
not a logic change; a manual code read confirms `payment.tsx` no longer has the inline `if`
ladder duplicated.

---

## WP5 — Code map

Update `.claude/code-map/mobile.md`:

1. Add a new "Where to find" row (alphabetically near "Buyer favorites"/"Regulated-license
   guard"):

   > | Regulated Items hub (operator, P10-REG-B) | `app/(operator)/compliance/{index,[id]}.tsx` —
   > hub (KPIs + section list + filings roll-up) and per-section detail (YTD ledger monthly list,
   > subcategory chips, Prepare filing → CSV share). `lib/api/regulated.ts`
   > (`useRegulatedFilings`/`usePrepareFiling`/`useRegulatedLedger`/`fetchRegulatedFilingUrl`,
   > dash-style keys `["regulated-filings",…]`/`["regulated-ledger",…]`) + `lib/regulated-format.ts`
   > gained `lastCompletedPeriod`/`fmtMoney`. `components/RegulatedFilingsList.tsx` (shared
   > CSV-share list, mirrors web `RegulatedFilingsTable`). `lib/share-pdf.ts` gained `shareCsv()`
   > (CSV sibling of `sharePdf`, untouched). More-menu row under INSIGHTS, unconditional (web hub
   > isn't addon-gated either — only the Tax KPI cell is). No mobile UI yet for REG-2 (section
   > create/edit) — that's the separate unimplemented `regulated/` plan; don't link to it.
   > **REG-7 verified fully wired** (driver POD age/ID capture → `useCompleteStop`/
   > `useCompleteWithPayment` → `CompleteStopDto`/`CompleteWithPaymentDto` →
   > `assertRegulatedDeliverySatisfied`); `lib/pod-gating.ts` `regulatedPodGateError` extracted
   > from `payment.tsx`'s inline check for test coverage, no behavior change.

2. Under `### (operator)/` screens-by-role list, add a line noting the new `compliance/` route
   group (index + `[id]`).
3. Under `### (driver)/` note the `payment.tsx` refactor referencing `lib/pod-gating.ts`.
4. Under `## Tests (__tests__/)` add: `pod-gating.test.ts` (`regulatedPodGateError` ladder order),
   and extend the existing `regulated-format.test.ts` mention with
   `lastCompletedPeriod`/`fmtMoney`.

Update `.claude/code-map/_meta.json`: bump `mappedSha` to the post-implementation
`git rev-parse --short HEAD` and `generatedAt` to the implementation date.

---

## Verify / gate

```
npx turbo run check-types lint test --filter=./apps/mobile
```

Mobile can't be device-tested by the pipeline — the gate is: typecheck clean, lint clean, Jest
green (`regulated-format.test.ts` incl. new cases, `pod-gating.test.ts` new), plus a manual code
read confirming:

- every new screen imports only from files that exist (no dangling import of the unbuilt
  `regulated/` REG-2 screens);
- `RegulatedFilingsList` is reused (not duplicated) by both `compliance/index.tsx` and
  `compliance/[id].tsx`;
- `payment.tsx`'s regulated-completion payload to `useCompleteWithPayment` is unchanged (still
  sends `ageVerified`/`identityVerified`/`identityType`) — only the pre-check moved.

## Money note

`RegulatedLedgerRow.netSales`/`.categoryTax` and `RegulatedFiling.totalNetSales`/
`.totalCategoryTax` are server-computed and server-authoritative (category tax engine, ledger
aggregation). This plan's mobile code only **formats and displays** them (`fmtMoney`, string→number
cast for Decimal fields) — it never sums, derives, or recomputes any of these values client-side,
and never touches `pricing.ts`. The KPI "Tax (this month)" tobacco-overview fallback similarly
displays a pre-computed server total (`overview.sales.totalTax`) verbatim.
