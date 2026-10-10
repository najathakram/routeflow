-- #2169 (SA-395): a system-written InvoiceItem purpose marker (one member today: the NSF
-- bounce-fee line). Additive only: one enum, one nullable column. No backfill, no existing row
-- touched. InvoicesService.setCheckStatus's BOUNCED branch is the only writer going forward; the
-- separate backfill script (apps/api/scripts/backfill-2169-nsf-system-kind.mjs) stamps
-- pre-existing NSF fee lines out-of-band.

-- CreateEnum
CREATE TYPE "InvoiceItemSystemKind" AS ENUM ('NSF_FEE');

-- AlterTable
ALTER TABLE "InvoiceItem" ADD COLUMN "systemKind" "InvoiceItemSystemKind";
