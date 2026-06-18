---
name: test-gen
description: >
  Auto-load for writing, adding, or improving tests in RouteFlow. Keywords: "test", "spec",
  "coverage", "unit test", "e2e", "Jest", "Playwright".
---

# Skill: Test Generation (RouteFlow)

Frameworks already in the repo — **use them, do not add Vitest**:

- **API + Mobile → Jest**
- **Web → Playwright**

## API (`apps/api`) — Jest, `*.spec.ts` co-located in `src/`

- Build the unit under test with `Test.createTestingModule({ providers: [...] })`.
- **Mock Prisma at the boundary** (provide a mock `PrismaService`); never hit a real DB in unit specs.
- Every test must prove **multi-tenant isolation**: a service called with tenant A's context must
  never read/write tenant B's rows. Model this on `src/auth/auth-isolation.spec.ts` and the
  `*.security.spec.ts` files.
- Cover nominal + boundary + error per public method. Validate guard/role behavior on controllers.
- Jest is pinned to 30.x via root `overrides` — match existing matcher usage.

## Mobile (`apps/mobile`) — Jest via `ts-jest`

- Config `jest.config.js`: `testMatch: __tests__/**/*.test.ts` — **pure-logic tests only**
  (no Expo/RN component rendering). Mocks exist for `expo-secure-store`, `@routeflow/ui`, `@routeflow/types`.
- Good targets: socket wiring, dashboard/data transforms, form/validation logic (see existing
  `socket-wiring.test.ts`, `buyer-home-dashboard.test.ts`).

## Web (`apps/web`) — Playwright, `e2e/*.spec.ts`

- Projects are role-based (super-admin, operator, customer, buyer, cross-cutting) with a `setup`
  project that creates pre-authenticated storage-state in `e2e/setup/.auth/`. Reuse it — don't re-login per test.
- Default base URL targets Railway; 2 retries absorb cold starts. Use role/label/text selectors,
  not brittle CSS/ids.

## Universal rules

- **No snapshot tests** — they break on every UI tweak and catch little.
- Deterministic: no unseeded random data; tests clean up after themselves; pass in isolation.
- One logical assertion per case; name expected values (no magic numbers in assertions).
- Run via `npm run test` (Jest) / `npm run test:e2e` (Playwright); never decrease existing coverage.
