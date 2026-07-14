# P10-REG-A — Mobile regulated categories: Tracked Categories manager + product picker (REG-2 + REG-3)

## Status

PLANNED — 2026-07-14

## Scope

**In scope (mobile only, reuse shipped API, no API/web changes):**

1. **REG-2** — a new operator screen group to list/create/edit/toggle tracked-category
   "sections", manage each section's subcategories (add/rename/toggle), and bulk-assign
   products to a section. Mirrors web `apps/web/app/(dashboard)/settings/_components/RegulatedSettingsTab.tsx`
   - `apps/web/components/{CategoryFormModal,AssignProductsModal}.tsx`.
2. **REG-3** — a dependent section→subcategory picker added to the mobile product
   create/edit form, wiring `trackedCategoryId`/`trackedSubcategoryId` into the existing
   create/update payloads. Mirrors web `apps/web/app/(dashboard)/products/page.tsx`
   (create modal, ~L915-951) and `apps/web/app/(dashboard)/products/[id]/page.tsx`
   (inline edit, ~L1534-1581).

**Out of scope (do NOT build):** REG-6 scope filter (needs an unshipped backend param),
per-section compliance dashboard / ledger (web `compliance/[id]`), filings, driver POD,
buyer licenses, license guard (already shipped on mobile). No API changes. No web changes.
No Prisma migration.

## Shipped API being reused (all `/api/v1`, tenant-scoped, `@Roles(OPERATOR)`)

- `GET /tracked-categories?search=&active=` → `TrackedCategory[]`
- `GET /tracked-categories/:id` → `TrackedCategory`
- `POST /tracked-categories` body `CreateTrackedCategoryDto` → `TrackedCategory`
- `PATCH /tracked-categories/:id` body `Partial<CreateTrackedCategoryDto>` → `TrackedCategory`
- `PATCH /tracked-categories/:id/toggle` (no body) → `TrackedCategory`
- `POST /tracked-categories/:id/products/assign` body `{productIds:string[]}` → `{assigned:number}`
- `POST /tracked-categories/:id/products/unassign` body `{productIds:string[]}` → `{unassigned:number}`
- `GET /tracked-categories/:id/subcategories` → `TrackedSubcategory[]` (active + inactive)
- `POST /tracked-categories/:id/subcategories` body `{name, active?}` → `TrackedSubcategory`
- `PATCH /tracked-categories/:id/subcategories/:subId` body `{name?, active?}` → `TrackedSubcategory`
- `PATCH /tracked-categories/:id/subcategories/:subId/toggle` (no body) → `TrackedSubcategory`
- `PATCH /products/:id` and `POST /products` already accept `trackedCategoryId?: string | null`,
  `trackedSubcategoryId?: string | null` (verified: `apps/api/src/products/dto/{create,update}-product.dto.ts`
  L48-51, both `@IsOptional() @Transform(emptyToNull) @IsUUID()` — omitting the key = "no change" on
  PATCH; explicit `null` clears it; `""` is also transformed to `null` server-side but the mobile
  convention below sends `undefined`/`null` explicitly, mirroring web).
- `GET /products?limit=0` is a valid **fetch-all sentinel** (verified:
  `apps/api/src/products/dto/list-products.dto.ts` L20 `@Min(0) @Max(10000)`, and
  `list-products.dto.spec.ts` asserts `limit=0` passes validation; `products.service.ts` L88-95
  caps the internal fetch at 10,000 rows). Web's `AssignProductsModal` already relies on this
  (`useProducts({ limit: 0 })`) — the mobile assign-products screen does the same via
  `useAdminProducts({ limit: 0 })` (WP2.7) instead of the paginated `useAdminProductsInfinite`,
  so "currently assigned" seeding is never based on a partially-loaded page.

## Key mobile facts established by reading the code (do not re-derive)

- **`ProductForm` is ONE shared component used by BOTH create and edit.**
  `apps/mobile/app/(operator)/products/new.tsx` and
  `apps/mobile/app/(operator)/products/[id]/edit.tsx` both render
  `apps/mobile/components/ProductForm.tsx` (imports `buildProductPayload`/`emptyProductForm`/
  `productFormFromValues`/`ProductFormValues` from `apps/mobile/lib/product-form.ts`, a pure,
  RN-free module). So REG-3 is **one picker addition to one form**, not two.
- **Query-key convention is inconsistent across existing mobile files** — `lib/api/tobacco.ts`
  and `lib/api/authorizations.ts` use nested-array keys (`["tenant","addons"]`), but the
  _majority_ of recent modules (`credit-notes.ts`, `recurring-invoices.ts`, `buyer.ts` per the
  code map) use **flat dash-style keys**: `["credit-notes"]`, `["credit-notes", id]`,
  `["recurring-invoices", customerId]`. The task spec calls for
  `["tracked-categories"]` / `["tracked-category", id]` / `["tracked-subcategories", categoryId]`
  — **use exactly these singular/plural forms as given below, do not invent variants.**
- **Every nested route folder under `app/(operator)/` carries its own trivial `_layout.tsx`**
  (`<Stack screenOptions={{ headerShown: false }} />`) — confirmed present in `products/`,
  `order-templates/`, `credit-notes/`, `recurring-invoices/`, `returns/`, etc. A brand-new
  `regulated/` folder needs one too (the "bare `<Stack>` auto-registers" shortcut only applies
  to dropping a new _file_ into an _existing_ registered folder, not a new top-level folder).
- **A flat `[id].tsx` detail screen coexists with an `[id]/` directory for sibling sub-routes** —
  confirmed real precedent: `products/[id].tsx` (detail) sits alongside
  `products/[id]/{edit,set-cost,adjust-stock}.tsx`. Mirror this exactly for `regulated/`.
- **`OptionPickerSheet`** (`apps/mobile/components/OptionPickerSheet.tsx`) is an existing generic
  single-select bottom sheet (`{id,label}` options, `nullable`/`nullLabel` support, checkmark on
  the active row) — this is the right primitive for every `<select>`-equivalent needed here (tax
  type, invoice treatment, report template, report cadence, regulated section, subcategory). Do
  **not** build a new picker component.
- **No TENANT_ADMIN (or any role) gating exists anywhere in the mobile operator app** (grepped —
  zero hits). Web gates the whole Settings→Regulated tab to `TENANT_ADMIN`; mobile has no
  precedent for gating a screen by role client-side (the API's `@Roles(OPERATOR)` guard is the
  real enforcement either way). **Decision: do not add a role gate** — matches every other mobile
  manager screen (Order Templates, Credit Notes, etc.), keeps scope minimal. Flag this to the
  reviewer; if the business wants a client-side TENANT_ADMIN gate later it's a small follow-up
  using `useAuthStore().user?.role`.
- **Toast/confirm idioms**: `showToast(message: string)` (`lib/toast.ts`, single string, no
  variant). `confirm(title, message, onConfirm, {confirmText?, destructive?})` and
  `alertInfo(title, message?)` (`lib/confirm.ts`).
- Mobile has **no `fmt()` currency helper** (web's `lib/formatting.ts#fmt`) — every mobile screen
  inlines `` `$${n.toFixed(2)}` ``. Mirror that idiom, do not import a nonexistent helper.

## New / changed files

| Path                                                            | Change | Purpose                                                          |
| --------------------------------------------------------------- | ------ | ---------------------------------------------------------------- |
| `apps/mobile/lib/api/tracked-categories.ts`                     | NEW    | Mobile hooks mirroring web's file (WP1)                          |
| `apps/mobile/lib/regulated-format.ts`                           | NEW    | Pure picker-option + label helpers (WP4)                         |
| `apps/mobile/__tests__/regulated-format.test.ts`                | NEW    | Jest coverage for WP4                                            |
| `apps/mobile/components/RegulatedCategoryForm.tsx`              | NEW    | Shared create/edit form for a section (WP2.2)                    |
| `apps/mobile/app/(operator)/regulated/_layout.tsx`              | NEW    | Stack layout (WP2.1)                                             |
| `apps/mobile/app/(operator)/regulated/index.tsx`                | NEW    | Section list screen (WP2.3)                                      |
| `apps/mobile/app/(operator)/regulated/new.tsx`                  | NEW    | Create-section screen (WP2.4)                                    |
| `apps/mobile/app/(operator)/regulated/[id].tsx`                 | NEW    | Section detail + subcategory manager (WP2.6)                     |
| `apps/mobile/app/(operator)/regulated/[id]/edit.tsx`            | NEW    | Edit-section screen (WP2.5)                                      |
| `apps/mobile/app/(operator)/regulated/[id]/assign-products.tsx` | NEW    | Bulk product assign (WP2.7)                                      |
| `apps/mobile/lib/api/admin.ts`                                  | EDIT   | Widen `AdminProduct` with `trackedCategoryId` (WP2.8)            |
| `apps/mobile/app/(operator)/(tabs)/more.tsx`                    | EDIT   | Nav entry into `regulated/` (WP2.9)                              |
| `apps/mobile/lib/product-form.ts`                               | EDIT   | Add tracked fields + `mode` param to `buildProductPayload` (WP3) |
| `apps/mobile/components/ProductForm.tsx`                        | EDIT   | Render the section→subcategory picker (WP3)                      |
| `apps/mobile/app/(operator)/products/new.tsx`                   | EDIT   | Pass `mode="create"` (WP3)                                       |
| `apps/mobile/app/(operator)/products/[id]/edit.tsx`             | EDIT   | Pass `mode="edit"` (WP3)                                         |
| `apps/mobile/lib/api/products.ts`                               | EDIT   | Widen `CreateProductDto` with tracked fields (WP3)               |
| `.claude/code-map/mobile.md`                                    | EDIT   | Record the new screens/hooks (WP5)                               |

**Suggested execution order:** WP1 and WP4 first (no dependents), in parallel. Then WP2 and WP3
in parallel (WP2 depends only on WP1+WP4; WP3 depends only on WP1+WP4, not on WP2). WP5 last.

---

## WP1 — Mobile API client: `apps/mobile/lib/api/tracked-categories.ts` (NEW)

**File:** `apps/mobile/lib/api/tracked-categories.ts`

Straight mirror of `apps/web/lib/api/tracked-categories.ts`'s types/hooks (filings/ledger
sections excluded — out of scope), with mobile's flat dash-style query keys instead of web's
`[...KEY, ...]` array. Write the complete file exactly as follows:

