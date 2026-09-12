// Jest mock for InvoiceTemplate (bookkeeping) — depends on @react-pdf/renderer ESM.
// Same pattern as invoice-pdf-template.js / tobacco-report-pdf.js / statement-pdf-template.js:
// these PDF template components are unreachable by ts-jest's transform as real .tsx files from
// a plain require() (no JSX/tsx entry in the transform config), so each gets an inert manual
// mock wired via moduleNameMapper instead of widening the transform for the whole project.
module.exports = {
  InvoiceTemplate: () => null,
};
