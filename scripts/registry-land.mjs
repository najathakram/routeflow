#!/usr/bin/env node
// registry-land.mjs — `npm run registry:land -- --sha M --claims FILE` (B1-b2a, SPEC v3.2 "Sync" and
// "Claims" steps 0-1). Run by the landing coordinator on the main checkout, after the code PR merged.
//
//   0. refuse unless the main checkout has no modified tracked files and HEAD == M; fetch origin
//      master and refuse (exit 2) unless M is an ancestor of origin/master;
//   1. read the sync anchor: missing, or not a commit -> `sync --rescan` (the bounded
//      FIRST_RUN_WINDOW commits, safe because events are sha-keyed and deduped); valid -> plain sync.
//      A rescan cannot reach an M older than the window: exit 2 "anchor gap", nothing written;
//   2. inside ONE register write transaction: sync, then prove/note for each claim, by running the
//      real bugs.mjs against the clone (BUGS_ROOT). The real anchor never moves until the push has
//      landed: the child sync runs on a temp copy that replaces it afterwards, so a rejected push, a
//      crash or a kill leaves the events to be re-scanned (a redo starts from a fresh copy).
//
// FILE is JSON: [{ "id": "B12", "action": "prove", "pr": 3901, "proof": "REG-B12 ..." },
//                { "id": "B12", "action": "note", "text": "..." }]; checked whole before the lock.
// Prints one summary line after the push landed (claims = applied now, skipped = already recorded).
// Exit 0 landed (or nothing to add), 1 not recorded, 2 fix it yourself (bad claims, dirty/HEAD != M,
// M not merged, anchor gap, dirty clone, tracked mode).
// campaign-check in landing mode is B1-b2b.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUG_ID_RE } from "./campaign/reg-token.mjs";
import { scrubbedGitEnv } from "./lib/check-git-hooks.mjs";
import { RegistryError, registryGit, reset, settings } from "./lib/registry-clone.mjs";
import {
  FIRST_RUN_WINDOW,
  REPO_ROOT,
  registryMode,
  syncRepoOverride,
  syncStatePath,
} from "./lib/registry-root.mjs";
import { withRegistryWrite } from "./lib/registry-write.mjs";

const BUGS = join(dirname(fileURLToPath(import.meta.url)), "campaign", "bugs.mjs");
const ORIGIN = "refs/remotes/origin/master";
const bad = (m) => {
  throw new RegistryError(m, 2);
};

function parseClaims(file) {
  let list;
  try {
    list = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    return bad(`claims file ${file}: ${e.message}`);
  }
  if (!Array.isArray(list)) bad(`claims file ${file}: expected a JSON array`);
  return list.map((c, i) => {
    const why = (m) => bad(`claims[${i}]: ${m}`);
    const id = c?.id;
    if (!BUG_ID_RE.test(id ?? "")) why(`id must look like B12 (got ${JSON.stringify(id)})`);
    if (c.action === "prove") {
      if (!Number.isInteger(c.pr) || c.pr <= 0) why("prove needs a positive integer pr");
      if (typeof c.proof !== "string" || !new RegExp(`REG-${id}(?![0-9])`).test(c.proof))
        why(`prove needs a proof citing REG-${id}`);
      return { id, args: ["prove", id, "--pr", String(c.pr), "--proof", c.proof], prove: c };
    }
    if (c.action !== "note") return why(`action must be prove or note (got ${c.action})`);
    if (typeof c.text !== "string" || !c.text.trim() || c.text.startsWith("--"))
      why("note needs text");
    return { id, args: ["note", id, c.text], text: c.text };
  });
}

// What `bugs.mjs note` writes (appendHistory): "- DATE · **note** · TEXT <!--key-->", the text with
// whitespace collapsed and comment delimiters stripped. A note counts as already there only when a
// History line holds that exact text, not because the text appears elsewhere in the record.
const cleanNote = (t) =>
  String(t)
    .replace(/\s+/g, " ")
    .trim()
    .replace(/<!--|-->/g, "");
const noteHeld = (body, text) =>
  body.split("\n").some((l) => {
    const m = /^- \d{4}-\d{2}-\d{2} · \*\*note\*\* · (.*?)(?:\s*<!--[^>]*-->)?\s*$/.exec(l.trim());
    return m !== null && m[1].trim() === cleanNote(text).trim();
  });
// A prove is already there when a ledger row for the bug holds the same state's PR and proof.
const proveHeld = (root, id, { pr, proof }) => {
  const dir = join(root, "status");
  if (!existsSync(dir)) return false;
  return readdirSync(dir)
    .filter((n) => n.endsWith(".jsonl"))
    .some((n) =>
      readFileSync(join(dir, n), "utf8")
        .split("\n")
        .some((l) => {
          try {
            const r = JSON.parse(l);
            return r.id === id && /^proven/.test(r.state ?? "") && r.pr === pr && r.proof === proof;
          } catch {
            return false;
          }
        }),
    );
};

