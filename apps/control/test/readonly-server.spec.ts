/**
 * B4 scope: with write-back off (the production default, read-only token) the SERVER performs no
 * git push of any kind. No ledger commit, no compaction, no archive push; the in-memory ledger
 * still serves the dashboard and /api/health shows no ledger error. With write-back on, the
 * ledger persists exactly as before (so the guard is not just a feature switched off everywhere).
 */
import { createHmac } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { startServer, WEBHOOK_SECRET } from "./helpers/start-server";
import type { Harness } from "./helpers/start-server";
import { git, STATE_BRANCH } from "./helpers/temp-repo";
import { scaled } from "./helpers/platform";

jest.setTimeout(scaled(60_000));
/* eslint-disable @typescript-eslint/no-explicit-any */
let h: Harness;
afterEach(() => h?.close());

const sign = (body: string): string =>
  "sha256=" + createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
const BODY = JSON.stringify({ action: "closed", number: 301, pull_request: { number: 301 } });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const refs = (): string =>
  git(h.world.originDir, ["for-each-ref", "--format=%(refname) %(objectname)"]);
const commits = (): number =>
  Number(git(h.world.originDir, ["rev-list", "--count", STATE_BRANCH]).trim());
const ledgerRows = (): any[] =>
  h.world
    .remoteFile("derived/prs.jsonl")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

/** POST a signed webhook (the harness's refresh stub is replaced so the REAL tick runs). */
async function signedWebhook(): Promise<void> {
  const r = await h.req("POST", "/api/github-webhook", {
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-github-delivery": "00000000-0000-0000-0000-0000000000aa",
      "x-hub-signature-256": sign(BODY),
    },
    body: BODY,
  });
  expect(r.status).toBe(202);
}

async function waitForTicks(n: number): Promise<void> {
  const s = await h.session();
  for (let i = 0; i < 100; i++) {
    const r = await h.req("GET", "/api/health", { headers: s.cookie ? { cookie: s.cookie } : {} });
    if (r.json().tick >= n) return;
    await sleep(50);
  }
  throw new Error(`the webhook-driven tick never ran (wanted ${n})`);
}

