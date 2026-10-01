/**
 * @jest-environment jsdom
 *
 * WP6 client.js behaviour in jsdom against the golden markup; fetch and EventSource are mocked.
 * Each test builds its own JSDOM window so document listeners never leak between tests.
 */
import * as fs from "fs";
import * as path from "path";
import { TextDecoder, TextEncoder } from "util";
import { checkField } from "../src/domain/schema";

/* eslint-disable @typescript-eslint/no-explicit-any */
Object.assign(globalThis, { TextEncoder, TextDecoder }); // jest-environment-jsdom lacks them
const { JSDOM } = require("jsdom");
const GOLDEN = fs.readFileSync(path.join(__dirname, "fixtures/acme/golden/index.html"), "utf8");
const CLIENT = fs.readFileSync(path.join(__dirname, "../src/render/assets/client.js"), "utf8");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const flush = async () => {
  for (let i = 0; i < 8; i++) await sleep(0);
};

class FakeES {
  static all: FakeES[] = [];
  readyState = 1;
  handlers: Record<string, any[]> = {};
  onopen: any = null;
  onerror: any = null;
  constructor(public url: string) {
    FakeES.all.push(this);
  }
  addEventListener(t: string, f: any) {
    (this.handlers[t] = this.handlers[t] || []).push(f);
  }
  emit(t: string) {
    (this.handlers[t] || []).forEach((f) => f({}));
  }
  close() {
    this.readyState = 2;
  }
}
const resp = (status: number, body: any = {}, etag: string | null = null) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: { get: () => etag },
  json: async () => body,
  text: async () => (typeof body === "string" ? body : GOLDEN),
});

interface Harness {
  w: any;
  d: Document;
  calls: { url: string; init: any }[];
  route: (url: string, fn: (init: any) => any) => void;
  posts: () => any[];
}
function boot(): Harness {
  FakeES.all = [];
  const dom = new JSDOM(GOLDEN, { url: "http://localhost/", runScripts: "outside-only" });
  const w: any = dom.window;
  w.document.querySelector('meta[name="csrf-token"]').setAttribute("content", "tok");
  const calls: Harness["calls"] = [];
  const routes: Record<string, (init: any) => any> = {};
  w.fetch = (url: string, init: any = {}) => {
    calls.push({ url, init });
    const f = routes[url];
    return Promise.resolve(
      f ? f(init) : url === "/" ? resp(200, GOLDEN) : resp(200, { fragments: {} }),
    );
  };
  w.EventSource = FakeES;
  w.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  w.eval(CLIENT);
  return {
    w,
    d: w.document,
    calls,
    route: (u, fn) => {
      routes[u] = fn;
    },
    posts: () => calls.filter((c) => c.url === "/api/event").map((c) => JSON.parse(c.init.body)),
  };
}
const click = (el: Element) =>
  el.dispatchEvent(
    new (el.ownerDocument.defaultView as any).MouseEvent("click", { bubbles: true }),
  );
const key = (h: Harness, k: string, target?: Element) =>
  (target || h.d).dispatchEvent(
    new h.w.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }),
  );
const queueBtn = (h: Harness, task: string) =>
  h.d.querySelector(`button[data-act="next"][data-task="${task}"]`) as HTMLElement;
const openDrawer = (h: Harness, task: string) => {
  click(h.d.querySelector(`.tid[data-task="${task}"]`) as Element);
  return h.d.getElementById("drawer") as HTMLElement;
};
const saveFor = (h: Harness, label: string) => {
  const f = [...h.d.querySelectorAll("#drawer-body .fld")].find(
    (x) => x.querySelector("label")?.textContent === label,
  ) as HTMLElement;
  return {
    field: f,
    control: f.querySelector("select,input,textarea") as any,
    save: f.querySelector("button") as HTMLElement,
  };
};
const frag = (h: Harness, k: string) =>
  (h.d.querySelector(`[data-panel="${k}"]`) as HTMLElement).innerHTML;

