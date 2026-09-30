# Web Layout Audit & Cleanup — Operator Dashboard + Settings

## Context

After many feature batches landed on the same pages, the operator dashboard's layouts have
drifted: pages look inconsistent and, in places, cramped or broken. The goal is to **restore
consistency, not redesign** — no changes to look and feel, branding, or functionality.

The decisive discovery: **RouteFlow already has a written design system** at
`docs/design-package/project/unified/system-sheet.html`, `ux-standards.html` and
`HANDOFF-CLAUDE-CODE.md`, with tokens in `packages/config/tailwind.config.ts`. It states that
surfaces differ *only* by accent and density, "never by being a different app." So this work is
**conformance to an existing spec**, not new design judgement. That is what keeps it inside the
"don't redesign" boundary.

**Scope (agreed):** the `apps/web/app/(dashboard)/` group + Settings — ~56 real screens plus
Settings' 11 `?tab=` screens and 4 sub-pages. Buyer portal, platform-admin and marketing are
explicitly out. **Findings are presented for approval before any code changes.** Fix depth:
structural conformance **+ in-page tidying**.

**Settings is a first-class target,** not one URL: 2,626 lines, 14 screens, redesigned in #289 then
patched in #290 and re-grown ever since. It is also the only dashboard page that caps width
(`mx-auto max-w-5xl`) while every sibling runs full-bleed, and it carries three duplicate `<h1>`s
and an unwrapped table.

## Verified findings (measured, not assumed)

| Fact | Evidence |
|---|---|
| `<main>` supplies **no padding, no max-width, no spacing**, and is `overflow-x-hidden` | `(dashboard)/layout.tsx:1141` |
| **16 of 37** dashboard files with a raw `<table>` have no overflow wrapper → columns clipped, unreachable | verified by scan; incl. `settings`, `finance/expenses`, `finance/payments`, `estimates`, `returns`, `suppliers` |
| Duplicate `<h1>`: topbar renders one, pages render a second | `layout.tsx` topbar + `settings/page.tsx`, `dashboard/page.tsx`, `finance/dashboard/page.tsx`, `compliance/page.tsx` |
| `PageHeader` used by only 19 files; 99 hand-rolled `text-2xl font-bold` headers | `packages/ui/src/web/PageHeader.tsx` |
| Container rhythm split: `space-y-5 p-6` (32) vs `space-y-6 p-6` (16) vs `space-y-4 p-6` (3) | dashboard pages |
| **LANDMINE:** `Modal.tsx:42` uses `rounded-xl`; two e2e specs select the dialog *by that class* | `packages/ui/src/web/Modal.tsx:42`; `e2e/15-stock-count-ui.spec.ts:116`, `e2e/16-variant-split-ui.spec.ts:114` |
| Playwright capture harness with saved operator auth already exists | `apps/web/playwright.config.ts`, `e2e/setup/.auth/operator.json` |

## Approach

**Capture with Playwright, not the Chrome MCP.** The repo already has an authenticated harness, so
captures parallelise inside one process, are deterministic and re-runnable for before/after diffs,
and can drive modals and tabs. Chrome MCP is kept only for spot checks and the final before/after.

### Phase 0 — Isolation (no agents)
- `EnterWorktree` on a fresh `chore/web-layout-audit` branch off **master**.
- **Quarantine** the 12 in-scope files the concurrent session is editing (`customers/[id]`,
  `invoices/[id]`, `finance/expenses`, `finance/payments*`, `finance/reports`, `vendor-bills/[id]`,
  `bookkeeping/[transactionId]`, `ScanInvoiceModal`, `CustomerRecordPaymentModal`,
  `RecordSupplierPaymentModal`). Audit them, fix them **last** (batch L7). Re-check
  `git status --porcelain` before every batch.
- Auth preflight: verify `operator.json` is still valid; refresh via `--project=setup` if not.
  Capture target is `routeflow-demo` (sanctioned demo tenant, realistic data). Credentials come
  from **env vars, never hardcoded** — falls back to the already-logged-in Chrome session for a
  reduced 1440-only pass if preferred.
- Freeze `<scratch>/audit/manifest.json` — one entry per target.

### Phase 1 — Probe (scripted, zero agents, zero tokens)
`<scratch>/audit/probe.mjs` visits each target and records **objective measurements** via
`page.evaluate`, so findings are measured rather than eyeballed:
- `h1` count; horizontal overflow (`scrollWidth > clientWidth`) — **the only way to see clipping,
  since `overflow-x-hidden` hides it from screenshots**
- per-table: scrollWidth vs container, row count, row height vs the 44px compact tier
- outermost-in-`<main>` computed padding / max-width / gap
- histogram of every computed `border-radius` and `box-shadow`, diffed against the sanctioned set
- sibling overlap, console errors, page height
- pins `rf-sidebar-collapsed=false` first — a collapsed rail changes content width by 176px and
  would poison every width judgement

Runs alongside a pure-ripgrep static scan (`static.jsonl`): outer-shell class, `PageHeader`/`Card`
imports, raw-table and `overflow-x-auto` counts, off-token `rounded-xl`/`shadow-*`/`bg-black/`.

### Phase 2 — Capture
Widths: **1440** (canonical, all targets), **1280** (where cramping bites), **1920** (where content
sprawls), **1024** (~25 table-heavy pages — worst real content width). Pages over 2500px tall get
viewport scroll slices, since a downscaled full-page PNG is unreadable. ~8 modal/interaction states
get explicit click recipes; anything unreachable is marked `NOT_CAPTURED` and audited from source at
reduced confidence — never silently omitted.

