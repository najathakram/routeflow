/**
 * Compaction (spec §8): snapshot.json at the tip, segments moved to the archive branch, new
 * segments start with a header. The snapshot carries the resume accumulator (`foldEvents`), so
 * fold(snapshot + new segments) == fold(all events) without replaying any archived event.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { foldEvents } from "../domain/fold";
import { CTL_IDENTITY, CtlError, cloneTimeoutMs, git, gitTry } from "./git";
import type { Env } from "./git";
import { withLock } from "./lock";
import {
  NONCES_FILE,
  appendRetrySleep,
  ensureClone,
  isOwned,
  lastSeq,
  liveEvents,
  formatNonces,
  lockDirOf,
  pruneNonces,
  readNonces,
  readTree,
  syncClone,
} from "./state-branch";
import type { SnapshotFile } from "./state-branch";

const MAX_ATTEMPTS = 6;
const REJECTED_PUSH = /non-fast-forward|fetch first|rejected/;

export interface CompactResult {
  compacted: boolean;
  archived: string[];
  /** Set when snapshot.json is over 1 MB; callers should surface it. */
  snapshotWarning: string | null;
}

interface ArchiveView {
  parent: string | null;
  paths: string[];
  read(file: string): string;
}

/** Fetch the archive branch (depth 1) and list its files; an absent branch is an empty archive. */
function loadArchive(env: Env, clone: string): ArchiveView {
  const ref = `refs/heads/${env.archiveBranch}`;
  const tracking = `refs/remotes/origin/${env.archiveBranch}`;
  const fetched = gitTry(clone, ["fetch", "-q", "--depth", "1", "origin", `+${ref}:${tracking}`], {
    timeoutMs: cloneTimeoutMs(),
  });
  if (!fetched.ok) return { parent: null, paths: [], read: () => "" };
  const parent = git(clone, ["rev-parse", tracking]).trim();
  const paths = git(clone, ["ls-tree", "-r", "--name-only", parent])
    .split("\n")
    .filter((l) => l !== "");
  return { parent, paths, read: (file) => git(clone, ["show", `${parent}:${file}`]) };
}

/**
 * Seqs of `lane` already archived as a contiguous run starting at `first`. Re-archiving them would
 * create overlapping ranges after a retry, so only what follows is archived.
 */
function alreadyArchived(view: ArchiveView, lane: string, first: number, last: number): number {
  const ranges: [number, number][] = [];
  const re = new RegExp(`^archive/${lane.replace(/[.]/g, "\\.")}/(\\d+)-(\\d+)\\.jsonl$`);
  for (const p of view.paths) {
    const m = re.exec(p);
    if (m && Number(m[1]) >= first && Number(m[2]) <= last)
      ranges.push([Number(m[1]), Number(m[2])]);
  }
  let covered = first - 1;
  for (;;) {
    const hit = ranges.find(([a, b]) => a === covered + 1 && b >= a);
    if (!hit) return covered;
    covered = hit[1];
  }
}

/** Compaction trigger: the WHOLE tip (events/ + snapshot.json + nonces.txt) over 384 KB. */
export const COMPACT_TRIGGER_BYTES = 384 * 1024;

/** Whole-tip size (events/ + snapshot.json + nonces.txt): a metric, not a trigger. */
export function tipBytes(dir: string): number {
  const size = (p: string): number => {
    try {
      return fs.statSync(p).size;
    } catch {
      return 0;
    }
  };
  let total = size(path.join(dir, "snapshot.json")) + size(path.join(dir, NONCES_FILE));
  try {
    for (const n of fs.readdirSync(path.join(dir, "events")))
      total += size(path.join(dir, "events", n));
  } catch {
    /* no events dir yet */
  }
  return total;
}

/** events/ bytes of a checkout: the only thing that triggers compaction (a fat snapshot cannot loop it). */
export function eventsBytes(dir: string): number {
  let total = 0;
  try {
    for (const n of fs.readdirSync(path.join(dir, "events"))) {
      try {
        total += fs.statSync(path.join(dir, "events", n)).size;
      } catch {
        /* vanished */
      }
    }
  } catch {
    /* no events dir yet */
  }
  return total;
}

/** True when events/ is over the trigger. */
export function compactDue(dir: string, limit = COMPACT_TRIGGER_BYTES): boolean {
  return eventsBytes(dir) > limit;
}

export const SNAPSHOT_WARN_BYTES = 1024 * 1024;

/** A human-readable warning when snapshot.json has outgrown 1 MB, else null. */
export function snapshotWarning(dir: string, limit = SNAPSHOT_WARN_BYTES): string | null {
  try {
    const size = fs.statSync(path.join(dir, "snapshot.json")).size;
    return size > limit
      ? `snapshot.json is ${Math.round(size / 1024)} KB (> ${Math.round(limit / 1024)} KB): the tip is outgrowing its budget`
      : null;
  } catch {
    return null;
  }
}