describe("confirmed writes (R18)", () => {
  it("does not touch the page until the server answers, then updates and offers Undo", async () => {
    const h = boot();
    let release: any;
    h.route("/api/event", () => new Promise((r) => (release = () => r(resp(200, { seq: 1 })))));
    click(h.d.querySelector('button[data-act="ack"]') as Element);
    await flush();
    const post = h.calls.find((c) => c.url === "/api/event")!;
    expect(post.init.headers["X-Control-Token"]).toBe("tok");
    expect(JSON.parse(post.init.body)).toMatchObject({
      type: "waste.ack",
      key: "W2:2810",
      expectedVersion: "9f3a1c0d5e7b",
    });
    expect(frag(h, "waste")).toContain("At risk of waste"); // not optimistic: old list stays until the server answers
    expect(frag(h, "waste")).toContain("W2:2810");
    h.route("/api/state.json", () =>
      resp(200, { version: "v2", fragments: { waste: "<h2>gone</h2>" } }, "e2"),
    );
    release();
    await flush();
    expect(frag(h, "waste")).toBe("<h2>gone</h2>");
    expect(h.d.querySelector("#toasts .toast")?.textContent).toMatch(/Acknowledged W2:2810/);
    expect(h.d.querySelector("#toasts .toast button")?.textContent).toBe("Undo");
  });
  it("Undo posts the inverse, whose until passes the schema date check", async () => {
    const h = boot();
    h.route("/api/event", () => resp(200, { seq: 1 }));
    click(h.d.querySelector('button[data-act="ack"]') as Element);
    await flush();
    click(h.d.querySelector("#toasts .toast button") as Element);
    await flush();
    const inv = h.posts()[1];
    expect(inv).toMatchObject({ type: "waste.ack", key: "W2:2810" });
    expect(checkField("waste.ack", "until", inv.until, "owner")).toBeNull();
  });
  it("409 reloads state and shows the conflict toast", async () => {
    const h = boot();
    h.route("/api/event", () => resp(409, { conflict: true }));
    click(h.d.querySelector('button[data-act="ack"]') as Element);
    await flush();
    expect(h.d.querySelector("#toasts")?.textContent).toMatch(/State changed elsewhere/);
    expect(h.calls.some((c) => c.url === "/api/state.json")).toBe(true);
  });
  it("500 on a drawer save restores the old value and shows an inline error", async () => {
    const h = boot();
    h.route("/api/event", () => resp(500));
    openDrawer(h, "F-1");
    const { control, save, field } = saveFor(h, "Priority");
    control.value = "P0";
    click(save);
    await flush();
    expect(control.value).toBe("P1");
    expect(field.querySelector(".err")?.textContent).toMatch(/Not saved/);
  });
  it("clearing release to (none) posts release:null with the old value as prev", async () => {
    const h = boot();
    h.route("/api/event", () => resp(200, { seq: 2 }));
    openDrawer(h, "F-1");
    const { control, save } = saveFor(h, "Release");
    control.value = "";
    click(save);
    await flush();
    expect(h.posts()[0]).toMatchObject({
      type: "task.release",
      task: "F-1",
      release: null,
      prev: "R1",
    });
  });
  it("drawer Set-as-next carries an Undo that restores the lane's previous next", async () => {
    const h = boot();
    h.route("/api/event", () => resp(200, { seq: 3 }));
    openDrawer(h, "F-3");
    const { control, save } = saveFor(h, "Set as next for lane");
    control.value = "lane-u";
    click(save);
    await flush();
    click(h.d.querySelector("#toasts .toast button") as Element);
    await flush();
    expect(h.posts()[1]).toMatchObject({ type: "task.next", task: "F-2", targetLane: "lane-u" });
  });
  it("Assign undo sends the piggyback row's previous lane", async () => {
    const h = boot();
    h.route("/api/event", () => resp(200, { seq: 4 }));
    const b = h.d.querySelector('button[data-act="assign"]') as HTMLElement;
    b.setAttribute("data-prev-lane", "lane-b");
    click(b);
    await flush();
    click(h.d.querySelector("#toasts .toast button") as Element);
    await flush();
    expect(h.posts()[1]).toMatchObject({ type: "task.lane", toLane: "lane-b" });
  });
});

