# RouteFlow

A full-stack delivery management platform built as a Turborepo monorepo.

| App / Package | Description |
|---|---|
| `apps/web` | Next.js 14 admin dashboard |
| `apps/api` | NestJS REST + WebSocket backend |
| `apps/mobile` | Expo React Native customer & driver apps |
| `packages/ui` | Cross-platform shared component library |
| `packages/types` | Shared TypeScript types and enums |
| `packages/config` | Shared Prettier / tsconfig base |
| `packages/eslint-config` | Shared ESLint configs |
| `packages/typescript-config` | Shared `tsconfig.json` bases |

---

## Prerequisites

| Tool | Minimum version | Install |
|---|---|---|
| Node.js | 20 LTS | https://nodejs.org |
| npm | 10 | bundled with Node 20 |
| Docker Desktop | latest | https://www.docker.com/products/docker-desktop |
| VS Code | latest | https://code.visualstudio.com |

> **Windows users:** ensure `HOME` is set to your user profile before running git commands:
> ```powershell
> [System.Environment]::SetEnvironmentVariable("HOME", "C:\Users\<you>", "User")
> ```

---

## Getting started

### 1. Clone and install

```bash
git clone https://github.com/najathakram1/routeflow.git
cd routeflow
npm install
```

### 2. Configure environment variables

Each app ships an `.env.example`. Copy it to `.env` and fill in real values before starting:

```bash
# API (PostgreSQL, Redis, JWT, Zoho, R2, ORS, FCM)
cp apps/api/.env.example apps/api/.env

# Web dashboard (API URL, Google Maps, NextAuth)
cp apps/web/.env.example apps/web/.env

# Mobile app (API URL, Google Maps)
cp apps/mobile/.env.example apps/mobile/.env

# Optional: Turborepo remote cache
cp .env.example .env
```

> **Never commit `.env` files.** The root `.gitignore` already excludes all `.env*`
> patterns except `.env.example`.

### 3. Start backing services (Docker)

```bash
# Postgres + Redis in the background
docker compose up -d

# Optional: also start Redis Commander UI at http://localhost:8081
docker compose --profile tools up -d
```

Services started:

| Service | Port | Credentials |
|---|---|---|
| PostgreSQL 16 | 5432 | user/pass (from `.env`) |
| Redis 7 | 6379 | no password in dev |
| Redis Commander | 8081 | admin/admin (tools profile only) |

### 4. Run all apps in development

```bash
npm run dev
```

Turbo starts every app that has a `dev` script in parallel:

| App | Default URL |
|---|---|
| `apps/api` | http://localhost:3000 |
| `apps/web` | http://localhost:3001 |
| `apps/mobile` | Expo DevTools (follow terminal prompt) |

### 5. Run a single app

```bash
npx turbo dev --filter=@routeflow/api
npx turbo dev --filter=@routeflow/web
npx turbo dev --filter=@routeflow/mobile
```

---

## Common scripts (run from monorepo root)

| Command | What it does |
|---|---|
| `npm run dev` | Start all apps in watch mode |
| `npm run build` | Production build (all apps, cached by Turbo) |
| `npm run lint` | Lint all packages |
| `npm run test` | Run unit tests across all packages |
| `npm run check-types` | TypeScript type-check across all packages |
| `npm run format` | Prettier format all source files |
| `npm run clean` | Remove all `dist/`, `build/`, `.next/` outputs |

---

## Remote caching (optional)

Turborepo can share build caches across CI and team machines via Vercel:

```bash
npx turbo login
npx turbo link
```

Then add `TURBO_TOKEN` and `TURBO_TEAM` to your CI environment (see root `.env.example`).

---

## Project conventions

- **Scoped package names** — every workspace package is `@routeflow/<name>`
- **Env vars** — prefix with `NEXT_PUBLIC_` (web) or `EXPO_PUBLIC_` (mobile) for client-side values
- **No secrets in `EXPO_PUBLIC_*`** — these are inlined at build time and visible in the bundle
- **Branch strategy** — `main` is production-ready; feature branches off `main`, PRs required
