// registry-records.mjs — the two hand-facing recovery commands on the register clone (B1-b1c,
// SPEC v3.2 G5 "Hand edits" and "Wedge recovery"). Both sit on registry-write.mjs / registry-clone.mjs:
// the lock, the git plumbing and the write transaction are theirs, never a second copy.
//
//   commitRecord(paths, opts)   make a hand edit durable: capture it, then 3-way merge it onto origin
//   discardRegistry(opts)       save a dirty clone's edits under .git/, then clear them
//
// Errors are RegistryError (exit 2 = fix it yourself, 1 = not recorded). Inert while REGISTRY_MODE is
// "tracked": bugs.mjs refuses both commands there.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  RegistryError,
  checkOrigin,
  dirtyPaths,
  locked,
  registryGit,
  settings,
  toOrigin,
} from "./registry-clone.mjs";
import { needClone, withRegistryWrite } from "./registry-write.mjs";

// Capture `ours` and `base` (HEAD:path) before anything resets, then merge them onto the freshly reset
// origin. A push retry re-applies from the capture, never from the working tree. Any failure after the
// capture (a conflict, every push rejected) keeps it and names it: a re-run with the file clean (or
// holding the same edit) resumes from it with its ORIGINAL base, and a different new edit is refused
// rather than written over it. A conflict is written into "ours" with markers and origin's side becomes
// the base, so once the markers are resolved the re-run merges cleanly. Every path is checked before
// any is captured.
export function commitRecord(paths, opts = {}) {
  const c = settings(opts);
  const capDir = (p) => join(c.cloneDir, ".campaign", `commit-record-${basename(p, ".md")}`);
  const capture = (cc) => {
    const dirty = dirtyPaths(cc);
    const fresh = paths.filter((p) => {
      const kept = join(capDir(p), "ours");
      const edited = dirty.includes(p) && existsSync(join(cc.cloneDir, p));
      if (existsSync(kept)) {
        // resume the kept capture (and its base) when the file is clean or holds the same edit
        if (!edited || readFileSync(kept, "utf8") === readFileSync(join(cc.cloneDir, p), "utf8"))
          return false;
        throw new RegistryError(
          `an earlier edit to ${p} is kept in ${capDir(p)}; undo the new edit and re-run to land it, ` +
            `or delete that folder to drop it`,
          2,
        );
      }
      if (!edited) throw new RegistryError(`nothing to record: ${p} has no uncommitted edit`, 2);
      return true;
    });
    for (const p of fresh) {
      mkdirSync(capDir(p), { recursive: true });
      cpSync(join(cc.cloneDir, p), join(capDir(p), "ours"));
      const base = registryGit(cc, ["show", `HEAD:${p}`], { ok: true, raw: true });
      writeFileSync(join(capDir(p), "base"), base.status === 0 ? base.stdout : "");
    }
  };
  const merge = () => {
    // Every path is merged in memory first; the tree is written only when all of them merged cleanly,
    // so a conflict on a later path never leaves an earlier path's merge behind as a dirty clone.
    const merged = [];
    const conflicts = [];
    for (const p of paths) {
      const at = join(c.cloneDir, p);
      const [ours, base, theirs] = ["ours", "base", "theirs"].map((n) => join(capDir(p), n));
      if (/^(<{7}|>{7}) /m.test(readFileSync(ours, "utf8")))
        throw new RegistryError(
          `${ours} still has conflict markers; resolve them, then re-run (or delete the folder)`,
          2,
        );
      if (existsSync(at)) cpSync(at, theirs);
      else writeFileSync(theirs, "");
      const m = registryGit(c, ["merge-file", "-p", ours, base, theirs], { ok: true, raw: true });
      if (m.status !== 0) {
        writeFileSync(ours, m.stdout); // the conflict, marked
        cpSync(theirs, base); // origin's side is what the resolved ours is merged onto next time
        conflicts.push(
          `your edit to ${p} conflicts with origin; the conflict is marked in ${ours} — resolve it ` +
            `there and re-run, or delete the folder to drop it`,
        );
      } else merged.push([at, m.stdout]);
    }
    if (conflicts.length) throw new RegistryError(conflicts.join("; "), 2);
    for (const [at, text] of merged) {
      mkdirSync(dirname(at), { recursive: true });
      writeFileSync(at, text);
    }
    return { paths };
  };
  let r;
  try {
    r = withRegistryWrite(merge, { ...opts, capture, allowDirty: paths, label: "hand edit" });
  } catch (e) {
    const kept = paths.filter((p) => existsSync(join(capDir(p), "ours")));
    if (kept.length && !e.message.includes(capDir(kept[0])))
      e.message += ` — your edit is kept in ${kept.map(capDir).join(", ")}; re-run to land it`;
    throw e;
  }
  for (const p of paths) rmSync(capDir(p), { recursive: true, force: true });
  return r;
}

// Saved under .git/ (never in the tree, so nothing can pick them up). Nothing is pushed.
export function discardRegistry(opts = {}) {
  const c = settings(opts);
  needClone(c);
  return locked(c, () => {
    checkOrigin(c);
    const dirty = dirtyPaths(c);
    if (!dirty.length) return { dir: null, dirty, patch: "", loose: [] };
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dir = join(c.cloneDir, ".git", `registry-discard-${stamp}`);
    mkdirSync(dir, { recursive: true });
    const diff = ["diff", "HEAD", "--binary", "--", c.prefix];
    const patch = registryGit(c, diff, { raw: true }).stdout;
    writeFileSync(join(dir, "changes.patch"), patch);
    const ls = ["ls-files", "-z", "--others", "--exclude-standard", "--", c.prefix];
    const loose = registryGit(c, ls, { raw: true }).stdout.split("\0").filter(Boolean);
    for (const p of loose) {
      mkdirSync(dirname(join(dir, "untracked", p)), { recursive: true });
      cpSync(join(c.cloneDir, p), join(dir, "untracked", p));
    }
    toOrigin(c);
    registryGit(c, ["clean", "-fd", "--", c.prefix]);
    return { dir, dirty, patch, loose };
  });
}
