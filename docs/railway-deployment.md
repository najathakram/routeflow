# Railway Deployment Guide

Step-by-step instructions for deploying RouteFlow to [Railway](https://railway.app).

---

## Prerequisites

| Requirement          | Notes                                             |
| -------------------- | ------------------------------------------------- |
| Railway account      | https://railway.app — free tier works for staging |
| GitHub repo          | RouteFlow monorepo pushed to GitHub               |
| Railway CLI          | Installed in step 1 below                         |
| OpenSSL (or similar) | For generating JWT secrets                        |

---

## 1. Install the Railway CLI

```bash
npm install -g @railway/cli
```

Verify:

```bash
railway --version
# Expected: railway vX.X.X
```

## 2. Authenticate

```bash
railway login
# Opens a browser window — authorize Railway to access your GitHub account.
# On success: "Logged in as <your-email>"
```

## 3. Create the Railway project

```bash
railway init
# When prompted:
#   Project name: routeflow
#   Team: (select your team or personal)
# Output: "Created project routeflow"
```

## 4. Add services from the Railway dashboard

Open https://railway.app/dashboard and click on the **routeflow** project.

### 4a. Add PostgreSQL

1. Click **+ New** → **Database** → **Add PostgreSQL**
2. Railway provisions a managed Postgres instance automatically
3. Note: the `DATABASE_URL` variable is injected as a Railway reference variable

### 4b. Add Redis

1. Click **+ New** → **Database** → **Add Redis**
2. Railway provisions a managed Redis instance automatically
3. Note: the `REDIS_URL` variable is injected as a Railway reference variable

### 4c. Add the API service

1. Click **+ New** → **GitHub Repo** → select your `routeflow` repository
2. Railway auto-detects the monorepo — when prompted for the service root:
   - **Service name:** `routeflow-api`
   - **Root directory:** `/` (builds from repo root; Dockerfile handles paths)
   - **Dockerfile path:** `apps/api/Dockerfile`
3. Or, if Railway shows the builder picker, select **Dockerfile** and set the
   path to `apps/api/Dockerfile`

### 4d. Add the Web service

1. Click **+ New** → **GitHub Repo** → select `routeflow` again
2. Configure:
   - **Service name:** `routeflow-web`
   - **Root directory:** `/`
   - **Dockerfile path:** `apps/web/Dockerfile`

### 4e. Connect services

Railway automatically injects connection variables when you reference them.
This happens in step 5 below via `${{Postgres.DATABASE_URL}}` syntax.

---

## 5. Environment variables — API service

Click on **routeflow-api** → **Variables** tab → **Raw Editor** and paste:

```env
# ─── Database (Railway auto-linked) ──────────────────────────────────────────
DATABASE_URL=${{Postgres.DATABASE_URL}}

# ─── Cache (Railway auto-linked) ─────────────────────────────────────────────
REDIS_URL=${{Redis.REDIS_URL}}

# ─── Auth / JWT ──────────────────────────────────────────────────────────────
# Generate these with: openssl rand -hex 32
JWT_SECRET=<paste-64-char-hex>
JWT_REFRESH_SECRET=<paste-different-64-char-hex>
JWT_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d

# ─── Server ──────────────────────────────────────────────────────────────────
NODE_ENV=production
PORT=3000

# ─── CORS ────────────────────────────────────────────────────────────────────
# Set this AFTER step 6, once you know the web service URL
CORS_ORIGINS=https://<routeflow-web>.up.railway.app

# ─── Zoho CRM (optional — leave blank to skip) ──────────────────────────────
ZOHO_CLIENT_ID=
ZOHO_CLIENT_SECRET=
ZOHO_REFRESH_TOKEN=

# ─── Cloudflare R2 (object storage for PDF invoices) ────────────────────────
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET_NAME=routeflow-assets

# ─── OpenRouteService (route optimization) ──────────────────────────────────
ORS_API_KEY=

# ─── Google Maps ─────────────────────────────────────────────────────────────
GOOGLE_MAPS_API_KEY=

# ─── Firebase Cloud Messaging ────────────────────────────────────────────────
FCM_PROJECT_ID=

# ─── Tax Rate ────────────────────────────────────────────────────────────────
TAX_RATE=0.1
```

Generate the JWT secrets:

```bash
openssl rand -hex 32
# Copy the output → paste into JWT_SECRET

openssl rand -hex 32
# Copy the output → paste into JWT_REFRESH_SECRET
```

## 6. Environment variables — Web service

Click on **routeflow-web** → **Variables** tab:

```env
NEXT_PUBLIC_API_URL=https://<routeflow-api>.up.railway.app/api/v1
NEXT_PUBLIC_GOOGLE_MAPS_KEY=<your-google-maps-key>
COOKIE_SECRET=<openssl rand -hex 32>
PORT=3001
```

> Replace `<routeflow-api>` with the actual Railway-assigned domain.
> Find it in the API service → **Settings** → **Networking** → **Public Domain**.

Once you know the web URL, go back to the API service and update `CORS_ORIGINS`.

---

## 7. Run initial database migration and seed

Link your local CLI to the Railway project:

```bash
railway link
# Select: routeflow project → production environment
```

Run the migration:

```bash
railway run --service routeflow-api -- npx prisma migrate deploy
# Expected output:
#   Datasource "db": PostgreSQL database
#   X migrations found in prisma/migrations
#   X migrations applied successfully
```

Seed the database with initial data (admin user, sample products, etc.):

```bash
railway run --service routeflow-api -- npx prisma db seed
# Expected output:
#   Running seed command `npx tsx ./prisma/seed.ts` ...
#   Seeded X users, X products, X customers...
```

---

## 8. Verify the deployment

### 8a. Railway dashboard

Open https://railway.app/dashboard → **routeflow** project.
Both **routeflow-api** and **routeflow-web** should show a green "Active" badge.

### 8b. API health check

```bash
curl https://<routeflow-api>.up.railway.app/api/v1
# Expected: HTTP 200
```

### 8c. Web dashboard

Open `https://<routeflow-web>.up.railway.app` in your browser.
You should see the login page.

### 8d. Login with seeded credentials

Use the admin account created by the seed script to verify end-to-end
connectivity between the web dashboard, the API, and the database.

---

## 9. Set up custom domains (optional)

1. In Railway, click on a service → **Settings** → **Networking**
2. Click **+ Custom Domain** and enter your domain (e.g., `api.routeflow.app`)
3. Add the CNAME record shown by Railway to your DNS provider
4. Railway provisions a TLS certificate automatically

Update `CORS_ORIGINS` and `NEXT_PUBLIC_API_URL` to use the custom domains.

---

## 10. Set up GitHub Actions secrets

For the CI/CD pipelines in `.github/workflows/` to deploy automatically:

1. Go to your GitHub repo → **Settings** → **Secrets and variables** → **Actions**
2. Add the following repository secrets:

| Secret                     | Value                            | Used by                 |
| -------------------------- | -------------------------------- | ----------------------- |
| `RAILWAY_TOKEN`            | Railway API token for staging    | `deploy-staging.yml`    |
| `RAILWAY_TOKEN_PRODUCTION` | Railway API token for production | `deploy-production.yml` |

To generate a Railway token:

```bash
railway tokens create --name "github-actions-staging"
railway tokens create --name "github-actions-production"
```

3. Create GitHub environments with protection rules:
   - Go to **Settings** → **Environments**
   - Create `staging` environment (no restrictions needed)
   - Create `production` environment → enable **Required reviewers** and add
     at least one team member who must approve before production deploys run

---

## Troubleshooting

| Problem                       | Solution                                                                                 |
| ----------------------------- | ---------------------------------------------------------------------------------------- |
| Build fails with Prisma error | Ensure `prisma generate` runs in the Dockerfile builder stage                            |
| `DATABASE_URL` not found      | Check the variable uses `${{Postgres.DATABASE_URL}}` (Railway reference syntax)          |
| CORS errors in browser        | Update `CORS_ORIGINS` on the API service to include the web service URL                  |
| WebSocket connection fails    | Railway supports WebSocket by default — check the web client connects to the correct URL |
| Migration fails               | Run `railway run --service routeflow-api -- npx prisma migrate status` to diagnose       |
