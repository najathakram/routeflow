// Jest stub for @react-pdf/renderer (ESM package)
"use strict";

async function renderToBuffer() {
  return Buffer.from("");
}

module.exports = {
  renderToBuffer,
  Document: () => null,
  Page: () => null,
  View: () => null,
  Text: () => null,
  Image: () => null,
  StyleSheet: { create: (s) => s },
};
