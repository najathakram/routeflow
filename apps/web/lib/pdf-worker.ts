/**
 * W-1064 (SA-1074): where pdf.js's worker lives. Webpack emits it under `/_next/static/media`, same-origin, so `worker-src
 * 'self'` allows it. Kept in its own file and loaded by `import()`, because `next/jest` compiles to CommonJS, where
 * `import.meta` fails at load.
 */
export const pdfWorkerSrc = (): string =>
  new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url).toString();
