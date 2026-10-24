/** WP7 round 1: the PR ledger persists to derived/prs.jsonl on ctl/state (spec 5.5). */
import { startServer } from "./helpers/start-server";
import type { Harness } from "./helpers/start-server";
import { git, NOW, STATE_BRANCH } from "./helpers/temp-repo";
import { scaled } from "./helpers/platform";

jest.setTimeout(scaled(30_000));
/* eslint-disable @typescript-eslint/no-explicit-any */
const FILE = "derived/prs.jsonl";
let h: Harness;
afterEach(() => h?.close());

const commits = (): number =>
  Number(git(h.world.originDir, ["rev-list", "--count", STATE_BRANCH]).trim());
const rows = (): any[] =>
  h.world
    .remoteFile(FILE)
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

// the ledger commit is a git push: it exists only with write-back on (readonly-server.spec.ts
// pins that it never happens with write-back off)
describe("PR ledger persistence", () => {
  it("a tick with new PRs appends the rows in exactly one commit", async () => {
    h = await startServer({ writeback: true });
    const c0 = commits();
    await h.app.tick();
    expect(rows().length).toBeGreaterThan(0);
    expect(commits()).toBe(c0 + 1);
    expect(rows().some((r) => r.pr === 301)).toBe(true);
  });
  it("a tick with no change writes nothing", async () => {
    h = await startServer({ writeback: true });
    await h.app.tick();
    const tip = h.world.remoteHead();
    const n = rows().length;
    await h.app.tick();
    expect(h.world.remoteHead()).toBe(tip);
    expect(rows().length).toBe(n);
  });
  it("a restarted server loads the ledger and writes no duplicate rows", async () => {
    h = await startServer({ writeback: true });
    await h.app.tick();
    const tip = h.world.remoteHead();
    const n = rows().length;
    const { createControlServer } = require("../src/http/server");
    const second = createControlServer({
      ...h.deps,
      env: h.world.env("server2", { now: () => NOW }),
    });
    await second.listen({ host: "127.0.0.1", port: 0 });
    try {
      await second.tick();
      expect(h.world.remoteHead()).toBe(tip);
      expect(rows().length).toBe(n);
    } finally {
      await second.close();
    }
  });
});
