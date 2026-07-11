-- Per-line note carried from OrderItem.notes onto the invoice line (buyer-visible).
-- Additive + nullable: safe to apply before the app deploy; the old image ignores it.
ALTER TABLE "InvoiceItem" ADD COLUMN "notes" TEXT;
