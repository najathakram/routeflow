#!/usr/bin/env node
// registry-clone.mjs — `npm run registry:clone`: clone or refresh the private register repo
// (REGISTRY_REPO, branch REGISTRY_BRANCH) into registryCloneDir(). Idempotent. Never forces: a clone
// with uncommitted edits is left untouched and the command exits 2 naming the fix.
//
//   RF_REGISTRY_DIR     clone location (default ~/.routeflow/registry/routeflow-specs)
//   RF_REGISTRY_REMOTE  remote URL (default https://github.com/<REGISTRY_REPO>.git)
// Exit codes: 0 cloned/refreshed, 1 git failed, 2 the clone has uncommitted edits.
import { RegistryError, cloneRegistry } from "./lib/registry-clone.mjs";
import { registryCloneDir } from "./lib/registry-root.mjs";

try {
  console.log(`registry:clone ${cloneRegistry()} ${registryCloneDir()}`);
} catch (e) {
  if (!(e instanceof RegistryError)) throw e;
  console.error(`registry:clone: ${e.message}`);
  process.exit(e.exitCode);
}
