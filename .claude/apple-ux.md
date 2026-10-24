# apple-ux adapter — RouteFlow (contract: ~/.claude/skills/apple-ux/references/adapter-contract.md)

1. **Target:** web `http://localhost:3001`, API `http://localhost:3000` (use `localhost`, never `127.0.0.1`, because of the CSP); Expo-web `http://localhost:8081` for phone jobs. Guard: `check-target.mjs`, with allowed read-only hosts `fonts.googleapis.com`, `fonts.gstatic.com` and `maps.googleapis.com`. Never Railway or production.
2. **Bring-up:** `npm run local:up` → `npm run local:seed` → `GET :3000/api/v1/health` = 200. Expo-web: `EXPO_PUBLIC_API_URL=http://localhost:3000 npm run web -w apps/mobile`.
3. **Sign-in, once per role:**
   - Operator and customer: copy `apps/web/e2e/setup/.auth/{operator,customer}.json` if fresh (minted by `node scripts/local-env.mjs --e2e -- "npx playwright test --project=setup"` from `apps/web`). Otherwise use `/login`, fill Workspace, then the credentials in `apps/web/e2e/helpers/constants.ts` (never echo them).
   - Driver: no seeded driver exists. Setup creates `UX-driver` (fixtures below), then signs in once on Expo-web.
   - `/auth/login` allows **10 per 5 minutes per IP**. **Mint one login state per walker** (not one shared file): a shared refresh token got one walker signed out in the first pilot.
   - Pilot gotchas: the plan catalog must be published or invoicing fails (`local:seed` does it; if it fails, copy `apps/api/src/billing` into the api container and run `db:publish:catalog:v11`/`v12` with `docker exec`); the api image lacks root `scripts/lib` and the api `tsconfig.json`, so seeding inside the container needs those two `docker cp`'d in; the buyer-portal login for the seeded customers did not work, so the buyer persona is not runnable until a buyer account is seeded.
   - Phone-width audits of the web app use `resize 390 844` with the desktop user agent; a phone user agent is served the Expo shell instead.
4. **Test data:** tenant `test` (seeded by `local:seed`: operator `admin`, 5 customers, 15 products, 10 orders; best choice when `e2e-routeflow` is empty, B566) or `e2e-routeflow`; always an approved test tenant (`assertTestTenant`). The seed script is `apps/api/prisma/seed.ts`; a walker's operator login is `Workspace=test`, username `admin`, and the password is the literal on the `adminHash` line of that file (never echo it).
   - Fixtures are created in the operator session with `eval`: a `fetch` to `:3000/api/v1/{customers,products,drivers}` with `Authorization: Bearer <localStorage rf:op:accessToken>` and `X-Tenant-Slug: <the audited test tenant slug>`.
   - Bodies follow the DTOs in `apps/api/src/{customers,products,drivers}/dto/create-*.dto.ts`; a 400 names the missing fields.
   - Per persona: 1 customer, 2 products and 1 order, all named `UX-<persona>-*`. Plus the `UX-driver` account, whose generated test password lives only in `<run>/state/`.
5. **Personas** (`quitAfter` comes from patience):

   | id       | name | one line                                                 | device / input                                        | patience | reading habit                             | typical mistake                       |
   | -------- | ---- | -------------------------------------------------------- | ----------------------------------------------------- | -------- | ----------------------------------------- | ------------------------------------- |
   | owner-op | Sam  | owns a small food distributor, has done orders for years | desktop 1440 / mouse                                  | low      | never reads, expects shortcuts            | assumes the last price is still right |
   | clerk    | Dana | first week as office clerk                               | desktop 1440 / keyboard only                          | medium   | reads labels literally, never helper text | types quantity in the price field     |
   | driver   | Luis | delivery driver, between stops                           | phone width 390 (resize, desktop UA) / one-hand touch | low      | glances only                              | taps the wrong stop in a long list    |
   | buyer    | Mia  | café owner reordering weekly                             | phone 390 / touch                                     | medium   | returning, forgot where things are        | edits the cart, then hits Back        |

6. **Jobs** (`scout` → Phase 0b, following the named spec):

   | id            | role     | goal                                         | success when                     | start         | expert path                           | freq   |
   | ------------- | -------- | -------------------------------------------- | -------------------------------- | ------------- | ------------------------------------- | ------ |
   | create-order  | operator | "Put in Monday's order for my café customer" | order detail shows lines + total | /orders       | scout (`e2e/13-boxed-order-entry`)    | daily  |
   | invoice-order | operator | "Bill the order I just made"                 | invoice number visible           | /orders       | scout (`e2e/06-critical-paths`)       | daily  |
   | find-customer | operator | "Check what this customer owes"              | balance visible                  | /customers    | scout                                 | daily  |
   | build-route   | operator | "Plan tomorrow's deliveries"                 | route with stops saved           | /routes       | scout (`e2e/50-routes-dispatch-mode`) | daily  |
   | buyer-reorder | customer | "Order what I got last week"                 | order confirmation               | /buyer/portal | scout (`e2e/04-buyer-portal`)         | weekly |
   | driver-stop   | driver   | "Mark this stop delivered"                   | stop shows delivered             | :8081         | scout                                 | daily  |

7. **No-go (look only, never submit):** settings and billing, choose-plan, Stripe or any payment, users, roles and sessions, the import/migration hub, platform admin, anything that emails or texts a customer, deleting anything not named `UX-*`.
8. **Known issues:** `known.json` combines two sources:
   - open `.claude/campaign/bugs/B*.md` (`state` ≠ closed) whose `location` or title names the audited routes or components;
   - the previous run's `final.json`.
9. **Evidence:** `local-assets/apple-ux/<date>-<slug>/` (git-ignored).
10. **Host:** the PC runs apple-ux proofs (lead allocation 2026-10-07); default `--parallel 2`. Any host needs the skill folder from the PC (`~/.claude/skills/apple-ux`) and `npm i -g @playwright/cli@latest`. Build the stack from fresh master (or the release train tree), never a stale checkout.
11. **Not covered:** native iOS/Android builds and the marketing site.
