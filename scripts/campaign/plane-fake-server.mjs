#!/usr/bin/env node
// plane-fake-server.mjs — disposable node:http fake of the Plane REST surface
// scripts/campaign/plane-*.mjs talk to. Extracted from plane-sync.self-test.mjs's
// v1 inline `startFakeServer` (build-plan.md TP1, .claude/pipeline/
// 2026-09-11-plane-harness/) so plane-intake/-triage/-apply's self-tests import
// ONE fixture instead of three near-identical copies. Dependency-free
// (node:http only) — this is test infra, not a second HTTP client, so it does
// not trip CLAUDE.md's do-not-introduce list.
//
// Routes served, all under .../workspaces/<slug>/ (the slug segment itself is
// never checked — any value matches, mirroring how the real scripts resolve
// everything else at runtime rather than by a hardcoded id):
//   GET  projects/
//   GET  projects/<id>/states/
//   GET  projects/<id>/labels/
//   GET  projects/<id>/work-item-types/            (BARE ARRAY — see below)
//   GET  members/                                  (BARE ARRAY — see below)
//   GET  projects/<id>/work-items/                 (cursor pagination)
//   POST projects/<id>/work-items/
//   PATCH projects/<id>/work-items/<itemId>/
//   POST projects/<id>/work-items/<itemId>/archive/
//   GET/POST projects/<id>/work-items/<itemId>/comments/
//   GET/POST projects/<id>/work-items/<itemId>/links/
//   POST projects/<id>/work-items/<itemId>/relations/
//   GET  projects/<id>/intake-issues/               (404 when seed.intake404)
// Anything else is a 404 naming the method+path, so a wrong URL fails loudly
// instead of silently 200-ing.
//
// LANDMINE 14 (build-plan.md): the real Plane REST paths for the Intake-queue
// resource and for `archive` are not named in spec.md/the ruling — this fixture
// models only the documented behavior (a listable status--2 record set; an
// archive op gated on the target's current state group). Confirm both against
// Plane's own API reference before wiring a real request in plane-intake.mjs /
// plane-apply.mjs.
//
// DEFECT 1 (proven live 2026-09-12): `members/` and `projects/<id>/work-item-
// types/` return a BARE ARRAY on the real API, not the `{results, ...}`
// envelope every other listed route here uses — this fixture defaults both to
// a bare array to mirror that. `seed.workItemTypesEnvelope` flips ONLY the
// work-item-types/ route back to the enveloped shape, for a test proving
// plane-client.mjs's `listAll` tolerates both (T17's negative twin); there is
// no equivalent flag for members/ since no case needs it.
import { createServer } from "node:http";