```ts
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";

// ─── Types (mirror apps/web/lib/api/tracked-categories.ts) ──────────────────────

export type TrackedCategoryTaxType =
  | "EXCISE_PER_UNIT"
  | "PERCENT_OF_SALE"
  | "PER_VOLUME"
  | "DEPOSIT_PER_CONTAINER"
  | "NONE";
export type InvoiceTreatment = "SEPARATE_INVOICE" | "SEPARATE_SECTION" | "LINE_TAX";
export type ReportCadence = "MONTHLY" | "QUARTERLY" | "ANNUAL";

export interface TrackedCategory {
  id: string;
  name: string;
  taxType: TrackedCategoryTaxType;
  rate: string; // Prisma Decimal serialized as a string
  unitBasis: string | null;
  priceIncludesTax: boolean;
  invoiceTreatment: InvoiceTreatment;
  requiresLicense: boolean;
  reportTemplate: string;
  reportCadence: ReportCadence;
  active: boolean;
  productCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface TrackedCategoryInput {
  name: string;
  taxType?: TrackedCategoryTaxType;
  rate?: number;
  unitBasis?: string;
  priceIncludesTax?: boolean;
  invoiceTreatment?: InvoiceTreatment;
  requiresLicense?: boolean;
  reportTemplate?: string;
  reportCadence?: ReportCadence;
  active?: boolean;
}

/**
 * A classification child of a section. Carries NO compliance semantics — every
 * regulated guard keys off the parent section's trackedCategoryId. Purely a
 * reporting/grouping tag on a product. Mirrors apps/web/lib/api/tracked-categories.ts.
 */
export interface TrackedSubcategory {
  id: string;
  trackedCategoryId: string;
  name: string;
  active: boolean;
  productCount: number;
  createdAt: string;
  updatedAt: string;
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export function useTrackedCategories(
  params?: { search?: string; active?: boolean },
  options?: { enabled?: boolean },
) {
  return useQuery<TrackedCategory[]>({
    queryKey: ["tracked-categories", params ?? {}],
    queryFn: () => apiClient.get("/tracked-categories", { params }).then((r) => r.data),
    enabled: options?.enabled ?? true,
  });
}

export function useTrackedCategory(id: string | undefined) {
  return useQuery<TrackedCategory>({
    queryKey: ["tracked-category", id],
    queryFn: () => apiClient.get(`/tracked-categories/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}

/** Subcategories of one section (includes inactive ones so a manager can toggle them). */
export function useTrackedSubcategories(categoryId: string | undefined) {
  return useQuery<TrackedSubcategory[]>({
    queryKey: ["tracked-subcategories", categoryId ?? null],
    queryFn: () =>
      apiClient.get(`/tracked-categories/${categoryId}/subcategories`).then((r) => r.data),
    enabled: !!categoryId,
  });
}

// ─── Mutations — sections ────────────────────────────────────────────────────

function invalidateTrackedCategories(qc: ReturnType<typeof useQueryClient>, id?: string) {
  qc.invalidateQueries({ queryKey: ["tracked-categories"] });
  if (id) qc.invalidateQueries({ queryKey: ["tracked-category", id] });
}

export function useCreateTrackedCategory() {
  const qc = useQueryClient();
  return useMutation<TrackedCategory, Error, TrackedCategoryInput>({
    mutationFn: (dto) => apiClient.post("/tracked-categories", dto).then((r) => r.data),
    onSuccess: () => invalidateTrackedCategories(qc),
  });
}

export function useUpdateTrackedCategory() {
  const qc = useQueryClient();
  return useMutation<TrackedCategory, Error, { id: string; data: Partial<TrackedCategoryInput> }>({
    mutationFn: ({ id, data }) =>
      apiClient.patch(`/tracked-categories/${id}`, data).then((r) => r.data),
    onSuccess: (_, { id }) => invalidateTrackedCategories(qc, id),
  });
}

/** Flip active on/off. Deactivation keeps historic sales/ledger data intact. */
export function useToggleTrackedCategory() {
  const qc = useQueryClient();
  return useMutation<TrackedCategory, Error, string>({
    mutationFn: (id) => apiClient.patch(`/tracked-categories/${id}/toggle`).then((r) => r.data),
    onSuccess: (_, id) => invalidateTrackedCategories(qc, id),
  });
}

// ─── Mutations — product membership ──────────────────────────────────────────

function invalidateProducts(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["products"] });
  qc.invalidateQueries({ queryKey: ["admin", "products"] }); // prefix-matches the infinite key too
}

export function useAssignProductsToCategory() {
  const qc = useQueryClient();
  return useMutation<{ assigned: number }, Error, { id: string; productIds: string[] }>({
    mutationFn: ({ id, productIds }) =>
      apiClient
        .post(`/tracked-categories/${id}/products/assign`, { productIds })
        .then((r) => r.data),
    onSuccess: (_, { id }) => {
      invalidateTrackedCategories(qc, id);
      invalidateProducts(qc);
    },
  });
}

export function useUnassignProductsFromCategory() {
  const qc = useQueryClient();
  return useMutation<{ unassigned: number }, Error, { id: string; productIds: string[] }>({
    mutationFn: ({ id, productIds }) =>
      apiClient
        .post(`/tracked-categories/${id}/products/unassign`, { productIds })
        .then((r) => r.data),
    onSuccess: (_, { id }) => {
      invalidateTrackedCategories(qc, id);
      invalidateProducts(qc);
    },
  });
}

// ─── Mutations — subcategories ───────────────────────────────────────────────

function invalidateSubcategories(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["tracked-subcategories"] });
}

export function useCreateSubcategory() {
  const qc = useQueryClient();
  return useMutation<
    TrackedSubcategory,
    Error,
    { categoryId: string; name: string; active?: boolean }
  >({
    mutationFn: ({ categoryId, ...body }) =>
      apiClient.post(`/tracked-categories/${categoryId}/subcategories`, body).then((r) => r.data),
    onSuccess: () => invalidateSubcategories(qc),
  });
}

export function useUpdateSubcategory() {
  const qc = useQueryClient();
  return useMutation<
    TrackedSubcategory,
    Error,
    { categoryId: string; subId: string; data: { name?: string; active?: boolean } }
  >({
    mutationFn: ({ categoryId, subId, data }) =>
      apiClient
        .patch(`/tracked-categories/${categoryId}/subcategories/${subId}`, data)
        .then((r) => r.data),
    onSuccess: () => invalidateSubcategories(qc),
  });
}

/** Flip active on/off. Deactivation keeps historic tagging intact (soft delete). */
export function useToggleSubcategory() {
  const qc = useQueryClient();
  return useMutation<TrackedSubcategory, Error, { categoryId: string; subId: string }>({
    mutationFn: ({ categoryId, subId }) =>
      apiClient
        .patch(`/tracked-categories/${categoryId}/subcategories/${subId}/toggle`)
        .then((r) => r.data),
    onSuccess: () => invalidateSubcategories(qc),
  });
}
```

**Acceptance:** file compiles standalone; every hook's `queryKey`/endpoint matches the table
above exactly; `useTrackedCategories`/`useTrackedCategory`/`useTrackedSubcategories` are the only
query hooks (no filings/ledger — out of scope).

---

## WP4 — Pure-logic helper + Jest test: `apps/mobile/lib/regulated-format.ts`

(Ordered before WP2/WP3 in this doc because both depend on it — implement WP1 and WP4 first.)

**File:** `apps/mobile/lib/regulated-format.ts` (NEW) — mirrors
`apps/web/lib/regulated-format.ts`'s `sectionPickerOptions`/`subcategoryPickerOptions`/
`taxRuleLabel`/`treatmentLabel` (the `lastCompletedPeriod` filings helper is out of scope — omit
it). No RN import — type-only imports from `./api/tracked-categories`, so this stays runnable
under mobile's pure-logic Jest (node env, no RN render).

```ts
import type {
  InvoiceTreatment,
  TrackedCategory,
  TrackedSubcategory,
} from "./api/tracked-categories";

