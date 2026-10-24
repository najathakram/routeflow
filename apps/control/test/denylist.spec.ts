/**
 * T58 (R29) — the denylist: every pattern in scripts/campaign/plane-denylist.json (read at test time,
 * L-206) plus a URL rule. Sample strings are assembled at runtime so this file itself stays clean
 * for the no-client-data grep (T59).
 *
 * Contract (src/sources/denylist.ts):
 *   denylistHit(line: string) -> string | null     name of the first matching rule, else null
 *   path: env CONTROL_DENYLIST, default = the repo copy of plane-denylist.json; read at runtime
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { makeWorld, baseState, git, World } from "./helpers/temp-repo";

function tryRequire(load: () => unknown): any {
  try {
    return load();
  } catch (e: any) {
    if (e && e.code === "MODULE_NOT_FOUND") return undefined;
    throw e;
  }
}
const DL = tryRequire(() => require("../src/sources/denylist"));
const SB = tryRequire(() => require("../src/sources/state-branch"));
const VAL = tryRequire(() => require("../src/domain/validate"));
const need = (m: any, name: string) => {
  if (!m) throw new Error(`${name} does not exist yet`);
  return m;
};

const REPO_ROOT = path.resolve(__dirname, "../../..");
const DENY_JSON = path.join(REPO_ROOT, "scripts", "campaign", "plane-denylist.json");
const PATTERNS: { name: string; regex: string; flags?: string }[] = JSON.parse(
  fs.readFileSync(DENY_JSON, "utf8"),
).patterns;

const hex = (n: number) => "a1b2c3d4e5f60718293a4b5c6d7e8f90".slice(0, n);
/** One positive sample per pattern name in plane-denylist.json, assembled from parts. */
const SAMPLES: Record<string, string> = {
  "tenant-uuid": ["3f2a1b4c", "5d6e", "4f70", "8a9b", "0c1d2e3f4a5b"].join("-"),
  "invoice-number": ["INV", "2026", "4417"].join("-"),
  email: ["someone", "example.co"].join("@"),
  "connection-string": ["postgres", "//", "u:p@host/db"].join(":"),
  jwt: "ey" + "J" + hex(16) + "." + hex(16),
  "railway-host": ["svc", "up", "railway", "app"].join("."),
  "api-key-ish": "sk" + "_" + "ABCDEFGHIJKL1234",
};

const line = (note: string) =>
  JSON.stringify({
    seq: 5,
    ts: "2026-01-12T10:00:00Z",
    lane: "lane-u",
    type: "lane.note",
    by: "agent",
    note,
  });

