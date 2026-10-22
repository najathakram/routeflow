import * as fs from "fs";
import * as path from "path";

/**
 * SA-842 §5 (B209 / #1402): the owner-run orphaned-delivery-evidence report. This spec covers the pure part
 * (scripts/lib/orphaned-delivery-evidence.cjs) with a mocked client, and pins the source of both files as
 * read-only. The spawned argument refusals live in report-orphaned-delivery-evidence-script.spec.ts.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const lib = require("../../scripts/lib/orphaned-delivery-evidence.cjs");

const API_DIR = path.resolve(__dirname, "../..");
const FILES = [
  path.join(API_DIR, "scripts", "report-orphaned-delivery-evidence.mjs"),
  path.join(API_DIR, "scripts", "lib", "orphaned-delivery-evidence.cjs"),
];

type Row = Record<string, unknown>;
/** A client whose answers are keyed by the exact SQL text; records every statement in order. */
function mockClient(answers: Map<string, Row[]>, readOnlyFlag = "on") {
  const seen: { sql: string; params?: unknown[] }[] = [];
  return {
    seen,
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      seen.push({ sql, params });
      if (sql === lib.SHOW_READ_ONLY) return { rows: [{ transaction_read_only: readOnlyFlag }] };
      return { rows: answers.get(sql) ?? [] };
    }),
  };
}
const q = (key: string) => lib.COUNT_QUERIES.find((c: { key: string }) => c.key === key).sql;

describe("SA-842 §5 report — source is read-only", () => {
  it.each(FILES)("%s has no write verb, storage write call or raw execute", (file) => {
    const src = fs.readFileSync(file, "utf8");
    expect(src).not.toMatch(/Delete|Put|Copy|executeRaw|UPDATE|INSERT|DELETE/);
  });

  it("every SQL statement is a SELECT, SHOW, SET, BEGIN READ ONLY or ROLLBACK", () => {
    const statements = [
      ...lib.READ_ONLY_SESSION,
      lib.BEGIN_READ_ONLY,
      lib.SHOW_READ_ONLY,
      lib.TENANT_IDS,
      lib.EXISTING_STOPS,
      ...lib.COUNT_QUERIES.map((c: { sql: string }) => c.sql),
    ];
    for (const s of statements) {
      expect(s.trim()).toMatch(/^(SELECT|SHOW|SET|BEGIN TRANSACTION READ ONLY)\b/);
      expect(s).not.toMatch(/\b(TRUNCATE|ALTER|DROP|GRANT|MERGE)\b/i);
    }
    expect(lib.READ_ONLY_SESSION[0]).toBe("SET default_transaction_read_only = on");
  });

  it("selects no slug, business name or email column (tenant ids and counts only)", () => {
    const sql = [
      lib.TENANT_IDS,
      lib.EXISTING_STOPS,
      ...lib.COUNT_QUERIES.map((c: { sql: string }) => c.sql),
    ].join("\n");
    expect(sql).not.toMatch(/\bslug\b|\bemail\b|businessName|\b[a-z]\."?name"?\b/i);
  });

  it("the storage side imports ListObjectsV2 only", () => {
    const src = fs.readFileSync(FILES[0], "utf8");
    const imported = src.match(/const \{([^}]*)\} = require\("@aws-sdk\/client-s3"\)/)?.[1] ?? "";
    expect(
      imported
        .split(",")
        .map((s) => s.trim())
        .sort(),
    ).toEqual(["ListObjectsV2Command", "S3Client"]);
  });
});

describe("checkArgs / targetOf", () => {
  it("refuses without --read-only, and without --target-host", () => {
    expect(lib.checkArgs([])).toMatchObject({ ok: false, code: 64 });
    expect(lib.checkArgs(["--target-host=h"])).toMatchObject({ ok: false, code: 64 });
    expect(lib.checkArgs(["--read-only"])).toMatchObject({ ok: false, code: 64 });
    expect(lib.checkArgs(["--read-only", "--target-host=h", "--json", "--skip-r2"])).toEqual({
      ok: true,
      targetHost: "h",
      json: true,
      skipStorage: true,
    });
  });
  it("targetOf gives host and database, never credentials", () => {
    const t = lib.targetOf("postgresql://user:s3cr%40t@proxy.example.test:12345/railway");
    expect(t).toEqual({ host: "proxy.example.test", database: "railway" });
  });
});