/**
 * Pure regulated-category display helpers — mirrors apps/web/lib/regulated-format.ts
 * (sectionPickerOptions/subcategoryPickerOptions/taxRuleLabel/treatmentLabel only;
 * the filings-only lastCompletedPeriod helper is out of scope for mobile REG-2/REG-3).
 * No RN import so apps/mobile/__tests__/*.test.ts (pure-logic, node env) can lock it.
 */

/** One entry in a section/subcategory picker sheet. */
export interface RegulatedPickerOption {
  id: string;
  name: string;
  inactive: boolean;
}

/**
 * Options for a regulated-section picker: the tenant's active sections, plus the
 * product's current section injected (flagged inactive) when it was since
 * deactivated — so an edit form never silently drops a still-applied tag. Shared
 * by the product create form and edit form so their filtering can't drift. On
 * the create path `current` is omitted/null (a new product has no pre-existing
 * tag), so the result is simply the active sections.
 */
export function sectionPickerOptions(
  activeSections: TrackedCategory[],
  current?: { id: string; name: string } | null,
): RegulatedPickerOption[] {
  const opts: RegulatedPickerOption[] = activeSections.map((s) => ({
    id: s.id,
    name: s.name,
    inactive: false,
  }));
  if (current && !opts.some((o) => o.id === current.id)) {
    opts.push({ id: current.id, name: current.name, inactive: true });
  }
  return opts;
}

/**
 * Options for a subcategory picker within a section: the active subcategories,
 * plus the current selection (flagged inactive) if it was since deactivated.
 * Same drift-proofing as {@link sectionPickerOptions}.
 */
export function subcategoryPickerOptions(
  subcategories: TrackedSubcategory[],
  currentId?: string | null,
): RegulatedPickerOption[] {
  return subcategories
    .filter((s) => s.active || s.id === currentId)
    .map((s) => ({ id: s.id, name: s.name, inactive: !s.active }));
}

/** Human label for a section's tax rule (e.g. "$2.87 / pack", "5% of sale"). */
export function taxRuleLabel(c: TrackedCategory): string {
  const rate = Number(c.rate);
  const basis = c.unitBasis || "unit";
  switch (c.taxType) {
    case "EXCISE_PER_UNIT":
    case "PER_VOLUME":
    case "DEPOSIT_PER_CONTAINER":
      return `$${rate.toFixed(2)} / ${basis}`;
    case "PERCENT_OF_SALE": {
      const pct = rate * 100;
      return `${pct % 1 === 0 ? pct : pct.toFixed(2)}% of sale`;
    }
    case "NONE":
    default:
      return "Tracked only · no auto tax";
  }
}

