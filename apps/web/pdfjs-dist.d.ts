// pdf.js ships types for pdf.mjs but not its minified twin; they're the same module.
declare module "pdfjs-dist/legacy/build/pdf.min.mjs" {
  export * from "pdfjs-dist";
}
