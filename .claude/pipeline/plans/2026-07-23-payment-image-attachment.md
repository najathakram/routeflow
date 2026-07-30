# Plan: Attach an image to a payment record

**Status:** PLANNED
**Scale:** major (schema + migration, endpoints, web + mobile + driver critical path)
**Stacks on:** the "api image compression" branch (PR D) — reuse `compressImage` from
`apps/api/src/storage/compress.util.ts` for the payment image.

## Context

Payment records (`InvoicePayment`) support a text `notes` field; wholesalers want to attach a
photo (receipt/slip/check) too. Clone the expense-receipt attachment pattern
(`Expense.receiptKey` + upload/get/delete endpoints). Single image per payment EVENT. Operator
web + mobile flows AND the driver at-door collect-payment flow are in scope (user-decided).

Key facts (verified by exploration):

- `InvoicePayment` (schema.prisma L1784-1819): `notes String?`, `paymentGroupId String?` (a
  standalone multi-invoice payment creates several rows sharing one group id), `tenantId`. No
  image field. `invoices.module.ts` already imports `StorageModule`.
- Payments list/detail render **per-row** (no group rollup) — so a grouped payment's image must
  be visible from every allocation row.
- Storage keys under `payments/…` are served via presigned URLs only (like `expenses/…`); the
  uploads-controller JWT path only whitelists `tenants|regulated-filings|tobacco-reports`
  prefixes, and expense receipts already rely on presigned URLs — mirror that.
- Reference pattern: `bookkeeping.service.ts` `uploadExpenseReceipt/getExpenseReceiptUrl/deleteExpenseReceipt`
  (L543-597) + `bookkeeping.controller.ts` POST/GET/DELETE `expenses/:id/receipt` (L150-170) +
  web `lib/api/finance.ts` `useUploadExpenseReceipt/useDeleteExpenseReceipt/useGetExpenseReceiptUrl`
  (L384-412) + web expense viewer (`finance/expenses/page.tsx`) + mobile `useUploadProductImages`
  FormData pattern (`lib/api/products.ts` L155-174) + `components/PhotoCapture.tsx`.

**At implementation, reconfirm these anchors by reading the files** (line numbers below are from
the exploration pass): `invoices.service.ts` `recordPayment` (~L3148-3230, creates the row inside
`tenantTransaction` with a FOR UPDATE lock; ~L3191 the `create`), `deletePayment` (~L3477-3540),
`findPaymentById`; `invoices.controller.ts` `findPayment` (~L86-89), class guard
`@Roles(OPERATOR)` (~L36-37), the `@Get(":id")` wildcard (~L118); `routes.controller.ts`
`complete-with-payment` (~L182+) + its service `recordDeliveryPaymentInTx`.

## Work packages

### WP1 — Schema + migration

**Files:** `apps/api/prisma/schema.prisma`, new
`apps/api/prisma/migrations/20260731000000_add_payment_image/migration.sql`.
Add to `model InvoicePayment` (after `nsfFeeAmount`, before the relations block):

```prisma
  // Payment image (receipt / slip / check photo). One image per payment EVENT:
  // grouped standalone rows share one object keyed by paymentGroupId, so these
  // three columns are identical across a group.
  imageKey          String?
  imageOriginalName String?
  imageMimeType     String?
```

Migration:

```sql
ALTER TABLE "InvoicePayment" ADD COLUMN "imageKey" TEXT;
ALTER TABLE "InvoicePayment" ADD COLUMN "imageOriginalName" TEXT;
ALTER TABLE "InvoicePayment" ADD COLUMN "imageMimeType" TEXT;
```

`prisma migrate dev` + `generate` locally. Additive/nullable → prod-safe.

### WP2 — API service methods + recordPayment return + deletePayment cleanup + endpoints

