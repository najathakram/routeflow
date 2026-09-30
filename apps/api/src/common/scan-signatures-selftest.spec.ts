import { spawnSync } from "node:child_process";
import path from "node:path";

// REG-G1 / R8 (P0) — the bug-signature scanner proves its own signatures.
//
// R8 adds six new signatures to `.claude/skills/bug-hunt/scripts/scan-signatures.mjs`. A
// signature is only worth what its regex is worth: one that matches nothing is a silent
// false-clean, and one that matches everything gets suppressed into uselessness within a week.
// So the scanner grew a `--self-test` mode that runs every signature against a mandatory
// inline offender/clean fixture pair. On the untouched branch the flag does not exist and this
// whole file is red.
//
// The trap this file is written around: a CLI that ignores an unrecognised flag and exits 0
// would satisfy a naive `expect(status).toBe(0)`. So exit status alone is never the assertion —
// the run must produce the self-test's own report shape, and its per-signature count must
// match `--list` exactly, which is what catches a mode that silently skips signatures.

const REPO_ROOT = path.join(__dirname, "..", "..", "..", "..");
const SCANNER = path.join(
  REPO_ROOT,
  ".claude",
  "skills",
  "bug-hunt",
  "scripts",
  "scan-signatures.mjs",
);

/** The six signatures R8 adds — named explicitly so dropping one is a red, not a smaller number. */
const NEW_SIGNATURE_IDS = [
  "unscoped-wipe",
  "draft-payment-not-void",
  "boxed-rederive",
  "import-parsefloat-money",
  "api-calendar-date",
  "log-only-catch",
];

function runScanner(...flags: string[]) {
  return spawnSync(process.execPath, [SCANNER, ...flags], { encoding: "utf8", cwd: REPO_ROOT });
}

describe("REG-G1 bug-signature scanner self-test (R8 / T-G1)", () => {
  const selfTest = runScanner("--self-test");
  const list = runScanner("--list");

  it("REG-G1: --self-test exits 0", () => {
    expect(selfTest.status).toBe(0);
  });

  it("REG-G1: --self-test really ran the fixture harness, not an ignored-flag fallback", () => {
    // `self-test PASS (n/n signatures)` is a line only runSelfTest emits. Without this, a
    // scanner that shrugged at an unknown flag and exited 0 would read as a pass.
    const summary = selfTest.stdout.match(/self-test PASS \((\d+)\/(\d+) signatures\)/);
    expect(summary).not.toBeNull();

    // Every id the scanner declares must have been exercised — a mode that quietly skipped
    // half of them would still print PASS, so tie the count to `--list`.
    const listedIds = list.stdout
      .split("\n")
      .map((l) => l.trim().split(/\s+/)[0])
      .filter(Boolean);
    expect(listedIds.length).toBeGreaterThanOrEqual(NEW_SIGNATURE_IDS.length);
    expect(Number(summary![1])).toBe(listedIds.length);
    expect(Number(summary![2])).toBe(listedIds.length);

    for (const id of listedIds) {
      expect(selfTest.stdout).toMatch(new RegExp(`^✓ ${id}$`, "m"));
    }
  });

  it("REG-G1: every one of R8's six new signatures proves itself in both directions", () => {
    for (const id of NEW_SIGNATURE_IDS) {
      // Present in the catalogue at all…
      expect(list.stdout).toMatch(new RegExp(`^${id}\\s`, "m"));
      // …and passed BOTH its offender fixture (regex actually matches the bug) and its clean
      // fixture (regex does not flag the known-good shape). `✓` is printed only when neither
      // direction recorded a miss.
      expect(selfTest.stdout).toMatch(new RegExp(`^✓ ${id}$`, "m"));
    }
  });
});