describe("refresh behaviour", () => {
  it("SSE refresh keeps a dirty drawer field; a clean drawer rebuilds and keeps field focus", async () => {
    const h = boot();
    h.route("/api/state.json", () => resp(200, { version: "v2", fragments: {} }, "e2"));
    openDrawer(h, "F-1");
    const p = saveFor(h, "Priority");
    p.control.value = "P3";
    p.control.dispatchEvent(new h.w.Event("input", { bubbles: true }));
    p.control.dispatchEvent(new h.w.Event("change", { bubbles: true }));
    FakeES.all[0].emit("version");
    await flush();
    expect(saveFor(h, "Priority").control.value).toBe("P3");
    const r = saveFor(h, "Release");
    r.control.focus();
    r.control.value = "R1"; // back to clean: same as stored
    p.control.value = "P1";
    p.control.dispatchEvent(new h.w.Event("change", { bubbles: true }));
    h.route("/api/state.json", () => resp(200, { version: "v3", fragments: {} }, "e3"));
    FakeES.all[0].emit("version");
    await flush();
    expect(h.d.activeElement?.id).toBe(r.control.id);
  });
  it("a refresh requested during an in-flight pull re-pulls afterwards", async () => {
    const h = boot();
    let n = 0;
    let first: any;
    h.route("/api/state.json", () => {
      n++;
      if (n === 1)
        return new Promise(
          (r) => (first = () => r(resp(200, { version: "v2", fragments: {} }, "a"))),
        );
      return resp(200, { version: "v3", fragments: {} }, "b");
    });
    FakeES.all[0].emit("version");
    await flush();
    FakeES.all[0].emit("version");
    await flush();
    expect(n).toBe(1);
    first();
    await flush();
    expect(n).toBe(2);
  });
  it("focus is restored by data-act + data-task even when rows reorder", async () => {
    const h = boot();
    const q = (t: string) =>
      `<button type="button" class="btn" data-act="next" data-task="${t}" data-lane="">${t}</button>`;
    const a = q("F-3");
    const b = q("F-2");
    h.d.querySelector('[data-panel="queue"]')!.innerHTML = a + b;
    (h.d.querySelector('[data-panel="queue"] button[data-task="F-2"]') as HTMLElement).focus();
    h.route("/api/state.json", () =>
      resp(200, { version: "v2", fragments: { queue: b + a } }, "e2"),
    );
    FakeES.all[0].emit("version");
    await flush();
    expect((h.d.activeElement as HTMLElement).getAttribute("data-task")).toBe("F-2");
  });
});

describe("SSE lifecycle", () => {
  it("onopen refreshes; a closed stream is recreated with backoff", async () => {
    const h = boot();
    FakeES.all[0].onopen();
    await flush();
    expect(h.calls.some((c) => c.url === "/api/state.json")).toBe(true);
    FakeES.all[0].readyState = 2;
    FakeES.all[0].onerror();
    await sleep(1300);
    expect(FakeES.all.length).toBeGreaterThan(1);
  });
});

describe("toast, legend, inert", () => {
  it("Undo toast lasts >= 20 s, pauses on hover and takes focus", async () => {
    const h = boot();
    const delays: number[] = [];
    const cleared: any[] = [];
    const st = h.w.setTimeout.bind(h.w);
    h.w.setTimeout = (f: any, ms: number) => (delays.push(ms), st(f, ms));
    h.w.clearTimeout = (id: any) => cleared.push(id);
    h.route("/api/event", () => resp(200, { seq: 1 }));
    click(h.d.querySelector('button[data-act="ack"]') as Element);
    await flush();
    const t = h.d.querySelector("#toasts .toast") as HTMLElement;
    expect(Math.max(...delays)).toBeGreaterThanOrEqual(20000);
    expect(h.d.activeElement).toBe(t.querySelector("button"));
    const n = cleared.length;
    t.dispatchEvent(new h.w.MouseEvent("mouseover", { bubbles: true }));
    t.dispatchEvent(new h.w.FocusEvent("focusin", { bubbles: true }));
    expect(cleared.length).toBeGreaterThan(n);
  });
  it("? toggles the legend idempotently", () => {
    const h = boot();
    const l = h.d.getElementById("legend") as HTMLElement;
    key(h, "?");
    expect(l.hasAttribute("open")).toBe(true);
    key(h, "?");
    expect(l.hasAttribute("open")).toBe(false);
  });
  it("the page behind the drawer is inert while it is open", () => {
    const h = boot();
    openDrawer(h, "F-1");
    expect(h.d.querySelector("main")!.hasAttribute("inert")).toBe(true);
    expect(h.d.querySelector("header")!.hasAttribute("inert")).toBe(true);
    key(h, "Escape");
    expect(h.d.querySelector("main")!.hasAttribute("inert")).toBe(false);
  });
  it("the drawer shows register/inferred alternates as text", () => {
    const h = boot();
    const d = openDrawer(h, "F-2");
    expect(d.textContent).toMatch(/register: R1/);
  });
});
