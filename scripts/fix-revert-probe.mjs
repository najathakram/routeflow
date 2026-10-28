#!/usr/bin/env node
// STUB (red commit): same exports as the implementation, empty behaviour.
export const PROBE_MODE = "dark";
export const isFixBranch = () => false;
export const classifyChanged = () => ({ tests: [], fix: [] });
export const jestCommand = () => ({ cmd: "", args: [], cwd: "" });
export const restoreFix = () => ({ ok: true });
export const runProbe = async () => ({ results: [{ file: "", verdict: "stub", reason: "" }] });
