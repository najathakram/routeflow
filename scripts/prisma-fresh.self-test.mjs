#!/usr/bin/env node
// Self-test for scripts/lib/prisma-fresh.mjs (the verify preflight that refuses a stale generated
// Prisma client BEFORE the heavy slot is taken). Synthetic fixtures live in a throwaway temp dir;
// one extra case reads the REAL checkout's generated client when one exists (not on CI).
//   F*: freshness (formatter-shaped copy passes; any real schema change is stale)
//   M*: missing pieces give a clear reason
//   P*: preflight decision (CI skipped, api-not-in-plan skipped, stale -> message with the fix)
//   R1: the real checkout's own client is fresh (opt-in: RF_PRISMA_FRESH_REAL=1; an environment
//       assertion, not a unit test - verify's own preflight enforces it)
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PRISMA_STALE_FIX,
  checkPrismaClientFresh,
  planReachesApi,
  prismaPreflight,
  resolveGeneratedClientDir,
  schemaBlocks,
} from "./lib/prisma-fresh.mjs";

let failures = 0;
let passed = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`ok   ${name}`);
  } else {
    failures++;
    console.log(`FAIL ${name}\n     expected ${e}\n     actual   ${a}`);
  }
}

const tmp = mkdtempSync(join(tmpdir(), "prisma-fresh-"));
let n = 0;
/** root/prisma/schema = the source folder (where the preflight looks), root/client = generated. */
function fixture({ schemaFiles, generated }) {
  const root = join(tmp, `f${n++}`);
  const schemaDir = join(root, "prisma", "schema");
  const clientDir = join(root, "client");
  mkdirSync(schemaDir, { recursive: true });
  mkdirSync(clientDir, { recursive: true });
  for (const [name, text] of Object.entries(schemaFiles))
    writeFileSync(join(schemaDir, name), text);
  if (generated !== null) writeFileSync(join(clientDir, "schema.prisma"), generated);
  return { root, schemaDir, clientDir };
}

const BASE = `generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
}
`;
// Source as written in this repo: unaligned columns, a field AFTER a block attribute, comments.
const DOMAIN = `// domain file
enum Role {
  ADMIN
  USER
}

model Order {
  id String @id
  total Decimal @db.Decimal(12, 2) // cents
  @@index([id])
  // late field
  note String?
}

model Line {
  id String @id
  orderId String
  order Order @relation(fields: [orderId], references: [id])
}
`;
// What Prisma's formatter writes: aligned columns, the late field moved above @@index, the whole
// folder concatenated in file-name order.
const GENERATED = `generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
}

// domain file
enum Role {
  ADMIN
  USER
}

model Order {
  id    String  @id
  total Decimal @db.Decimal(12, 2) // cents
  // late field
  note  String?

  @@index([id])
}

model Line {
  id      String @id
  orderId String
  order   Order  @relation(fields: [orderId], references: [id])
}
`;
const files = { "_base.prisma": BASE, "domain.prisma": DOMAIN };
const verdict = (f) => {
  const r = checkPrismaClientFresh(f);
  return [r.fresh, r.reason === null];
};

