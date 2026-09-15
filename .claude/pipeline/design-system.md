# RouteFlow design system (DERIVED)

Re-derived 2026-09-15 on `feat/crm-phase1` (replaces the 2026-08-31 cache). **Extend, don't
reinvent.** Every row cites a path; anything uncited does not exist.

## Tokens (web)

Source: `packages/config/tailwind.config.ts` (preset + `tailwindcss-animate`) via
`apps/web/tailwind.config.ts` (adds `background/foreground/primary`, semantic `fontSize`). CSS
vars: `apps/web/app/globals.css` `:root` ("Ledger").

- **Ink** `--ink-900 #0f1b2d` / `-700 #33425b` / `-500 #5c6b82` / `-400 #8b97ac` (+`-rgb` so
  `text-navy/70`, `bg-navy/10` work; `navy` = ink-900).
- **Surfaces** `--paper #fff`, `--canvas #f7f9fc` (body), `--sunken #edf1f6`, `--line #e2e8f0`,
  `--line-strong #d6dee8`; Tailwind `surface{DEFAULT,raised #f7f9fc,border #e2e8f0}`.
- **Brand** `brand.50–900` (500 `#14A39F`); `--primary: var(--brand-500)` (tenant-overridable,
  `components/tenant-provider.tsx`); `--accent*` per surface — `.surface-operator` on
  `app/(dashboard)/layout.tsx` (`--row-h 44px`, `--text-body 13.5px`).
- **Status** `success #16a34a/#dcfce7`, `warning #d97706/#fef3c7`, `danger #dc2626/#fee2e2`,
  `info #0284c7/#e0f2fe` → `text-danger`, `bg-danger-bg`, `border-danger/30`.
- **Radius** `sm 4` `ctl 6` (controls) `DEFAULT 8` `card 10` `lg 12` `xl 16` `full`.
- **Shadow** `card 0 1px 2px rgba(15,27,45,.05)` · `dropdown 0 8px 24px .14` · `modal 0 24px 64px .28`.
- **Type** `font-sans` Spline Sans (`app/layout.tsx:26`, next/font/google), `font-mono` Spline Sans
  Mono, `font-display` Instrument Serif. **Geist in `apps/web/fonts/` is marketing-only**
  (`app/fonts.ts`, scoped `.rf-marketing`). Semantic `display…caption` scale (dashboard code mostly uses raw `text-sm`/`text-xs`).
- **Utilities** (`globals.css`): `.money` `.mono` `.overline` (11px/600/uppercase section label)
  `.font-display` `.skeleton` (shimmer, reduced-motion off).
- **Spacing/breakpoints** stock Tailwind, no `screens` override → `sm 640 md 768 lg 1024 xl 1280`.
  No dark mode.

## Components — `@routeflow/ui/web` (`packages/ui/src/web/index.ts`)

| Export | Props / variants (actual) |
|---|---|
| `Button` | `variant` primary·secondary·ghost·danger·link; `size` sm h-7·md h-[34px]·lg h-10; `loading` (→`Loader2`+`aria-busy`+disabled), `href`, `leftIcon`, `rightIcon` |
| `Badge` | `variant` success·warning·danger·info·neutral **or** `status` (~45 keys incl. `CONVERTED`,`COMPLETED`,`CANCELLED`; **no** OPEN/QUALIFIED/LOST/DONE → pass `variant`+`label`) |
| `Input` `Textarea` `Select` | `label` (auto id/htmlFor), `error` (→`aria-invalid`+`aria-describedby`+`text-xs text-danger`), `register`; `Select` = native `<select>` `options[{value,label,disabled}]`,`placeholder` |
| `Modal` | Radix Dialog `open,onClose,title,description,footer,className,onEscapeKeyDown`; Title/Description always rendered; close `aria-label="Close"` |
| `Table` | TanStack `data,columns,onRowClick,isLoading` (5 pulse rows),`emptyState` (default "No data available"), `aria-sort`; **no pagination** |
| `Tabs` | `tabs[{key,label,badge}]`,`activeKey`,`onChange`; underline; `focus-visible:ring-inset` |
| `Skeleton`/`SkeletonRows` | `shape` line·block·circle; `aria-hidden` |
| `EmptyState` | `variant` orders·routes·customers·products·invoices·drivers·returns·inbox·data·custom; `icon,title,description,action` |
| `useToast` | `toast({title,description,variant,duration 4000,action{label,onClick}})`; viewport `fixed bottom-4 right-4 w-96 max-w-[calc(100vw-2rem)]` |
| `PageHeader` `Card` `cn` | `PageHeader{title,subtitle,action}` renders `h2` (top bar owns `h1`) |

