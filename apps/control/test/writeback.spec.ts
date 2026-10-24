/**
 * B4: CONTROL_WRITEBACK, default OFF. The web write path (POST /api/event) needs a state-repo-only
 * write credential this version does not carry, so it is switched off unless the variable is exactly
 * `on`. Covers the config rule, the server guard (after the session/Origin/CSRF checks, before the
 * body and the state clone), and the "View only" render (page, fragments, state.json).
 * The client half lives in writeback-client.spec.ts (jsdom).
 */
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { startServer } from "./helpers/start-server";
import type { Harness, Session } from "./helpers/start-server";
import { loadConfig } from "../src/config";
import { scaled } from "./helpers/platform";

jest.setTimeout(scaled(30_000));
/* eslint-disable @typescript-eslint/no-explicit-any */

const VIEW_ONLY_TITLE = "View only: changes are switched off on this dashboard";
const CHIP =
  '<span class="chip view-only" title="Changes are switched off on this dashboard">View only</span>';
const STATE = (): any =>
  JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/acme/state.json"), "utf8"));
const renderPage = (s: any, o: Record<string, unknown> = {}): string =>
  require("../src/render/page").renderPage(s, { now: "2026-01-12T10:00:00Z", ...o });
const renderFragments = (s: any, o: Record<string, unknown> = {}): Record<string, string> =>
  require("../src/render/page").renderFragments(s, { now: "2026-01-12T10:00:00Z", ...o });

const WRITE_ACTS = ["ack", "superseded", "next", "assign"];
/** state with every kind of write button on it, including a replaced-PR row */
const stateWithAll = (): any => {
  const s = STATE();
  s.waste = [
    ...(s.waste ?? []),
    { key: "W5:12", rule: "W5", subject: "PR #12", why: "x", action: "Ack" },
  ];
  return s;
};
/** every <button ...> start tag in `html` whose data-act is one of the four write acts */
const writeButtons = (html: string): string[] =>
  (html.match(/<button\b[^>]*>/g) ?? []).filter((b) =>
    WRITE_ACTS.some((a) => b.includes(`data-act="${a}"`)),
  );
const isOff = (tag: string): boolean =>
  /\sdisabled(\s|>|=)/.test(tag) &&
  tag.includes('aria-disabled="true"') &&
  tag.includes(`title="${VIEW_ONLY_TITLE}"`);
const isOn = (tag: string): boolean =>
  !/\sdisabled(\s|>|=)/.test(tag) &&
  !tag.includes("aria-disabled") &&
  !tag.includes(VIEW_ONLY_TITLE);

describe("config: writeback is on only for the exact string `on`", () => {
  const base = { CONTROL_LOCAL: "1" };
  it("is off when the variable is absent or empty", () => {
    expect(loadConfig({ ...base }).writeback).toBe(false);
    expect(loadConfig({ ...base, CONTROL_WRITEBACK: "" }).writeback).toBe(false);
  });
  it("is on for exactly `on`", () => {
    expect(loadConfig({ ...base, CONTROL_WRITEBACK: "on" }).writeback).toBe(true);
  });
  it.each(["ON", "On", "true", "1", " on", "on ", "yes", "off", "enabled"])(
    "is off (never an error) for %j",
    (v) => {
      expect(loadConfig({ ...base, CONTROL_WRITEBACK: v }).writeback).toBe(false);
    },
  );
  const prod = {
    CONTROL_PASSWORD: "p".repeat(20),
    CONTROL_SESSION_SECRET: "s".repeat(40),
    CONTROL_GITHUB_TOKEN: "ghp_test_token",
    CONTROL_REPO: "acme/acme",
    CONTROL_STATE_REPO: "acme/acme-control-state",
  };
  const WARN = "control: CONTROL_WRITEBACK=on but the token is read-only; saves will fail";
  it("warns when `on` in a real (non-local, non-fixture) deployment", () => {
    expect(loadConfig({ ...prod, CONTROL_WRITEBACK: "on" }).warnings).toContain(WARN);
  });
  it("does not warn when off, in local mode, or against a fixture", () => {
    expect(loadConfig({ ...prod }).warnings).not.toContain(WARN);
    expect(loadConfig({ ...prod, CONTROL_WRITEBACK: "true" }).warnings).not.toContain(WARN);
    expect(loadConfig({ ...base, CONTROL_WRITEBACK: "on" }).warnings).not.toContain(WARN);
    expect(
      loadConfig({ ...prod, CONTROL_FIXTURE: "/x", CONTROL_WRITEBACK: "on" }).warnings,
    ).not.toContain(WARN);
  });
});