/** Human label for how a section appears on invoices. */
export function treatmentLabel(t: InvoiceTreatment): string {
  return t === "SEPARATE_INVOICE"
    ? "Separate invoice"
    : t === "SEPARATE_SECTION"
      ? "Sectioned on invoice"
      : "Per-line tax";
}
```

**File:** `apps/mobile/__tests__/regulated-format.test.ts` (NEW) — style mirrors
`apps/mobile/__tests__/credit-notes-helpers.test.ts` (`it.each` tables). Cover:

- `sectionPickerOptions`: no `current` → maps active sections 1:1, all `inactive:false`;
  `current` whose id IS in the active list → not duplicated; `current` whose id is NOT in the
  active list → appended once with `inactive:true`; `current` omitted/null on an empty active
  list → `[]`.
- `subcategoryPickerOptions`: drops inactive subs whose id != currentId; keeps an inactive sub
  whose id == currentId (flagged `inactive:true`); keeps all active subs regardless of currentId.
- `taxRuleLabel`: `EXCISE_PER_UNIT` with `rate:"2.87", unitBasis:"pack"` → `"$2.87 / pack"`;
  `PERCENT_OF_SALE` with `rate:"0.05"` → `"5% of sale"` (integer-percent, no decimals);
  `PERCENT_OF_SALE` with `rate:"0.0525"` → `"5.25% of sale"`; `NONE` → `"Tracked only · no auto tax"`;
  `unitBasis:null` on a per-unit type → falls back to `"unit"` (e.g. `"$2.87 / unit"`).
- `treatmentLabel`: all 3 `InvoiceTreatment` values map to their exact label strings above.

Build minimal `TrackedCategory`/`TrackedSubcategory` fixture objects inline in the test (only the
fields the function under test reads need to be non-placeholder; fill the rest with dummy
values matching the interface so TS is happy).

**Acceptance:** `npx jest --selectProjects mobile regulated-format` passes; every branch above has
at least one case.

---

## WP2 — Tracked Categories manager (REG-2)

### WP2.1 — `apps/mobile/app/(operator)/regulated/_layout.tsx` (NEW)

```tsx
import { Stack } from "expo-router";
export default function RegulatedLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
```

### WP2.2 — `apps/mobile/components/RegulatedCategoryForm.tsx` (NEW)

Shared create/edit form for a section — mirrors `apps/web/components/CategoryFormModal.tsx`'s
fields exactly, translated to the `FormSheet`/`FormField`/`FormSection`/`FormTextInput`
(`./FormSheet`) + `OptionPickerSheet` (`./OptionPickerSheet`) idiom already used by
`ProductForm.tsx`. Both `regulated/new.tsx` and `regulated/[id]/edit.tsx` render this one
component (exactly the same "one shared form" pattern as `ProductForm`).

```tsx
import * as React from "react";
import { Pressable, StyleSheet, Switch, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { ios } from "@routeflow/ui/tokens";
import { FormField, FormSection, FormSheet, FormTextInput } from "./FormSheet";
import { OptionPickerSheet, type PickerOption } from "./OptionPickerSheet";
import type {
  InvoiceTreatment,
  ReportCadence,
  TrackedCategoryTaxType,
} from "../lib/api/tracked-categories";

export interface RegulatedCategoryFormValues {
  name: string;
  taxType: TrackedCategoryTaxType;
  rate: string;
  unitBasis: string;
  priceIncludesTax: boolean;
  invoiceTreatment: InvoiceTreatment;
  requiresLicense: boolean;
  reportTemplate: string;
  reportCadence: ReportCadence;
  active: boolean;
}

export function emptyRegulatedCategoryForm(): RegulatedCategoryFormValues {
  return {
    name: "",
    taxType: "NONE",
    rate: "0",
    unitBasis: "",
    priceIncludesTax: false,
    invoiceTreatment: "SEPARATE_INVOICE",
    requiresLicense: false,
    reportTemplate: "GENERIC",
    reportCadence: "MONTHLY",
    active: true,
  };
}

export interface RegulatedCategorySubmitPayload {
  name: string;
  taxType: TrackedCategoryTaxType;
  rate: number;
  unitBasis?: string;
  priceIncludesTax: boolean;
  invoiceTreatment: InvoiceTreatment;
  requiresLicense: boolean;
  reportTemplate: string;
  reportCadence: ReportCadence;
  active: boolean;
}

const TAX_TYPES: PickerOption[] = [
  { id: "NONE", label: "None (track only, no auto tax)" },
  { id: "EXCISE_PER_UNIT", label: "Excise per unit" },
  { id: "PERCENT_OF_SALE", label: "Percent of sale" },
  { id: "PER_VOLUME", label: "Per volume" },
  { id: "DEPOSIT_PER_CONTAINER", label: "Deposit per container" },
];
const TREATMENTS: PickerOption[] = [
  { id: "SEPARATE_INVOICE", label: "Separate invoice (default)" },
  { id: "SEPARATE_SECTION", label: "Sectioned on the main invoice" },
  { id: "LINE_TAX", label: "Per-line tax" },
];
const TEMPLATES: PickerOption[] = ["GENERIC", "CA_CDTFA", "CA_ABC", "CALRECYCLE"].map((t) => ({
  id: t,
  label: t,
}));
const CADENCES: PickerOption[] = ["MONTHLY", "QUARTERLY", "ANNUAL"].map((c) => ({
  id: c,
  label: c,
}));

interface Props {
  title: string;
  submitLabel: string;
  submitting?: boolean;
  initial: RegulatedCategoryFormValues;
  onSubmit: (payload: RegulatedCategorySubmitPayload) => void;
}

export function RegulatedCategoryForm({
  title,
  submitLabel,
  submitting,
  initial,
  onSubmit,
}: Props) {
  const [form, setForm] = React.useState<RegulatedCategoryFormValues>(initial);
  const [error, setError] = React.useState<string | null>(null);
  const [taxTypeOpen, setTaxTypeOpen] = React.useState(false);
  const [treatmentOpen, setTreatmentOpen] = React.useState(false);
  const [templateOpen, setTemplateOpen] = React.useState(false);
  const [cadenceOpen, setCadenceOpen] = React.useState(false);

  const set = <K extends keyof RegulatedCategoryFormValues>(
    k: K,
    v: RegulatedCategoryFormValues[K],
  ) => setForm((f) => ({ ...f, [k]: v }));

  const hasTax = form.taxType !== "NONE";
  const isPercent = form.taxType === "PERCENT_OF_SALE";

  const submit = () => {
    const name = form.name.trim();
    if (!name) {
      setError("Name is required.");
      return;
    }
    setError(null);
    onSubmit({
      name,
      taxType: form.taxType,
      rate: hasTax ? Number(form.rate) || 0 : 0,
      unitBasis: form.unitBasis.trim() || undefined,
      priceIncludesTax: form.priceIncludesTax,
      invoiceTreatment: form.invoiceTreatment,
      requiresLicense: form.requiresLicense,
      reportTemplate: form.reportTemplate,
      reportCadence: form.reportCadence,
      active: form.active,
    });
  };

  return (
    <FormSheet title={title} submitLabel={submitLabel} onSubmit={submit} submitting={submitting}>
      {error ? (
        <View style={styles.errorBanner}>
          <Ionicons name="warning-outline" size={16} color={ios.system.redInk} />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      <FormSection title="Basics">
        <FormField label="Name">
          <FormTextInput
            value={form.name}
            onChangeText={(v) => set("name", v)}
            placeholder='e.g. "Alcohol", "CRV Beverage Deposits"'
            autoCapitalize="words"
          />
        </FormField>
        <FormField label="Tax type">
          <PickerRow
            label={TAX_TYPES.find((t) => t.id === form.taxType)?.label ?? form.taxType}
            onPress={() => setTaxTypeOpen(true)}
          />
        </FormField>
        <FormField label="Invoice treatment">
          <PickerRow
            label={
              TREATMENTS.find((t) => t.id === form.invoiceTreatment)?.label ?? form.invoiceTreatment
            }
            onPress={() => setTreatmentOpen(true)}
          />
        </FormField>
      </FormSection>

      {hasTax ? (
        <FormSection title="Tax">
          <FormField label={isPercent ? "Rate (fraction — 0.05 = 5%)" : "Rate ($ per unit)"}>
            <FormTextInput
              value={form.rate}
              onChangeText={(v) => set("rate", v)}
              keyboardType="decimal-pad"
              placeholder={isPercent ? "0.05" : "2.87"}
            />
          </FormField>
          {!isPercent ? (
            <FormField label="Unit basis (pack, oz…)">
              <FormTextInput
                value={form.unitBasis}
                onChangeText={(v) => set("unitBasis", v)}
                placeholder="pack"
              />
            </FormField>
          ) : null}
          <SwitchRow
            label="Price already includes this tax"
            value={form.priceIncludesTax}
            onValueChange={(v) => set("priceIncludesTax", v)}
          />
        </FormSection>
      ) : null}

      <FormSection title="Reporting">
        <FormField label="Report template">
          <PickerRow label={form.reportTemplate} onPress={() => setTemplateOpen(true)} />
        </FormField>
        <FormField label="Report cadence">
          <PickerRow label={form.reportCadence} onPress={() => setCadenceOpen(true)} />
        </FormField>
      </FormSection>

      <FormSection>
        <SwitchRow
          label="Requires the customer to hold a license"
          value={form.requiresLicense}
          onValueChange={(v) => set("requiresLicense", v)}
        />
        <SwitchRow label="Active" value={form.active} onValueChange={(v) => set("active", v)} />
      </FormSection>

      <OptionPickerSheet
        visible={taxTypeOpen}
        title="Tax type"
        options={TAX_TYPES}
        selectedId={form.taxType}
        onClose={() => setTaxTypeOpen(false)}
        onSelect={(o) => {
          const taxType = o.id as TrackedCategoryTaxType;
          setForm((f) => ({
            ...f,
            taxType,
            unitBasis: taxType === "PERCENT_OF_SALE" || taxType === "NONE" ? "" : f.unitBasis,
          }));
          setTaxTypeOpen(false);
        }}
      />
      <OptionPickerSheet
        visible={treatmentOpen}
        title="Invoice treatment"
        options={TREATMENTS}
        selectedId={form.invoiceTreatment}
        onClose={() => setTreatmentOpen(false)}
        onSelect={(o) => {
          set("invoiceTreatment", o.id as InvoiceTreatment);
          setTreatmentOpen(false);
        }}
      />
      <OptionPickerSheet
        visible={templateOpen}
        title="Report template"
        options={TEMPLATES}
        selectedId={form.reportTemplate}
        onClose={() => setTemplateOpen(false)}
        onSelect={(o) => {
          set("reportTemplate", o.id);
          setTemplateOpen(false);
        }}
      />
      <OptionPickerSheet
        visible={cadenceOpen}
        title="Report cadence"
        options={CADENCES}
        selectedId={form.reportCadence}
        onClose={() => setCadenceOpen(false)}
        onSelect={(o) => {
          set("reportCadence", o.id as ReportCadence);
          setCadenceOpen(false);
        }}
      />
    </FormSheet>
  );
}

function PickerRow({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable style={styles.picker} onPress={onPress}>
      <View style={styles.pickerInner}>
        <Text style={styles.pickerText} numberOfLines={1}>
          {label}
        </Text>
        <Ionicons name="chevron-down" size={14} color={ios.label3} />
      </View>
    </Pressable>
  );
}

function SwitchRow({
  label,
  value,
  onValueChange,
}: {
  label: string;
  value: boolean;
  onValueChange: (v: boolean) => void;
}) {
  return (
    <View style={styles.switchRow}>
      <Text style={styles.switchLabel}>{label}</Text>
      <Switch value={value} onValueChange={onValueChange} trackColor={{ true: ios.brand }} />
    </View>
  );
}

const styles = StyleSheet.create({
  errorBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: ios.system.redWash,
    padding: 10,
    borderRadius: 10,
  },
  errorText: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.system.redInk, flex: 1 },
  picker: {
    backgroundColor: ios.fill3,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 11,
    minHeight: 44,
    justifyContent: "center",
  },
  pickerInner: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  pickerText: { fontSize: 15, fontFamily: "Inter_400Regular", color: ios.label, flex: 1 },
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  switchLabel: { fontSize: 15, fontFamily: "Inter_500Medium", color: ios.label, flex: 1 },
});
```

> Confirmed: `apps/mobile/components/OptionPickerSheet.tsx` already exports
> `interface PickerOption { id: string; label: string; }` (line 5) — import it directly as shown
> above, no changes needed to that file.

### WP2.3 — `apps/mobile/app/(operator)/regulated/index.tsx` (NEW) — section list

Mirrors `apps/web/.../RegulatedSettingsTab.tsx`'s top-level list + `apps/mobile/app/(operator)/products/index.tsx`'s screen shell (SafeAreaView/NavBar/ScrollView+RefreshControl/empty-state).

```tsx
import { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavAction, NavBackButton, NavBar, Pill } from "@routeflow/ui/mobile/ios";
import {
  useTrackedCategories,
  useToggleTrackedCategory,
  type TrackedCategory,
} from "../../../lib/api/tracked-categories";
import { taxRuleLabel, treatmentLabel } from "../../../lib/regulated-format";
import { showToast } from "../../../lib/toast";

export default function RegulatedCategoriesScreen() {
  const router = useRouter();
  const { data: sections = [], isLoading, isFetching, refetch } = useTrackedCategories();
  const toggle = useToggleTrackedCategory();

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        largeTitle="Regulated"
        leading={<NavBackButton label="More" onPress={() => router.back()} />}
        trailing={
          <NavAction label="New" bold onPress={() => router.push("/(operator)/regulated/new")} />
        }
      />
      <ScrollView
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={isFetching && !isLoading} onRefresh={refetch} />
        }
      >
        {isLoading ? (
          <View style={styles.center}>
            <ActivityIndicator color={ios.brand} />
          </View>
        ) : sections.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.empty}>No regulated sections yet.</Text>
            <Pressable
              style={styles.primaryBtn}
              onPress={() => router.push("/(operator)/regulated/new")}
            >
              <Ionicons name="add" size={16} color="#fff" />
              <Text style={styles.primaryBtnText}>New section</Text>
            </Pressable>
          </View>
        ) : (
          <View style={{ paddingHorizontal: 16, gap: 8, paddingBottom: 24 }}>
            {sections.map((s) => (
              <SectionRow
                key={s.id}
                section={s}
                toggling={toggle.isPending}
                onPress={() => router.push(`/(operator)/regulated/${s.id}`)}
                onToggle={() =>
                  toggle.mutate(s.id, {
                    onSuccess: (updated) =>
                      showToast(updated.active ? `${s.name} activated` : `${s.name} deactivated`),
                    onError: (e: any) =>
                      showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
                  })
                }
              />
            ))}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function SectionRow({
  section,
  toggling,
  onPress,
  onToggle,
}: {
  section: TrackedCategory;
  toggling: boolean;
  onPress: () => void;
  onToggle: () => void;
}) {
  return (
    <Pressable style={[styles.row, !section.active && { opacity: 0.6 }]} onPress={onPress}>
      <View style={styles.rowHead}>
        <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Ionicons name="shield-checkmark-outline" size={16} color={ios.brand} />
          <Text style={styles.title} numberOfLines={1}>
            {section.name}
          </Text>
        </View>
        <View style={{ flexDirection: "row", gap: 6 }}>
          {section.requiresLicense ? (
            <Pill variant="orange" small>
              License
            </Pill>
          ) : null}
          <Pill variant={section.active ? "green" : "gray"} small>
            {section.active ? "Active" : "Off"}
          </Pill>
        </View>
      </View>
      <Text style={styles.sub} numberOfLines={1}>
        {taxRuleLabel(section)} · {treatmentLabel(section.invoiceTreatment)} ·{" "}
        {section.productCount} {section.productCount === 1 ? "product" : "products"}
      </Text>
      <Pressable style={styles.toggleBtn} onPress={onToggle} disabled={toggling} hitSlop={6}>
        <Ionicons name="power-outline" size={13} color={ios.label2} />
        <Text style={styles.toggleBtnText}>{section.active ? "Deactivate" : "Activate"}</Text>
      </Pressable>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center", gap: 14 },
  empty: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label2 },
  primaryBtn: {
    backgroundColor: ios.brand,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 12,
  },
  primaryBtnText: { color: "#fff", fontSize: 14, fontFamily: "Inter_600SemiBold" },
  row: { backgroundColor: ios.bgElev, borderRadius: 12, padding: 14, gap: 8 },
  rowHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  title: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label, letterSpacing: -0.2 },
  sub: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2 },
  toggleBtn: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    backgroundColor: ios.fill3,
  },
  toggleBtnText: { fontSize: 12, fontFamily: "Inter_500Medium", color: ios.label2 },
});
```

### WP2.4 — `apps/mobile/app/(operator)/regulated/new.tsx` (NEW)

```tsx
import { useRouter } from "expo-router";
import {
  RegulatedCategoryForm,
  emptyRegulatedCategoryForm,
} from "../../../components/RegulatedCategoryForm";
import { useCreateTrackedCategory } from "../../../lib/api/tracked-categories";
import { showToast } from "../../../lib/toast";