describe("buildCounts with a mocked client", () => {
  it("SETs read-only first, runs every count inside BEGIN READ ONLY, and ends with ROLLBACK", async () => {
    const client = mockClient(new Map([[lib.TENANT_IDS, [{ tenantId: "t1" }]]]));
    await lib.buildCounts(client);
    const sqls = client.seen.map((s) => s.sql);
    expect(sqls.slice(0, 3)).toEqual(lib.READ_ONLY_SESSION);
    expect(sqls[3]).toBe("BEGIN TRANSACTION READ ONLY");
    expect(sqls[4]).toBe("SHOW transaction_read_only");
    for (const c of lib.COUNT_QUERIES) expect(sqls).toContain(c.sql);
    expect(sqls.at(-1)).toBe("ROLLBACK");
  });

  it("aborts before any count when the transaction is not read-only, and still ends the transaction", async () => {
    const client = mockClient(new Map(), "off");
    await expect(lib.buildCounts(client)).rejects.toThrow(/transaction_read_only is "off"/);
    const sqls = client.seen.map((s) => s.sql);
    for (const c of lib.COUNT_QUERIES) expect(sqls).not.toContain(c.sql);
    expect(sqls.at(-1)).toBe("ROLLBACK");
  });

  it("lands each count on its tenant id, with the 30-day bands for count 3", async () => {
    const client = mockClient(
      new Map<string, Row[]>([
        [lib.TENANT_IDS, [{ tenantId: "t1" }, { tenantId: "t2" }]],
        [q("returnStopMissing"), [{ tenantId: "t1", total: 2 }]],
        [q("advanceRunMissing"), [{ tenantId: "t2", total: 1 }]],
        [q("mutationUnlinked"), [{ tenantId: "t1", total: 5, recent: 3, older: 2 }]],
        [q("batchUnlinked"), [{ tenantId: "t1", total: 4 }]],
        [q("deliveredOrderUnpinned"), [{ tenantId: "t1", total: 3 }]],
      ]),
    );
    const { tenants, tenantIds } = await lib.buildCounts(client);
    expect(tenantIds).toEqual(["t1", "t2"]);
    expect(tenants.get("t1")).toMatchObject({
      returnStopMissing: 2,
      mutationUnlinked: 5,
      mutationUnlinkedRecent: 3,
      mutationUnlinkedOlder: 2,
      batchUnlinked: 4,
      deliveredOrderUnpinned: 3,
    });
    expect(tenants.get("t2")).toMatchObject({ advanceRunMissing: 1, returnStopMissing: 0 });
  });

  it("runs inTx before the ROLLBACK (the storage stop-id lookups share the READ ONLY transaction)", async () => {
    const client = mockClient(new Map());
    let rolledBackFirst = false;
    await lib.buildCounts(client, {
      inTx: async () => {
        rolledBackFirst = client.seen.some((s) => s.sql === "ROLLBACK");
      },
    });
    expect(rolledBackFirst).toBe(false);
  });
});

describe("count 6: storage stop dirs with no RouteRunStop row", () => {
  const now = new Date("2026-10-22T00:00:00Z");
  const objects = [
    {
      Key: "tenants/t1/pod/gone/sig-a.png",
      Size: 10,
      LastModified: new Date("2026-10-20T00:00:00Z"),
    },
    {
      Key: "tenants/t1/pod/gone/photo-b.jpg",
      Size: 5,
      LastModified: new Date("2026-09-01T00:00:00Z"),
    },
    {
      Key: "tenants/t1/pod/old/sig-c.png",
      Size: 1,
      LastModified: new Date("2026-08-01T00:00:00Z"),
    },
    {
      Key: "tenants/t1/pod/live/sig-d.png",
      Size: 7,
      LastModified: new Date("2026-10-21T00:00:00Z"),
    },
    { Key: "tenants/t1/logo.png", Size: 99, LastModified: new Date("2026-10-21T00:00:00Z") },
  ];

  it("groups by stop id and ignores keys outside the pod layout", () => {
    const by = lib.groupPodObjects(objects);
    expect([...by.keys()].sort()).toEqual(["gone", "live", "old"]);
    expect(by.get("gone")).toMatchObject({ objects: 2, bytes: 15 });
  });

  it("counts only orphan dirs, banded by each dir's newest object, with oldest/newest", () => {
    const c = lib.foldOrphanStops(
      lib.emptyCounts(),
      lib.groupPodObjects(objects),
      new Set(["live"]),
      now,
    );
    expect(c).toMatchObject({
      podStopDirs: 2,
      podObjects: 3,
      podBytes: 16,
      podRecent: 1,
      podOlder: 1,
    });
    expect(c.podOldest.toISOString().slice(0, 10)).toBe("2026-08-01");
    expect(c.podNewest.toISOString().slice(0, 10)).toBe("2026-10-20");
  });

  it("existingStops chunks the id list at 1000 and binds it as a parameter", async () => {
    const ids = Array.from({ length: 2500 }, (_, i) => `s${i}`);
    const client = {
      query: jest.fn(async (_sql: string, params: string[][]) => ({
        rows: params[0].filter((id) => id === "s1" || id === "s2400").map((id) => ({ id })),
      })),
    };
    const found = await lib.existingStops(client, ids);
    expect(client.query).toHaveBeenCalledTimes(3);
    expect(client.query.mock.calls.every(([sql]) => sql === lib.EXISTING_STOPS)).toBe(true);
    expect([...found].sort()).toEqual(["s1", "s2400"]);
  });
});

describe("formatReport", () => {
  it("prints tenant ids and counts only, skips all-zero tenants, and totals", () => {
    const tenants = new Map([
      [
        "t1",
        {
          ...lib.emptyCounts(),
          returnStopMissing: 2,
          podStopDirs: 1,
          podOldest: new Date("2026-09-01"),
        },
      ],
      ["t2", lib.emptyCounts()],
    ]);
    const text = lib.formatReport({
      tenants,
      target: { host: "h", database: "d" },
      storageNote: "skipped",
      generatedAt: "2026-10-22T00:00:00.000Z",
    });
    expect(text).toContain("target host h · database d");
    expect(text).toMatch(/^t1\t2\t/m);
    expect(text).not.toMatch(/^t2\t/m);
    expect(text).toMatch(/^TOTAL\t2\t/m);
  });
});