### Phase 3 — Analysis (**max 4 Sonnet agents**, per the hard cap)
Targets split into 4 disjoint slices balanced by page size. Each agent gets the slices' PNGs, probe
JSON and static record, applies the fixed taxonomy, and **appends one JSON finding per line to its
own shard** (`findings/shard-N.jsonl`) after each page — per-agent shards avoid interleaved writes,
append-per-page means a kill costs one page.

Taxonomy (agents may only file these): **A** shell/container · **B** header/titling · **C**
surface/elevation tokens · **D** tables/density · **E** actions/buttons · **F** alignment/whitespace
· **G** responsive/overflow · **H** state coverage. Severity **S0** broken/clipped · **S1**
structural drift · **S2** token drift · **S3** polish · **S4** out of scope (logged, never fixed).

Two guardrails against false findings: no density/whitespace finding on a table with **<3 rows**
(file `DATA_THIN` instead — demo data thinness is not a layout defect), and every S3 must cite the
repo spec or a peer-page precedent, else it drops to S4.

### Phase 4 — Synthesis (Opus)
Dedupe shards, corroborate every S0/S1 against a measurement or screenshot (demote what isn't),
group **by fix batch rather than by page** — the batch is the decision unit — and produce
`<scratch>/audit/AUDIT-LAYOUT.md` with an executive summary, S0 pulled to the top, a checkbox per
finding, and an explicit "noted, not fixing" appendix.

### Phase 5 — APPROVAL GATE ⛔
You read `AUDIT-LAYOUT.md` and tick what gets fixed. **No repo file is modified before this point.**

## Fix phase (only after approval)

Per batch: `/design` for the visual decisions, `dev-pipeline` for execution (Fable plans → Sonnet
implements → Opus reviews). One PR per batch, ≤10 files, `style(web):` commit type.

**Mandatory pre-flight before every batch** — this is what prevents the confirmed landmine:
1. `rg -n "<class-being-changed>" apps/web/e2e/` — is the class an e2e selector?
2. `rg -n "xpath=" apps/web/e2e/` — does a spec walk the DOM structure being changed?
3. `git status --porcelain -- <targets>` — has the other session touched it?

**Diff invariant** (the core safety contract): a layout PR's diff must contain **no** change to
`useState|useEffect|useMemo|useCallback|onClick|onChange|onSubmit|fetch(|api.|router.|useQuery|useMutation`.
If it does, it is a behaviour change and leaves this effort.

| Batch | What | Risk |
|---|---|---|
| **L-1** | Test-only PR: re-selector specs 15/16 off `rounded-xl` (and `02-operator.spec.ts:416`) onto `getByRole`/`data-testid` | none — unblocks L4 |
| **L0** | Remove duplicate `<h1>` (~4 files, incl. Settings ×3) | ~0, a11y win, proves the pipeline |
| **L1** | **Wrap the 16 clipped tables in `overflow-x-auto`** — S0, content currently unreachable | low; visibly changes 16 pages (intended) |
| **L2** | Adopt a new `apps/web/components/PageShell.tsx` (`default` / `narrow` / `full` variants) page by page | low |
| **L3** | Adopt `PageHeader` where the shape fits | medium — changes DOM nesting, gate 2 applies |
| **L4** | Token conformance, **one PR per family**: `rounded-xl`→`rounded-card`, off-token `shadow-*`→`shadow-card`, `bg-black/40`→`bg-ink-900/40` | medium; blocked until L-1 |
| **L5** | Replace hand-rolled card divs with `Card` (skip any with handlers/conditional classes) | low-med |
| **L6** | Density, alignment, whitespace, button placement — 3-4 pages per PR | judgement; last |
| **L7** | The 12 quarantined files, after the other session's PR merges | — |

**Deliberately NOT doing in L2:** moving padding into `<main>`. It looks like the elegant one-line
fix but silently changes all 65 routes at once, including two-pane and stub pages, with no per-page
escape hatch and an unreviewable diff. Explicit per-page adoption is more diff and strictly safer.

**Deferred as a separate decision:** capping content width on 1920+ screens. That *is* a
look-and-feel change on ultrawide monitors, which you ruled out — it will be presented with
before/after shots for a yes/no, not applied by default.

## Verification (after every batch)
1. `npm run check-types` && `npm run lint`
2. Playwright subset: `--project=operator --project=critical-paths` + any project whose spec touches
   a batch file. Full 18-project suite only before final merge.
3. **Re-capture the batch's own pages and diff before/after** — the only check that actually answers
   "did I break the layout".
4. **Re-run the probe**: assert the target metric moved (after L1, clipped-table count → 0) *and
   nothing else did* (radius/shadow histograms and `h1` counts unchanged).
5. `npm run verify` before the final merge.

## Reuse (do not reinvent)
`PageHeader`, `Card`, `Badge`, `Button`, `Modal`, `Table`, `EmptyState`, `Skeleton`/`SkeletonRows`,
`StatCard`, `Tabs` from `@routeflow/ui/web`; `ConfirmDialog` and `SortableTh` from
`apps/web/components/`. **Raw `<table>` + `SortableTh` is a sanctioned idiom** (66 files) — never
file "convert to `<Table>`" as a finding. Tokens come from `packages/config/tailwind.config.ts`; no
new hex, radius or shadow values.

## Top risks
1. **Invisible test breakage from "safe" class edits** — confirmed live in `Modal.tsx`. Mitigated by
   L-1 and the pre-flight gates.
2. **Demo-data thinness reading as a layout defect** — mitigated by the `<3 rows` rule and reporting
   `DATA_THIN` screens separately.
3. **Tidying that breaks behaviour** — mitigated by the diff invariant; `overflow-x-auto` goes on a
   table's immediate parent only, never a container holding a popover (it would clip it).
4. **Collision with the concurrent session** — worktree isolation + 12-file quarantine + L7 last.
5. **Scope creep into redesign** — every judgement finding must cite the repo spec or be logged S4.
