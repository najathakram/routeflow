# RouteFlow Multi-Tenant Production Setup Guide

## Overview

RouteFlow operates as a multi-tenant SaaS with:

- **API**: Railway (single service, all tenants)
- **Web dashboard**: Railway (Next.js, wildcard subdomain)
- **Database**: Railway PostgreSQL (single DB, tenant isolation via Row-Level Security)
- **DNS**: Cloudflare (wildcard `*.routeflow.io`)

---

## 1. Cloudflare DNS

### Add wildcard A/CNAME records

In your Cloudflare dashboard for `routeflow.io`:

| Type  | Name  | Value                             | Proxy |
| ----- | ----- | --------------------------------- | ----- |
| CNAME | `*`   | `your-railway-api.up.railway.app` | ✅ ON |
| CNAME | `api` | `your-railway-api.up.railway.app` | ✅ ON |
| CNAME | `app` | `your-railway-web.up.railway.app` | ✅ ON |

> **Note**: Cloudflare proxied wildcard records forward all `*.routeflow.io` traffic
> to Railway. Railway then routes by the `Host` header.

---

## 2. Railway — API Service

### Custom domain

In **Settings → Networking → Custom Domain**:

```
*.routeflow.io
api.routeflow.io
```

> Railway supports wildcard custom domains. Each tenant's subdomain
> (e.g. `acme.routeflow.io`) hits the same API service; the
> `TenantResolutionMiddleware` extracts the slug from the `Host` header.

### Environment variables

```env
NODE_ENV=production
DATABASE_URL=postgresql://...           # Railway PostgreSQL (internal URL)
JWT_SECRET=<256-bit random>
JWT_REFRESH_SECRET=<256-bit random>
REDIS_URL=redis://...                   # Railway Redis (internal URL)

# CORS — comma-separated explicit origins + wildcard domain pattern
CORS_ORIGINS=https://app.routeflow.io,https://api.routeflow.io
CORS_WILDCARD_DOMAINS=routeflow.io,routeflow.app

# Storage (Cloudflare R2)
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET_NAME=routeflow-assets

# Email fallback (Resend)
RESEND_API_KEY=re_...

# Encryption (for per-tenant SMTP passwords + OAuth secrets)
ENCRYPTION_KEY=<32-byte hex — generate with: openssl rand -hex 32>
```

### Dockerfile (already configured — no migrations on deploy)

```dockerfile
CMD ["node", "dist/main.js"]
```

Schema changes are applied **manually** via `prisma db push` or migrations.

---

## 3. Railway — Web Dashboard (Next.js)

### Custom domain

```
*.routeflow.io    → web service
app.routeflow.io  → web service (explicit)
```

### Environment variables

```env
NEXT_PUBLIC_API_URL=https://api.routeflow.io/api/v1
```

The Next.js middleware (`apps/web/middleware.ts`) extracts the tenant slug
from the subdomain automatically — no additional config needed.

---

## 4. First-time setup after deploy

### a) Apply Row-Level Security policies

```bash
node apps/api/scripts/apply-rls.js
```

Run once after the initial deploy. Safe to re-run.

### b) Migrate legacy users

If you have pre-SaaS users with `tenantId = NULL`:

```bash
# Dry run first
node apps/api/scripts/migrate-legacy-users.js --dry-run

# Apply
node apps/api/scripts/migrate-legacy-users.js
```

### c) Create your first SUPER_ADMIN

```sql
INSERT INTO "User" (id, email, username, password, role, status, "forcePasswordChange", "tenantId", "createdAt", "updatedAt")
VALUES (
  gen_random_uuid(),
  'admin@routeflow.io',
  'superadmin',
  '<bcrypt-hash-of-password>',
  'SUPER_ADMIN',
  'ACTIVE',
  false,
  NULL,
  NOW(), NOW()
);
```

Generate hash: `node -e "const b=require('bcrypt'); b.hash('YourPassword', 10).then(console.log)"`

---

## 5. Tenant onboarding flow

1. Tenant signs up via `POST /api/v1/tenants/register`
2. API creates: `Tenant` + `TenantConfig` + initial `TENANT_ADMIN` user
3. Tenant accesses their dashboard at `https://{slug}.routeflow.io`
4. Mobile users enter their company code (`{slug}`) on first launch

---

## 6. Mobile app (EAS)

### Staging build

```bash
cd apps/mobile
eas build --profile staging --platform android
```

### Production build

```bash
eas build --profile production --platform all
```

The `EXPO_PUBLIC_API_URL=https://api.routeflow.app` is baked into the production
build. The company-code screen stores the tenant slug in SecureStore and sends
`X-Tenant-Slug: {slug}` on every API request.

---

## 7. Security checklist

- [ ] `ENCRYPTION_KEY` set (32-byte hex) — required for per-tenant SMTP/OAuth secrets
- [ ] `JWT_SECRET` and `JWT_REFRESH_SECRET` are unique, 256-bit random values
- [ ] RLS applied to all 52 tenant-scoped tables (`apply-rls.js`)
- [ ] `NODE_ENV=production` set (disables Swagger UI)
- [ ] `CORS_WILDCARD_DOMAINS` limited to your own domains
- [ ] Cloudflare proxying enabled (hides Railway origin IPs)
- [ ] Rate limiting active (100 req/60s per IP via ThrottlerModule)
- [ ] AuditLog table monitored for suspicious cross-tenant access patterns

---

## 8. Monitoring

### Key metrics to watch

- `AuditLog` entries with `tenantId = NULL` (super-admin actions)
- Failed login attempts per tenant
- `POST /platform-admin/tenants/:id/impersonate` entries

### Query recent audit activity

```sql
SELECT action, "entityType", "tenantId", "createdAt"
FROM "AuditLog"
ORDER BY "createdAt" DESC
LIMIT 50;
```
