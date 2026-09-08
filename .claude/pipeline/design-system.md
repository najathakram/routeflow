# RouteFlow design system (DERIVED)

DERIVED from the codebase on 2026-08-31 at master `26037bd4`. Repo-level cache for the
dev-pipeline design-system lens — **extend, don't reinvent**. Every claim below cites a real
path; nothing here is a proposal.

## Tokens

Source of truth is the shared Tailwind preset + CSS custom properties. `apps/web/tailwind.config.ts`
consumes `packages/config/tailwind.config.ts` via `presets: [preset]`; there is **no**
tailwind config in `packages/ui`.

- **CSS vars** — `apps/web/app/globals.css` (`:root`, called "Ledger" tokens):
  - ink neutrals `--ink-900 #0f1b2d` / `--ink-700 #33425b` / `--ink-500 #5c6b82` / `--ink-400 #8b97ac`,
    plus `--ink-*-rgb` triples so Tailwind opacity modifiers work (`text-navy/70`, `bg-navy/10`).
  - surfaces `--paper #ffffff`, `--canvas #f7f9fc`, `--sunken #edf1f6`, `--line #e2e8f0`, `--line-strong #d6dee8`.
  - brand teal `--brand-700/600/500/300/50`; `--primary: var(--brand-500)` (+ `-strong/-deep/-soft/-mist/-foreground`).
  - `--accent{,-strong,-deep,-soft}` = the per-surface knob; `--background: var(--paper)`, `--foreground: var(--ink-700)`.
  - status: `--success #16a34a` / `--warning #d97706` / `--danger #dc2626` / `--info #0284c7`, each with a `-bg`.
  - shape/elevation: `--r-ctl 6px`, `--r-card 10px`, `--sh-card`, `--sh-drop`, `--sh-modal`.
  - density knob: `--row-h 44px`, `--text-body 13.5px` (operator).
- **Surface classes** override accent + density: `.surface-buyer` (emerald `#059669`, `--row-h 52px`,
  `--text-body 14px`), `.surface-admin` (indigo `#4f46e5`, slate chrome). Applied at
  `apps/web/app/(dashboard)/layout.tsx:1288` (`surface-operator`),
  `apps/web/app/buyer/portal/layout.tsx:248`, `apps/web/app/(platform-admin)/layout.tsx:145`.
- **Tailwind color scales** (`packages/config/tailwind.config.ts`): `brand.50–900` (500 `#14A39F`),
  `buyer.50–900`, `canvas{DEFAULT,mid,light}` (marketing dark navy), `ink.{900,700,500,400}`,
  `navy{DEFAULT,light}`, `accent{DEFAULT,strong,deep,soft}`, `paper`, `sunken`, `line{,strong}`,
  `success/warning/danger/info` each `{DEFAULT,bg}`, `surface{DEFAULT,raised,border}`.
  `apps/web/tailwind.config.ts` adds `background`, `foreground`, `primary{DEFAULT,foreground}`
  (tenant-overridable at runtime by `apps/web/components/tenant-provider.tsx`).
- **Radius** (`borderRadius`): `sm 4px`, `ctl 6px` (controls), `DEFAULT 8px`, `card 10px`,
  `lg 12px`, `xl 16px`, `full`.
- **Shadow**: `card 0 1px 2px rgba(15,27,45,.05)`, `dropdown 0 8px 24px rgba(15,27,45,.14)`,
  `modal 0 24px 64px rgba(15,27,45,.28)`. Hairline-first — border + `shadow-card`, not big elevation.
- **Type**: `font-sans` = Spline Sans (`--font-spline`) → Inter fallback; `font-mono` = Spline Sans Mono;
  `font-display` = Instrument Serif. Loaded in `apps/web/app/layout.tsx:2` via `next/font/google`.
  Semantic scale (duplicated in both configs and `packages/ui/src/typography.ts`):
  `display 2rem/2.5 -0.03em 700`, `heading-1 1.5rem/2 600`, `heading-2 1.25rem/1.75 600`,
  `body 1rem/1.5`, `body-sm .875rem/1.25`, `label .875rem/1.25 500`, `caption .75rem/1`.
  In practice dashboard code uses raw px (`text-[13px]`, `text-[12.5px]`, `text-[11px]`) far more
  than the semantic names.
- **Component-layer utilities** (`globals.css` `@layer components`): `.money` (mono + tabular-nums,
  used for every currency figure), `.mono`, `.overline` (11px/600/uppercase/.08em), `.font-display`,
  `.strike` (pre-discount price). Utilities: `.text-balance`, `.scrollbar-hide`, `.focus-ring`
  (`outline-none ring-2 ring-brand-500 ring-offset-2`), `.skeleton` (shimmer, reduced-motion aware).
- **Spacing**: no custom spacing scale — stock Tailwind. No `darkMode` key in either config; the
  `.dark` block in `globals.css:109-119` is **commented out** and there are **zero `dark:` classes**
  in `apps/web/app` + `apps/web/components`. Dark mode is effectively not implemented.
- RN token mirror (mobile only, not web): `packages/ui/src/tokens.ts` (`colors`, `ios.*`).