describe("render: View only when writeback is false", () => {
  it("defaults to writeback ON when the option is not given (existing render meaning)", () => {
    const h = renderPage(stateWithAll());
    expect(h).toContain('<meta name="control-writeback" content="on">');
    expect(h).not.toContain("view-only");
    const btns = writeButtons(h);
    expect(btns.length).toBeGreaterThan(0);
    for (const b of btns) expect(isOn(b)).toBe(true);
  });
  it("the page shows the chip and the off meta", () => {
    const h = renderPage(stateWithAll(), { writeback: false });
    expect(h).toContain(CHIP);
    expect(h).toContain('<meta name="control-writeback" content="off">');
    expect(h).not.toContain('content="on">');
  });
  it("the chip sits in the header tools, beside the theme and help buttons", () => {
    const h = renderPage(stateWithAll(), { writeback: false });
    const tools = h.slice(h.indexOf('<div class="tools">'), h.indexOf("</header>"));
    expect(tools).toContain(CHIP);
    expect(tools).toContain('data-act="theme"');
  });
  it("all four write buttons are rendered disabled, aria-disabled and titled", () => {
    const h = renderPage(stateWithAll(), { writeback: false });
    const btns = writeButtons(h);
    for (const a of WRITE_ACTS) expect(btns.some((b) => b.includes(`data-act="${a}"`))).toBe(true);
    for (const b of btns) expect(isOff(b)).toBe(true);
  });
  it("with writeback on, none carries the chip, disabled, or the view-only title", () => {
    const h = renderPage(stateWithAll(), { writeback: true });
    expect(h).not.toContain("View only");
    expect(h).toContain('<meta name="control-writeback" content="on">');
    for (const b of writeButtons(h)) expect(isOn(b)).toBe(true);
  });
  it("fragments follow the same rule (the pieces state.json and the refresh carry)", () => {
    const off = renderFragments(stateWithAll(), { writeback: false });
    const on = renderFragments(stateWithAll(), { writeback: true });
    const offBtns = Object.values(off).flatMap(writeButtons);
    const onBtns = Object.values(on).flatMap(writeButtons);
    expect(offBtns.length).toBe(onBtns.length);
    expect(offBtns.length).toBeGreaterThan(0);
    for (const b of offBtns) expect(isOff(b)).toBe(true);
    for (const b of onBtns) expect(isOn(b)).toBe(true);
  });
  it("everything else is unchanged: the attention headline and the copy", () => {
    const strip = (h: string) =>
      h
        .replace(CHIP, "")
        .replace('content="off">', 'content="on">')
        .replace(/ disabled aria-disabled="true"/g, "");
    const norm = (h: string) => h.replace(/ title="[^"]*"/g, "");
    expect(norm(strip(renderPage(stateWithAll(), { writeback: false })))).toBe(
      norm(renderPage(stateWithAll(), { writeback: true })),
    );
  });
  it("the loading page carries the meta too", () => {
    const h = renderPage({}, { loading: true, writeback: false });
    expect(h).toContain('<meta name="control-writeback" content="off">');
    expect(h).toContain(CHIP);
  });
  it("styles.css has a .chip.view-only rule", () => {
    const css = fs.readFileSync(path.join(__dirname, "../src/render/assets/styles.css"), "utf8");
    expect(css).toMatch(/\.chip\.view-only\s*\{/);
  });
});

/** Everything a stray write would touch: origin tip, owner file, clone log and files, pending/. */
function snapshot(h: Harness) {
  const clone = h.world.cloneDirOf("server");
  const git = (...a: string[]): string =>
    fs.existsSync(clone)
      ? execFileSync("git", ["-C", clone, ...a], { encoding: "utf8", stdio: "pipe" })
      : "";
  return {
    originHead: h.world.remoteHead(),
    ownerBytes: h.world.remoteFile("events/owner.jsonl"),
    log: git("log", "--format=%H", "--all"),
    cloneOwner: fs.existsSync(path.join(clone, "events", "owner.jsonl"))
      ? fs.readFileSync(path.join(clone, "events", "owner.jsonl"), "utf8")
      : null,
    pending: fs.existsSync(path.join(clone, "pending")),
    fetchHead: fs.existsSync(path.join(clone, ".git", "FETCH_HEAD"))
      ? fs.statSync(path.join(clone, ".git", "FETCH_HEAD")).mtimeMs
      : null,
  };
}
const prio = (st: any, id = "RF-1"): string => st.tasks[id].priority.value;
const evt = (st: any, over: Record<string, unknown> = {}) => {
  const prev = prio(st);
  return {
    type: "task.priority",
    task: "RF-1",
    priority: prev === "P1" ? "P2" : "P1",
    prev,
    expectedVersion: st.version,
    ...over,
  };
};

describe("server: POST /api/event is closed unless CONTROL_WRITEBACK=on", () => {
  let h: Harness;
  let s: Session;
  afterEach(() => h?.close());

  describe("default config (off)", () => {
    beforeEach(async () => {
      h = await startServer();
      s = await h.session();
    });

    it("a valid session + CSRF + body gets 403 writeback_off, no-store, and nothing is written", async () => {
      const st = (await h.stateJson(s)).state;
      const before = snapshot(h);
      const ownerBefore = h.ownerLines().length;
      const r = await h.postEvent(s, evt(st));
      expect(r.status).toBe(403);
      expect(r.json()).toEqual({ error: "writeback_off" });
      expect(r.headers["cache-control"]).toMatch(/no-store/);
      expect(snapshot(h)).toEqual(before);
      expect(h.ownerLines().length).toBe(ownerBefore);
      expect(fs.existsSync(path.join(h.world.cloneDirOf("server"), "pending"))).toBe(false);
    });
    it("the guard answers before the body is read: a malformed or oversized body is still writeback_off", async () => {
      const bad = await h.req("POST", "/api/event", { headers: s.write(), body: "{not json" });
      expect(bad.status).toBe(403);
      expect(bad.json()).toEqual({ error: "writeback_off" });
      const big = await h.req("POST", "/api/event", {
        headers: s.write(),
        body: JSON.stringify({ pad: "x".repeat(20 * 1024) }),
      });
      expect(big.status).toBe(403);
      expect(big.json()).toEqual({ error: "writeback_off" });
    });
    it("an unauthenticated POST still gets 401 (it learns nothing about the switch)", async () => {
      const st = (await h.stateJson(s)).state;
      const { cookie: _c, ...noCookie } = s.write();
      const r = await h.req("POST", "/api/event", {
        headers: noCookie,
        body: JSON.stringify(evt(st)),
      });
      expect(r.status).toBe(401);
      expect(r.text).not.toContain("writeback_off");
    });
    it("a bad CSRF token, a foreign Origin and a wrong content type keep their own answers", async () => {
      const st = (await h.stateJson(s)).state;
      const body = JSON.stringify(evt(st));
      const csrf = await h.postEvent(s, evt(st), { "x-control-token": "AAAA" + s.csrf.slice(4) });
      expect(csrf.status).toBe(403);
      expect(csrf.text).not.toContain("writeback_off");
      const org = await h.postEvent(s, evt(st), { origin: "https://evil.example" });
      expect(org.status).toBe(403);
      expect(org.text).not.toContain("writeback_off");
      const ct = await h.req("POST", "/api/event", {
        headers: s.write({ "content-type": "text/plain" }),
        body,
      });
      expect(ct.status).toBe(415);
    });
    it("the config says off and the page, state.json and fragments say View only", async () => {
      expect(h.config.writeback).toBe(false);
      const page = await h.req("GET", "/", { headers: { cookie: s.cookie } });
      expect(page.text).toContain(CHIP);
      expect(page.text).toContain('<meta name="control-writeback" content="off">');
      const btns = writeButtons(page.text);
      expect(btns.length).toBeGreaterThan(0);
      for (const b of btns) expect(isOff(b)).toBe(true);
      const j = await h.stateJson(s);
      const fr = Object.values(j.fragments as Record<string, string>).flatMap(writeButtons);
      expect(fr.length).toBeGreaterThan(0);
      for (const b of fr) expect(isOff(b)).toBe(true);
    });
    it("other routes are untouched: GETs and logout still work", async () => {
      expect((await h.req("GET", "/api/health", { headers: { cookie: s.cookie } })).status).toBe(
        200,
      );
      const out = await h.req("POST", "/logout", {
        headers: { cookie: s.cookie, origin: h.origin },
      });
      expect(out.status).toBe(303);
    });
  });

  describe("CONTROL_WRITEBACK=on", () => {
    beforeEach(async () => {
      h = await startServer({ writeback: true });
      s = await h.session();
    });
    it("writes as before: 200 {seq, version} and one owner line", async () => {
      const st = (await h.stateJson(s)).state;
      const before = h.ownerLines().length;
      const r = await h.postEvent(s, evt(st));
      expect(r.status).toBe(200);
      expect(typeof r.json().seq).toBe("number");
      expect(h.ownerLines().length).toBe(before + 1);
    });
    it("the page, fragments and state.json carry no View only chip and enabled buttons", async () => {
      expect(h.config.writeback).toBe(true);
      const page = await h.req("GET", "/", { headers: { cookie: s.cookie } });
      expect(page.text).not.toContain("View only");
      expect(page.text).toContain('<meta name="control-writeback" content="on">');
      for (const b of writeButtons(page.text)) expect(isOn(b)).toBe(true);
      const j = await h.stateJson(s);
      const fr = Object.values(j.fragments as Record<string, string>).flatMap(writeButtons);
      expect(fr.length).toBeGreaterThan(0);
      for (const b of fr) expect(isOn(b)).toBe(true);
    });
  });

  describe.each(["ON", "true", "1", " on", "yes", "On", "on "])("CONTROL_WRITEBACK=%j", (v) => {
    it("is off: 403 writeback_off and nothing written", async () => {
      h = await startServer({ writebackValue: v });
      s = await h.session();
      expect(h.config.writeback).toBe(false);
      const st = (await h.stateJson(s)).state;
      const tip = h.world.remoteHead();
      const r = await h.postEvent(s, evt(st));
      expect(r.status).toBe(403);
      expect(r.json()).toEqual({ error: "writeback_off" });
      expect(h.world.remoteHead()).toBe(tip);
    });
  });
});
