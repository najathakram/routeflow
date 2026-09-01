---
name: new-feature
description: >
  Auto-load when the task involves adding a feature, endpoint, screen, component, or
  user-visible capability to RouteFlow. Keywords: "add", "implement", "create", "build",
  "new <noun>", "feature", "endpoint", "screen".
---

# Skill: New Feature (RouteFlow)

Skim [`.claude/lessons/LESSONS.md`](../../lessons/LESSONS.md) first — especially `domain`,
`testing`, and the entitlement-gate rule (L-016) — then confirm scope before coding (name,
one-line description, ≥3 testable acceptance criteria, DB/API/UI impact). Then follow
**Red → Green → Refactor → gate → PR**. The `/new-feature` command has the full step list; this
skill is the file-scaffold map.

## Golden rule

**Web is the reference.** New capabilities land against the same API endpoints/DTOs the web
app uses; mobile mirrors those flows. Don't invent a parallel API for mobile.

## Scaffold order by target

### API (`apps/api/src/<feature>/`)

1. `<feature>.service.spec.ts` — failing first. Use `Test.createTestingModule`, mock Prisma
   at the boundary, and **assert tenant isolation** (see `apps/api/src/auth/auth-isolation.spec.ts`).
2. `<feature>.module.ts`
3. `<feature>.controller.ts` — apply `JwtAuthGuard` + `RolesGuard`; validate input with
   `class-validator` DTOs; respect the `/api/v1` global prefix.
4. `<feature>.service.ts` — every query scoped by `tenantId` from the JWT payload.
5. Prisma migration if schema changes (local `npx prisma migrate dev`; see the db-migration skill).

### Web (`apps/web/`)

1. `apps/web/e2e/<feature>.spec.ts` — Playwright, reuse the role auth storage-state.
2. Route/server-action under `app/…`, component under `components/…`.
3. Data via TanStack Query against `NEXT_PUBLIC_API_URL`; forms via react-hook-form + zod.

### Mobile (`apps/mobile/`)

1. `__tests__/<feature>.test.ts` — pure-logic Jest only (no RN component rendering).
2. Screen under `app/(customer|driver|operator|tenant)/…` (expo-router); call the same API.

## Reuse, don't duplicate

Grep existing modules for the pattern before writing new code (guards, DTO shapes, Prisma
query helpers, query-key conventions, socket wiring). Keep DB migration and implementation in
**separate commits**.