function land(sha, claims) {
  const repoDir = syncRepoOverride() || REPO_ROOT;
  const c = { ...settings({ label: `land ${sha.slice(0, 8)}` }), cloneDir: repoDir };
  const g = (args, o) => registryGit(c, args, o);
  if (g(["status", "--porcelain", "--untracked-files=no"]).stdout)
    bad("the main checkout has modified tracked files — land from a clean checkout at M");
  const full = g(["rev-parse", "--verify", "--quiet", `${sha}^{commit}`], { ok: true }).stdout;
  if (!full) bad(`--sha ${sha} is not a commit in ${repoDir}`);
  if (g(["rev-parse", "HEAD"]).stdout !== full)
    bad(`HEAD is not ${sha} — check out the merged sha`);
  g(["fetch", "origin", "master"]);
  const anc = g(["merge-base", "--is-ancestor", full, ORIGIN], { ok: true }).status;
  if (anc === 1) bad(`${sha} is not in origin/master — registry:land only runs on merged code`);
  if (anc !== 0) bad("could not check that the sha is in origin/master");

  const anchorPath = syncStatePath();
  let prev = null;
  if (existsSync(anchorPath))
    try {
      prev = JSON.parse(readFileSync(anchorPath, "utf8")).lastSha ?? null;
    } catch (e) {
      bad(`malformed sync anchor at ${anchorPath} — ${e.message} (delete it to re-anchor)`);
    }
  const valid =
    /^[0-9a-f]{7,40}$/i.test(prev ?? "") &&
    g(["cat-file", "-e", `${prev}^{commit}`], { ok: true }).status === 0;
  const behind = Number(g(["rev-list", "--count", `${full}..${ORIGIN}`]).stdout);
  if (!valid && behind >= FIRST_RUN_WINDOW)
    bad("anchor gap: run `bugs.mjs sync --rescan` with a wider window");

  const work = `${anchorPath}.land-${process.pid}`;
  const bugs = (root, args) => {
    const r = spawnSync(process.execPath, [BUGS, ...args], {
      cwd: repoDir,
      encoding: "utf8",
      env: { ...scrubbedGitEnv(), BUGS_ROOT: root, BUGS_SYNC_STATE: work },
    });
    if (r.status !== 0)
      throw new RegistryError(
        `bugs.mjs ${args[0]} failed: ${(r.stderr || r.stdout).trim().split("\n")[0]}`,
      );
    return r.stdout;
  };
  let out;
  try {
    out = withRegistryWrite(
      ({ cloneDir, root, dirty }) => {
        // every attempt starts from the anchor as found
        if (existsSync(anchorPath)) copyFileSync(anchorPath, work);
        else rmSync(work, { force: true });
        try {
          const synced = bugs(root, valid ? ["sync"] : ["sync", "--rescan"]);
          let applied = 0;
          for (const k of claims) {
            const rec = join(root, "bugs", `${k.id}.md`);
            // `note` stamps its own key, so a re-run would add a second line: skip a note already there
            if (k.text && existsSync(rec) && noteHeld(readFileSync(rec, "utf8"), k.text)) continue;
            if (k.prove && proveHeld(root, k.id, k.prove)) continue; // a redo: already on origin
            bugs(root, k.args);
            applied++;
          }
          const events = /recorded (\d+) new event/.exec(synced)?.[1] ?? 0;
          return {
            paths: dirty(),
            result: { events: Number(events), applied, skipped: claims.length - applied },
          };
        } catch (e) {
          reset(settings({ cloneDir })); // everything dirty here is ours: the dirty guard ran first
          throw e;
        }
      },
      { label: c.label },
    );
    if (existsSync(work)) renameSync(work, anchorPath); // the push landed: the anchor may move now
  } finally {
    rmSync(work, { force: true });
  }
  // The push landed. A child sync that wrote no anchor leaves nothing to move: say so (the landing
  // is recorded) and let the next sync rescan, instead of crashing on a file that is not there.
  let after = "unwritten";
  if (existsSync(anchorPath))
    after = JSON.parse(readFileSync(anchorPath, "utf8")).lastSha.slice(0, 8);
  else
    console.warn(
      `registry:land: WARNING — no sync anchor at ${anchorPath} after the push; the landing is ` +
        `recorded and the next sync will rescan`,
    );
  const was = valid ? prev.slice(0, 8) : prev ? "invalid" : "none";
  console.log(
    `registry:land: ${full.slice(0, 8)}, events ${out.result.events}, claims ${out.result.applied}, ` +
      `skipped ${out.result.skipped}, scan ${valid ? "anchored" : "rescan"}, anchor ${was} → ${after}`,
  );
}

try {
  if (registryMode() !== "clone") {
    console.error("registry:land: the register is tracked in git here; commit with git");
    process.exit(2);
  }
  const argv = process.argv.slice(2);
  const flag = (n) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : undefined);
  const sha = flag("sha");
  if (!sha || sha.startsWith("--") || (argv.includes("--claims") && !flag("claims")))
    bad("usage: registry:land --sha <merged sha> --claims <file.json>");
  const claims = flag("claims") ? parseClaims(flag("claims")) : [];
  land(sha, claims);
} catch (e) {
  if (!(e instanceof RegistryError)) throw e;
  console.error(`registry:land: ${e.message}`);
  process.exit(e.exitCode);
}
