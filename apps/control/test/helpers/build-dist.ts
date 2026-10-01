/**
 * Compile apps/control into a PRIVATE out dir so a spec never depends on a prebuilt `dist/`.
 * CI runs `turbo test`, which does not build this package's `dist/`, so a spec that spawns
 * `dist/main.js` is red on a fresh checkout. The private dir also keeps parallel specs from
 * racing on one shared `dist/`.
 *
 * The dir stays inside apps/control because the compiled server resolves the shared denylist
 * relative to itself; apps/control/.gitignore ignores `.dist-*` so a killed run cannot leave files
 * behind for `git add -A`. Call `cleanup()` in `afterAll`.
 */
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

const CONTROL = path.join(__dirname, "..", "..");

export interface PrivateDist {
  dir: string;
  /** The compiled entry point (`node <main>`). */
  main: string;
  cleanup(): void;
}

export function buildPrivateDist(label: string): PrivateDist {
  const dir = path.join(CONTROL, `.dist-${label}-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  execFileSync(
    "node",
    [
      require.resolve("typescript/bin/tsc"),
      "-p",
      "tsconfig.build.json",
      "--outDir",
      dir,
      "--incremental",
      "false",
    ],
    { cwd: CONTROL, stdio: "pipe" },
  );
  // tsc emits only .ts output: the page assets ride along from src, as in the Dockerfile
  fs.cpSync(path.join(CONTROL, "src/render/assets"), path.join(dir, "render/assets"), {
    recursive: true,
  });
  return {
    dir,
    main: path.join(dir, "main.js"),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}