describe("write-back off: the server never pushes", () => {
  it("a signed webhook plus a poll tick leave origin refs and the ctl/state tip byte-identical", async () => {
    h = await startServer({ webhook: true, depsOver: { refresh: undefined } });
    const refsBefore = refs();
    const tipBefore = h.world.remoteHead();
    const c0 = commits();

    await signedWebhook(); // schedules the real tick (the webhook-driven path)
    await waitForTicks(1);
    await h.app.tick(); // and a plain poll tick on top

    expect(refs()).toBe(refsBefore);
    expect(h.world.remoteHead()).toBe(tipBefore);
    expect(commits()).toBe(c0);
    expect(h.world.remoteFile("derived/prs.jsonl")).toBe("");
    // the server's own clone holds no parked/pending file and no unpushed commit
    const clone = h.world.cloneDirOf("server");
    expect(fs.existsSync(path.join(clone, "pending"))).toBe(false);
    expect(git(clone, ["rev-parse", "HEAD"]).trim()).toBe(tipBefore);
    expect(git(clone, ["status", "--porcelain"]).trim()).toBe("");
  });

  it("the in-memory ledger still serves the dashboard and health shows no ledger error", async () => {
    h = await startServer({ webhook: true, depsOver: { refresh: undefined } });
    await h.app.tick();
    const s = await h.session();
    const state = await h.stateJson(s);
    expect(JSON.stringify(state)).toContain("301"); // PRs are still served
    const health = await h.req("GET", "/api/health", {
      headers: s.cookie ? { cookie: s.cookie } : {},
    });
    expect(health.status).toBe(200);
    expect(health.text).not.toMatch(/ledger/i);
    expect(health.json().ok).toBe(true);
    expect(h.app.pendingLedgerRows()).toBeLessThanOrEqual(5_000); // never drained, so bounded
  });

  const growOwnerLane = (): void => {
    const clone = h.world.shallowClone(STATE_BRANCH, "grow");
    const file = path.join(clone, "events", "owner.jsonl");
    const cur = fs.readFileSync(file, "utf8").trimEnd().split("\n");
    let seq = Math.max(...cur.map((l) => JSON.parse(l).seq as number));
    const add: string[] = [];
    for (let i = 0; i < 260; i++) {
      add.push(
        JSON.stringify({
          seq: ++seq,
          ts: "2026-01-10T12:00:00Z",
          lane: "owner",
          type: "lane.note",
          by: "owner",
          note: `${i} ${"n".repeat(1_600)}`,
        }),
      );
    }
    fs.writeFileSync(file, cur.concat(add).join("\n") + "\n");
    git(clone, ["add", "-A"]);
    git(clone, ["commit", "-q", "-m", "bulk"]);
    git(clone, ["push", "-q", h.world.originUrl, `HEAD:refs/heads/${STATE_BRANCH}`]);
  };

  it("compaction never runs: an over-trigger events dir leaves the origin untouched", async () => {
    h = await startServer({ webhook: true, depsOver: { refresh: undefined } });
    growOwnerLane();
    const refsBefore = refs();
    await h.app.tick();
    await h.app.tick();
    expect(refs()).toBe(refsBefore);
    const s = await h.session();
    const health = await h.req("GET", "/api/health", {
      headers: s.cookie ? { cookie: s.cookie } : {},
    });
    expect(health.text).not.toMatch(/compact/i);
  });

  it("(control) with write-back on the same over-trigger origin IS compacted", async () => {
    h = await startServer({ writeback: true });
    growOwnerLane();
    const tipBefore = h.world.remoteHead();
    await h.app.tick();
    expect(h.world.remoteHead()).not.toBe(tipBefore);
    expect(h.world.remoteHas("ctl/archive")).toBe(true);
  });
});

describe("write-back on: behaviour is exactly as before", () => {
  it("a tick with new PRs still appends the ledger in exactly one commit", async () => {
    h = await startServer({ writeback: true });
    const c0 = commits();
    await h.app.tick();
    expect(commits()).toBe(c0 + 1);
    expect(ledgerRows().some((r) => r.pr === 301)).toBe(true);
  });
});

describe("pendingRows is bounded", () => {
  it.each([true, false])("write-back %s: the queue never grows past the ledger cap", async (wb) => {
    const many = Array.from({ length: 5_200 }, (_, i) => ({
      number: 1000 + i,
      title: `acme: pr ${i}`,
      url: `https://github.com/acme/acme/pull/${1000 + i}`,
      isDraft: false,
      state: "OPEN",
      headRefName: `feat/RF-${i}-x`,
      headRefOid: "eca1a6c879d71c2057ea1e74f6053e62a4e1a4bc",
      baseRefName: "master",
      createdAt: "2026-01-10T08:00:00Z",
      updatedAt: "2026-01-11T09:00:00Z",
      closedAt: null,
      mergedAt: null,
      mergeCommit: null,
      mergeable: "MERGEABLE",
      reviewDecision: null,
      body: "",
      labels: { nodes: [] },
      commits: { nodes: [] },
    }));
    h = await startServer({
      writeback: wb,
      depsOver: {
        github: {
          poll: async () => ({ prs: many, branches: [], files: {} }),
          state: { rateLimit: { remaining: 4000, resetAt: null } },
        },
      },
    });
    // with write-back on the origin refuses every push (a read-only token behaves the same way)
    const hook = path.join(h.world.originDir, "hooks", "pre-receive");
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.writeFileSync(hook, "#!/bin/sh\necho refused >&2\nexit 1\n", { mode: 0o755 });
    await h.app.tick();
    await h.app.tick();
    expect(h.app.pendingLedgerRows()).toBeGreaterThan(0);
    expect(h.app.pendingLedgerRows()).toBeLessThanOrEqual(5_000);
  });
});