export default function NewRegulatedCategoryScreen() {
  const router = useRouter();
  const mut = useCreateTrackedCategory();

  return (
    <RegulatedCategoryForm
      title="New section"
      submitLabel={mut.isPending ? "Saving…" : "Save"}
      submitting={mut.isPending}
      initial={emptyRegulatedCategoryForm()}
      onSubmit={(payload) => {
        mut.mutate(payload, {
          onSuccess: (created) => {
            showToast("Section created");
            router.replace(`/(operator)/regulated/${created.id}`);
          },
          onError: (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
        });
      }}
    />
  );
}
```

### WP2.5 — `apps/mobile/app/(operator)/regulated/[id]/edit.tsx` (NEW)

```tsx
import { ActivityIndicator, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { RegulatedCategoryForm } from "../../../../components/RegulatedCategoryForm";
import {
  useTrackedCategory,
  useUpdateTrackedCategory,
} from "../../../../lib/api/tracked-categories";
import { showToast } from "../../../../lib/toast";

export default function EditRegulatedCategoryScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: category, isLoading } = useTrackedCategory(id);
  const mut = useUpdateTrackedCategory();

  if (isLoading || !category) {
    return (
      <View
        style={{ flex: 1, backgroundColor: ios.bg, alignItems: "center", justifyContent: "center" }}
      >
        <ActivityIndicator color={ios.brand} />
      </View>
    );
  }

  return (
    <RegulatedCategoryForm
      title="Edit section"
      submitLabel={mut.isPending ? "Saving…" : "Save"}
      submitting={mut.isPending}
      initial={{
        name: category.name,
        taxType: category.taxType,
        rate: String(category.rate ?? "0"),
        unitBasis: category.unitBasis ?? "",
        priceIncludesTax: category.priceIncludesTax,
        invoiceTreatment: category.invoiceTreatment,
        requiresLicense: category.requiresLicense,
        reportTemplate: category.reportTemplate,
        reportCadence: category.reportCadence,
        active: category.active,
      }}
      onSubmit={(payload) => {
        if (!id) return;
        mut.mutate(
          { id, data: payload },
          {
            onSuccess: () => {
              showToast("Section updated");
              router.back();
            },
            onError: (e: any) =>
              showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
          },
        );
      }}
    />
  );
}
```

### WP2.6 — `apps/mobile/app/(operator)/regulated/[id].tsx` (NEW) — detail + subcategory manager

Mirrors web's `SectionPanel` (fields + toggle) and inline `SubcategoryManager` (add/rename/toggle),
translated to RN screen conventions (card layout like `products/[id].tsx`, inline-rename via local
row state instead of a native prompt — `Alert.prompt` is iOS-only, not cross-platform).

```tsx
import { useState } from "react";
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
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavAction, NavBackButton, NavBar, Pill } from "@routeflow/ui/mobile/ios";
import {
  useTrackedCategory,
  useToggleTrackedCategory,
  useTrackedSubcategories,
  useCreateSubcategory,
  useUpdateSubcategory,
  useToggleSubcategory,
  type TrackedSubcategory,
} from "../../../lib/api/tracked-categories";
import { taxRuleLabel, treatmentLabel } from "../../../lib/regulated-format";
import { showToast } from "../../../lib/toast";

export default function RegulatedCategoryDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: section, isLoading } = useTrackedCategory(id);
  const toggle = useToggleTrackedCategory();

  if (isLoading || !section) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar inlineTitle="Section" leading={<NavBackButton onPress={() => router.back()} />} />
        <View style={styles.center}>
          <ActivityIndicator color={ios.brand} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Section"
        leading={<NavBackButton label="Back" onPress={() => router.back()} />}
        trailing={
          <NavAction
            label="Edit"
            bold
            onPress={() => router.push(`/(operator)/regulated/${id}/edit`)}
          />
        }
      />
      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={{ paddingHorizontal: 16, paddingTop: 12, gap: 14 }}>
          <View style={styles.card}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Ionicons name="shield-checkmark-outline" size={18} color={ios.brand} />
              <Text style={styles.name}>{section.name}</Text>
            </View>
            <View style={{ flexDirection: "row", gap: 6, marginTop: 8 }}>
              {section.requiresLicense ? <Pill variant="orange">License required</Pill> : null}
              <Pill variant={section.active ? "green" : "gray"}>
                {section.active ? "Active" : "Off"}
              </Pill>
            </View>
            <Row label="Tax" value={taxRuleLabel(section)} />
            <Row label="Invoice treatment" value={treatmentLabel(section.invoiceTreatment)} />
            <Row label="Report" value={`${section.reportTemplate} · ${section.reportCadence}`} />
            <Row label="Products" value={String(section.productCount)} />
          </View>

          <Pressable
            style={styles.assignBtn}
            onPress={() => router.push(`/(operator)/regulated/${id}/assign-products`)}
          >
            <Ionicons name="cube-outline" size={16} color={ios.brand} />
            <Text style={styles.assignBtnText}>Assign products</Text>
          </Pressable>

          <SubcategoryManager categoryId={id!} />

          <Pressable
            style={styles.toggleBtn}
            onPress={() =>
              toggle.mutate(id!, {
                onSuccess: (updated) =>
                  showToast(updated.active ? "Section activated" : "Section deactivated"),
                onError: (e: any) =>
                  showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
              })
            }
            disabled={toggle.isPending}
          >
            <Ionicons name="power-outline" size={16} color={ios.label} />
            <Text style={styles.toggleBtnText}>
              {section.active ? "Deactivate section" : "Activate section"}
            </Text>
          </Pressable>
        </View>
        <View style={{ height: 24 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue}>{value}</Text>
    </View>
  );
}