Composites: `components/ConfirmDialog.tsx` `{open,onClose,onConfirm,title,description,
confirmLabel,variant danger·secondary,loading}`; `components/SortableTh.tsx`; `components/PlanGateNotice.tsx`
(GET 403 PLAN_GATE → warning toast + `upgradeHint()`); `app/(dashboard)/_components/gates/PlanGates.tsx`
`LockedPage{gate,title,children}` ("Not on your plan" card, `/choose-plan` CTA), `GraceBanner`, `InlineResolveModal`.

**MISSING (no shared export):** Pagination (local `estimates/page.tsx:965-1005` + `lib/hooks/useUrlPage.ts`),
Load-more (local button `deliveries/_components/OrderPickerPanel.tsx:164-173`), Tooltip (native
`title=`), Popover/Combobox (local `components/CategoryCombobox.tsx`), Checkbox (raw `<input
type=checkbox class="h-3.5 w-3.5 rounded border-surface-border text-brand-500 focus:ring-brand-500">`
`sales-agents/page.tsx:174`), single DatePicker (`<input type="date">`), live-region helper.

## State patterns (list screens) — reuse verbatim

- **Loading**: `Table isLoading`, or pulse rows `animate-pulse rounded bg-surface-raised`
  (`customers/page.tsx:935-939`); detail: `h-6 w-48` bar + 3 `h-28` cards (`suppliers/[id]/page.tsx:399-410`);
  addon resolving: `Loader2 h-8 w-8 animate-spin text-navy/70` centred (`sales-agents/page.tsx:133-138`).
- **Empty**: `EmptyState` in `Table emptyState`, unfiltered vs filtered + secondary sm "Clear filters"
  (`estimates/page.tsx:889-921`, `customers/page.tsx:955-975`).
- **Error**: `rounded-lg border border-danger/30 bg-danger-bg px-4 py-3` + `text-sm text-danger`
  (`customers/page.tsx:941-946`); retry: `<Button variant="secondary" size="sm" loading={isRefetching}>Try again</Button>`
  (`finance/payment-requests/page.tsx:306-318`); not-found: same banner "Supplier not found."
  (`suppliers/[id]/page.tsx:412-420`); crash: `app/(dashboard)/error.tsx`.
- **Inline warning**: `role="alert"` `border-amber-300 bg-amber-50 text-amber-900` + `AlertTriangle` (`routes/page.tsx:246-256`).
- **Mutations**: global `MutationCache.onError` toast (`app/providers.tsx:16-56`) — `HANDLED_CODES`
  allowlist + `READ_ONLY` branch (warning toast, `action` → `/choose-plan`); own error UI ⇒ add the code. Queries: `retry` 0 on 403, `staleTime 30s`, **`refetchOnWindowFocus:false`** (`:67`), no override anywhere.
- **401**: in-place re-auth dialog "You've been signed out" (`components/ReAuthProvider.tsx:125-145`).
  **Role deny**: `router.replace("/dashboard")` via `CUSTOMER_ALLOWED`/`DRIVER_ALLOWED`
  (`layout.tsx:239-241,305-313`) — **no 403 page exists**. **Ungranted addon page**: `LockedPage`
  over `<Card className="h-64" />` (`sales-agents/page.tsx:141-151`).
- **Offline (web)**: **none** — no `navigator.onLine`/indicator; network errors surface as axios "Network Error".
- **Destructive**: `ConfirmDialog`. **Undo**: toast `action`.