// ---- F: freshness
check(
  "F1 formatter-shaped client (realigned, field moved, comments) is fresh",
  verdict(fixture({ schemaFiles: files, generated: GENERATED })),
  [true, true],
);
check(
  "F2 byte-identical copy is fresh",
  verdict(fixture({ schemaFiles: files, generated: BASE + "\n" + DOMAIN })),
  [true, true],
);
check(
  "F3 CRLF generated copy is fresh",
  verdict(fixture({ schemaFiles: files, generated: GENERATED.replace(/\n/g, "\r\n") })),
  [true, true],
);
{
  const f = fixture({
    schemaFiles: {
      ...files,
      "domain.prisma": DOMAIN.replace("note String?", "note String?\n  extra Int?"),
    },
    generated: GENERATED,
  });
  const r = checkPrismaClientFresh(f);
  check(
    "F4 new optional field in source -> stale, names the model",
    [r.fresh, /model Order differs/.test(r.reason)],
    [false, true],
  );
}
check(
  "F5 changed field optionality -> stale",
  verdict(
    fixture({ schemaFiles: files, generated: GENERATED.replace("note  String?", "note  String") }),
  ),
  [false, false],
);
{
  const f = fixture({
    schemaFiles: { ...files, "extra.prisma": "model Fresh {\n  id String @id\n}\n" },
    generated: GENERATED,
  });
  const r = checkPrismaClientFresh(f);
  check(
    "F6 new model in source -> stale (missing from the generated client)",
    [r.fresh, /model Fresh missing/.test(r.reason)],
    [false, true],
  );
}
{
  const f = fixture({
    schemaFiles: {
      "_base.prisma": BASE,
      "domain.prisma": DOMAIN.replace(/model Line \{[\s\S]*$/, ""),
    },
    generated: GENERATED,
  });
  const r = checkPrismaClientFresh(f);
  check(
    "F7 model removed from source -> stale (only in the generated client)",
    [r.fresh, /model Line only in the generated client/.test(r.reason)],
    [false, true],
  );
}
check(
  "F8 enum value only in the client -> stale",
  verdict(
    fixture({ schemaFiles: files, generated: GENERATED.replace("  USER\n", "  USER\n  GUEST\n") }),
  ),
  [false, false],
);
check(
  "F9 changed block attribute -> stale",
  verdict(
    fixture({
      schemaFiles: files,
      generated: GENERATED.replace("@@index([id])", "@@index([total])"),
    }),
  ),
  [false, false],
);
{
  // identical line text in two models: moving it from one to the other must NOT cancel out
  const two = (a, b) => `model A {\n  id String @id\n${a}}\nmodel B {\n  id String @id\n${b}}\n`;
  const f = fixture({
    schemaFiles: { "x.prisma": two("  tag String?\n", "") },
    generated: two("", "  tag String?\n"),
  });
  check("F10 same field moved between models -> stale", verdict(f), [false, false]);
}
check(
  "F11 comment-only difference is not stale (no behavioural effect)",
  verdict(
    fixture({
      schemaFiles: files,
      generated: GENERATED.replace("// domain file", "// reworded comment only").replace(
        "// cents",
        "// pennies",
      ),
    }),
  ),
  [true, true],
);
check(
  "F12 schemaBlocks ignores layout, keys by kind+name",
  [...schemaBlocks("model A  {\n  id   String   @id\n}\n").entries()],
  [["model A", ["id String @id"]]],
);

// ---- M: missing pieces
{
  const f = fixture({ schemaFiles: files, generated: GENERATED });
  const r = checkPrismaClientFresh({ schemaDir: f.schemaDir, clientDir: join(f.root, "nope") });
  check(
    "M1 missing client dir -> stale with a clear reason",
    [
      r.fresh,
      /generated Prisma client not found/.test(r.reason),
      /never generated here/.test(r.reason),
    ],
    [false, true, true],
  );
}
{
  const r = checkPrismaClientFresh({ schemaDir: join(tmp, "noschema"), clientDir: tmp });
  check(
    "M2 missing schema folder -> stale with a clear reason",
    [r.fresh, /schema folder not found/.test(r.reason)],
    [false, true],
  );
}
{
  const r = checkPrismaClientFresh(fixture({ schemaFiles: files, generated: null }));
  check(
    "M3 client dir without schema.prisma -> stale, names the file",
    [r.fresh, /has no schema\.prisma/.test(r.reason)],
    [false, true],
  );
}
{
  const f = fixture({ schemaFiles: files, generated: null });
  const r = checkPrismaClientFresh({ schemaDir: f.schemaDir, clientDir: null });
  check(
    "M4 unresolvable client (null dir) -> stale, not a crash",
    [r.fresh, /not resolvable/.test(r.reason)],
    [false, true],
  );
}
check(
  "M5 resolveGeneratedClientDir where @prisma/client is not installed -> null",
  resolveGeneratedClientDir(join(tmp, "nowhere")),
  null,
);

// ---- P: preflight decision
const FULL = { mode: "full", reason: "x" };
const AFFECTED_API = { mode: "affected", workspaces: ["@routeflow/api", "@routeflow/pricing"] };
const AFFECTED_WEB = { mode: "affected", workspaces: ["@routeflow/web"] };
{
  const stale = fixture({
    schemaFiles: files,
    generated: GENERATED.replace("note  String?", "note  Int?"),
  });
  const run = (env, scope, excluded = []) =>
    prismaPreflight({
      env,
      scope,
      excluded,
      apiDir: stale.root,
      resolveClient: () => stale.clientDir,
    });
  const full = run({}, FULL);
  check(
    "P1 stale + full scope -> message carries the fix and the junction warning",
    [
      full.ran,
      full.fresh,
      full.message.includes(PRISMA_STALE_FIX),
      /cd apps\/api && npx prisma generate/.test(full.message),
      /share ONE generated client/.test(full.message),
    ],
    [true, false, true, true, true],
  );
  check("P2 CI -> skipped entirely (CI behaviour unchanged)", run({ CI: "true" }, FULL), {
    ran: false,
    why: "CI",
  });
  check("P3 affected scope without api -> skipped", run({}, AFFECTED_WEB), {
    ran: false,
    why: "api not in plan",
  });
  check("P4 affected scope listing api -> checked", run({}, AFFECTED_API).fresh, false);
  check("P5 api excluded -> skipped", run({}, FULL, ["@routeflow/api"]), {
    ran: false,
    why: "api not in plan",
  });
  const ok = fixture({ schemaFiles: files, generated: GENERATED });
  check(
    "P6 fresh client -> ran, fresh, no message",
    prismaPreflight({ env: {}, scope: FULL, apiDir: ok.root, resolveClient: () => ok.clientDir }),
    { ran: true, fresh: true, reason: null, message: null },
  );
}
check(
  "P7 planReachesApi: full yes, affected+api yes, affected-web no",
  [
    planReachesApi({ scope: FULL }),
    planReachesApi({ scope: AFFECTED_API }),
    planReachesApi({ scope: AFFECTED_WEB }),
  ],
  [true, true, false],
);

// ---- R: the real checkout (opt-in only; skipped when no client has been generated here)
if (process.env.RF_PRISMA_FRESH_REAL !== "1") {
  console.log("skip R1 (set RF_PRISMA_FRESH_REAL=1 to check this checkout)");
} else {
  const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "api");
  const clientDir = resolveGeneratedClientDir(apiDir);
  if (clientDir) {
    const t0 = performance.now();
    const r = checkPrismaClientFresh({ schemaDir: join(apiDir, "prisma", "schema"), clientDir });
    const ms = performance.now() - t0;
    check(
      `R1 this checkout's generated client is fresh (${Math.round(ms)} ms, < 2000)`,
      [r.fresh, ms < 2000],
      [true, true],
    );
    if (!r.fresh) console.log(`     ${r.reason}`);
  } else console.log("skip R1 (no generated client resolvable from apps/api)");
}

rmSync(tmp, { recursive: true, force: true });
console.log(`prisma-fresh self-test: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