function SubcategoryManager({ categoryId }: { categoryId: string }) {
  const { data: subs = [], isLoading } = useTrackedSubcategories(categoryId);
  const create = useCreateSubcategory();
  const update = useUpdateSubcategory();
  const toggleSub = useToggleSubcategory();

  const [newName, setNewName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const err = (e: any, fallback: string) => showToast(e?.response?.data?.message ?? fallback);

  const addSub = () => {
    const name = newName.trim();
    if (!name) return;
    create.mutate(
      { categoryId, name },
      {
        onSuccess: () => {
          setNewName("");
          showToast(`Subcategory "${name}" added`);
        },
        onError: (e) => err(e, "Failed to add subcategory"),
      },
    );
  };

  const startRename = (s: TrackedSubcategory) => {
    setRenamingId(s.id);
    setRenameValue(s.name);
  };
  const saveRename = (s: TrackedSubcategory) => {
    const name = renameValue.trim();
    if (!name || name === s.name) {
      setRenamingId(null);
      return;
    }
    update.mutate(
      { categoryId, subId: s.id, data: { name } },
      {
        onSuccess: () => {
          setRenamingId(null);
          showToast("Subcategory renamed");
        },
        onError: (e) => err(e, "Failed to rename subcategory"),
      },
    );
  };

  const toggleActive = (s: TrackedSubcategory) =>
    toggleSub.mutate(
      { categoryId, subId: s.id },
      {
        onSuccess: (updated) =>
          showToast(updated.active ? `${s.name} activated` : `${s.name} deactivated`),
        onError: (e) => err(e, "Failed to update subcategory"),
      },
    );

  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>Subcategories</Text>
      {isLoading ? (
        <ActivityIndicator color={ios.brand} style={{ marginVertical: 8 }} />
      ) : subs.length === 0 ? (
        <Text style={styles.subEmpty}>None yet — add subcategories to classify products.</Text>
      ) : (
        subs.map((s) => (
          <View key={s.id} style={styles.subRow}>
            {renamingId === s.id ? (
              <>
                <TextInput
                  autoFocus
                  value={renameValue}
                  onChangeText={setRenameValue}
                  style={styles.subInput}
                  onSubmitEditing={() => saveRename(s)}
                />
                <Pressable onPress={() => saveRename(s)} hitSlop={8}>
                  <Ionicons name="checkmark" size={18} color={ios.brand} />
                </Pressable>
                <Pressable onPress={() => setRenamingId(null)} hitSlop={8}>
                  <Ionicons name="close" size={18} color={ios.label3} />
                </Pressable>
              </>
            ) : (
              <>
                <Text
                  style={[styles.subName, !s.active && { color: ios.label3 }]}
                  numberOfLines={1}
                >
                  {s.name}
                  {!s.active ? " (off)" : ""}
                </Text>
                <Text style={styles.subCount}>{s.productCount}</Text>
                <Pressable onPress={() => startRename(s)} hitSlop={8}>
                  <Ionicons name="pencil-outline" size={16} color={ios.label2} />
                </Pressable>
                <Pressable
                  onPress={() => toggleActive(s)}
                  disabled={toggleSub.isPending}
                  hitSlop={8}
                >
                  <Ionicons name="power-outline" size={16} color={ios.label2} />
                </Pressable>
              </>
            )}
          </View>
        ))
      )}
      <View style={styles.subAddRow}>
        <TextInput
          value={newName}
          onChangeText={setNewName}
          placeholder="Add a subcategory…"
          placeholderTextColor={ios.label3}
          style={styles.subInput}
          onSubmitEditing={addSub}
        />
        <Pressable
          style={[styles.subAddBtn, !newName.trim() && { opacity: 0.4 }]}
          onPress={addSub}
          disabled={!newName.trim() || create.isPending}
        >
          <Text style={styles.subAddBtnText}>Add</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center" },
  card: { backgroundColor: ios.bgElev, borderRadius: 14, padding: 14, gap: 4 },
  cardTitle: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label, marginBottom: 6 },
  name: { fontSize: 20, fontFamily: "Inter_700Bold", color: ios.label, letterSpacing: -0.3 },
  detailRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 6 },
  detailLabel: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2 },
  detailValue: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.label },
  assignBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: ios.brandWash,
    borderRadius: 12,
    paddingVertical: 12,
  },
  assignBtnText: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: ios.brand },
  subEmpty: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label3, paddingVertical: 4 },
  subRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
  },
  subName: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label, flex: 1 },
  subCount: { fontSize: 11, fontFamily: "Inter_400Regular", color: ios.label3 },
  subInput: {
    flex: 1,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: ios.label,
    backgroundColor: ios.fill3,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  subAddRow: { flexDirection: "row", gap: 8, marginTop: 8, alignItems: "center" },
  subAddBtn: {
    backgroundColor: ios.brand,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  subAddBtnText: { color: "#fff", fontSize: 13, fontFamily: "Inter_600SemiBold" },
  toggleBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: ios.bgElev,
    paddingVertical: 14,
    borderRadius: 12,
  },
  toggleBtnText: { fontSize: 15, fontFamily: "Inter_500Medium", color: ios.label },
});
```

### WP2.7 — `apps/mobile/app/(operator)/regulated/[id]/assign-products.tsx` (NEW) — bulk assign

Mirrors `apps/web/components/AssignProductsModal.tsx`: single full-catalog fetch (NOT the
paginated `useAdminProductsInfinite`), checkbox rows, diff-and-save. Seeds the checked set once
per screen mount from current membership (`p.trackedCategoryId === id`) via a `hasSeeded` ref —
same guard idiom as the web modal's `seeded` ref, adapted for a screen instead of a re-openable
modal (a fresh navigation already gives a fresh component instance, so there's no `isOpen` reset
to replicate).

```tsx
import { useMemo, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavAction, NavBackButton, NavBar, SearchBar } from "@routeflow/ui/mobile/ios";
import { useAdminProducts, type AdminProduct } from "../../../../lib/api/admin";
import {
  useTrackedCategories,
  useAssignProductsToCategory,
  useUnassignProductsFromCategory,
} from "../../../../lib/api/tracked-categories";
import { displayProductName } from "../../../../lib/product-display";
import { showToast } from "../../../../lib/toast";

export default function AssignProductsScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const hasSeeded = useRef(false);

  // Single fetch-all call (limit:0 sentinel — see WP2 header note), NOT the
  // paginated admin hook: seeding "currently assigned" from a partial page
  // would silently unassign not-yet-loaded products on Save.
  const { data, isLoading } = useAdminProducts({ limit: 0 });
  const { data: categories = [] } = useTrackedCategories();
  const assign = useAssignProductsToCategory();
  const unassign = useUnassignProductsFromCategory();

  const products = useMemo(() => data?.data ?? [], [data]);
  const catName = useMemo(() => {
    const m: Record<string, string> = {};
    for (const c of categories) m[c.id] = c.name;
    return m;
  }, [categories]);

  if (!hasSeeded.current && products.length > 0) {
    hasSeeded.current = true;
    selected.clear(); // defensive no-op on first run (Set starts empty)
    for (const p of products) if (p.trackedCategoryId === id) selected.add(p.id);
    setSelected(new Set(selected));
  }

  const q = search.trim().toLowerCase();
  const displayName = (p: AdminProduct) => displayProductName(p, products);
  const visible = q
    ? products.filter(
        (p) => displayName(p).toLowerCase().includes(q) || (p.sku ?? "").toLowerCase().includes(q),
      )
    : products;

  const toggle = (pid: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(pid) ? next.delete(pid) : next.add(pid);
      return next;
    });

  const [saving, setSaving] = useState(false);
  const handleSave = async () => {
    const toAssign = products
      .filter((p) => selected.has(p.id) && p.trackedCategoryId !== id)
      .map((p) => p.id);
    const toUnassign = products
      .filter((p) => !selected.has(p.id) && p.trackedCategoryId === id)
      .map((p) => p.id);
    if (toAssign.length === 0 && toUnassign.length === 0) {
      router.back();
      return;
    }
    setSaving(true);
    try {
      if (toAssign.length) await assign.mutateAsync({ id: id!, productIds: toAssign });
      if (toUnassign.length) await unassign.mutateAsync({ id: id!, productIds: toUnassign });
      showToast(`${toAssign.length} added · ${toUnassign.length} removed`);
      router.back();
    } catch (e: any) {
      showToast(e?.response?.data?.message ?? e?.message ?? "Failed to update products.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Assign products"
        leading={<NavBackButton onPress={() => router.back()} />}
        trailing={<NavAction label={saving ? "Saving…" : "Save"} bold onPress={handleSave} />}
      />
      <SearchBar placeholder="Search products…" value={search} onChangeText={setSearch} />
      <Text style={styles.hint}>
        {selected.size} selected · checking a product in another section moves it here.
      </Text>
      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={ios.brand} />
        </View>
      ) : (
        <FlatList
          data={visible}
          keyExtractor={(p) => p.id}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24 }}
          ListEmptyComponent={
            <View style={styles.center}>
              <Text style={styles.empty}>No products match.</Text>
            </View>
          }
          renderItem={({ item }) => {
            const checked = selected.has(item.id);
            const otherCat =
              item.trackedCategoryId && item.trackedCategoryId !== id
                ? catName[item.trackedCategoryId]
                : null;
            return (
              <Pressable style={styles.row} onPress={() => toggle(item.id)}>
                <Ionicons
                  name={checked ? "checkbox" : "square-outline"}
                  size={20}
                  color={checked ? ios.brand : ios.label3}
                />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.rowName} numberOfLines={1}>
                    {displayName(item)}
                  </Text>
                  {item.sku ? (
                    <Text style={styles.rowSub} numberOfLines={1}>
                      {item.sku}
                    </Text>
                  ) : null}
                </View>
                {otherCat ? (
                  <View style={styles.otherBadge}>
                    <Text style={styles.otherBadgeText}>in {otherCat}</Text>
                  </View>
                ) : null}
              </Pressable>
            );
          }}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center" },
  empty: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label2 },
  hint: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10 },
  rowName: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label },
  rowSub: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label3, marginTop: 1 },
  otherBadge: {
    backgroundColor: ios.system.orangeWash,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  otherBadgeText: { fontSize: 10, fontFamily: "Inter_500Medium", color: ios.system.orangeInk },
});
```

> Implementer note: the "seed on first data" block above mutates `selected` directly before
> calling `setSelected` purely to build the initial Set contents in one pass — if this pattern
> trips a lint rule (mutating state outside a setter), rewrite as a `useEffect` with a
> `hasSeeded` ref guard instead (functionally identical, cleaner): `React.useEffect(() => { if
(hasSeeded.current || products.length === 0) return; hasSeeded.current = true;
setSelected(new Set(products.filter(p => p.trackedCategoryId === id).map(p => p.id))); },
[products]);`. Either is acceptable; prefer the `useEffect` form if in doubt.

### WP2.8 — `apps/mobile/lib/api/admin.ts` (EDIT)

Widen `AdminProduct` (used by WP2.7's assign screen) with the tracked-category scalar. Find the
interface (~L369-390) and add one field:

```ts
export interface AdminProduct {
  id: string;
  name: string;
  barcode?: string;
  sku?: string;
  unit: string;
  unitsPerBox?: number | null;
  pricePerUnit: number | string;
  priceTier2?: number | string;
  priceTier3?: number | string;
  priceTier4?: number | string;
  priceTier5?: number | string;
  standardCost?: number | string | null;
  currentStock: number | string;
  reorderPoint?: number | null;
  reorderQty?: number | null;
  isActive: boolean;
  parentProductId?: string | null;
  parent?: { id: string; name: string } | null;
  supplier?: { id: string; name: string };
  /** REG-2/REG-3: the product's regulated-section tag, if any. */
  trackedCategoryId?: string | null;
}
```

(Add just the `trackedCategoryId` line — everything else in the interface is unchanged.)

### WP2.9 — `apps/mobile/app/(operator)/(tabs)/more.tsx` (EDIT) — nav entry

Insert a new `ListRow` into the existing `<ListGroup header="MANAGE">`, immediately **after** the
"Products" row (~L65-72) and before "Invoices":

```tsx
<ListRow
  icon={<Ionicons name="shield-checkmark-outline" size={16} color={ios.brand} />}
  iconBg={ios.brandWash}
  title="Regulated"
  subtitle="Tax, licensing & subcategories"
  onPress={() => router.push("/(operator)/regulated")}
  chevron
