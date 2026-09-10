#!/usr/bin/env node
/**
 * Unmocked PDF render smoke — proves apps/api's money-document PDFs still render
 * through the React copy apps/api actually resolves (the hoisted root one).
 *
 * The api Jest config maps `@react-pdf/renderer` and both templates to stubs
 * (`test/__mocks__/*`), so no spec exercises a real render. This script does:
 * it loads the COMPILED templates from `apps/api/dist` (run
 * `npm run build -w apps/api` first) and calls the real `renderToBuffer` on the
 * invoice and the monthly-statement templates with minimal acme fixtures.
 *
 * Usage (from repo root):  npm run build -w apps/api && npm run smoke:pdf -w apps/api
 * Exit 0 = both rendered a real PDF (starts "%PDF-", > 1000 bytes); non-zero otherwise.
 */
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const apiRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(apiRoot, "package.json"));

const reactPkgPath = require.resolve("react/package.json");
const reactVersion = require(reactPkgPath).version;
console.log(`react resolved from apps/api: ${reactVersion} (${reactPkgPath})`);

const invoiceTemplatePath = join(apiRoot, "dist", "invoices", "invoice-pdf-template.js");
const statementTemplatePath = join(apiRoot, "dist", "buyer", "statement-pdf-template.js");
for (const p of [invoiceTemplatePath, statementTemplatePath]) {
  if (!existsSync(p)) {
    console.error(
      `FAIL: compiled template missing: ${p} — run \`npm run build -w apps/api\` first`,
    );
    process.exit(2);
  }
}

const React = require("react");
const { renderToBuffer } = require("@react-pdf/renderer");
const { InvoicePdfTemplate } = require(invoiceTemplatePath);
const { StatementPdfTemplate } = require(statementTemplatePath);

const invoice = {
  id: "inv-smoke-1",
  invoiceNumber: "INV-ACME-0001",
  status: "SENT",
  issueDate: "2026-09-01T00:00:00.000Z",
  dueDate: "2026-10-01T00:00:00.000Z",
  subtotal: 20,
  taxAmount: 0,
  discount: 0,
  shippingFee: 0,
  total: 20,
  customer: { businessName: "Acme Retail" },
  items: [
    {
      id: "item-smoke-1",
      description: "Acme Widget",
      qty: 2,
      unitPrice: 10,
      discount: 0,
      taxRate: 0,
      subtotal: 20,
    },
  ],
  payments: [],
  tenant: { businessName: "Acme Wholesale" },
};

const statement = {
  period: {
    month: "2026-08",
    from: "2026-08-01T00:00:00.000Z",
    to: "2026-09-01T00:00:00.000Z",
    label: "August 2026",
  },
  customer: { id: "cust-smoke-1", businessName: "Acme Retail" },
  opening: 0,
  charges: 20,
  payments: 0,
  credits: 0,
  adjustments: 0,
  closing: 20,
  availableCredit: 0,
  lineItems: [
    {
      date: "2026-08-15T00:00:00.000Z",
      type: "INVOICE",
      description: "Invoice INV-ACME-0001",
      reference: "INV-ACME-0001",
      amount: 20,
    },
  ],
};

const cases = [
  ["invoice", () => React.createElement(InvoicePdfTemplate, { invoice })],
  [
    "statement",
    () =>
      React.createElement(StatementPdfTemplate, {
        statement,
        tenant: null,
        generatedAt: new Date("2026-09-01T12:00:00.000Z"),
      }),
  ],
];

let failed = 0;
for (const [name, build] of cases) {
  try {
    const buf = await renderToBuffer(build());
    const magic = buf.subarray(0, 5).toString("latin1");
    if (magic !== "%PDF-" || buf.length <= 1000) {
      failed++;
      console.error(`FAIL ${name}: magic=${JSON.stringify(magic)} length=${buf.length}`);
    } else {
      console.log(`ok   ${name}: ${buf.length} bytes, starts %PDF-`);
    }
  } catch (err) {
    failed++;
    console.error(`FAIL ${name}: render threw — ${err instanceof Error ? err.stack : err}`);
  }
}

if (failed) {
  console.error(`pdf-render-smoke: ${failed} template(s) failed`);
  process.exit(1);
}
console.log("pdf-render-smoke: all templates rendered");