## Components

Shared web primitives live in `packages/ui/src/web/` (barrel `index.ts`, imported as
`@routeflow/ui/web`). `apps/web/components/` holds app-specific composites; there is **no**
`apps/web/components/ui/` shadcn folder.

| Primitive                              | Path                 | Variants / sizes (actual cva or map keys)                                                                                                                                                                                                                             |
| -------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Button`                               | `web/Button.tsx`     | cva `variant`: `primary`, `secondary`, `ghost`, `danger`, `link`; `size`: `sm` (h-7), `md` (h-[34px], default), `lg` (h-10), all `rounded-ctl`; compoundVariants flatten `link` to `h-auto p-0 rounded-none`. Extra props `loading`, `href`, `leftIcon`, `rightIcon`. |
| `Badge`                                | `web/Badge.tsx`      | `variant`: `success`,`warning`,`danger`,`info`,`neutral`; plus a `status` prop mapping ~40 domain statuses (`DRAFT`…`PROCESSED`) to variant+label. Pill: `h-[21px] rounded-full text-[11px] uppercase` with a 6px dot.                                                |
| `Input` / `Textarea` / `PasswordInput` | `web/Input.tsx` etc. | no variants; `label`, `error`, `register` (react-hook-form) props.                                                                                                                                                                                                    |
| `Select`                               | `web/Select.tsx`     | native `<select>` + `ChevronDown`; `options`, `placeholder`, `error`, `register`.                                                                                                                                                                                     |
| `Modal`                                | `web/Modal.tsx`      | Radix Dialog; `title`, `description`, `footer`, `onEscapeKeyDown`. `rounded-xl … shadow-modal`, overlay `bg-black/40 backdrop-blur-sm`.                                                                                                                               |
| `Table`                                | `web/Table.tsx`      | TanStack Table; `isLoading`, `emptyState`, `onRowClick`.                                                                                                                                                                                                              |
| `Tabs`                                 | `web/Tabs.tsx`       | flat underline tabs; `tabs[{key,label,badge}]`.                                                                                                                                                                                                                       |
| `Skeleton` / `SkeletonRows`            | `web/Skeleton.tsx`   | `shape`: `line`(default) \| `block` \| `circle`; `width`/`height`.                                                                                                                                                                                                    |
| `EmptyState`                           | `web/EmptyState.tsx` | `variant`: `orders`,`routes`,`customers`,`products`,`invoices`,`drivers`,`returns`,`inbox`,`data`,`custom` → SVG illustration from `web/illustrations.tsx`.                                                                                                           |
| `Toast` (`ToastProvider`/`useToast`)   | `web/Toast.tsx`      | `variant`: `success`,`error`,`warning`,`info`; optional `action` (Undo).                                                                                                                                                                                              |
| `Avatar`                               | `web/Avatar.tsx`     | `size`: `sm` h-8 / `md` h-10 / `lg` h-14.                                                                                                                                                                                                                             |
| `Card`, `StatCard`, `PageHeader`       | `web/`               | no variants; `StatCard` takes `trend`/`trendLabel`.                                                                                                                                                                                                                   |

**No Tooltip primitive exists** (`@radix-ui/react-tooltip` is not a dependency) — hover hints are
native `title="…"` (497 occurrences in `apps/web/app` + `components`), e.g.
`apps/web/app/(dashboard)/orders/[id]/page.tsx:1242` `title="Delete item"`.

**Disabled treatment** — three consistent patterns:

- `Button`: cva base carries `disabled:pointer-events-none disabled:opacity-50`; `isDisabled = disabled || loading`;
  the `href` branch adds `pointer-events-none opacity-50` + `aria-disabled` + `tabIndex={-1}` (`web/Button.tsx:9,73,79-81`).
- `Input`/`Select`: `props.disabled && "opacity-50 cursor-not-allowed bg-surface-raised"` (`web/Input.tsx:30`, `web/Select.tsx:40`).
- Raw buttons in app code: `disabled={mutation.isPending} … className="… disabled:opacity-50"`
  (`apps/web/app/(dashboard)/orders/[id]/page.tsx:206-207, 251-252, 287-288`).

**Loading affordances actually in use** (3 real sites):

1. `Button loading` → swaps `leftIcon` for `<Loader2 className="h-4 w-4 animate-spin" />` and sets
   `aria-busy` (`packages/ui/src/web/Button.tsx:83,96,99`); used ~15× on the order page, e.g.
   `loading={updateItems.isPending}` at `orders/[id]/page.tsx:2661`, `loading={deleteOrder.isPending}` at `:2128`.
2. Full-page gate: `if (isLoading) … <Loader2 className="h-8 w-8 animate-spin text-navy/70" />`
   (`orders/[id]/page.tsx:1691-1694`).
3. Skeletons: `Table` renders 5 rows of `h-4 w-full animate-pulse rounded bg-surface-border`
   (`packages/ui/src/web/Table.tsx:104-110`); local `StatSkeleton` uses `animate-pulse … bg-navy/10`
   (`apps/web/app/(dashboard)/dashboard/page.tsx:171-178`); `Skeleton` shimmer used in
   `app/(dashboard)/analytics/page.tsx`, `products/[id]/DemandCard.tsx`, `components/RouteVariantsPanel.tsx`.

## States & feedback

- **Toasts**: no third-party toast lib — in-house `ToastProvider` over `@radix-ui/react-toast`
  (`packages/ui/src/web/Toast.tsx`), mounted in `apps/web/app/providers.tsx:66`. White card +
  colored icon tile, `rounded-card border border-line shadow-dropdown`, 4000ms default, viewport
  `fixed bottom-4 right-4 z-[100] w-96`.
- **Global mutation errors** auto-toast: `MutationCache.onError` in `apps/web/app/providers.tsx:16-40`
  emits `toast({ variant: "error" })` for every failed mutation, except a `HANDLED_CODES` allowlist
  (`MERGE_CHOICE_REQUIRED`, `CHANGE_REQUEST_ALREADY_RESOLVED`, `EDIT_WINDOW_OPEN`, …) that components
  turn into guided flows. **A new feature that shows its own error UI must add its code there.**
- **Inline validation**: react-hook-form + zod via `@hookform/resolvers` `zodResolver`
  (`app/(auth)/login/page.tsx`, `orders/_components/CreateOrderModal.tsx`,
  `customers/_components/CustomerFormModal.tsx`, …). The `error` string prop on `Input`/`Select`
  renders `<p class="text-xs text-danger">` wired by `aria-invalid` + `aria-describedby`.
  Ad-hoc forms use a local error string, e.g. `customError` → `<p className="text-xs text-danger">`
  (`orders/[id]/page.tsx:1450`).
- **Empty states**: `EmptyState` (illustration + `font-display` title + `text-[12.5px] text-ink-500`
  description + action), or `Table`'s `emptyState` prop / default `"No data available"`.
- **Error banners**: local pattern `border border-danger/30 bg-danger-bg px-4 py-3`
  (`app/(dashboard)/dashboard/page.tsx:181+` `ErrorBanner`).
- **Destructive confirm**: `apps/web/components/ConfirmDialog.tsx` — Modal + `AlertTriangle`,
  `variant: "danger" | "secondary"`, `loading` prop wired to the confirm `Button` while Cancel gets `disabled={loading}`.

## Motion

- No framer-motion (not in `apps/web/package.json`; zero imports in `app`/`components`). Motion is
  Tailwind + `tailwindcss-animate` (registered in the preset, `packages/config/tailwind.config.ts:5`).
- Dominant idiom by count in `apps/web/app` + `components` + `packages/ui/src/web`:
  `transition-colors` (700), `animate-spin` (155), `animate-pulse` (51), `transition-all` (29),
  `transition-transform` (19), `transition-opacity` (19), `transition-shadow` (14).
  Explicit durations are rare (`duration-200` ×9, `duration-150` ×1) — default 150ms is the norm.
- Radix enter/exit uses `data-[state=open]:animate-in / data-[state=closed]:animate-out` with
  `fade-*`, `zoom-*`, `slide-*` (`web/Modal.tsx:38-47`, `web/Toast.tsx:92-94`).
- `.skeleton` shimmer is 1.4s and disabled under `prefers-reduced-motion` (`globals.css:199-208`).

## Icons

- `lucide-react` ^0.577.0, used everywhere (Radix icons are not a dependency).
- Sizes by frequency: `h-4 w-4` (750) is the default, `h-3.5 w-3.5` (333) for dense/table chrome,
  `h-5 w-5` (143), `h-3 w-3` (122) inside small text buttons, `h-8 w-8` (127) for page-level spinners.
- Recurring semantics: `Loader2` = busy, `CheckCircle2`/`XCircle`/`AlertTriangle`/`Info` = toast +
  confirm variants, `X` = close, `Search` = pickers, `RotateCcw` = undo, `ChevronDown` = select.

## A11y

- Focus: `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2` + per-variant
  ring color on `Button` (`web/Button.tsx:9,15-20`); `focus:ring-2 focus:ring-brand-500` on
  `Input`/`Select`/`Modal` close; `focus-visible:ring-inset` on `Tabs` (`web/Tabs.tsx:29`).
  The `.focus-ring` utility in `globals.css:188` exists but is **unused** in `apps/web`.
- Labels/descriptions: `Input`/`Select` auto-derive `htmlFor`/`id` from `label`, set `aria-invalid` and
  `aria-describedby={`${id}-error`}`.
- Button sets `aria-busy={loading}`; anchor-form sets `aria-disabled` + `tabIndex={-1}`.
- Modal always renders a `Dialog.Title` and `Dialog.Description` (`sr-only` when absent) —
  `web/Modal.tsx:55-65`. Close buttons carry `aria-label="Close"` / `"Dismiss"`.
- `Skeleton` is `aria-hidden="true"` (`web/Skeleton.tsx:23`).
- `PageHeader` renders an `h2` on purpose: the dashboard top bar owns the page `h1`
  (`web/PageHeader.tsx:18-20`).
- `aria-label` appears 89× across `apps/web/app` + `components`; there is no live-region /
  `role="status"` convention yet.

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
