import { execFileSync } from "child_process";
import { join } from "path";

/**
 * The pipeline hook writes `.claude/pipeline/approach-rotation.json` relative to ITS cwd, so a session started
 * in a subdirectory leaves a stray copy there (`apps/.claude/...`, `apps/api/src/.claude/...`). It is per-machine
 * runtime state (see .gitignore): only the repo-root copy may be tracked. This pin fails when any other tracked
 * path matches `**` + `/.claude/pipeline/approach-rotation.json`, so a stray cannot reach master again.
 * No runtime imports; `git ls-files` is the source of truth (plain `fs` would also see untracked files).
 */
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const ROOT_COPY = ".claude/pipeline/approach-rotation.json";
const STRAY = /(^|\/)\.claude\/pipeline\/approach-rotation\.json$/;

/** The tracked paths that are a stray copy: any match other than the repo-root one. */
export function strayPipelineState(trackedPaths: readonly string[]): string[] {
  return trackedPaths
    .map((p) => p.split("\\").join("/"))
    .filter((p) => STRAY.test(p) && p !== ROOT_COPY);
}

describe("no stray pipeline runtime state is tracked", () => {
  it("the matcher flags a subdirectory copy and nothing else (red row)", () => {
    const fixture = [
      ".claude/pipeline/approach-rotation.json", // the root copy is allowed
      "apps/.claude/pipeline/approach-rotation.json",
      "apps/api/src/.claude/pipeline/approach-rotation.json",
      "apps/web/app/(dashboard)/inventory/_components/.claude/pipeline/approach-rotation.json",
      "apps/api/.claude/pipeline/agent-log.jsonl", // other pipeline files are not this pin's concern
      "apps/api/src/approach-rotation.json", // not under .claude/pipeline
      "docs/not.claude/pipeline/approach-rotation.json", // 'not.claude' is a different directory name
    ];
    expect(strayPipelineState(fixture)).toEqual([
      "apps/.claude/pipeline/approach-rotation.json",
      "apps/api/src/.claude/pipeline/approach-rotation.json",
      "apps/web/app/(dashboard)/inventory/_components/.claude/pipeline/approach-rotation.json",
    ]);
  });

  it("flags Windows-style separators too", () => {
    const win = ["apps", ".claude", "pipeline", "approach-rotation.json"].join(
      String.fromCharCode(92),
    );
    expect(strayPipelineState([win])).toEqual(["apps/.claude/pipeline/approach-rotation.json"]);
  });

  it("the root copy alone is allowed", () => {
    expect(strayPipelineState([ROOT_COPY])).toEqual([]);
  });

  it("no tracked path in this repo is a stray copy", () => {
    const tracked = execFileSync("git", ["-C", REPO_ROOT, "ls-files", "-z"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
      .split("\0")
      .filter(Boolean);
    expect(strayPipelineState(tracked)).toEqual([]);
  });
});
