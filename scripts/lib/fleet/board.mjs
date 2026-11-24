// Posts a comment to the team board after a leak check and a comment-count check.
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import {
  HOWTO,
  loadPatterns as realLoad,
  matchesBuf as realMatchesBuf,
} from "../leak-patterns.mjs";

export const COMMENT_CAP = 2300; // GitHub refuses above 2,500; roll over with 200 of margin.

export const defaultExec = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

export function resolveRepo(exec) {
  const r = exec("gh", ["repo", "view", "--json", "nameWithOwner"]);
  try {
    const name = r.status === 0 ? JSON.parse(r.stdout).nameWithOwner : null;
    return typeof name === "string" && name ? name : null;
  } catch {
    return null;
  }
}

export async function post({
  issue,
  bodyFile,
  exec = defaultExec,
  repo,
  cwd = process.cwd(),
  loadPatterns = realLoad,
  matchesBuf = realMatchesBuf,
}) {
  const n = String(issue ?? "");
  if (!/^\d+$/.test(n) || !bodyFile)
    return {
      code: 2,
      lines: ["usage: node scripts/fleet.mjs post --issue <n> --body-file <path>"],
    };
  let buf = Buffer.alloc(0);
  try {
    buf = fs.readFileSync(bodyFile);
  } catch {
    /* treated as empty */
  }
  if (!buf.toString("utf8").trim())
    return {
      code: 2,
      lines: [`body file ${bodyFile} is empty or unreadable; write the post first`],
    };

  const loaded = loadPatterns(cwd);
  if (!loaded.ok)
    return {
      code: 4,
      lines: [`no leak patterns loaded; fail-closed. ${loaded.message ?? ""} ${HOWTO}`.trim()],
    };
  // Scan the raw bytes (UTF-16 and NUL forms included), then refuse anything that is not UTF-8 text.
  if (matchesBuf(loaded.regexes, buf))
    return { code: 4, lines: ["body matches a leak pattern; reword it and post again"] };
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return {
      code: 4,
      lines: ["body is not UTF-8 text, so it cannot be checked; save it as UTF-8 and post again"],
    };
  }
  if (buf.includes(0))
    return {
      code: 4,
      lines: ["body contains NUL bytes, so it cannot be checked; save it as UTF-8 and post again"],
    };

  const slug = repo ?? resolveRepo(exec);
  if (!slug) return { code: 3, lines: ["repo name unreadable; run `gh auth status`, then retry"] };
  const unreadable = {
    code: 3,
    lines: [
      `count unreadable; read it by hand with \`gh api repos/${slug}/issues/${n} --jq .comments\` ` +
        `and post with raw \`gh issue comment\` only if it is below ${COMMENT_CAP}`,
    ],
  };
  const api = exec("gh", ["api", `repos/${slug}/issues/${n}`]);
  if (api.status !== 0) return unreadable;
  let count;
  try {
    count = JSON.parse(api.stdout).comments;
  } catch {
    return unreadable;
  }
  if (typeof count !== "number" || !Number.isFinite(count)) return unreadable;
  if (count >= COMMENT_CAP)
    return { code: 5, lines: [`board ${n} has ${count} comments; open the next board first`] };

  const r = exec("gh", ["issue", "comment", n, "--repo", slug, "--body-file", bodyFile]);
  const out = (r.stdout || r.stderr || "").trim();
  return { code: r.status, lines: out ? [out] : [] };
}

export async function run(args, ctx = {}) {
  const at = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  return post({ issue: at("--issue"), bodyFile: at("--body-file"), ...ctx });
}
