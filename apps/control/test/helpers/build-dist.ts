/**
 * Compile apps/control into a PRIVATE out dir so a spec never depends on a prebuilt `dist/`.
 * CI runs `turbo test`, which does not build this package's `dist/`, so a spec that spawns
 * `dist/main.js` is red on a fresh checkout. The private dir also keeps parallel specs from
 * racing on one shared `dist/`.
 *
 * Under jest, `test/global-setup.ts` compiles the server ONCE per run into `.dist-global-<pid>` and
 * publishes it as `CONTROL_TEST_DIST`; `buildPrivateDist` then hands every spec that build (its
 * `cleanup()` does nothing: the teardown owns the dir). A spec run outside that setup (no env, or a
 * stale path) still builds its own private copy, exactly as before.
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

/** Prefix of the once-per-run build (`.dist-global-<pid>`), the only dir the teardown may delete. */
export const GLOBAL_DIST_PREFIX = ".dist-global-";

/**
 * Compile apps/control into `dir` (replacing it) and copy the page assets in. A compile error
 * throws with tsc's own output and leaves no half-built dir behind.
 */
export function compileDist(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
  try {
    execFileSync(
      process.execPath,
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
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    const x = e as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
    throw new Error(
      `building ${dir} failed:\n${x.stdout ?? ""}${x.stderr ?? ""}${x.message ?? ""}`,
    );
  }
}

/** The once-per-run build `global-setup.ts` published, when it exists on disk; else null. */
export function sharedDist(): PrivateDist | null {
  const dir = process.env.CONTROL_TEST_DIST;
  if (!dir || !fs.existsSync(path.join(dir, "main.js"))) return null;
  return { dir, main: path.join(dir, "main.js"), cleanup: () => undefined };
}

export function buildPrivateDist(label: string): PrivateDist {
  const shared = sharedDist();
  if (shared) return shared;
  const dir = path.join(CONTROL, `.dist-${label}-${process.pid}`);
  compileDist(dir);
  return {
    dir,
    main: path.join(dir, "main.js"),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}
