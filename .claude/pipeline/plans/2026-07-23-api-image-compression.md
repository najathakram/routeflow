# Plan: Compress every server-side image upload

**Status:** PLANNED
**Scale:** small-major (1 shared util + 4 call sites + tests, storage-adjacent)

## Context

RouteFlow stores uploaded files on a Railway volume (or R2). Three server-side image-upload
paths currently store the **raw** uploaded buffer (full-resolution phone photos), wasting disk:

1. Product images — `apps/api/src/products/products.service.ts` `uploadImage`
2. Customer tax documents — `apps/api/src/customers/customers.service.ts` `uploadTaxDocument`
3. Tenant logos — `apps/api/src/tenants/tenants.service.ts` `uploadLogo`

Meanwhile `apps/api/src/storage/compress.util.ts` `compressDocument` (sharp: resize ≤1600px +
JPEG q80, PDF passthrough) is already used by `uploadCustomerDocument`, and
`bookkeeping.service.ts` `uploadExpenseReceipt` inlines an identical sharp block.

Goal: one shared, **alpha-aware** compression util applied at every image upload site.
Crucially, product images and tenant logos can carry transparency (cut-out product shots,
PNG logos) — force-converting them to JPEG would flatten alpha onto black/white. So a new
`compressImage` preserves alpha (→ WebP) and only uses JPEG for opaque images. Documents
(tax docs, expense receipts) keep `compressDocument` (JPEG is fine for scans; it also handles
PDF). No "decompression" is needed anywhere — stored files are standard JPEG/WebP/PNG served
as-is via presigned URLs.

`sharp ^0.34.5` is already an `apps/api` dependency.

## Current state (verified)

### `apps/api/src/storage/compress.util.ts` (full current contents)

```ts
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sharp: (buf: Buffer) => any = require("sharp");

export interface CompressResult {
  buffer: Buffer;
  mimeType: string;
  ext: string;
}

export async function compressDocument(buffer: Buffer, mimeType: string): Promise<CompressResult> {
  if (mimeType === "application/pdf") return { buffer, mimeType: "application/pdf", ext: "pdf" };
  if (mimeType.startsWith("image/")) {
    const out = (await sharp(buffer)
      .resize({ width: 1600, withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer()) as Buffer;
    return { buffer: out, mimeType: "image/jpeg", ext: "jpg" };
  }
  throw new Error(`Unsupported mime type: ${mimeType}`);
}
```

### `products.service.ts` `uploadImage` (L256-284)

Builds `const ext = originalName.split(".").pop() ?? "jpg";` then
`const key = \`products/${id}/${crypto.randomUUID()}${fpSuffix}.${ext}\`;`(fpSuffix from`encodeFocalSuffix(focal)`), then `await this.storage.upload(key, buffer, mimetype);`. Pushes
`key`to`product.imageKeys[]`. Does NOT persist a mimeType. Returns `{ key, url }`.

### `customers.service.ts` `uploadTaxDocument` (L2149-2164)

`const ext = (originalName.split(".").pop() ?? "jpg").toLowerCase();`
`const key = \`customers/${id}/tax-documents/${crypto.randomUUID()}.${ext}\`;`
`await this.storage.upload(key, buffer, mimetype);` pushes to `taxExemptDocumentKeys[]`.
The SAME file's `uploadCustomerDocument` (L2194+) already does the target pattern:
`const compressed = await compressDocument(buffer, mimetype); const key = \`...${compressed.ext}\`; await this.storage.upload(key, compressed.buffer, compressed.mimeType);`
`compressDocument` is already imported at the top of customers.service.ts.

### `tenants.service.ts` `uploadLogo` (L355-373)

`const ext = (path.extname(file.originalname) || ".jpg").toLowerCase().replace(/[^a-z0-9.]/g, "");`
`const key = \`tenants/${tenantId}/logo${ext}\`;`then`await this.storage.upload(key, file.buffer, file.mimetype);`then updates`logoKey`,
invalidates invoice PDF cache, returns presigned URL. Controller restricts to PNG/JPEG/WEBP,
5 MB.

### `bookkeeping.service.ts` `uploadExpenseReceipt` (L543-579)

Inlines: if not PDF → `sharp(buffer).resize({ width: 1600, withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer()`, `finalMime = "image/jpeg"`; `ext = isPdf ? "pdf" : "jpg"`;
`key = \`expenses/${id}/receipt.${ext}\``; persists `receiptKey/receiptOriginalName/receiptMimeType`.

## Work packages

### WP1 — Add `compressImage` to `compress.util.ts` + spec

**Files:** `apps/api/src/storage/compress.util.ts`, new `apps/api/src/storage/compress.util.spec.ts`.

Add an alpha-aware image compressor beside `compressDocument`:

```ts
/**
 * Compress an uploaded IMAGE for storage, preserving transparency:
 * - resize to max `maxWidth`px wide (no enlargement), auto-orient via EXIF
 * - images WITH an alpha channel (PNG/WebP cut-outs, logos) → WebP q82 (keeps alpha)
 * - opaque images → JPEG q80 (smallest)
 * Throws if the mime type is not image/*. Callers that must also accept PDFs
 * should use `compressDocument` instead.
 */
export async function compressImage(
  buffer: Buffer,
  mimeType: string,
  maxWidth = 1600,
): Promise<CompressResult> {
  if (!mimeType.startsWith("image/")) {
    throw new Error(`Unsupported mime type: ${mimeType}`);
  }
  const img = sharp(buffer).rotate(); // honor EXIF orientation, then strip the tag
  const meta = await img.metadata();
  img.resize({ width: maxWidth, withoutEnlargement: true });
  if (meta.hasAlpha) {
    const out = (await img.webp({ quality: 82 }).toBuffer()) as Buffer;
    return { buffer: out, mimeType: "image/webp", ext: "webp" };
  }
  const out = (await img.jpeg({ quality: 80 }).toBuffer()) as Buffer;
  return { buffer: out, mimeType: "image/jpeg", ext: "jpg" };
}
```

