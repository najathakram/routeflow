# `drafts/` (Minimize & resume, pos-cost-roles-spec §2)

> Split from [`../feature-modules-3.md`](../feature-modules-3.md) (verbatim, lines 254-257 of the pre-split file) on 2026-09-16. Originally itself split from `.claude/code-map/api.md` (verbatim, lines 1344-1592) on 2026-09-13. See [`../../INDEX.md`](../../INDEX.md).

- **controller** `drafts` — `/drafts` CRUD (`@Roles(OPERATOR, DRIVER)`; TENANT_ADMIN satisfies OPERATOR).
- **service** — `list`/`create`/`update`/`get`/`remove`; per-user ownership (`assertOwned`) + tenant-scoped (`forTenant()`); autosave upserts the same draft. Model **`SaleDraft`** (per-user, `payload` Json, additive migration `20260705120000_add_sale_drafts` — CREATE TABLE only; **apply to prod before the web dock deploys**). Spec `drafts.service.spec.ts`. Web: `components/DraftDock.tsx` + `CreateOrderModal` Minimize/resume.