## Icons · motion · a11y

- `lucide-react` only; `h-4 w-4` default, `h-3.5 w-3.5` table chrome, `h-8 w-8` spinners. Names
  already imported (safe): `Contact` `Phone` `Mail` `Clock` `MessageSquare` `CheckSquare`
  `CheckCircle2` `RotateCcw` `ArrowRightLeft` `ArrowLeft` `Plus` `Search` `Trash2` `AlertTriangle`
  `Loader2` `Building2` `Users`. Bare checkout has no `node_modules` — verify any other name.
- Motion: `transition-colors` 150ms; `animate-spin/pulse`; Radix `animate-in fade-in-0 zoom-in-95`
  (`web/Modal.tsx:38-47`); sidebar `transition-[width] duration-200` (`layout.tsx:1314`). No framer-motion.
- A11y: `focus-visible:ring-2 ring-offset-2` (Button), `focus:ring-2 focus:ring-brand-500` (inputs);
  auto labels + `aria-invalid/describedby`; `aria-busy`; Modal titled; `role="alert"`/`"status"` ad hoc,
  no shared live region; no jsx-a11y plugin or written contrast/target rule → **WCAG 2.2 AA by default**.

## Mobile — `@routeflow/ui/mobile/ios`, tokens `@routeflow/ui/tokens`

`ios.*` (`packages/ui/src/tokens.ts:83+`): `bg #F2F2F7` `bgElev #fff` `brand #0B6E6B` `brandWash`
`system.{green,orange,red,yellow,purple}{Wash,Ink}` `separator` `rowMinH 44` `cardRadius 16`
`listRadius 12`; font `Inter_400Regular`. Exports (`mobile/ios/index.ts`): `NavBar{largeTitle|inlineTitle,
leading,trailing}` `NavBackButton{label}` `NavAction{label,bold}` `SearchBar` `FilterChipRow{chips,value,
onChange}` `SegmentedControl` `Pill{variant brand·green·orange·red·gray·yellow·purple,dot,small}`
`ListGroup{header,footer}`+`ListRow{icon,iconBg,title,subtitle,value,trailing,onPress,chevron}`
`IosEmptyState{icon,title,subtitle,actionLabel,onActionPress}`; `@routeflow/ui/mobile`: `MobileButton` `MobileInput`. Operator list convention (`(operator)/credit-notes/index.tsx:47-90`,
`customers/[id]/comments.tsx:113-135`): `SafeAreaView` → `NavBar largeTitle`+`NavAction "New"` →
`SearchBar` → `FilterChipRow` → `ScrollView`+`RefreshControl` → loading `ActivityIndicator
color={ios.brand}` (operator screens; `ShimmerBox` skeletons are driver/buyer only) → error "Couldn't
load X. Pull to retry." → empty "No X yet."/"No X match." + `Pressable` "Add X". Detail: `NavBar
inlineTitle`+`NavBackButton label`; Call/Text/Email via `Linking.openURL("tel:")` (`customers/[id].tsx:
145-170`). Feedback: `lib/toast.ts showToast`, `lib/confirm.ts confirm(title,msg,onConfirm,{confirmText,
destructive})`/`chooseAction(title,msg,actions)`. Offline: `components/OfflineBanner.tsx`; api-client
**queues every** non-FormData mutation (`lib/api-client.ts:120-166`, rejects `isOfflineQueued`;
`lib/offline-errors.ts classifyMutationError`). Addon: `lib/api/tobacco.ts useHasAddon`; More rows gated
inline (`(operator)/(tabs)/more.tsx:164`); new section → `lib/operator-tabs.ts SECTION_TO_TAB` (`:41`).

## How to add a dashboard screen

- `apps/web/app/(dashboard)/<area>/page.tsx` (+`[id]/page.tsx`, `_components/`), `"use client"`,
  `usePageTitle`, root `<div className="space-y-5 p-6"><PageHeader/>`.
- `apps/web/lib/api/<area>.ts`: `useQuery({queryKey:["<area>",params],queryFn:()=>apiClient.get(url,
  {params}).then(r=>r.data)})`; mutations invalidate `["<area>"]` (`lib/api/suppliers.ts:50-80`).
  Search `useUrlSearch()` (300ms, URL-synced); paging `useUrlPage()`; addon `useHasAddon` (`tobacco.ts:18`).
- Nav: `layout.tsx` `OPERATOR_NAV` (`:88-147`; `NavLeaf/NavGroup/NavSkeleton` `:83-86`); gated entries
  spliced in `DashboardShell` (`:1094-1150`) with `{kind:"skeleton",key}` while `useTenantAddons().isLoading`
  (rendered `:552-566`); role deny `*_ALLOWED` (`:239-241`).
- Forms: RHF+zod in `Modal` (`customers/_components/CustomerFormModal.tsx:5-9`, `:414-424`).
- Gate e2e neighbour: `e2e/18-sales-agents-gate.spec.ts:20-27` (`getByRole("navigation").getByText`).

## Order-edit page notes

`apps/web/app/(dashboard)/orders/[id]/page.tsx` (3538 lines). `EditableLineItems` is defined
in-file at **:861** and rendered at **:2656**.

Affordances already present on/near the add-product + substitute controls:

- **Add-product / scan row** (`:1341-1385`): container
  `flex items-center gap-2 rounded-lg border border-dashed border-brand-300 bg-brand-50 px-3 py-2`.
  Local `addLoading` state (`:907`) set in `handleScanEnter`'s `try/finally` (`:994`, `:1032`) swaps
  the leading icon: `addLoading ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-brand-400" />