const stripTags = (html) =>
  String(html ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export const DEFAULT_PROJECTS = [
  { id: "proj-bugs", identifier: "BUGS", name: "Bugs" },
  { id: "proj-road", identifier: "ROAD", name: "Roadmap" },
  { id: "proj-ops", identifier: "OPS", name: "Ops" },
  { id: "proj-decide", identifier: "DECIDE", name: "Decisions" },
  { id: "proj-client", identifier: "CLIENT", name: "Client" },
];

// Same ids/names v1's inline fake shipped for BUGS — plane-sync.self-test.mjs
// pins several of these literally (e.g. `post?.body?.state === "state-backlog"`),
// so the id/name pairs cannot move. `group` is new (the harness's R4/R5/R8 need
// completed/cancelled classification); it was absent from v1 and adding it
// changes no v1 assertion, which only ever compares id/name.
export const DEFAULT_STATES = [
  { id: "state-backlog", name: "Backlog", group: "backlog" },
  { id: "state-inprogress", name: "In progress", group: "started" },
  { id: "state-inreview", name: "In review", group: "started" },
  { id: "state-landing", name: "Landing", group: "started" },
  { id: "state-live", name: "Live", group: "completed" },
  { id: "state-cancelled", name: "Cancelled", group: "cancelled" },
];

function cloneStates(list) {
  return (list ?? DEFAULT_STATES).map((s) => ({ ...s }));
}

/**
 * startFakePlane(seed) -> Promise<{ url, port, requests, state, close() }>
 *
 * seed (all optional):
 *   slug             workspace slug segment (cosmetic only — never checked)
 *   projects         override the default BUGS/ROAD/OPS/DECIDE/CLIENT list
 *   states   { <identifier>: [{id,name,group}] }   per-project state list
 *   labels   { <identifier>: [...] }
 *   types    { <identifier>: [...] }
 *   members  [...]                                  workspace-level
 *   workItems { <identifier>: [item, ...] }         seeded existing items
 *   comments  { <itemId>: [comment, ...] }          seeded comment history
 *   links     { <itemId>: [link, ...] }             seeded link history
 *   intake    { <identifier>: [record, ...] }       status -2/-1/0/1/2 records
 *   intake404 boolean   every intake-issues/ route 404s (Landmine 14)
 *   workItemTypesEnvelope boolean   serve work-item-types/ as the old
 *                            {results, ...} envelope instead of the live
 *                            bare-array shape (Defect 1 negative twin)
 *   failFirstCreate boolean  first POST .../work-items/ on ANY project 429s
 *                            once, with x-ratelimit-reset = now+1s (v1 behavior)
 *   omitDescriptionStripped boolean  list responses drop description_stripped
 *                                    (Landmine 1 fixture, v1 behavior)
 *
 * `requests` records every request this server receives, in order, as
 * `{method, path, query, body}`. `state` exposes the live, mutable seed data
 * keyed by project IDENTIFIER (never the opaque id) so a test can read or
 * mutate it after requests have been recorded (seed one phase, assert a
 * write, seed a follow-up state for the next phase).
 */
export function startFakePlane(seed = {}) {
  const requests = [];
  const projects = (seed.projects ?? DEFAULT_PROJECTS).map((p) => ({ ...p }));
  const byId = new Map(projects.map((p) => [p.id, p]));

  const states = {};
  const labels = {};
  const types = {};
  const workItems = {};
  const intake = {};
  for (const p of projects) {
    states[p.identifier] = cloneStates(seed.states?.[p.identifier]);
    labels[p.identifier] = (seed.labels?.[p.identifier] ?? []).map((l) => ({ ...l }));
    types[p.identifier] = (seed.types?.[p.identifier] ?? []).map((t) => ({ ...t }));
    workItems[p.identifier] = (seed.workItems?.[p.identifier] ?? []).map((it) => ({ ...it }));
    intake[p.identifier] = (seed.intake?.[p.identifier] ?? []).map((r) => ({ ...r }));
  }
  const members = (seed.members ?? []).map((m) => ({ ...m }));
  const comments = {};
  const links = {};

  let nextItemSeq = 1;
  let nextItemId = 1;
  const bumpFromId = (id) => {
    const digits = String(id).replace(/\D/g, "");
    if (digits) nextItemId = Math.max(nextItemId, Number(digits) + 1);
  };
  for (const items of Object.values(workItems)) {
    for (const it of items) {
      if (it.id === undefined) it.id = `item-${nextItemId++}`;
      else bumpFromId(it.id);
      if (it.sequence_id === undefined) it.sequence_id = nextItemSeq++;
      else nextItemSeq = Math.max(nextItemSeq, it.sequence_id + 1);
      comments[it.id] = [];
      links[it.id] = [];
    }
  }
  // seed.comments/seed.links are keyed by item id directly, applied after the
  // per-item scan above so a case can seed comment/link HISTORY (e.g. "this
  // item already carries its own plane-sync:closed comment") without also
  // having to inline it on the work-item object itself.
  for (const [itemId, list] of Object.entries(seed.comments ?? {})) {
    comments[itemId] = (list ?? []).map((c) => ({ ...c }));
  }
  for (const [itemId, list] of Object.entries(seed.links ?? {})) {
    links[itemId] = (list ?? []).map((l) => ({ ...l }));
  }

  let createFailuresLeft = seed.failFirstCreate ? 1 : 0;
  const intake404 = Boolean(seed.intake404);
  const workItemTypesEnvelope = Boolean(seed.workItemTypesEnvelope);
  const omitDescriptionStripped = Boolean(seed.omitDescriptionStripped);
  let nextCommentId = 1;
  let nextLinkId = 1;

  function listPayload(items, query) {
    const perPage = Math.max(1, Number(query.per_page) || 100);
    const offset = query.cursor ? Number(query.cursor) || 0 : 0;
    const page = items.slice(offset, offset + perPage);
    const hasMore = offset + perPage < items.length;
    const listed = omitDescriptionStripped
      ? page.map(({ description_stripped: _d, ...rest }) => rest)
      : page;
    return {
      results: listed,
      next_cursor: hasMore ? String(offset + perPage) : null,
      next_page_results: hasMore,
      total_count: items.length,
    };
  }

  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const u = new URL(req.url, "http://127.0.0.1");
      let body = null;
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }
      const query = Object.fromEntries(u.searchParams);
      requests.push({ method: req.method, path: u.pathname, query, body });

      const send = (status, obj) => {
        const buf = Buffer.from(JSON.stringify(obj));
        res.writeHead(status, { "content-type": "application/json" });
        res.end(buf);
      };
      const notFound = () =>
        send(404, { error: `fake Plane server: no route for ${req.method} ${u.pathname}` });

      const segs = u.pathname.split("/").filter(Boolean);
      const wsIdx = segs.indexOf("workspaces");
      if (wsIdx === -1) return notFound();
      const tail = segs.slice(wsIdx + 2); // drop "workspaces", <slug>

      if (req.method === "GET" && tail.length === 1 && tail[0] === "members") {
        // Defect 1: bare array on the live API — no envelope, ever.
        return send(200, members);
      }
      if (req.method === "GET" && tail.length === 1 && tail[0] === "projects") {
        return send(200, { results: projects, next_cursor: null, next_page_results: false });
      }
      if (tail[0] !== "projects" || tail.length < 2) return notFound();

      const project = byId.get(tail[1]);
      if (!project) return notFound();
      const identifier = project.identifier;
      const rest = tail.slice(2); // after projects/<id>/

      if (req.method === "GET" && rest.length === 1 && rest[0] === "states") {
        return send(200, { results: states[identifier] });
      }
      if (req.method === "GET" && rest.length === 1 && rest[0] === "labels") {
        return send(200, { results: labels[identifier] });
      }
      if (req.method === "GET" && rest.length === 1 && rest[0] === "work-item-types") {
        // Defect 1: bare array on the live API by default; `seed.
        // workItemTypesEnvelope` opts one test into the OLD enveloped shape
        // to prove listAll tolerates it too (T17's negative twin).
        return workItemTypesEnvelope
          ? send(200, { results: types[identifier], next_cursor: null, next_page_results: false })
          : send(200, types[identifier]);
      }
      if (rest.length === 1 && rest[0] === "intake-issues") {
        if (req.method !== "GET") return notFound();
        if (intake404) return send(404, { error: "intake-issues not enabled for this project" });
        return send(200, listPayload(intake[identifier], query));
      }
      if (rest[0] !== "work-items") return notFound();

      const items = workItems[identifier];

      if (rest.length === 1) {
        if (req.method === "GET") return send(200, listPayload(items, query));
        if (req.method === "POST") {
          if (createFailuresLeft > 0) {
            createFailuresLeft--;
            res.writeHead(429, {
              "content-type": "application/json",
              "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 1),
            });
            return res.end(JSON.stringify({ error: "rate limited" }));
          }
          const created = { id: `item-${nextItemId++}`, sequence_id: nextItemSeq++, ...body };
          if (created.description_html) {
            created.description_stripped = stripTags(created.description_html);
          }
          items.push(created);
          comments[created.id] = [];
          links[created.id] = [];
          return send(201, created);
        }
        return notFound();
      }

      const itemId = rest[1];
      const idx = items.findIndex((it) => it.id === itemId);
      const sub = rest.slice(2);

      if (sub.length === 0) {
        if (req.method === "PATCH") {
          if (idx === -1) return notFound();
          items[idx] = { ...items[idx], ...body };
          if (body?.description_html) {
            items[idx].description_stripped = stripTags(body.description_html);
          }
          return send(200, items[idx]);
        }
        return notFound();
      }

      if (sub.length === 1 && sub[0] === "archive" && req.method === "POST") {
        if (idx === -1) return notFound();
        const st = states[identifier].find((s) => s.id === items[idx].state);
        const group = st?.group;
        if (group !== "completed" && group !== "cancelled") {
          return send(400, {
            error: "archive requires the item's current state group to be completed or cancelled",
          });
        }
        items[idx] = { ...items[idx], archived_at: new Date().toISOString() };
        return send(200, items[idx]);
      }

      if (sub.length === 1 && sub[0] === "comments") {
        if (idx === -1) return notFound();
        if (req.method === "GET") return send(200, { results: comments[itemId] ?? [] });
        if (req.method === "POST") {
          const created = {
            id: `comment-${nextCommentId++}`,
            comment_html: body?.comment_html ?? "",
            comment_stripped: stripTags(body?.comment_html),
            created_at: new Date().toISOString(),
          };
          (comments[itemId] ??= []).push(created);
          return send(201, created);
        }
        return notFound();
      }

      if (sub.length === 1 && sub[0] === "links") {
        if (idx === -1) return notFound();
        if (req.method === "GET") return send(200, { results: links[itemId] ?? [] });
        if (req.method === "POST") {
          const created = { id: `link-${nextLinkId++}`, url: body?.url ?? "" };
          (links[itemId] ??= []).push(created);
          return send(201, created);
        }
        return notFound();
      }

      if (sub.length === 1 && sub[0] === "relations" && req.method === "POST") {
        if (idx === -1) return notFound();
        return send(201, { id: `relation-${Date.now()}`, ...body });
      }

      return notFound();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        requests,
        state: { projects, states, labels, types, members, workItems, comments, links, intake },
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}
