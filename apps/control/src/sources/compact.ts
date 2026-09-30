/**
 * Compaction (spec §8): snapshot.json at the tip, segments moved to the archive branch, new
 * segments start with a header. fold(snapshot + new segments) == fold(all events): the snapshot
 * keeps a slimmed replay (inert note text dropped) so the one fold function stays the only truth.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import type { ControlEvent } from "../domain/types";
import { CTL_IDENTITY, CtlError, git, gitTry } from "./git";
import type { Env } from "./git";
import { withLock } from "./lock";
import {
  appendRetrySleep,
  ensureClone,
  foldDir,
  lastSeq,
  lockDirOf,
  readTree,
  syncClone,
} from "./state-branch";
import type { SnapshotFile } from "./state-branch";

const MAX_ATTEMPTS = 6;

const slim = (e: ControlEvent): Record<string, unknown> => {
  const { lane: _lane, ...rest } = e;
  void _lane;
  return e.type === "lane.note" ? { ...rest, note: "" } : rest;
};

export interface CompactResult {
  compacted: boolean;
  archived: string[];
}

/** Compact the state branch from `env.cloneDir`. Safe to re-run; never rewrites history. */
export async function compact(env: Env): Promise<CompactResult> {
  const clone = await ensureClone(env);
  const sleep = (ms: number): Promise<void> =>
    env.sleep ? env.sleep(ms) : new Promise<void>((r) => setTimeout(r, ms));
  return withLock(lockDirOf(clone), 30_000, async () => {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        syncClone(env, clone);
      } catch (e) {
        throw new CtlError(5, (e as Error).message);
      }
      const tree = readTree(clone);
      const now = env.now();
      const lanes = Object.keys(tree.lanes).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const archives: { file: string; text: string }[] = [];
      const replay: Record<string, Record<string, unknown>[]> = {};
      const seqByLane: Record<string, number> = {};
      const fresh: Record<string, string> = {};
      for (const lane of lanes) {
        const d = tree.lanes[lane];
        const last = lastSeq(tree, lane);
        seqByLane[lane] = last;
        replay[lane] = [...(tree.snap?.replay[lane] ?? []), ...d.liveEvents.map(slim)];
        if (d.liveEvents.length > 0) {
          const first = d.liveEvents[0].seq;
          const text =
            d.live.filter((l) => !l.startsWith('{"seq":0,"type":"segment"')).join("\n") + "\n";
          archives.push({ file: `archive/${lane}/${first}-${last}.jsonl`, text });
        }
        fresh[lane] = JSON.stringify({ seq: 0, type: "segment", from: last + 1 }) + "\n";
      }
      if (archives.length === 0) return { compacted: false, archived: [] };

      const state = foldDir(clone, env.registers, now);
      const sha = git(clone, ["rev-parse", "HEAD"]).trim();
      const snap: SnapshotFile = {
        v: 1,
        at: now,
        sha,
        seqByLane,
        tasks: state.tasks,
        lanes: state.lanes,
        releases: state.releases,
        acks: state.acks,
        version: state.version,
        replay,
      };

      pushArchive(env, clone, archives);

      for (const lane of lanes) {
        const f = path.join(clone, "events", `${lane}.jsonl`);
        fs.mkdirSync(path.dirname(f), { recursive: true });
        writeAtomic(f, fresh[lane]);
      }
      writeAtomic(path.join(clone, "snapshot.json"), JSON.stringify(snap));
      git(clone, ["add", "-A"]);
      git(clone, [
        ...CTL_IDENTITY,
        "commit",
        "-q",
        "--no-verify",
        "-m",
        `ctl(compact): snapshot at ${sha.slice(0, 12)}`,
      ]);
      const pushed = gitTry(clone, ["push", "-q", "origin", `HEAD:refs/heads/${env.stateBranch}`]);
      if (pushed.ok) return { compacted: true, archived: archives.map((a) => a.file) };
      gitTry(clone, ["reset", "-q", "--hard", `refs/remotes/origin/${env.stateBranch}`]);
      if (!/non-fast-forward|fetch first|rejected/.test(pushed.err)) {
        throw new CtlError(5, pushed.err.trim());
      }
      if (attempt < MAX_ATTEMPTS) await sleep(appendRetrySleep(attempt));
    }
    throw new CtlError(5, "compaction push exhausted");
  });
}

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/**
 * Add the segment files to the archive branch as one new commit (plumbing, temp index, no
 * checkout). Existing archive files are never rewritten; a clash with different bytes is an error.
 */
function pushArchive(env: Env, clone: string, files: { file: string; text: string }[]): void {
  const ref = `refs/heads/${env.archiveBranch}`;
  const tracking = `refs/remotes/origin/${env.archiveBranch}`;
  const idxDir = fs.mkdtempSync(path.join(os.tmpdir(), "ctl-idx-"));
  const idxEnv = { GIT_INDEX_FILE: path.join(idxDir, "index") };
  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const fetched = gitTry(clone, [
        "fetch",
        "-q",
        "--depth",
        "1",
        "origin",
        `+${ref}:${tracking}`,
      ]);
      const parent = fetched.ok ? git(clone, ["rev-parse", tracking]).trim() : null;
      fs.rmSync(idxEnv.GIT_INDEX_FILE, { force: true });
      if (parent) git(clone, ["read-tree", parent], { env: idxEnv });
      let changed = false;
      for (const f of files) {
        const blob = git(clone, ["hash-object", "-w", "--stdin"], { input: f.text }).trim();
        if (parent) {
          const have = gitTry(clone, ["rev-parse", "--verify", "-q", `${parent}:${f.file}`]);
          if (have.ok) {
            if (have.out.trim() !== blob) {
              throw new CtlError(5, `archive file exists with different content: ${f.file}`);
            }
            continue;
          }
        }
        git(clone, ["update-index", "--add", "--cacheinfo", `100644,${blob},${f.file}`], {
          env: idxEnv,
        });
        changed = true;
      }
      if (!changed) return;
      const tree = git(clone, ["write-tree"], { env: idxEnv }).trim();
      const args = [
        ...CTL_IDENTITY,
        "commit-tree",
        tree,
        "-m",
        `ctl(archive): ${files.length} segment(s)`,
      ];
      if (parent) args.push("-p", parent);
      const commit = git(clone, args).trim();
      const pushed = gitTry(clone, ["push", "-q", "origin", `${commit}:${ref}`]);
      if (pushed.ok) return;
      if (!/non-fast-forward|fetch first|rejected/.test(pushed.err)) {
        throw new CtlError(5, pushed.err.trim());
      }
    }
    throw new CtlError(5, "archive push exhausted");
  } finally {
    fs.rmSync(idxDir, { recursive: true, force: true });
  }
}
