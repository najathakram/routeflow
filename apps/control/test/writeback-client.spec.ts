/**
 * @jest-environment jsdom
 *
 * B4 client half: when the page says `<meta name="control-writeback" content="off">` the drawer's
 * Save buttons are disabled and NO fetch to /api/event is ever made; a 403 {error:"writeback_off"}
 * from the server shows one plain toast (no retry, no generic error text).
 */
import * as fs from "fs";
import * as path from "path";
import { TextDecoder, TextEncoder } from "util";

/* eslint-disable @typescript-eslint/no-explicit-any */
Object.assign(globalThis, { TextEncoder, TextDecoder }); // jest-environment-jsdom lacks them
const { JSDOM } = require("jsdom");
const CLIENT = fs.readFileSync(path.join(__dirname, "../src/render/assets/client.js"), "utf8");
const STATE = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/acme/state.json"), "utf8"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const flush = async () => {
  for (let i = 0; i < 8; i++) await sleep(0);
};
const VIEW_ONLY = "View only: changes are switched off on this dashboard";

class FakeES {
  readyState = 1;
  onopen: any = null;
  onerror: any = null;
  addEventListener() {}
  close() {}
}
const resp = (status: number, body: any = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: { get: () => null },
  json: async () => body,
  text: async () => "",
});

function boot(writeback: boolean, route?: (init: any) => any) {
  const { renderPage } = require("../src/render/page");
  const html: string = renderPage(STATE, { now: "2026-01-12T10:00:00Z", writeback, csrf: "tok" });
  const dom = new JSDOM(html, { url: "http://localhost/", runScripts: "outside-only" });
  const w: any = dom.window;
  const calls: { url: string; init: any }[] = [];
  w.fetch = (url: string, init: any = {}) => {
    calls.push({ url, init });
    if (url === "/api/event" && route) return Promise.resolve(route(init));
    return Promise.resolve(url === "/" ? { ...resp(200), text: async () => html } : resp(200, {}));
  };
  w.EventSource = FakeES;
  w.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  w.eval(CLIENT);
  const d: Document = w.document;
  return {
    w,
    d,
    calls,
    posts: () => calls.filter((c) => c.url === "/api/event"),
    said: () => [...d.querySelectorAll("#toasts .toast > span")].map((s) => s.textContent),
    click: (el: Element) => el.dispatchEvent(new w.MouseEvent("click", { bubbles: true })),
  };
}
type H = ReturnType<typeof boot>;
const openFirstDrawer = (h: H) => {
  h.click(h.d.querySelector(".tid[data-task]") as Element);
  return [...h.d.querySelectorAll("#drawer-body .fld button")] as HTMLButtonElement[];
};

describe("client with the write path switched off", () => {
  it("every Save in the drawer is disabled, aria-disabled and titled", () => {
    const h = boot(false);
    const saves = openFirstDrawer(h);
    expect(saves.length).toBeGreaterThan(0);
    for (const b of saves) {
      expect(b.disabled).toBe(true);
      expect(b.getAttribute("aria-disabled")).toBe("true");
      expect(b.title).toBe(VIEW_ONLY);
    }
  });
  it("the replaced-PR dialog's Save is disabled too", () => {
    const h = boot(false);
    const row = h.d.createElement("li");
    row.innerHTML =
      '<button type="button" class="btn" data-act="superseded" data-pr="12">Mark as replaced</button>';
    h.d.body.append(row);
    h.click(row.querySelector("button") as Element);
    const b = h.d.querySelector("#drawer-body .fld button") as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    expect(b.title).toBe(VIEW_ONLY);
  });
  it("no fetch to /api/event is ever made, even when a Save handler is invoked directly", async () => {
    const h = boot(false);
    const saves = openFirstDrawer(h);
    for (const [i, b] of saves.entries()) {
      const c = h.d.getElementById(`f-${i}`) as any;
      if (c.options) c.value = c.options[c.options.length - 1].value;
      else c.value = "changed";
      await (b as any).onclick({ currentTarget: b });
    }
    await flush();
    expect(h.posts()).toHaveLength(0);
    expect(h.said().length).toBeGreaterThan(0);
    expect(h.said()).toContain(VIEW_ONLY + ".");
  });
  it("clicking the (disabled) server-rendered buttons posts nothing", async () => {
    const h = boot(false);
    for (const b of h.d.querySelectorAll('button[data-act="ack"], button[data-act="assign"]')) {
      expect((b as HTMLButtonElement).disabled).toBe(true);
      h.click(b);
    }
    await flush();
    expect(h.posts()).toHaveLength(0);
  });
});

describe("client with the write path on", () => {
  it("Save buttons are enabled and a save still posts", async () => {
    const h = boot(true, () => resp(200, { seq: 1 }));
    const saves = openFirstDrawer(h);
    expect(saves.length).toBeGreaterThan(0);
    for (const b of saves) {
      expect(b.disabled).toBe(false);
      expect(b.getAttribute("aria-disabled")).toBeNull();
      expect(b.title).toBe("");
    }
    h.click(h.d.querySelector('button[data-act="ack"]') as Element);
    await flush();
    expect(h.posts()).toHaveLength(1);
  });
});

describe("a 403 writeback_off answer", () => {
  it("shows the View only toast once: no retry, no generic error text", async () => {
    const h = boot(true, () => resp(403, { error: "writeback_off" }));
    const ack = h.d.querySelector('button[data-act="ack"]') as HTMLButtonElement;
    h.click(ack);
    await flush();
    expect(h.posts()).toHaveLength(1);
    expect(h.said()).toEqual([VIEW_ONLY + "."]);
    expect(h.d.querySelector("#toasts .toast.error")).not.toBeNull();
    expect(h.d.body.textContent).not.toMatch(/Not saved|refused the change|error 403/);
    expect(ack.disabled).toBe(false); // the page itself is not locked by an answer
  });
  it("a different 403 keeps the generic failure copy", async () => {
    const h = boot(true, () => resp(403, { error: "refused" }));
    h.click(h.d.querySelector('button[data-act="ack"]') as Element);
    await flush();
    expect(h.said().join(" ")).toMatch(/Not saved: the server refused the change \(error 403\)/);
    expect(h.said().join(" ")).not.toContain("View only");
  });
});