/>
```

**Acceptance for WP2 (all sub-parts):** operator can navigate More → Regulated → see the section
list → New → fill form → Save → lands on the new section's detail → Edit → change a field → Save
→ change reflects; add/rename/toggle a subcategory inline on the detail screen; Assign products →
search, check/uncheck, Save → membership updates and the section's `productCount` refreshes (via
the WP1 invalidation) without a manual pull-to-refresh.

---

## WP3 — Product form regulated picker (REG-3)

Everything here targets the **one shared** `ProductForm` component — no separate work for create
vs edit.

### WP3.1 — `apps/mobile/lib/api/products.ts` (EDIT)

Widen `CreateProductDto` (used directly by create, and via `Partial<CreateProductDto>` by
`useUpdateProduct`) — add after `variantName` (~L72):

```ts
  /** Flavor/variety label; required when parentProductId is set. */
  variantName?: string;
  /** Regulated section tag. Create: omit when unset. Edit: send `null` to clear. */
  trackedCategoryId?: string | null;
  /** Regulated subcategory tag (must belong to trackedCategoryId). Same null-to-clear rule. */
  trackedSubcategoryId?: string | null;
```

### WP3.2 — `apps/mobile/lib/product-form.ts` (EDIT)

1. **`ProductFormValues`** — add after `parentName?: string;`:

```ts
  /** Regulated section id, "" = none. */
  trackedCategoryId: string;
  /** Section's display name — carried alongside the id so the picker can show a
   *  since-deactivated current section without a second lookup (same pattern as
   *  `parentName` above for the "Variant of" picker). */
  trackedCategoryName?: string;
  /** Regulated subcategory id, "" = none. */
  trackedSubcategoryId: string;
```

2. **`emptyProductForm()`** — add to the returned object (alongside `variantName: ""`):

```ts
    trackedCategoryId: "",
    trackedCategoryName: undefined,
    trackedSubcategoryId: "",
```

3. **`productFormFromValues(p)`** — add to the returned object (alongside `variantName: p.variantName ?? ""`):

```ts
    trackedCategoryId: p.trackedCategory?.id ?? p.trackedCategoryId ?? "",
    trackedCategoryName: p.trackedCategory?.name,
    trackedSubcategoryId: p.trackedSubcategory?.id ?? p.trackedSubcategoryId ?? "",
```

4. **`SubmitPayload`** — add after `variantName?: string;`:

```ts
  trackedCategoryId?: string | null;
  trackedSubcategoryId?: string | null;
