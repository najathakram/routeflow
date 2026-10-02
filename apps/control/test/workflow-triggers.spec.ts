/**
 * T57 (R28) — no GitHub Actions workflow fires on a push to `ctl/state` or `ctl/archive`.
 *
 * spec.md R28: control's git-backed state lives on branches `ctl/state`/`ctl/archive`, pushed by
 * every `ctl` write and by compaction. No workflow may declare a `push:` trigger that would catch
 * those branches (CI/db-migrations/deploy would run needlessly, or worse, treat state-branch
 * commits as application changes) — either the workflow has no `push` key at all, or its
 * `push.branches-ignore` covers a glob that matches `ctl/state`.
 *
 * test-plan.md notes this test is a **pin**: today no `.github/workflows/*.yml` declares a
 * `push:` trigger at all (each uses `pull_request`/`workflow_dispatch`/`schedule`), so it passes
 * right now and exists to catch the day someone adds a bare `push:` trigger without excluding
 * `ctl/**` — it is excluded from the WP0 red gate by name (test-plan.md §6).
 */

import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const WORKFLOWS_DIR = path.join(REPO_ROOT, ".github", "workflows");

type WorkflowOn = Record<string, unknown> | string | string[] | null | undefined;

function listWorkflowFiles(): string[] {
  if (!fs.existsSync(WORKFLOWS_DIR)) return [];
  return fs
    .readdirSync(WORKFLOWS_DIR)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .map((name) => path.join(WORKFLOWS_DIR, name));
}

/** Converts a simple glob (`*`, `**`) to a RegExp anchored on the full string. */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const withGlobs = escaped
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${withGlobs}$`);
}

function matchesCtlState(glob: string): boolean {
  return globToRegExp(glob).test("ctl/state") || globToRegExp(glob).test("ctl/archive");
}

describe("no GitHub Actions push trigger fires on ctl/state or ctl/archive (T57, R28)", () => {
  const files = listWorkflowFiles();

  it("finds at least one workflow file to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((file) => [path.basename(file), file] as const))(
    "%s has no push trigger, or excludes ctl/** via branches-ignore",
    (_name, file) => {
      const doc = yaml.load(fs.readFileSync(file, "utf8")) as { on?: WorkflowOn } | undefined;
      const onBlock = doc?.on;

      if (onBlock == null || typeof onBlock === "string" || Array.isArray(onBlock)) {
        // No structured `on.push` key possible in either shape.
        if (Array.isArray(onBlock)) {
          expect(onBlock).not.toContain("push");
        }
        return;
      }

      const pushTrigger = (onBlock as Record<string, unknown>).push;
      if (pushTrigger === undefined) {
        // No push trigger at all — satisfies R28 trivially.
        return;
      }

      const branchesIgnore = (pushTrigger as { "branches-ignore"?: string[] } | null)?.[
        "branches-ignore"
      ];
      expect(Array.isArray(branchesIgnore)).toBe(true);
      const covered = (branchesIgnore ?? []).some((glob) => matchesCtlState(glob));
      expect(covered).toBe(true);
    },
  );
});
