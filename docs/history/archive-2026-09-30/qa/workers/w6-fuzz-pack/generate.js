/**
 * W6 Fuzz Pack Generator
 * Generates test documents for upload-endpoint QA at:
 *   1. POST /api/v1/bookkeeping/expenses/:id/receipt  (expense receipt)
 *   2. POST /api/v1/vendor-bills/scan-invoice          (OCR scan)
 *   3. Returns /:id — no dedicated upload endpoint exists (confirmed via code audit)
 *
 * Run: node generate.js
 * Output: all files written to the same directory as this script.
 */

const fs = require("fs");
const path = require("path");

const OUT = __dirname;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function write(filename, content) {
  const dest = path.join(OUT, filename);
  if (Buffer.isBuffer(content)) {
    fs.writeFileSync(dest, content);
  } else {
    fs.writeFileSync(dest, content, "utf8");
  }
  const stat = fs.statSync(dest);
  console.log(`  [OK] ${filename}  (${stat.size} bytes)`);
}

// ─── F01 — Minimal valid PDF ───────────────────────────────────────────────────
// Raw PDF-1.4 with a single blank page. No external libraries needed.
const MINIMAL_PDF = `%PDF-1.4
1 0 obj<</Type /Catalog /Pages 2 0 R>>endobj
2 0 obj<</Type /Pages /Kids[3 0 R] /Count 1>>endobj
3 0 obj<</Type /Page /Parent 2 0 R /MediaBox[0 0 612 792]>>endobj
xref
0 4
0000000000 65535 f\r
0000000009 00000 n\r
0000000058 00000 n\r
0000000115 00000 n\r
trailer<</Size 4 /Root 1 0 R>>
startxref
190
%%EOF`;

write("f01-clean-invoice.pdf", Buffer.from(MINIMAL_PDF, "utf8"));

// ─── F01-TXT — Plain text invoice ─────────────────────────────────────────────
const PLAIN_TEXT_INVOICE = `INVOICE #001
Date: 2026-04-29
Vendor: Acme Supplies Co.
Address: 42 Distribution Ave, Warehouse District

Bill To:
  RouteFlow Operator
  1 Main Street

Line Items:
  1x Widget A           $12.50
  3x Gizmo B            $45.00
  2x Sprocket C         $18.00
  1x Delivery Fee        $5.00

                         --------
Subtotal:               $80.50
Tax (10%):               $8.05
                         --------
TOTAL DUE:              $88.55

Payment terms: Net 30
Thank you for your business.
`;

write("f01-clean-invoice.txt", PLAIN_TEXT_INVOICE);

// ─── F05 — Minimal valid 1×1 white JPEG ───────────────────────────────────────
// Known-good minimal JPEG bytes (1×1 white pixel).
const JPEG_HEX =
  "ffd8ffe000104a46494600010100000100010000" +
  "ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f14" +
  "1d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d" +
  "38323c2e333432ffc0000b080001000101011100ffc4001f00000105010101" +
  "01010100000000000000000102030405060708090a0bffda00080101000003" +
  "f0ffd9";

write("f05-receipt-clean.jpg", Buffer.from(JPEG_HEX, "hex"));

// ─── F16 — Password-protected PDF note ────────────────────────────────────────
// Generating a genuinely encrypted PDF requires a library (pdf-lib, etc.).
// This placeholder documents the test intent for manual QA.
const F16_NOTE = `NOTE: f16-password-protected.pdf cannot be generated without a library.

Manual QA step:
  1. Open any PDF in Adobe Acrobat or an online PDF encryptor.
  2. Set a password and export as "f16-password-protected.pdf".
  3. Upload to:
       - POST /api/v1/bookkeeping/expenses/:id/receipt
       - POST /api/v1/vendor-bills/scan-invoice

Expected behaviour:
  - Expense receipt endpoint: sharp will throw on the non-image data; the
    server will crash with a 500 instead of returning a useful 400. (See W6-003)
  - Scan-invoice endpoint: Anthropic SDK will receive encrypted bytes and
    return a parsing failure. Ideally the server returns 422 with a message.

Password to use for the test file: P@$$w0rd123
`;

write("f16-password-protected.txt", F16_NOTE);

// ─── F17 — Corrupt/truncated PDF ──────────────────────────────────────────────
// Take the minimal PDF and truncate it at byte 200 (well into the xref section).
const CORRUPT_PDF = Buffer.from(MINIMAL_PDF, "utf8").slice(0, 200);
write("f17-corrupt.pdf", CORRUPT_PDF);

// ─── F18 — Mislabeled PDF (plain text inside .pdf extension) ──────────────────
write(
  "f18-mislabeled.pdf",
  Buffer.from("INVOICE #001\nThis is plain text, not a real PDF.\n", "utf8"),
);

// ─── F19 — SVG with embedded XSS script ───────────────────────────────────────
const XSS_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
  <rect width="100" height="100" fill="white"/>
  <script type="text/javascript">alert('xss-w6')</script>
  <image href="x" onerror="alert('xss-onerror')"/>
</svg>`;

write("f19-xss.svg", Buffer.from(XSS_SVG, "utf8"));

// ─── F_EMPTY — Zero-byte file with .pdf extension ─────────────────────────────
write("f_empty.pdf", Buffer.alloc(0));

// ─── F20 — Very large file (~26 MB) ───────────────────────────────────────────
// 26 MB of repeated text to probe file-size limits.
// Expense receipt limit: 10 MB  → should be rejected with 413.
// Scan-invoice limit:   20 MB  → should be rejected with 413.
// We use 26 MB to exceed BOTH limits.
const CHUNK = Buffer.from("INVOICE LINE ITEM: Widget XYZ  QTY:  1  UNIT: $99.99  TOTAL: $99.99\n");
const TARGET_SIZE = 26 * 1024 * 1024; // 26 MB
const repeatCount = Math.ceil(TARGET_SIZE / CHUNK.length);
const HUGE_BUF = Buffer.concat(Array(repeatCount).fill(CHUNK)).slice(0, TARGET_SIZE);
write("f20-huge.pdf", HUGE_BUF);

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log("\nW6 fuzz pack generation complete.");
console.log("Files written to:", OUT);
console.log("\nFile inventory:");
fs.readdirSync(OUT)
  .filter((f) => f !== "generate.js" && f !== "findings.md")
  .sort()
  .forEach((f) => {
    const s = fs.statSync(path.join(OUT, f));
    const kb = (s.size / 1024).toFixed(1);
    console.log(`  ${f.padEnd(35)} ${kb.padStart(9)} KB`);
  });
