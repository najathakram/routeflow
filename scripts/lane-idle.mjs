#!/usr/bin/env node
// Keeps ONE sticky "LANE IDLE (auto)" comment on the fleet board, edited in place (PATCH), never re-posted.
//   node scripts/lane-idle.mjs [--dry-run]
// Reads the last 100 comments of the board issue (scripts/fleet-lanes.json), computes idle lanes
// (scripts/lib/lane-idle.mjs), runs the leak check on its own body, then PATCHes the sticky comment (POSTs it
// only when none exists yet). Exit: 0 written or dry-run, 1 leak check failed (nothing written), 2 usage / gh failure.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatReport, idleLanes } from "./lib/lane-idle.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MARK = "LANE IDLE (auto)";

function realGh(args, input) {
  const r = spawnSync("gh", args, { encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0)
    throw new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${r.stderr.trim()}`);
  return r.stdout;
}

function realLeakCheck(body) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lane-idle-")), "body.txt");
  fs.writeFileSync(file, body);
  const r = spawnSync(process.execPath, [path.join(HERE, "leak-check.mjs"), "--text-file", file], {
    encoding: "utf8",
  });
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
  return r.status === 0;
}

/** `gh` is `(args, input?) => stdout`; `leakCheck` is `(body) => boolean` (true = clean). */
export function main(
  argv = process.argv.slice(2),
  { gh = realGh, leakCheck = realLeakCheck, now = Date.now, log = console.log, config } = {},
) {
  const dry = argv.includes("--dry-run");
  const cfg = config ?? JSON.parse(fs.readFileSync(path.join(HERE, "fleet-lanes.json"), "utf8"));
  const base = `repos/${cfg.board.repo}/issues`;
  try {
    const total = Number(gh(["api", `${base}/${cfg.board.issue}`, "--jq", ".comments"]));
    const lastPage = Math.max(1, Math.ceil(total / 100));
    const page = JSON.parse(
      gh(["api", `${base}/${cfg.board.issue}/comments?per_page=100&page=${lastPage}`]),
    );
    const prev =
      lastPage > 1
        ? JSON.parse(
            gh(["api", `${base}/${cfg.board.issue}/comments?per_page=100&page=${lastPage - 1}`]),
          )
        : [];
    const all = [...prev, ...page];
    const comments = all.slice(-100);
    const body = formatReport(idleLanes(comments, cfg.lanes, now()), now());
    if (dry) {
      log(body);
      return 0;
    }
    if (!leakCheck(body)) {
      log("lane-idle: the report failed the leak check; nothing written");
      return 1;
    }
    const sticky = [...all].reverse().find((c) => String(c.body).startsWith(MARK));
    // The sticky may be older than the 100-comment window: search the issue's own comments by marker once.
    const found = sticky ?? findSticky(gh, base, cfg.board.issue, lastPage);
    if (found) gh(["api", "-X", "PATCH", `${base}/comments/${found.id}`, "-f", `body=${body}`]);
    else gh(["api", "-X", "POST", `${base}/${cfg.board.issue}/comments`, "-f", `body=${body}`]);
    log(`lane-idle: ${found ? "edited" : "created"} the sticky comment`);
    return 0;
  } catch (e) {
    log(`lane-idle: ${e instanceof Error ? e.message : e}`);
    return 2;
  }
}

function findSticky(gh, base, issue, lastPage) {
  for (let p = lastPage - 2; p >= 1; p--) {
    const hit = JSON.parse(gh(["api", `${base}/${issue}/comments?per_page=100&page=${p}`]))
      .reverse()
      .find((c) => String(c.body).startsWith(MARK));
    if (hit) return hit;
  }
  return null;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