**Spec** (`compress.util.spec.ts`, real sharp — node env, no mock): generate tiny fixtures with
sharp itself so the test is deterministic and needs no binary assets:

- alpha PNG: `await sharp({ create: { width: 4, height: 4, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer()` → `compressImage(buf, "image/png")` returns `mimeType: "image/webp"`, `ext: "webp"`, non-empty buffer.
- opaque JPEG: `channels: 3` (or `.jpeg()`) → `compressImage` returns `image/jpeg`, `ext: "jpg"`.
- oversized opaque image (width 3000) with `maxWidth: 512` → output metadata width ≤ 512 (decode the result with `sharp(out).metadata()`).
- non-image mime (`"text/plain"`) → rejects with `/Unsupported mime type/`.
- `compressDocument` still: PDF passthrough (mime unchanged, ext "pdf"); image → JPEG.

### WP2 — Apply compression at product image upload

**File:** `apps/api/src/products/products.service.ts` (only). Depends on WP1.
Import `compressImage` from `../storage/compress.util`. In `uploadImage`, compress before
building the key so the key extension matches the stored bytes:

```ts
const compressed = await compressImage(buffer, mimetype);
const fpSuffix = encodeFocalSuffix(focal);
const key = `products/${id}/${crypto.randomUUID()}${fpSuffix}.${compressed.ext}`;
await this.storage.upload(key, compressed.buffer, compressed.mimeType);
```

Keep the focal suffix BEFORE the extension (unchanged position). Verify the focal
decoder (`encodeFocalSuffix`/its decode counterpart) parses the suffix independent of the
extension (it splits on the final `.`), so a `.webp`/`.jpg` key still round-trips the focal —
if the decoder is ext-sensitive, adjust it, otherwise no change. `imageKeys[]` push unchanged.

### WP3 — Apply compression at tax-document + logo uploads

**Files:** `apps/api/src/customers/customers.service.ts`, `apps/api/src/tenants/tenants.service.ts`
(disjoint from WP2/WP4). Depends on WP1.

- `uploadTaxDocument`: mirror `uploadCustomerDocument` in the same file — replace the raw
  ext/upload with `const compressed = await compressDocument(buffer, mimetype);` (PDF-safe, tax
  docs may be PDFs), `key = \`customers/${id}/tax-documents/${crypto.randomUUID()}.${compressed.ext}\``,
`storage.upload(key, compressed.buffer, compressed.mimeType)`. `compressDocument` already imported.
- `uploadLogo`: import `compressImage` from `../storage/compress.util`. Logos are images (no
  PDF); use `compressImage(file.buffer, file.mimetype, 512)` (logos don't need 1600px, and
  alpha must survive for transparent PNG logos). Build `key = \`tenants/${tenantId}/logo.${compressed.ext}\``and`storage.upload(key, compressed.buffer, compressed.mimeType)`. Keep the PDF-cache
invalidation + presigned URL. (Old key had `logo${ext}` where ext included the dot; new form
  is `logo.${compressed.ext}` — fine, keys are overwritten per tenant; the presignedUrl is
  re-derived from the new key.)

### WP4 — Refactor expense receipt to the shared util

**File:** `apps/api/src/bookkeeping/bookkeeping.service.ts` (only). Depends on WP1.
Replace the inline sharp block in `uploadExpenseReceipt` with
`const compressed = await compressDocument(buffer, mimeType);` then
`key = \`expenses/${id}/receipt.${compressed.ext}\``,
`storage.upload(key, compressed.buffer, compressed.mimeType)`, and persist
`receiptMimeType: compressed.mimeType`. Behavior is identical (compressDocument === the inline
block). Remove the now-unused inline `sharp` import if nothing else in the file uses it (grep
first — leave it if other methods use sharp).

## Acceptance criteria

1. `compressImage` exists, alpha-aware (WebP for alpha, JPEG for opaque), configurable maxWidth,
   throws on non-image mime; `compress.util.spec.ts` passes with real sharp.
2. Product images, tax documents, and tenant logos are compressed before `storage.upload`; the
   storage key extension matches the compressed bytes.
3. Product image focal-point suffix still round-trips through the key.
4. Expense receipt upload uses `compressDocument` with identical behavior; existing bookkeeping
   tests still pass.
5. Transparent PNG logo/product image keeps its alpha (stored as WebP), opaque photo stored as JPEG.

## Verify commands (run from repo root)

- `npx tsc -p apps/api/tsconfig.build.json --noEmit` (typecheck EXCLUDING scripts/ — plain
  `check-types`/`tsc --noEmit` picks up pre-existing errors under `scripts/` and is unusable)
- `npm run test -w apps/api` (Jest — new compress.util.spec + existing bookkeeping/customers/products specs)
- `npm run lint -w apps/api`
