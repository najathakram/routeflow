origin/master @ 0f51a712e2b1b10a51f7657a2a95a277d4733c63
# Context pack c1 (bug 668) - apps/web/components/DraftDock.tsx

## Exported signatures
- `export function DraftDock()` - role gate (no role or CUSTOMER -> null), else renders internal `DraftDockInner` (non-exported).
- Non-exported helper: `function resumeHref(draft: SaleDraft, scanCode?: string): string` (INVOICE -> /invoices/new, else /orders; merges intent params onto the current query when already on that route).
- Imports: useGuardedRouter (@/lib/use-guarded-router), useAuth, useDrafts/useDeleteDraft/SaleDraft (@/lib/api/drafts), draftSummary/parkedAgo (@/lib/drafts), ConfirmDialog, Button/cn/useToast (@routeflow/ui/web).

## Graph radius (condensed)
scripts/graph.mjs radius returned EMPTY: graphify python not found (GRAPHIFY_PY unset; pipx venv absent in this worktree). Fallback = grep, treat all as grep-only.
Importers/mentions of DraftDock:
- apps/web/app/(dashboard)/layout.tsx (mount)
- apps/web/app/(dashboard)/orders/page.tsx (resumeDraft/scan/action=new deep-link consumer)
- layout tests: layout.register.test.tsx, layout.till-permission.test.tsx, layout.get-the-app.test.tsx, layout.counter-entry.test.tsx, layout.counter-gate-roles.test.tsx, layout.skip-link.test.tsx, layout.register.screen.test.tsx
Dependencies: apps/web/lib/api/drafts.ts (useDrafts, useDraft, useCreateDraft, useUpdateDraft, useDeleteDraft; types SaleDraft/SaveDraftInput from @routeflow/types), apps/web/lib/drafts.ts (OrderDraftPayload, DraftLineItem, DraftCustomer, draftDeviceLabel, parkedAgo, draftSummary), components/ConfirmDialog.tsx.

## Code-map area file
.claude/code-map/web/components-shared.md (DraftDock entry ~line 146); related: .claude/code-map/web/app-shell-lib.md (~line 339, lib/drafts.ts); index: .claude/code-map/INDEX.md

## Relevant lessons (LESSONS-DIGEST.md)
- L-200 process: before removing a UI control, grep every other client entry point reaching the same capability.
- L-205 testing: regression tests assert real behavior (DOM state, reachable size), not source scrapes.
- L-258 testing: target by data-testid/role, never .first()/.last()/nth(); re-run before filing from a capture.
- L-305 domain: when a gate/notice is delivered by wrappers, enumerate surfaces (dialogs, raw buttons) by search.
- L-333 domain: derive values from props/state in render; do not mirror into state and clear in effects.
- L-300 domain: snapshot server state at edit start; send only touched fields (draft autosave/hydrate).
- L-304 domain: name the select/serializer feeding a display field before fixing a display gap.
- L-265 tooling: rm -rf apps/web/.next after any next dev proof.
- L-176 tooling: worktree needs its own npm ci + rebuilt package dists before web tests.
- L-322 testing: after move-only extraction, repoint static source-pin specs.
