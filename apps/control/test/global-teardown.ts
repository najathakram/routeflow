/**
 * Jest globalTeardown: remove the once-per-run build `global-setup.ts` made. Jest runs it after the
 * suites finish whether they passed or failed. It only ever deletes a `.dist-global-<pid>` dir inside
 * apps/control, whatever `CONTROL_TEST_DIST` says.
 */
import * as fs from "fs";
import * as path from "path";
import { GLOBAL_DIST_PREFIX } from "./helpers/build-dist";

const CONTROL = path.resolve(__dirname, "..");

export default async function globalTeardown(): Promise<void> {
  const dir = process.env.CONTROL_TEST_DIST;
  if (!dir) return;
  const resolved = path.resolve(dir);
  if (
    path.dirname(resolved) === CONTROL &&
    path.basename(resolved).startsWith(GLOBAL_DIST_PREFIX)
  ) {
    fs.rmSync(resolved, { recursive: true, force: true });
  }
  delete process.env.CONTROL_TEST_DIST;
}
