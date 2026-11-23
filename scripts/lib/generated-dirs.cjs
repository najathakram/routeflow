"use strict";
// The ONE list of generated / tool-written folders a source scan must never walk.
//
// A cross-workspace scan (a pricing spec reading apps/web, an api spec reading packages/*) walks trees that OTHER
// workspaces' tools are writing into at the same moment under `turbo run test`: web jest renames temp files inside
// apps/web/.jest-cache, so a scan that stats them dies with ENOENT and refuses a push. Import this list
// instead of hand-typing one; generated-dirs.pin.spec.ts fails a cross-workspace scan that declares its own set
// without it. CommonJS so a Jest spec can `require` it.
const GENERATED_DIRS = Object.freeze([
  "node_modules",
  ".next",
  "dist",
  ".expo",
  "coverage",
  ".turbo",
  ".jest-cache",
]);

module.exports = { GENERATED_DIRS };