: <Search className="h-4 w-4 shrink-0 text-brand-400" />` (`:1344-1349`). **The `<input>` itself is
  never disabled and the dropdown stays clickable while `addLoading` is true** — the icon swap is the
  only gate today.
- **Suggestion dropdown** (`:1387-1405`): rows are plain `<button type="button" onMouseDown={() => addProduct(p)}>`
  with `hover:bg-brand-50` — no `disabled`, no `aria-busy`.
- **Substitute trigger** (`:1222-1227`): `<button className="rounded px-2 py-1 text-xs text-navy/70
hover:bg-surface-raised hover:text-navy disabled:opacity-50" disabled={!pricingReady}
onClick={…}>Substitute</button>` — already gated with pattern (c) on pricing readiness
  (`disabled={!pricingReady}` + `disabled:opacity-50`), but NOT on the add/scan busy state.
  Sibling row actions follow the same shape: Undo `text-brand-600 hover:bg-brand-50` with
  `<RotateCcw className="h-3 w-3" />` (`:1193-1218`; the second Undo is `:1230-1250`),
  "Not available" `text-danger hover:bg-danger-bg` (`:1252-1257`), delete icon button with
  `title="Delete item"` (`:1258-1264`).
- **SubstitutePicker** (`:676-733`): 300ms debounce → `useProducts`; destructures only `{ data }`,
  so there is **no loading state** — it shows "No products found." (`:707`) during the first fetch.
- **Save bar** (`Save Draft` `:2719-2726`, `Save Changes` `:2803-2805`; the DRAFT/CHANGES label
  ternary is `:2644`): `<Button size="sm" loading={updateItems.isPending}>Save Draft</Button>` —
  the established busy affordance on this page (`Button.loading` → `Loader2` + `aria-busy` + `disabled`).
- **Custom-item form** (`:1408-1481`) shows the inline-error convention: `<p className="text-xs text-danger">{customError}</p>`.

**Reuse for a "pricing loading" gate**: the page's existing vocabulary is
(a) `Button loading={…}` for anything that is already a `Button`, (b) the `addLoading` →
`Loader2 h-4 w-4 animate-spin text-brand-400` icon swap in the scan row, and (c) raw buttons with
`disabled={pending}` + `disabled:opacity-50` (pattern at `:206-207`, `:251-252`, `:287-288`).
Extend the Substitute trigger's existing (c) condition to `disabled={!pricingReady || addLoading}`
(never a second `disabled` attribute) and gate the dropdown rows with (c); keep (b) as the visible
spinner.
