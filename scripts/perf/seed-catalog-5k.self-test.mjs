#!/usr/bin/env node
// Self-test for scripts/perf/seed-catalog-5k.mjs. Plain node: `node scripts/perf/seed-catalog-5k.self-test.mjs`.
// No database: the Prisma client is a fake that records every call.
import {
  assertSafeTarget,
  assertSeedTenant,
  buildCatalog,
  seedCatalog,
} from "./seed-catalog-5k.mjs";

let failures = 0;
let passed = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) passed++;
  else failures++;
  console.log(
    `${ok ? "  ok  " : "  FAIL"} ${name}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`,
  );
};
const throwsMsg = async (fn) => {
  try {
    await fn();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
};

// A fake client: counts every call and keeps rows keyed like the real unique index (tenantId + sku).
const makeFake = () => {
  const rows = new Map();
  let calls = 0;
  let seq = 0;
  return {
    get calls() {
      return calls;
    },
    rows,
    client: {
      tenant: {
        findUnique: async ({ where }) => {
          calls++;
          return where.slug === "test" ? { id: "tenant-test" } : null;
        },
      },
      product: {
        upsert: async ({ where, create, update }) => {
          calls++;
          const key = `${where.tenantId_sku.tenantId}:${where.tenantId_sku.sku}`;
          const hit = rows.get(key);
          if (hit) {
            Object.assign(hit, update);
            return { id: hit.id };
          }
          const row = { id: `p${++seq}`, ...create };
          rows.set(key, row);
          return { id: row.id };
        },
      },
      $disconnect: async () => {},
    },
  };
};

// 1. Guards (before any client exists)
let made = 0;
const spyFactory = () => {
  made++;
  return makeFake().client;
};
const remote = {
  DATABASE_URL: "postgresql://u:p@db.example.com:5432/x",
};
const local = { DATABASE_URL: "postgresql://u:p@localhost:5432/x" };
check(
  "1a remote database refused",
  (
    await throwsMsg(() => seedCatalog({ env: remote, slug: "test", createClient: spyFactory }))
  )?.includes("Refusing to seed the non-local database"),
  true,
);
check("1a no client was created", made, 0);
check(
  "1b NODE_ENV=production refused even on a local url",
  (
    await throwsMsg(() =>
      seedCatalog({
        env: { ...local, NODE_ENV: "production" },
        slug: "test",
        createClient: spyFactory,
      }),
    )
  )?.includes("NODE_ENV=production"),
  true,
);
check(
  "1b2 SEED_ALLOW_REMOTE does not exist here (no override)",
  (
    await throwsMsg(() =>
      seedCatalog({
        env: { ...remote, SEED_ALLOW_REMOTE: "1" },
        slug: "test",
        createClient: spyFactory,
      }),
    )
  )?.includes("Refusing to seed the non-local database"),
  true,
);
check(
  "1c ?host= redirect refused",
  (
    await throwsMsg(() =>
      assertSafeTarget({ DATABASE_URL: "postgresql://u:p@localhost:5432/x?host=db.example.com" }),
    )
  )?.includes("Refusing"),
  true,
);
check(
  "1d unparseable url refused",
  (await throwsMsg(() => assertSafeTarget({ DATABASE_URL: "" })))?.includes("Refusing"),
  true,
);
check(
  "1e slug acme is not a test tenant",
  (await throwsMsg(() => assertSeedTenant("acme")))?.includes("Test-tenant policy violation"),
  true,
);
check(
  "1e2 slug acme stops seedCatalog before a client exists",
  (
    await throwsMsg(() => seedCatalog({ env: local, slug: "acme", createClient: spyFactory }))
  )?.includes("Test-tenant policy violation"),
  true,
);
check("1e3 still no client", made, 0);
check("1f local url passes", assertSafeTarget(local), undefined);

// 2. Shape
const cat = buildCatalog(5000);
check("2a exactly 5000 rows", cat.length, 5000);
check("2b 5000 distinct SKUs", new Set(cat.map((r) => r.sku)).size, 5000);
check("2c 5000 distinct names", new Set(cat.map((r) => r.name)).size, 5000);
check("2d every name starts with Acme ", cat.filter((r) => !/^Acme /.test(r.name)).length, 0);
check(
  "2e boxed rows with 24 per box exist",
  cat.some((r) => r.unitsPerBox === 24),
  true,
);
check(
  "2f loose rows exist",
  cat.some((r) => r.unitsPerBox === null),
  true,
);
const parents = cat.filter((r) => r.kind === "FAMILY");
const variants = cat.filter((r) => r.kind === "VARIANT");
check("2g 100 family parents", parents.length, 100);
check("2h 400 variants (4 per parent)", variants.length, 400);
check(
  "2i every parent has exactly 4 variants",
  parents.every((p) => variants.filter((v) => v.parentSku === p.sku).length === 4),
  true,
);
check(
  "2j parents precede their variants",
  cat.indexOf(parents[0]) < cat.indexOf(variants[0]),
  true,
);
check(
  "2k prices are whole cents",
  cat.filter((r) => Math.abs(Math.round(r.pricePerUnit * 100) - r.pricePerUnit * 100) > 1e-6)
    .length,
  0,
);
check(
  "2l same input, same output",
  JSON.stringify(buildCatalog(5000)) === JSON.stringify(cat),
  true,
);
check("2m small n works", buildCatalog(10).length, 10);

// 3. Run twice against the fake: idempotent, upsert-only, tenant-scoped
const fake = makeFake();
const r1 = await seedCatalog({ env: local, slug: "test", createClient: () => fake.client });
check("3a first run reports 5000", r1.total, 5000);
check("3b 5000 rows stored", fake.rows.size, 5000);
const callsAfterOne = fake.calls;
await seedCatalog({ env: local, slug: "test", createClient: () => fake.client });
check("3c second run keeps 5000 rows", fake.rows.size, 5000);
check("3d second run made the same number of calls", fake.calls - callsAfterOne, callsAfterOne);
check(
  "3e variants point at their parent's id",
  [...fake.rows.values()].filter((r) => r.kind === "VARIANT" && !r.parentProductId).length,
  0,
);
check(
  "3f every row carries the tenant id",
  [...fake.rows.values()].filter((r) => r.tenantId !== "tenant-test").length,
  0,
);

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