```

5. **`buildProductPayload`** — add a second parameter with a default so the existing call sites
   and the existing test file (`__tests__/operator-create-forms.test.ts`, which calls
   `buildProductPayload(form)` with no second arg) keep compiling/passing unchanged:

```ts
export function buildProductPayload(
  form: ProductFormValues,
  mode: "create" | "edit" = "create",
): SubmitPayload | { error: string } {
```

and in the return object (after `variantName: parentProductId ? variantName : undefined,`),
add:

```ts
    trackedCategoryId: mode === "edit"
      ? form.trackedCategoryId.trim() || null
      : form.trackedCategoryId.trim() || undefined,
    trackedSubcategoryId: mode === "edit"
      ? form.trackedSubcategoryId.trim() || null
      : form.trackedSubcategoryId.trim() || undefined,
```

This is the exact web convention restated for mobile: **create omits the key when blank**
(`undefined` keys are dropped by the axios/JSON body, matching every other optional field in
this file, e.g. `sku`); **edit sends explicit `null`** when blank so a cleared picker actually
clears the tag server-side (the API only clears on an explicit `null` — see the "Shipped API"
section above; omitting/`undefined` on PATCH means "no change").

### WP3.3 — `apps/mobile/components/ProductForm.tsx` (EDIT)

1. **Imports** — add:

```ts
import { OptionPickerSheet } from "./OptionPickerSheet";
import { useTrackedCategories, useTrackedSubcategories } from "../lib/api/tracked-categories";
import { sectionPickerOptions, subcategoryPickerOptions } from "../lib/regulated-format";
```

2. **`ProductFormProps`** — add a required `mode` field:

```ts
interface ProductFormProps {
  title: string;
  submitLabel: string;
  initial: ProductFormValues;
  submitting?: boolean;
  /** REG-3: create omits blank tracked-category fields, edit sends explicit null to clear. */
  mode: "create" | "edit";
  onSubmit: (payload: SubmitPayload) => void | Promise<void>;
}
```

3. **Component signature** — destructure `mode` and use it in `submit()`:

```ts
export function ProductForm({
  title,
  submitLabel,
  initial,
  submitting,
  mode,
  onSubmit,
}: ProductFormProps) {
  const router = useRouter();
  const [form, setForm] = React.useState<ProductFormValues>(initial);
  const [error, setError] = React.useState<string | null>(null);
  const [parentPickerOpen, setParentPickerOpen] = React.useState(false);
  const [sectionPickerOpen, setSectionPickerOpen] = React.useState(false);
  const [subcategoryPickerOpen, setSubcategoryPickerOpen] = React.useState(false);

  const set = <K extends keyof ProductFormValues>(key: K, value: ProductFormValues[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const isVariant = !!form.parentProductId;

  // Regulated section + subcategory pickers (both optional). The subcategory
  // list is scoped to the section currently chosen in the form; `current` uses
  // the ORIGINAL initial value (not the live form) so re-selecting a section
  // doesn't change what counts as "the tag this product started with" — mirrors
  // web's product?.trackedCategory (stable across the edit session).
  const { data: sections = [] } = useTrackedCategories({ active: true });
  const { data: subcategories = [] } = useTrackedSubcategories(form.trackedCategoryId || undefined);
  const sectionOptions = sectionPickerOptions(
    sections,
    initial.trackedCategoryId
      ? { id: initial.trackedCategoryId, name: initial.trackedCategoryName ?? "Unknown section" }
      : null,
  );
  const subcategoryOptions = subcategoryPickerOptions(subcategories, form.trackedSubcategoryId);

  const submit = () => {
    const result = buildProductPayload(form, mode);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setError(null);
    onSubmit(result);
  };
```

4. **JSX** — add a new `FormSection` right after the existing "Identifiers" section and before
   "Pricing" (i.e. after the closing `</FormSection>` that follows the "Pieces per box" field,
   before `<FormSection title="Pricing">`), gated exactly like web (`sectionOptions.length > 0`):

```tsx
{
  sectionOptions.length > 0 ? (
    <FormSection title="Regulated (optional)">
      <FormField label="Regulated section">
        <Pressable style={styles.picker} onPress={() => setSectionPickerOpen(true)}>
          <View style={styles.pickerInner}>
            <Text style={styles.pickerText} numberOfLines={1}>
              {form.trackedCategoryId
                ? (sectionOptions.find((s) => s.id === form.trackedCategoryId)?.name ?? "—")
                : "None (not regulated)"}
            </Text>
            <Ionicons name="chevron-down" size={14} color={ios.label3} />
          </View>
        </Pressable>
      </FormField>
      <FormField label="Subcategory">
        <Pressable
          style={[styles.picker, !form.trackedCategoryId && { opacity: 0.5 }]}
          onPress={() => form.trackedCategoryId && setSubcategoryPickerOpen(true)}
          disabled={!form.trackedCategoryId}
        >
          <View style={styles.pickerInner}>
            <Text style={styles.pickerText} numberOfLines={1}>
              {!form.trackedCategoryId
                ? "Pick a section first"
                : form.trackedSubcategoryId
                  ? (subcategoryOptions.find((s) => s.id === form.trackedSubcategoryId)?.name ??
                    "—")
                  : "None"}
            </Text>
            <Ionicons name="chevron-down" size={14} color={ios.label3} />
          </View>
        </Pressable>
      </FormField>
    </FormSection>
  ) : null;
}
```

5. **New `OptionPickerSheet` pair** — add alongside the existing `ProductPickerSheet` at the
   bottom of the returned `<FormSheet>` tree:

```tsx
      <OptionPickerSheet
        visible={sectionPickerOpen}
        title="Regulated section"
        options={sectionOptions.map((s) => ({ id: s.id, label: s.name + (s.inactive ? " (inactive)" : "") }))}
        selectedId={form.trackedCategoryId}
        nullable
        nullLabel="None (not regulated)"
        onClose={() => setSectionPickerOpen(false)}
        onSelect={(opt) => {
          set("trackedCategoryId", opt.id);
          set("trackedSubcategoryId", "");
          setSectionPickerOpen(false);
        }}
      />
      <OptionPickerSheet
        visible={subcategoryPickerOpen}
        title="Subcategory"
        options={subcategoryOptions.map((s) => ({ id: s.id, label: s.name + (s.inactive ? " (inactive)" : "") }))}
        selectedId={form.trackedSubcategoryId}
        nullable
        nullLabel="None"
        onClose={() => setSubcategoryPickerOpen(false)}
        onSelect={(opt) => {
          set("trackedSubcategoryId", opt.id);
          setSubcategoryPickerOpen(false);
        }}
      />
```

No new styles needed — `styles.picker`/`styles.pickerInner`/`styles.pickerText` already exist
in this file (reused from the "Variant of" picker).

### WP3.4 — `apps/mobile/app/(operator)/products/new.tsx` (EDIT)

Add `mode="create"` to the existing `<ProductForm>` call:

```tsx
    <ProductForm
      title="New product"
      submitLabel={mut.isPending ? "Saving…" : "Save"}
      submitting={mut.isPending}
      mode="create"
      initial={initial}
      onSubmit={(payload) => {
```

### WP3.5 — `apps/mobile/app/(operator)/products/[id]/edit.tsx` (EDIT)

Add `mode="edit"` to the existing `<ProductForm>` call:

```tsx
    <ProductForm
      title="Edit product"
      submitLabel={mut.isPending ? "Saving…" : "Save"}
      submitting={mut.isPending}
      mode="edit"
      initial={productFormFromValues(product)}
      onSubmit={(payload) => {
```

### WP3.6 — Extend `apps/mobile/__tests__/operator-create-forms.test.ts` (EDIT)

Add new `describe` cases (near the existing `buildProductPayload` block) — these test the pure
`lib/product-form.ts` change only, no RN render:

- `buildProductPayload({...emptyProductForm(), name:"X", pricePerUnit:"1", trackedCategoryId:"sec-1", trackedSubcategoryId:"sub-1"})` (default `mode`, i.e. create) →
  `result.trackedCategoryId === "sec-1"` and `result.trackedSubcategoryId === "sub-1"`.
- Same form with `trackedCategoryId: ""` on create → `result.trackedCategoryId === undefined`
  (key omitted, not `null`).
- Same form with `trackedCategoryId: ""`, called as `buildProductPayload(form, "edit")` →
  `result.trackedCategoryId === null` (explicit clear).
- `productFormFromValues({ trackedCategory: { id: "sec-1", name: "Alcohol" }, trackedSubcategory: { id: "sub-1", name: "Beer" } })` →
  `trackedCategoryId === "sec-1"`, `trackedCategoryName === "Alcohol"`, `trackedSubcategoryId === "sub-1"`.
- `productFormFromValues({})` → `trackedCategoryId === ""`, `trackedCategoryName === undefined`,
  `trackedSubcategoryId === ""` (matches `emptyProductForm()`).

**Acceptance for WP3 (all sub-parts):** creating a product with a section+subcategory selected
sends both ids in the POST body; creating with none selected omits both keys; editing a product
that has a section, then clearing it, sends `trackedCategoryId: null` AND
`trackedSubcategoryId: null` in the PATCH body (server auto-nulls the subcategory when the section
clears, per `products.service.ts` L478-479, but the client should not rely on that silently —
explicit null on both is correct here since clearing the section also clears the form's
subcategory field via step 5 above); a section deactivated after being tagged on a product still
shows (flagged "(inactive)") in that product's edit picker; `npx jest --selectProjects mobile
operator-create-forms` passes including the new cases.

---

## WP5 — Code-map update

**File:** `.claude/code-map/mobile.md` (EDIT)

Add one new "Where to find" row (insert alphabetically-adjacent to the existing "Regulated-license
guard (operator)" row, or immediately after it) summarizing:

```
Regulated categories manager + product picker (P10-REG-A) | `lib/api/tracked-categories.ts`
(hooks mirroring web, dash-style keys `["tracked-categories"]`/`["tracked-category",id]`/
`["tracked-subcategories",categoryId]`) + `lib/regulated-format.ts` (pure
`sectionPickerOptions`/`subcategoryPickerOptions`/`taxRuleLabel`/`treatmentLabel`, mirrors web) +
`components/RegulatedCategoryForm.tsx` (shared create/edit form) + `app/(operator)/regulated/`
(`index.tsx` list, `new.tsx`, `[id].tsx` detail+subcategory manager, `[id]/edit.tsx`,
`[id]/assign-products.tsx` bulk assign via `useAdminProducts({limit:0})` fetch-all) — reached from
More → MANAGE → "Regulated". `ProductForm.tsx`/`lib/product-form.ts` gained a dependent
section→subcategory `OptionPickerSheet` picker on the shared create/edit form (`mode` param on
`buildProductPayload`: create omits blank tracked fields, edit sends explicit `null` to clear).
No role gate (mobile has none anywhere; API `@Roles(OPERATOR)` is the real enforcement). Test
`__tests__/regulated-format.test.ts` + extended `operator-create-forms.test.ts`.
```

Also bump `.claude/code-map/_meta.json` (`mappedSha`/`generatedAt`) per the standing code-map
routine — do this as the LAST commit of the increment, after WP1-4 land, so the recorded SHA is
accurate.

---

## Verify / gate

Mobile cannot be device/simulator-tested in this pipeline. The gate is:

1. `npm run check-types` (turbo `check-types` — must include `apps/mobile` cleanly; the DTO/type
   widenings in WP2.8/WP3.1/WP3.2 are the highest-risk spots for a type error).
2. `npm run lint` (turbo `lint`, per-workspace — mobile ESLint flat config).
3. `npx jest --selectProjects mobile` (or `npm run test` at the root) — must include the new
   `regulated-format.test.ts` and the extended `operator-create-forms.test.ts`, both green.
4. Code review of the diff against this plan (screen navigation wiring, query-key spelling exactly
   matching WP1, the create-vs-edit null/undefined convention in WP3.2/WP3.3).

Do not attempt `preview_start`/browser verification for mobile screens — Expo Go can't run this
app (per `reference_mobile_web_testing_constraints`) and `preview_start` is bound to the main
checkout, not a worktree (`reference_preview_tools_bound_to_main_checkout`). Static
analysis + pure-logic tests + review is the full gate for this increment.

## Money note

None. This increment is pure config/display plumbing (section/subcategory metadata + product
tagging) — no line/tax/total math is introduced or touched. Category tax computation stays
100% server-authoritative (`apps/api/src/regulated/` / order & invoice services); the mobile
`taxRuleLabel` helper only _displays_ the rate the server already computed/stores, it never
computes a chargeable amount. No `pricing.ts` mirror is affected.

## Ambiguities flagged for implementers / reviewer

1. **No client-side role gate** on `app/(operator)/regulated/` — deliberate, matches every other
   mobile manager screen; the API's `@Roles(OPERATOR)` guard is the real enforcement. Revisit only
   if the business explicitly wants TENANT_ADMIN-only on mobile too.
2. **Assign-products data source is `useAdminProducts({ limit: 0 })`**, a single up-to-10,000-row
   fetch, not the paginated `useAdminProductsInfinite` used by `products/index.tsx` — this is
   intentional (see WP2.7 rationale) and mirrors web exactly; do not "fix" it to use pagination.
3. **Screen location** — a new top-level `app/(operator)/regulated/` route group (reached from
   More → MANAGE), not a tab inside the existing 4-tab Settings screen. Settings' tab strip is a
   fixed enum (`General|Users|Branding|Integrations`) with no deep-link/tab-param support like
   web's `?tab=regulated`, and every other multi-screen manager (Order Templates, Credit Notes,
   Recurring Invoices, Payments, Reports) already lives at this same top level — this is the
   established mobile pattern, not a new one.