describe("denylistHit", () => {
  it("has a positive sample for every pattern in plane-denylist.json (new pattern => extend SAMPLES)", () => {
    for (const p of PATTERNS) expect(SAMPLES[p.name]).toBeDefined();
    for (const p of PATTERNS) {
      expect(new RegExp(p.regex, p.flags).test(SAMPLES[p.name])).toBe(true); // sample is honest
    }
  });

  it.each(PATTERNS.map((p) => [p.name]))("flags a line containing a %s", (name) => {
    const { denylistHit } = need(DL, "src/sources/denylist");
    const hit = denylistHit(line(`context ${SAMPLES[name]} tail`));
    expect(typeof hit).toBe("string");
    expect(hit).toContain(name);
  });

  it.each([
    ["https", "https" + "://" + "x"],
    ["http", "http" + "://" + "x.test/a?b=1"],
  ])("flags a URL (%s)", (_n, url) => {
    const { denylistHit } = need(DL, "src/sources/denylist");
    expect(denylistHit(line(`see ${url}`))).not.toBeNull();
  });

  it.each([
    ["stripe live key", "sk" + "_" + "live" + "_" + "a".repeat(24)],
    ["stripe test key", "pk" + "_" + "test" + "_" + "B".repeat(12)],
    ["webhook secret", "whsec" + "_" + "A1b2C3d4E5f6G7h8"],
  ])("built-in supplemental patterns flag a %s", (_n, sample) => {
    const { denylistHit } = need(DL, "src/sources/denylist");
    expect(denylistHit(line(`key ${sample} tail`))).not.toBeNull();
  });

  it("returns null for a clean event line", () => {
    const { denylistHit } = need(DL, "src/sources/denylist");
    expect(denylistHit(line("phase1 done, see RF-12 and PR 2801 sha abc1234"))).toBeNull();
    expect(denylistHit(line("uuid-ish but short 3f2a1b4c-5d6e"))).toBeNull();
    expect(denylistHit(line("INV-12 is not a full invoice number"))).toBeNull();
  });

  it("honours CONTROL_DENYLIST (path read at runtime) in addition to the URL rule", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctl-deny-"));
    const file = path.join(dir, "deny.json");
    fs.writeFileSync(
      file,
      JSON.stringify({ patterns: [{ name: "zzz-marker", regex: "ZZZMARK\\d+" }] }),
    );
    const prev = process.env.CONTROL_DENYLIST;
    process.env.CONTROL_DENYLIST = file;
    try {
      jest.isolateModules(() => {
        const fresh = require("../src/sources/denylist");
        expect(fresh.denylistHit(line("has ZZZMARK42 inside"))).toContain("zzz-marker");
        expect(fresh.denylistHit(line("go to " + "http" + "s://x"))).not.toBeNull();
      });
    } finally {
      if (prev === undefined) delete process.env.CONTROL_DENYLIST;
      else process.env.CONTROL_DENYLIST = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("denylist wired into validateEvents (ctx.denylistHit)", () => {
  it("reports file:line for a hit and nothing for a clean tree", () => {
    const { denylistHit } = need(DL, "src/sources/denylist");
    const ev = (seq: number, note: string) =>
      JSON.stringify({
        seq,
        ts: `2026-01-10T09:0${seq}:00Z`,
        lane: "lane-u",
        type: "lane.note",
        by: "agent",
        note,
      });
    const lead = baseState(0)["events/lead.jsonl"];
    const mk = (n2: string) => [
      { file: "lead.jsonl", text: lead },
      { file: "lane-u.jsonl", text: ev(1, "fine") + "\n" + ev(2, n2) + "\n" },
    ];
    const ctx = { taskIds: [], releaseIds: [], denylistHit };
    const clean = need(VAL, "validate").validateEvents(mk("still fine"), ctx);
    expect(clean).toEqual([]);
    const bad = VAL.validateEvents(mk(`mail ${SAMPLES.email}`), ctx);
    expect(bad.map((e: any) => [e.file, e.line])).toContainEqual(["lane-u.jsonl", 2]);
  });
});

describe("appendAndPush refuses denylisted content (exit 4), remote unchanged", () => {
  let world: World;
  beforeEach(() => {
    world = makeWorld();
    world.seedBranch("ctl/state", baseState(4));
  });
  afterEach(() => world.cleanup());

  it.each([
    ["tenant uuid", () => `tenant ${SAMPLES["tenant-uuid"]}`],
    ["email", () => SAMPLES.email],
    ["url", () => "https" + "://" + "x"],
  ])(
    "%s in a note -> CtlError code 4, nothing pushed, nothing committed locally",
    async (_n, mk) => {
      const before = world.remoteHead();
      const env = world.env("a");
      const err = await need(SB, "state-branch")
        .appendAndPush(env, "lane-u", { type: "lane.note", by: "agent", note: mk() })
        .then(
          () => null,
          (e: any) => e,
        );
      expect(err).not.toBeNull();
      expect(err.code ?? err.exitCode).toBe(4);
      expect(world.remoteHead()).toBe(before);
      expect(world.remoteLines("lane-u")).toHaveLength(4);
      // the working clone has no extra commit and no dirty append either
      expect(git(env.cloneDir, ["status", "--porcelain"]).trim()).toBe("");
      expect(git(env.cloneDir, ["rev-parse", "HEAD"]).trim()).toBe(before);
    },
  );
});
