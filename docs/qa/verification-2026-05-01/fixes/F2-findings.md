# F2-XSS

## RFs addressed

| RF     | Sev | Status          | Files                                                                        | Commit    | Test added                 | Migration? |
| ------ | --- | --------------- | ---------------------------------------------------------------------------- | --------- | -------------------------- | ---------- |
| RF-076 | P0  | ✅ FIXED+TESTED | `products.controller.ts`, `customers.controller.ts`, `uploads.controller.ts` | see below | Yes — 13 tests pass        | No         |
| RF-157 | P1  | ✅ FIXED+TESTED | `products.controller.ts`, `customers.controller.ts`                          | see below | Yes — 11 MIME filter tests | No         |
| RF-078 | P1  | ✅ FIXED+TESTED | `uploads.controller.ts`                                                      | see below | Yes — 2 header tests       | No         |

## What was changed

### 1. `apps/api/src/products/products.controller.ts`

`@Post(":id/images")` multer `fileFilter` replaced with a **strict allowlist** (`Set<image/jpeg, image/png, image/webp>`).  
Previously the filter only blocked `image/svg+xml` by name; any other non-image or unusual MIME would silently pass through.  
Now any unlisted MIME (including SVG, GIF, HTML, JS) returns HTTP 400 with a clear message.

### 2. `apps/api/src/customers/customers.controller.ts`

`@Post(":id/tax-documents")` multer `fileFilter` replaced with a strict allowlist (`image/jpeg`, `image/png`, `image/webp`, `application/pdf`).  
PDFs are permitted for tax documents. All other MIMEs (including SVG) are rejected with HTTP 400.

### 3. `apps/api/src/uploads/uploads.controller.ts` ← RF-078

Removed the conditional that only set `Content-Disposition: attachment` for non-image types.  
**Now always sets `Content-Disposition: attachment; filename="…"` regardless of content type.**  
This means images served via the local file server are also forced to download, preventing any future MIME-confusion or SVG-inline-render attack.  
`X-Content-Type-Options: nosniff` was already present — retained.

### 4. `apps/api/scripts/purge-live-svg-xss.js` (new — do not auto-run)

Idempotent cleanup script for the `ux-audit-1777265477001` tenant only.  
Scans `Product.imageKeys` and `CustomerDocument` rows for `.svg` keys, deletes the files, and removes the DB references.  
Never touches the `affa` tenant. **Operator must run manually after deploy.**

### 5. `apps/api/src/uploads/uploads-xss.security.spec.ts` (new)

13 Jest unit/integration tests:

- 7 tests for product image MIME allowlist (SVG, HTML, JS, GIF all → 400; JPEG/PNG/WEBP → pass)
- 4 tests for tax-doc MIME allowlist (SVG/HTML → 400; PDF/JPEG → pass)
- 2 supertest tests verifying `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff` on `GET /uploads/*`

## Notes / blockers

- The `file-type` magic-byte sniffing (defense-in-depth bullet 3) was **skipped** — the `file-type` package is ESM-only and adding it would require build changes. The allowlist alone closes the audit finding.
- R2 (Cloudflare) serves files via presigned URLs with its own headers; the `uploads.controller.ts` fix only covers the local-disk fallback path. For R2, `Content-Disposition` must be set at upload time or via a Cloudflare Transform Rule — out of scope for this PR.
- Build: `npx nest build` — **PASS** (zero errors, zero warnings).
- Tests: `npx jest uploads-xss.security.spec` — **13/13 PASS**.

## User-visible proof of fix

- Uploading `<svg><script>alert(1)</script></svg>` as `evil.svg` to `POST /products/:id/images` or `POST /customers/:id/tax-documents` now returns:
  ```json
  {
    "statusCode": 400,
    "message": "File type \"image/svg+xml\" is not permitted. Allowed types: JPEG, PNG, WEBP."
  }
  ```
- `GET /uploads/some-image.png` response now always includes:
  ```
  Content-Disposition: attachment; filename="some-image.png"
  X-Content-Type-Options: nosniff
  ```