/** Compact the state branch from `env.cloneDir`. Safe to re-run; never rewrites history. */
export async function compact(env: Env): Promise<CompactResult> {
  const clone = await ensureClone(env);
  const sleep = (ms: number): Promise<void> =>
    env.sleep ? env.sleep(ms) : new Promise<void>((r) => setTimeout(r, ms));
  return withLock(lockDirOf(clone), 30_000, async () => {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      syncClone(env, clone);
      const tree = readTree(clone);
      const now = env.now();
      const lanes = Object.keys(tree.lanes).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const view = loadArchive(env, clone);
      const archives: { file: string; text: string }[] = [];
      let any = false;
      for (const lane of lanes) {
        const d = tree.lanes[lane];
        if (d.liveEvents.length === 0) continue;
        any = true;
        const seqs = d.liveEvents.map((e) => e.seq);
        const first = seqs[0];
        const last = Math.max(...seqs);
        const raws = d.live.filter((l) => !l.startsWith('{"seq":0,"type":"segment"'));
        const covered = alreadyArchived(view, lane, first, last);
        if (covered >= first) {
          // what an earlier (interrupted) run archived must be exactly our prefix
          const prefix = raws.filter((_, i) => seqs[i] <= covered).join("\n") + "\n";
          const have = view.paths
            .filter((p) => p.startsWith(`archive/${lane}/`))
            .map((p) => ({ p, m: /\/(\d+)-(\d+)\.jsonl$/.exec(p) }))
            .filter((x) => x.m && Number(x.m[1]) >= first && Number(x.m[2]) <= covered)
            .sort((x, y) => Number(x.m?.[1]) - Number(y.m?.[1]))
            .map((x) => view.read(x.p))
            .join("");
          if (have !== prefix)
            throw new CtlError(5, `archive conflict for ${lane} at ${first}-${covered}`);
        }
        const fresh = raws.filter((_, i) => seqs[i] > covered);
        if (fresh.length > 0) {
          archives.push({
            file: `archive/${lane}/${Math.max(first, covered + 1)}-${last}.jsonl`,
            text: fresh.join("\n") + "\n",
          });
        }
      }
      if (!any) return { compacted: false, archived: [], snapshotWarning: snapshotWarning(clone) };

      const base = { tasks: env.registers.tasks, releases: env.registers.releases };
      const acc = foldEvents(tree.snap?.acc ?? null, base, liveEvents(tree));
      const seqByLane: Record<string, number> = {};
      for (const lane of lanes) seqByLane[lane] = lastSeq(tree, lane);
      const sha = git(clone, ["rev-parse", "HEAD"]).trim();
      const snap: SnapshotFile = { v: 2, at: now, sha, seqByLane, acc };

      pushArchive(env, clone, archives);

      for (const lane of lanes) {
        const header = { seq: 0, type: "segment", from: seqByLane[lane] + 1 };
        writeAtomic(path.join(clone, "events", `${lane}.jsonl`), JSON.stringify(header) + "\n");
      }
      writeAtomic(path.join(clone, "snapshot.json"), JSON.stringify(snap));
      // the dedupe window is 7 days: older nonces are dead weight on the tip
      const kept = pruneNonces(readNonces(clone), now);
      if (kept.length !== readNonces(clone).length) {
        writeAtomic(path.join(clone, NONCES_FILE), formatNonces(kept));
      }
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
      if (pushed.ok) {
        return {
          compacted: true,
          archived: archives.map((a) => a.file),
          snapshotWarning: snapshotWarning(clone),
        };
      }
      if (isOwned(env, clone)) {
        gitTry(clone, ["reset", "-q", "--hard", `refs/remotes/origin/${env.stateBranch}`]);
      }
      if (!REJECTED_PUSH.test(pushed.err)) throw new CtlError(5, pushed.err.trim());
      if (attempt < MAX_ATTEMPTS) await sleep(appendRetrySleep(attempt));
    }
    throw new CtlError(5, "compaction push exhausted");
  });
}

function writeAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/**
 * Add the segment files to the archive branch as one new commit (plumbing, temp index, no
 * checkout). Existing archive files are never rewritten; a clash with different bytes is an error.
 */
function pushArchive(env: Env, clone: string, files: { file: string; text: string }[]): void {
  if (files.length === 0) return;
  const ref = `refs/heads/${env.archiveBranch}`;
  const tracking = `refs/remotes/origin/${env.archiveBranch}`;
  const idxDir = fs.mkdtempSync(path.join(os.tmpdir(), "ctl-idx-"));
  const idxEnv = { GIT_INDEX_FILE: path.join(idxDir, "index") };
  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const fetched = gitTry(
        clone,
        ["fetch", "-q", "--depth", "1", "origin", `+${ref}:${tracking}`],
        { timeoutMs: cloneTimeoutMs() },
      );
      const parent = fetched.ok ? git(clone, ["rev-parse", tracking]).trim() : null;
      fs.rmSync(idxEnv.GIT_INDEX_FILE, { force: true });
      if (parent) git(clone, ["read-tree", parent], { env: idxEnv, timeoutMs: cloneTimeoutMs() });
      let changed = false;
      for (const f of files) {
        const blob = git(clone, ["hash-object", "-w", "--stdin"], {
          input: f.text,
          timeoutMs: cloneTimeoutMs(),
        }).trim();
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
      const tree = git(clone, ["write-tree"], { env: idxEnv, timeoutMs: cloneTimeoutMs() }).trim();
      const args = [
        ...CTL_IDENTITY,
        "commit-tree",
        tree,
        "-m",
        `ctl(archive): ${files.length} segment(s)`,
      ];
      if (parent) args.push("-p", parent);
      const commit = git(clone, args).trim();
      const pushed = gitTry(clone, ["push", "-q", "origin", `${commit}:${ref}`], {
        timeoutMs: cloneTimeoutMs(),
      });
      if (pushed.ok) return;
      if (!REJECTED_PUSH.test(pushed.err)) throw new CtlError(5, pushed.err.trim());
    }
    throw new CtlError(5, "archive push exhausted");
  } finally {
    fs.rmSync(idxDir, { recursive: true, force: true });
  }
}
