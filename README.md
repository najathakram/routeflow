# RouteFlow

Multi-tenant delivery / route-management SaaS: a NestJS API, a Next.js web dashboard, and an
Expo (React Native) multi-role mobile app, in one npm + Turbo monorepo, deployed to Railway.

| App / Package                | Description                                                  |
| ---------------------------- | ------------------------------------------------------------ |
| `apps/api`                   | NestJS REST + WebSocket backend                              |
| `apps/web`                   | Next.js 14 admin dashboard (golden reference for flows/DTOs) |
| `apps/mobile`                | Expo React Native customer & driver apps                     |
| `packages/types`             | Shared TypeScript types and enums                            |
| `packages/ui`                | Cross-platform shared component library                      |
| `packages/config`            | Shared Prettier / tsconfig base                              |
| `packages/eslint-config`     | Shared ESLint flat configs                                   |
| `packages/typescript-config` | Shared `tsconfig.json` bases                                 |

## Stack

- **Monorepo**: npm workspaces orchestrated by **Turbo**. Package manager npm 10.8 (Node ≥ 18, CI pins 20).
- **API**: NestJS 11, Prisma 7 + PostgreSQL, Redis (Socket.io), Passport JWT auth. Tests: Jest (`*.spec.ts`).
- **Web**: Next.js 14 App Router, Radix + Tailwind, TanStack Query, react-hook-form + zod. Tests: Jest + RTL (`*.test.tsx`, `npm test -w apps/web`) + Playwright E2E (`e2e/*.spec.ts`).
- **Mobile**: Expo 55 / RN 0.83, expo-router, multi-role. Tests: Jest (pure-logic only).
- **Lint/format**: ESLint flat config per workspace + Prettier.
- **Deploy**: Railway via Docker (per-app `Dockerfile` + `railway.toml`).

Full detail (run commands, architecture, conventions, money discipline, test-tenant policy) lives
in [`CLAUDE.md`](CLAUDE.md) — the canonical reference for this repo, kept current because the
coding agent reads it every session.

## Getting started

```bash
git clone https://github.com/najathakram/routeflow.git
cd routeflow
npm install

# Copy env examples and fill in real values
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env
cp apps/mobile/.env.example apps/mobile/.env

npm run db:up      # Postgres + Redis via Docker Compose
npm run dev         # all apps in watch mode — api :3000, web :3001, mobile via Expo DevTools
```

**Never commit `.env` files** — the root `.gitignore` excludes all `.env*` except `.env.example`.

### Run the whole system locally before a PR

`npm run dev` is the fast watch-mode loop. Before opening a PR, also exercise the change against
the **real production Docker images** — API, web, Postgres, Redis wired together, the same
artifacts Railway deploys:

```bash
npm run local:up        # build images + start the full stack
npm run local:seed      # seed the approved `test` tenant
npm run local:validate  # smoke + post-deploy-check + schema-drift gate
```

Design and rationale: [`docs/adr/0001-local-hosting-environment.md`](docs/adr/0001-local-hosting-environment.md).

## Common scripts (from repo root)

| Command               | What it does                                                             |
| --------------------- | ------------------------------------------------------------------------ |
| `npm run dev`         | Start all apps in watch mode                                             |
| `npm run build`       | Production build (all apps, Turbo-cached)                                |
| `npm run lint`        | Lint all packages                                                        |
| `npm run check-types` | TypeScript type-check across all packages                                |
| `npm run test`        | Jest (api, web, mobile)                                                  |
| `npm run test:e2e`    | Playwright E2E (web)                                                     |
| `npm run format`      | Prettier write across the repo                                           |
| `npm run verify`      | The pre-push gate — type-check + lint + test; run this before every push |

## Branch model

- **`master`** is trunk — the only long-lived branch — and deploys straight to Railway.
- Feature and fix branches: `feat/*`, `fix/*` (also `test/*`, `chore/*`, `docs/*` for
  non-feature work), opened as PRs against `master`.
- Commits follow **Conventional Commits** (enforced by commitlint):
  `feat|fix|test|ci|refactor|docs|chore|perf|revert|build|style`.
- Run `npm run verify` before every push — the same command CI runs, and what `.husky/pre-push`
  already enforces locally.

## CI/CD, as it actually runs today

1. A PR into `master` runs **one `verify` job** (`ci.yml`: lint, type-check, test, lockfile
   integrity, a bug-signature scan, and a security audit) — there is deliberately no `push:`
   trigger, so correctness runs once per PR, not again on the merge.
2. A green PR is **squash-merged** to `master`.
3. **Railway auto-deploys each service** straight from the `master` push via its native GitHub
   integration (`watchPatterns` per service — a docs-only change touches nothing Railway watches).
   No GHCR image build, no manual `railway up`.
4. Once Railway reports the deploy `SUCCESS` (a `deployment_status` webhook), the **Playwright E2E
   suite fires itself** against the freshly-deployed site — nobody dispatches it manually.

This repo is private by default; PR CI still needs a brief public window until GitHub's
private-minute Actions billing is fixed — see
[`docs/runbooks/deploy-visibility-flip.md`](docs/runbooks/deploy-visibility-flip.md) for the
routine and its retirement checklist. A `staging` environment is designed but not yet built —
see [`docs/adr/0002-staging-environment.md`](docs/adr/0002-staging-environment.md).

## Docs

- [`CLAUDE.md`](CLAUDE.md) — the canonical reference: run commands, architecture, money
  discipline, test-tenant policy, deploy routine.
- [`docs/adr/`](docs/adr/) — Architecture Decision Records (`0001` local hosting, `0002` staging).
- [`docs/runbooks/`](docs/runbooks/) — operational runbooks (deploy visibility flip).
- [`docs/IMPROVEMENTS.md`](docs/IMPROVEMENTS.md) — the prioritized engineering backlog.
- [`docs/ARCHITECTURE_REVERSE_ENGINEERING.md`](docs/ARCHITECTURE_REVERSE_ENGINEERING.md) — how
  the system works today, derived from the code.
- [`docs/railway-deployment.md`](docs/railway-deployment.md) — historical step-by-step Railway
  setup guide (see its banner for what's current).
