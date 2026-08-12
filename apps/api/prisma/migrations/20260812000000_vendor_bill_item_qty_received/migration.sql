-- Per-line receipt progress for partial receiving (G3). Additive and nullable:
-- null means "no per-line tracking recorded" — a bill received before this
-- column existed (receivedDate set, every line null) counts as fully received.
ALTER TABLE "VendorBillItem" ADD COLUMN "qtyReceived" DECIMAL(10,3);
