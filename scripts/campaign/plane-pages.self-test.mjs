#!/usr/bin/env node
// Coverage for the pages (wiki) endpoint in plane-client.mjs (#2030). Same standalone-script
// convention as plane-sync.self-test.mjs: `node scripts/campaign/plane-pages.self-test.mjs`,
// ok/FAIL lines, `process.exit(failures ? 1 : 0)`. Drives the client against the fake Plane
// server; the ledger and machine root are a throwaway tmp dir, never the real one.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakePlane } from "./plane-fake-server.mjs";

const machineRoot = mkdtempSync(join(tmpdir(), `plane-pages-self-test-${process.pid}-`));
process.env.PLANE_MACHINE_ROOT = machineRoot;
process.env.PLANE_SYNC_SELF_TEST = "1";
const { createClient, EXTERNAL_SOURCE } = await import("./plane-client.mjs");

let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(
    `${ok ? "  ok  " : "  FAIL"} ${name}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`,
  );
}

const PROJECT = "proj-ops";
const mine = (over = {}) => ({
  name: "Release 1",
  description_html: "<p>old</p>",
  external_source: EXTERNAL_SOURCE,
  external_id: "release-1",
  ...over,
});
const spec = { externalId: "release-1", name: "Release 1", descriptionHtml: "<p>new</p>" };

async function run(seed, fn) {
  const server = await startFakePlane({ pages: { OPS: seed } });
  try {
    const client = createClient({
      baseUrl: server.url,
      slug: "ws",
      apiKey: "test",
      tool: "plane-apply",
      maxWrites: 10,
      log: () => {},
    });
    await fn(client, server);
  } finally {
    await server.close();
  }
}
const writesOf = (server) => server.requests.filter((r) => r.method !== "GET");

try {
  // Create when absent: dry-run first writes nothing, the real run POSTs once, stamped.
  await run([], async (client, server) => {
    check(
      "dry-run create plans a create",
      (await client.upsertPage(PROJECT, spec, { dryRun: true })).action,
      "create",
    );
    check("dry-run create made no request beyond GETs", writesOf(server).length, 0);
    const r = await client.upsertPage(PROJECT, spec, { ref: "R1", reason: "test" });
    check("real run creates", r.action, "create");
    const posts = writesOf(server);
    check(
      "one POST",
      posts.map((p) => p.method),
      ["POST"],
    );
    check(
      "POST is stamped with the registry source + external id",
      [posts[0].body.external_source, posts[0].body.external_id, posts[0].body.description_html],
      [EXTERNAL_SOURCE, "release-1", "<p>new</p>"],
    );
  });

  // Idempotent: the same body twice is a noop with no write.
  await run([mine({ description_html: "<p>new</p>" })], async (client, server) => {
    check("unchanged page is a noop", (await client.upsertPage(PROJECT, spec)).action, "noop");
    check("noop writes nothing", writesOf(server).length, 0);
  });

  // Changed body: dry-run plans an update, real run PATCHes the whole body.
  await run([mine()], async (client, server) => {
    check(
      "dry-run update plans an update",
      (await client.upsertPage(PROJECT, spec, { dryRun: true })).action,
      "update",
    );
    check("dry-run update wrote nothing", writesOf(server).length, 0);
    check("real run updates", (await client.upsertPage(PROJECT, spec)).action, "update");
    const patches = writesOf(server);
    check(
      "one PATCH sending the whole body",
      [patches.length, patches[0].method, patches[0].body],
      [1, "PATCH", { name: "Release 1", description_html: "<p>new</p>" }],
    );
  });

  // Locked and archived pages are skipped, never forced.
  await run([mine({ is_locked: true })], async (client, server) => {
    check("locked page is skipped", (await client.upsertPage(PROJECT, spec)).action, "skip-locked");
    check("locked page: no write", writesOf(server).length, 0);
  });
  await run([mine({ archived_at: "2026-09-01T00:00:00Z" })], async (client, server) => {
    check(
      "archived page is skipped",
      (await client.upsertPage(PROJECT, spec)).action,
      "skip-archived",
    );
    check("archived page: no write", writesOf(server).length, 0);
  });

  // A hand-made page with the same external_id but another source is never touched: we create ours.
  await run([mine({ external_source: "someone-else" })], async (client, server) => {
    check(
      "foreign-source page is not matched",
      (await client.resolvePage(PROJECT, "release-1")) === undefined,
      true,
    );
    check(
      "so a create is planned",
      (await client.upsertPage(PROJECT, spec, { dryRun: true })).action,
      "create",
    );
    check("and nothing was written", writesOf(server).length, 0);
  });

  // Budget: a write past maxWrites is deferred, not sent.
  {
    const server = await startFakePlane({ pages: { OPS: [] } });
    try {
      const client = createClient({
        baseUrl: server.url,
        slug: "ws",
        apiKey: "t",
        tool: "plane-apply",
        maxWrites: 0,
        log: () => {},
      });
      const r = await client.upsertPage(PROJECT, spec);
      check(
        "past the write budget the create is deferred",
        [r.action, r.deferred],
        ["create", true],
      );
      check("deferred means no POST", writesOf(server).length, 0);
    } finally {
      await server.close();
    }
  }

  // externalId is required.
  await run([], async (client) => {
    let msg = "";
    try {
      await client.upsertPage(PROJECT, { name: "x", descriptionHtml: "" });
    } catch (e) {
      msg = e.message;
    }
    check("missing externalId throws", /externalId is required/.test(msg), true);
  });
} finally {
  rmSync(machineRoot, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILED` : "\nall pages checks passed");
process.exit(failures ? 1 : 0);