**Files:** `apps/api/src/invoices/invoices.service.ts`, `apps/api/src/invoices/invoices.controller.ts`.
Depends on WP1 (+ PR D's `compressImage`).

Service: inject `StorageService` (constructor) and import `compressDocument` from
`../storage/compress.util`. **Use `compressDocument`, NOT `compressImage`** — the payment-image
endpoint (like the expense-receipt endpoint) has no controller MIME allowlist, and mobile file
pickers routinely send `application/octet-stream`/empty content-type. `compressDocument`
byte-sniffs via sharp (any real image → JPEG) and tolerates a PDF, so a real receipt/check photo
never 500s on a generic content-type (this is the exact regression the compression PR's review
caught for expense receipts — do not reintroduce it here). Add after `findPaymentById`:

```ts
private async findPaymentOrThrow(paymentId: string) {
  const payment = await this.prisma.forTenant().invoicePayment.findUnique({ where: { id: paymentId } });
  if (!payment) throw new NotFoundException("Payment not found");
  return payment;
}

async uploadPaymentImage(paymentId: string, buffer: Buffer, originalName: string, mimeType: string): Promise<{ url: string }> {
  const payment = await this.findPaymentOrThrow(paymentId);
  let compressed;
  try {
    compressed = await compressDocument(buffer, mimeType); // byte-sniffs; JPEG for images, PDF passthrough
  } catch {
    throw new BadRequestException("File is not a decodable image or PDF");
  }
  // One object per payment EVENT: a grouped standalone payment (several rows
  // sharing paymentGroupId) anchors on the group id so the same photo is
  // reachable from every allocation row.
  const anchor = payment.paymentGroupId ?? payment.id;
  const key = `payments/${anchor}/image.${compressed.ext}`;
  await this.storage.upload(key, compressed.buffer, compressed.mimeType);
  const data = { imageKey: key, imageOriginalName: originalName, imageMimeType: compressed.mimeType };
  if (payment.paymentGroupId) {
    await this.prisma.forTenant().invoicePayment.updateMany({ where: { paymentGroupId: payment.paymentGroupId }, data });
  } else {
    await this.prisma.forTenant().invoicePayment.update({ where: { id: paymentId }, data });
  }
  return { url: await this.storage.presignedUrl(key) };
}

async getPaymentImageUrl(paymentId: string): Promise<{ url: string }> {
  const payment = await this.findPaymentOrThrow(paymentId);
  if (!payment.imageKey) throw new NotFoundException("No image attached to this payment");
  return { url: await this.storage.presignedUrl(payment.imageKey) };
}

async deletePaymentImage(paymentId: string): Promise<{ success: boolean }> {
  const payment = await this.findPaymentOrThrow(paymentId);
  if (!payment.imageKey) throw new NotFoundException("No image to delete");
  const clear = { imageKey: null, imageOriginalName: null, imageMimeType: null };
  if (payment.paymentGroupId) {
    await this.prisma.forTenant().invoicePayment.updateMany({ where: { paymentGroupId: payment.paymentGroupId }, data: clear });
  } else {
    await this.prisma.forTenant().invoicePayment.update({ where: { id: paymentId }, data: clear });
  }
  await this.storage.delete(payment.imageKey);
  return { success: true };
}
```

- `recordPayment`: capture the created row and return `{ ...paid, createdPaymentId: payment.id }`
  (additive — existing consumers read Invoice fields off the response and ignore the extra scalar).
- `deletePayment`: after the tx commits, best-effort cleanup — only delete the object if no
  sibling still references it:
  ```ts
  if (imageKey) {
    const stillRef = await this.prisma.forTenant().invoicePayment.count({ where: { imageKey } });
    if (stillRef === 0) await this.storage.delete(imageKey).catch(() => {});
  }
  ```
  (surface `imageKey` out of the tx callback; never do storage I/O inside the money tx; never throw).
  `voidPayment`/`updatePayment`: unchanged (void keeps the row → keeps the image).

Controller: add imports `UseInterceptors, UploadedFile, BadRequestException` (@nestjs/common) +
`FileInterceptor` (@nestjs/platform-express). Insert after `findPayment`, before the `@Get(":id")`
wildcard (routes inherit the class-level OPERATOR guard):

```ts
@Post("payments/:paymentId/image")
@UseInterceptors(FileInterceptor("file", { limits: { fileSize: 10 * 1024 * 1024 } }))
uploadPaymentImage(@Param("paymentId") paymentId: string, @UploadedFile() file: Express.Multer.File) {
  if (!file) throw new BadRequestException("No file uploaded");
  return this.invoicesService.uploadPaymentImage(paymentId, file.buffer, file.originalname, file.mimetype);
}
@Get("payments/:paymentId/image")
getPaymentImage(@Param("paymentId") paymentId: string) { return this.invoicesService.getPaymentImageUrl(paymentId); }
@Delete("payments/:paymentId/image")
deletePaymentImage(@Param("paymentId") paymentId: string) { return this.invoicesService.deletePaymentImage(paymentId); }
```

### WP3 — Driver collect-payment returns created payment ids

**Files:** `apps/api/src/invoices/invoices.service.ts` (`recordDeliveryPaymentInTx`),
`apps/api/src/routes/routes.service.ts` (`completeWithPayment`),
`apps/api/src/routes/routes.service.spec.ts`. Depends on WP1.
Verified structure: `recordDeliveryPaymentInTx` (invoices.service.ts ~L3256-3395) creates one
`tx.invoicePayment.create(...)` per invoice in a loop (~L3358), pushes `inv.id` to `invoiceIds`
(~L3392), and returns `{ applied, invoiceIds }` (~L3395). These rows are NOT grouped (no shared
`paymentGroupId`).

- Change the create at ~L3358 to capture the row (`const pay = await tx.invoicePayment.create(...)`)
  and push `pay.id` into a new `paymentIds: string[]`; return `{ applied, invoiceIds, paymentIds }`
  (also update the three early-return `{ applied: 0, invoiceIds: [] }` guards to include
  `paymentIds: []`, and the return type annotation).
- `completeWithPayment` (routes.service.ts): thread `paymentIds` from the
  `recordDeliveryPaymentInTx` result into the method's response object (additive field).
- Update `routes.service.spec.ts` — the `recordDeliveryPaymentInTx` mock (currently returns
  `{ applied: 0, invoiceIds: [] }`) gains `paymentIds: []`; assert `completeWithPayment` surfaces
  `paymentIds`.
  Additive, non-breaking. The mobile driver photo attaches to `paymentIds[0]` — since delivery
  rows are ungrouped, the photo shows on that first invoice's payment row (acceptable for v1).

### WP4 — Web API layer

**File:** `apps/web/lib/api/invoices.ts`. Add `imageKey?/imageOriginalName?/imageMimeType?` to the
`InvoicePayment` and `AllPayment` interfaces; make `useRecordInvoicePayment`'s result type
`Invoice & { createdPaymentId?: string }`. Add hooks cloned from `lib/api/finance.ts` L384-412:
`useUploadPaymentImage` (FormData field `"file"` → `POST /invoices/payments/${paymentId}/image`,
`Content-Type: multipart/form-data`), `useDeletePaymentImage` (DELETE), `useGetPaymentImageUrl`
(GET mutation). Invalidate `["invoices"]` + `["invoices","payments"]` on success.

### WP5 — Web UI

**Files:** `apps/web/app/(dashboard)/invoices/[id]/page.tsx`,
`apps/web/app/(dashboard)/finance/payments/page.tsx`,
`apps/web/app/(dashboard)/finance/payments/[id]/page.tsx`. Depends on WP4.

- invoice page RecordPaymentModal: `file` state + hidden `<input type="file" accept="image/*">`
  "Attach image (optional)" after Notes; extend `onRecord`/`handleRecordPayment` — after record
  success, if `file && updated.createdPaymentId` upload best-effort (payment must NEVER fail
  because the image failed; on error toast "Payment saved, image upload failed"). Payment History
  row: paperclip + "View receipt" (calls `useGetPaymentImageUrl` → `window.open`). Edit-payment
  modal: View / Replace (immediate upload — payment exists) / Remove.
- finance/payments modal: same attach control; upload to `res.payments[0].id` (server propagates
  to the group); paperclip presence icon in table rows.
- finance/payments/[id]: "Receipt image" section rendering `<img>` from the presigned URL
  (expense-viewer pattern; prints with the page).

### WP6 — Mobile

**Files:** `apps/mobile/lib/api/payments.ts` (or wherever `AllPayment` lives),
`apps/mobile/lib/api/invoices.ts`,
`apps/mobile/app/(operator)/(tabs)/invoices/[id]/record-payment.tsx`,
`apps/mobile/app/(operator)/(tabs)/invoices/[id].tsx`,
`apps/mobile/app/(operator)/(tabs)/invoices/[id]/payments/[paymentId]/edit.tsx`,
`apps/mobile/app/(driver)/route/stop/[stopId]/payment.tsx`. Depends on WP2/WP3.

- API types + hooks: add the 3 image fields; `useRecordInvoicePayment` result gains
  `createdPaymentId`; add `useUploadPaymentImage` (FormData clone of `useUploadProductImages`,
  60s timeout), `useGetPaymentImageUrl`, `useDeletePaymentImage`.
- record-payment.tsx: `PhotoCapture` (maxPhotos 1, "Receipt photo") after Notes; on success,
  HEIC-safe `manipulateAsync(uri, [], { compress: 0.8, format: SaveFormat.JPEG })` then upload to
  `createdPaymentId` via the FormData file helper (`productImageFile`); best-effort + toast.
- invoices/[id].tsx payment rows (~L455-476): "View receipt" via `useGetPaymentImageUrl` +
  `Linking.openURL`.
- payments/[paymentId]/edit.tsx: Add/Replace/Remove photo section (acts immediately).
- driver payment.tsx: optional `PhotoCapture` (maxPhotos 1, "Payment photo"); after
  `useCompleteWithPayment` succeeds, transcode + upload to `paymentIds[0]` — best-effort; stop
  completion must NEVER block or fail on the photo.

### WP7 — Tests

**File:** `apps/api/src/invoices/invoices.service.spec.ts` (extend; existing money tests untouched).
Add a sharp mock (or rely on `compressImage` via a mocked storage) + a `StorageService` mock
provider (`upload → "key"`, `presignedUrl → "https://signed/url"`, `delete`, etc.). Cases: solo
upload (key `payments/pay-1/image.*`, update, url); grouped upload (`updateMany` on the group key);
unknown payment → NotFound; `getPaymentImageUrl` no-key → NotFound; `deletePaymentImage` grouped →
`updateMany` clears + `storage.delete` once; `deletePayment` last-reference cleanup (count 0 →
delete; count 1 → not); `recordPayment` response carries `createdPaymentId`. Add a routes-service
spec assertion that `complete-with-payment` returns `paymentIds`.

## Acceptance criteria

1. `InvoicePayment.imageKey/imageOriginalName/imageMimeType` added; migration additive.
2. Upload/get/delete endpoints work (OPERATOR-guarded); image compressed before storage; served
   via presigned URL; non-image → 400; >10MB → 413.
3. Grouped standalone payment: one object, visible from every allocation row; delete-one keeps the
   object while a sibling references it, delete-last removes it.
4. Web + mobile operator record/edit/list/detail expose attach + view + replace + remove; the
   payment is never lost when an image upload fails.
5. Driver collect-payment returns `paymentIds` and can attach a photo best-effort without ever
   blocking/failing stop completion.
6. `recordPayment` returns `createdPaymentId`; existing consumers unaffected.

## Verify commands (run from repo root)

- `npx tsc -p apps/api/tsconfig.build.json --noEmit`
- `npm run test -w apps/api` (invoices.service.spec + routes spec)
- `npm run lint -w apps/api`
- `npm run check-types -w apps/web && npm run lint -w apps/web`
- `npm run check-types -w apps/mobile && npm run lint -w apps/mobile`
