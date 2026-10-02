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
/** every toast message so far, in order (the message span only, not the Undo/Dismiss buttons) */
const said = (h: Harness) =>
  [...h.d.querySelectorAll("#toasts .toast > span")].map((s) => s.textContent);
/** swap a panel's markup for hand-written rows (the golden has none of these cases) */
const put = (h: Harness, panel: string, html: string) => {
  (h.d.querySelector(`[data-panel="${panel}"]`) as HTMLElement).innerHTML = html;
};
const ack = (h: Harness) => h.d.querySelector('button[data-act="ack"]') as Element;
const optionsOf = (control: any) =>
  [...control.options].map((o: any) => [o.textContent, o.value] as const);

describe("confirmed writes (R18)", () => {
  it("does not touch the page until the server answers, then updates and offers Undo", async () => {
    const h = boot();
    let release: any;
    h.route("/api/event", () => new Promise((r) => (release = () => r(resp(200, { seq: 1 })))));
    const rows = () =>
      [...h.d.querySelectorAll('[data-panel="waste"] .waste')].map((r) =>
        r.getAttribute("data-key"),
      );
    const heading = () => h.d.querySelector('[data-panel="waste"] h2')?.textContent;
    const [rowsBefore, headingBefore] = [rows(), heading()];
    expect(rowsBefore).toContain("W2:2810");
    const b = ack(h);
    click(b);
    await flush();
    expect((b as HTMLButtonElement).disabled).toBe(true); // the control shows it is waiting
    const post = h.calls.find((c) => c.url === "/api/event")!;
    expect(post.init.headers["X-Control-Token"]).toBe("tok");
    expect(JSON.parse(post.init.body)).toMatchObject({
      type: "waste.ack",
      key: "W2:2810",
      expectedVersion: "9f3a1c0d5e7b",
    });
    // not optimistic: the same warnings stay on the page until the server answers
    expect(rows()).toEqual(rowsBefore);
    expect(heading()).toBe(headingBefore);
    h.route("/api/state.json", () =>
      resp(200, { version: "v2", fragments: { waste: "<h2>gone</h2>" } }, "e2"),
    );
    release();
    await flush();
    expect(frag(h, "waste")).toBe("<h2>gone</h2>");
    // the toast names the warning the way its row does ("PR #2810 …"), not by its internal key
    expect(said(h)[0]).toMatch(/^Dismissed: PR #2810\b/);
    expect(said(h)[0]).not.toContain("W2:2810");
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
  it("409 reloads state and tells the owner in plain words to try again", async () => {
    const h = boot();
    h.route("/api/event", () => resp(409, { conflict: true }));
    click(ack(h));
    await flush();
    expect(said(h)).toEqual([
      "Someone changed this at the same time, so the page was refreshed. Please try again.",
    ]);
    expect(h.d.querySelector("#toasts .toast")?.classList.contains("error")).toBe(true);
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
    expect(field.querySelector(".err")?.textContent).toBe(
      "Not saved: the server refused the change (error 500).",
    );
    // re-query the LIVE drawer: a rebuild after the failure must not wipe the error or the focus
    const live = h.d.getElementById("drawer") as HTMLElement;
    expect(live.querySelector(".err")?.textContent).toMatch(/Not saved/);
    expect(live.contains(h.d.activeElement) && h.d.activeElement !== h.d.body).toBe(true);
    expect(saveFor(h, "Priority").control.value).toBe("P1");
  });
  it("clearing release to None posts release:null with the old value as prev", async () => {
    const h = boot();
    h.route("/api/event", () => resp(200, { seq: 2 }));
    openDrawer(h, "F-1");
    const { control, save } = saveFor(h, "Release");
    expect(optionsOf(control)[0]).toEqual(["None", ""]); // the blank choice is a word, not "(none)"
    control.value = "";
    click(save);
    await flush();
    expect(h.posts()[0]).toMatchObject({
      type: "task.release",
      task: "F-1",
      release: null,
      prev: "R1",
    });
    expect(said(h)).toEqual(["F-1 removed from its release."]);
  });
  it("drawer Make-this-next carries an Undo that restores the lane's previous next", async () => {
    const h = boot();
    h.route("/api/event", () => resp(200, { seq: 3 }));
    openDrawer(h, "F-3");
    const { control, save } = saveFor(h, "Make this the next task for lane");
    control.value = "lane-u";
    click(save);
    await flush();
    expect(said(h)).toEqual(["F-3 is now the next task for lane-u."]);
    click(h.d.querySelector("#toasts .toast button") as Element);
    await flush();
    expect(h.posts()[1]).toMatchObject({ type: "task.next", task: "F-2", targetLane: "lane-u" });
    expect(said(h)).toEqual(["Undone: F-3 is now the next task for lane-u."]); // the first toast closed
  });
  it("Assign undo sends the piggyback row's previous lane", async () => {
    const h = boot();
    h.route("/api/event", () => resp(200, { seq: 4 }));
    const b = h.d.querySelector('button[data-act="assign"]') as HTMLElement;
    b.setAttribute("data-prev-lane", "lane-b");
    click(b);
    await flush();
    expect(said(h)).toEqual([`${b.getAttribute("data-task")} now belongs to lane-u.`]);
    click(h.d.querySelector("#toasts .toast button") as Element);
    await flush();
    expect(h.posts()[1]).toMatchObject({ type: "task.lane", toLane: "lane-b" });
  });
  it("the inline Make-next button on a queue row confirms in a sentence and can be undone", async () => {
    const h = boot();
    h.route("/api/event", () => resp(200, { seq: 6 }));
    const b = queueBtn(h, "F-2"); // a lane is named on this row, so no drawer is needed
    expect(b.getAttribute("data-lane")).toBe("lane-u");
    click(b);
    await flush();
    expect(h.posts()[0]).toMatchObject({ type: "task.next", task: "F-2", targetLane: "lane-u" });
    expect(said(h)).toEqual(["F-2 is now the next task for lane-u."]);
    click(h.d.querySelector("#toasts .toast button") as Element);
    await flush();
    expect(h.posts()[1]).toMatchObject({ targetLane: "lane-u", task: b.getAttribute("data-prev") });
    expect(said(h)).toEqual(["Undone: F-2 is now the next task for lane-u."]);
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
  it("the live chip says in words whether the page is updating by itself", async () => {
    const h = boot();
    const chip = () => h.d.getElementById("live") as HTMLElement;
    const sources = frag(h, "sources"); // the server-rendered footer, with its own "live" chip
    FakeES.all[0].onerror(); // the stream drops
    expect(chip().textContent).toBe("Reconnecting…");
    expect(chip().getAttribute("data-live")).toBe("off");
    // a refresh swaps the footer for the server's chip; the client re-applies the real state
    h.route("/api/state.json", () => resp(200, { version: "v2", fragments: { sources } }, "e2"));
    FakeES.all[0].emit("version");
    await flush();
    expect(chip().textContent).toBe("Reconnecting…");
    FakeES.all[0].onopen(); // the stream is back (also clears the polling fallback)
    await flush();
    expect(chip().textContent).toBe("Live — updates automatically");
    expect(chip().getAttribute("data-live")).toBe("on");
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
  it("the drawer repeats the task's source details as text, under a plain lead-in", () => {
    const h = boot();
    const alt = (h.d.querySelector('.tid[data-task="F-2"]') as HTMLElement).dataset.alt as string;
    expect(alt).not.toBe(""); // F-2's release was changed by the owner: the renderer reports it
    const d = openDrawer(h, "F-2");
    expect(d.querySelector(".hint")?.textContent).toBe(`Where these values came from: ${alt}`);
    // a task with nothing to explain gets no empty note
    key(h, "Escape");
    expect(openDrawer(h, "F-4").querySelector(".hint")).toBeNull();
  });
});

describe("plain-language drawer", () => {
  const labels = (d: HTMLElement) =>
    [...d.querySelectorAll(".fld label")].map((l) => l.textContent);
  it("opens with '<id> — <title>', a plain info line and plain field labels", () => {
    const h = boot();
    const d = openDrawer(h, "F-1");
    expect(d.querySelector("#drawer-title")?.textContent).toBe("F-1 — Acme invoice date fixes");
    expect(d.querySelector(".info")?.textContent).toBe(
      "Status: In progress · Priority: High · Release: R1 · Lane: lane-u · Pull request: #2801",
    );
    expect(labels(d)).toEqual([
      "Priority",
      "Release",
      "Lane",
      "Make this the next task for lane",
      "Put up for reconsideration — why?",
      "Files this task touches (one pattern per line, like apps/api/**)",
    ]);
  });
  it("a task with no lane or pull request says so in words", () => {
    const h = boot();
    const info = openDrawer(h, "F-3").querySelector(".info")?.textContent;
    expect(info).toBe("Status: Planned · Priority: Urgent · Release: R1 · Lane: Not assigned");
  });
  it.each([
    ["planned", "Planned"],
    ["proposed", "Proposed"],
    ["in-progress", "In progress"],
    ["blocked", "Blocked"],
    ["code-complete", "Code finished"],
    ["released", "Released"],
    ["reconsider", "Being reconsidered"],
    ["dropped", "Dropped"],
    ["constructor", "Constructor"], // an inherited object key must fall back, never leak a function
    ["", "Unknown"],
  ])("status %p reads %p", (status, words) => {
    const h = boot();
    (h.d.querySelector('.tid[data-task="F-1"]') as HTMLElement).setAttribute("data-status", status);
    expect(openDrawer(h, "F-1").querySelector(".info")?.textContent).toContain(
      `Status: ${words} ·`,
    );
  });
  it.each([
    ["P0", "Urgent"],
    ["P1", "High"],
    ["P2", "Normal"],
    ["P3", "Low"],
    ["", "None"],
    ["constructor", "None"],
  ])("priority %p reads %p in the info line", (p, words) => {
    const h = boot();
    (h.d.querySelector('.tid[data-task="F-1"]') as HTMLElement).setAttribute("data-priority", p);
    expect(openDrawer(h, "F-1").querySelector(".info")?.textContent).toContain(
      `Priority: ${words} ·`,
    );
  });
  it("priority options read Urgent (P0) … Low (P3) but the value posted is still the P-code", async () => {
    const h = boot();
    h.route("/api/event", () => resp(200, { seq: 7 }));
    openDrawer(h, "F-1");
    const { control, save } = saveFor(h, "Priority");
    expect(optionsOf(control)).toEqual([
      ["Urgent (P0)", "P0"],
      ["High (P1)", "P1"],
      ["Normal (P2)", "P2"],
      ["Low (P3)", "P3"],
    ]);
    control.value = "P0";
    click(save);
    await flush();
    expect(h.posts()[0]).toMatchObject({
      type: "task.priority",
      task: "F-1",
      priority: "P0",
      prev: "P1",
    });
    expect(said(h)).toEqual(["Priority of F-1 changed to Urgent."]);
    click(h.d.querySelector("#toasts .toast button") as Element);
    await flush();
    expect(h.posts()[1]).toMatchObject({ type: "task.priority", priority: "P1", prev: "P0" });
    expect(said(h)).toEqual(["Undone: Priority of F-1 changed to Urgent."]);
  });
  it("release, lane, reconsider and file-list saves each confirm in a sentence", async () => {
    const h = boot();
    h.route("/api/event", () => resp(200, { seq: 8 }));
    openDrawer(h, "F-2");
    const set = async (label: string, value: string) => {
      const f = saveFor(h, label);
      f.control.value = value;
      click(f.save);
      await flush();
    };
    await set("Release", "R3");
    await set("Lane", "lane-b");
    await set("Put up for reconsideration — why?", "needs a rethink");
    await set(
      "Files this task touches (one pattern per line, like apps/api/**)",
      "apps/web/**\napps/api/**",
    );
    expect(said(h)).toEqual([
      "F-2 moved to release R3.",
      "F-2 now belongs to lane-b.",
      "F-2 was put up for reconsideration.",
      "The list of files for F-2 was updated.",
    ]);
    expect(h.posts()[3]).toMatchObject({
      type: "task.areas",
      areas: ["apps/web/**", "apps/api/**"],
    });
  });
  it("a blank choice reads None, or Choose… where a value is required, and refuses to save", async () => {
    const h = boot();
    openDrawer(h, "F-3");
    const next = saveFor(h, "Make this the next task for lane");
    expect(optionsOf(next.control)[0]).toEqual(["Choose…", ""]);
    expect(optionsOf(saveFor(h, "Lane").control)[0]).toEqual(["None", ""]);
    click(next.save);
    await flush();
    expect(next.field.querySelector(".err")?.textContent).toBe("Not saved: choose a value first");
    expect(h.posts()).toEqual([]); // nothing was sent
  });
  it("lane choices use the name on the lane's card but post the lane id", async () => {
    const h = boot();
    h.route("/api/event", () => resp(200, { seq: 9 }));
    (h.d.querySelector('.lane[data-lane="lane-u"] .lane-h strong') as HTMLElement).textContent =
      "Lane U";
    openDrawer(h, "F-1");
    expect(h.d.querySelector(".info")?.textContent).toContain("Lane: Lane U");
    const { control, save } = saveFor(h, "Make this the next task for lane");
    expect(optionsOf(control)).toContainEqual(["Lane U", "lane-u"]);
    control.value = "lane-u";
    click(save);
    await flush();
    expect(h.posts()[0]).toMatchObject({ type: "task.next", task: "F-1", targetLane: "lane-u" });
    expect(said(h)).toEqual(["F-1 is now the next task for Lane U."]);
  });
  it("with no lane cards on the page the drawer still works and shows the lane ids", () => {
    const h = boot();
    put(h, "lanes", ""); // e.g. the lane board is still loading
    const d = openDrawer(h, "F-1");
    expect(d.querySelector(".info")?.textContent).toContain("Lane: lane-u");
    const lanes = optionsOf(saveFor(h, "Lane").control).map(([text]) => text);
    expect(lanes).toEqual(["None", "lane-b", "lane-idle", "lane-u"]);
  });
  it("shows task data as text, never as markup", () => {
    const h = boot();
    const b = h.d.querySelector('.tid[data-task="F-1"]') as HTMLElement;
    b.setAttribute("data-title", '<img src=x onerror="window.pwned=1">');
    b.setAttribute("data-alt", "<b>bold</b>");
    b.setAttribute("data-release", "<i>R1</i>");
    const d = openDrawer(h, "F-1");
    expect(d.querySelector("img, b, i")).toBeNull();
    expect(d.querySelector("#drawer-title")?.textContent).toContain("<img src=x");
    expect(d.querySelector(".hint")?.textContent).toContain("<b>bold</b>");
  });
});

describe("the replaced-PR dialog", () => {
  it("asks in plain words and posts the PR numbers", async () => {
    const h = boot();
    h.route("/api/event", () => resp(200, { seq: 5 }));
    put(
      h,
      "waste",
      '<button type="button" class="btn" data-act="superseded" data-pr="12">Mark as replaced</button>',
    );
    click(h.d.querySelector('button[data-act="superseded"]') as Element);
    expect(h.d.getElementById("drawer-title")?.textContent).toBe("PR #12 was replaced");
    expect(h.d.querySelector("#drawer .info")?.textContent).toBe(
      "Which pull request replaces it? (number)",
    );
    const { control, save } = saveFor(h, "Replacing pull request number");
    control.value = "34";
    click(save);
    await flush();
    expect(h.posts()[0]).toMatchObject({ type: "pr.superseded", pr: 12, supersededBy: 34 });
    expect(said(h)).toEqual(["PR #12 marked as replaced by PR #34."]);
  });
});

describe("dismissing a warning names it from its own row", () => {
  const row = (head: string) =>
    `<ul><li class="waste" data-key="W5:12">${head}<p>why</p><span class="acts"><button type="button" class="btn" data-act="ack" data-key="W5:12">Dismiss</button></span></li></ul>`;
  it("uses the row's heading with its glyph dropped", async () => {
    const h = boot();
    h.route("/api/event", () => resp(200, { seq: 10 }));
    put(
      h,
      "waste",
      row(
        '<p class="w-head"><span class="glyph" aria-hidden="true">⚠</span> <strong>PR #12</strong> — Closed but the work never landed</p>',
      ),
    );
    click(ack(h));
    await flush();
    expect(said(h)).toEqual(["Dismissed: PR #12 — Closed but the work never landed"]);
    click(h.d.querySelector("#toasts .toast button") as Element);
    await flush();
    expect(h.posts()[1]).toMatchObject({ type: "waste.ack", key: "W5:12" }); // the key still travels
  });
  it("falls back to the row's first <strong>, then to a generic sentence", async () => {
    const h = boot();
    h.route("/api/event", () => resp(200, { seq: 11 }));
    put(h, "waste", row("<strong>branch fix/B1</strong> — idle"));
    click(ack(h));
    await flush();
    put(h, "waste", row(""));
    click(ack(h));
    await flush();
    expect(said(h)).toEqual(["Dismissed: branch fix/B1", "Warning dismissed."]);
  });
  it("never puts the internal key in the toast", async () => {
    const h = boot();
    h.route("/api/event", () => resp(200, { seq: 12 }));
    put(h, "waste", row(""));
    click(ack(h));
    await flush();
    expect(said(h).join(" ")).not.toContain("W5:12");
  });
});

describe("failure copy", () => {
  const refuse = async (reply: () => unknown) => {
    const h = boot();
    h.route("/api/event", reply);
    const b = ack(h);
    click(b);
    await flush();
    return { h, inline: b.parentNode?.querySelector(".err")?.textContent };
  };
  const errToast = (h: Harness) => h.d.querySelector("#toasts .toast.error > span")?.textContent;
  it.each([
    [429, {}, "Not saved: too many changes in a short time. Wait a minute and try again."],
    [500, {}, "Not saved: the server refused the change (error 500)."],
    [403, {}, "Not saved: the server refused the change (error 403)."],
    [422, {}, "Not saved: the server refused the change (error 422)."],
    [
      422,
      { error: "invalid", reason: "priority must be one of P0, P1, P2, P3" },
      "Not saved: priority must be one of P0, P1, P2, P3",
    ],
  ])("HTTP %i is explained as %p", async (status, body, copy) => {
    const { h, inline } = await refuse(() => resp(status, body));
    expect(errToast(h)).toBe(copy);
    expect(inline).toBe(copy); // and inline, beside the control
  });
  it("a network failure says nothing was changed", async () => {
    const { h } = await refuse(() => Promise.reject(new Error("offline")));
    expect(errToast(h)).toBe("Not saved: the server could not be reached, so nothing was changed.");
  });
});

describe("theme toast", () => {
  it("names the colour theme in words as the button cycles through it", () => {
    const h = boot();
    const theme = () => click(h.d.querySelector('button[data-act="theme"]') as Element);
    theme();
    theme();
    theme();
    expect(said(h)).toEqual([
      "Colour theme: dark",
      "Colour theme: light",
      "Colour theme: follows your system",
    ]);
  });
});

describe("what the client reads from the page (contract with the renderer)", () => {
  it("each lane card shows its name in .lane-h strong", () => {
    const h = boot();
    const cards = [...h.d.querySelectorAll(".lane[data-lane]")];
    expect(cards.length).toBeGreaterThan(0);
    for (const c of cards) expect(c.querySelector(".lane-h strong")?.textContent).toMatch(/\S/);
  });
  it("each waste row names itself in .w-head (or its first <strong>) and holds its ack button", () => {
    const h = boot();
    const rows = [...h.d.querySelectorAll('[data-panel="waste"] .waste')];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.querySelector(".w-head, strong")?.textContent).toMatch(/\S/);
      expect(r.querySelector('button[data-act="ack"]')).not.toBeNull();
    }
  });
});

describe("client.js stays small and never templates markup from data", () => {
  it("is at most 500 lines and assigns innerHTML only for the two server-rendered swaps", () => {
    expect(CLIENT.split("\n").length).toBeLessThanOrEqual(500);
    const sinks = CLIENT.split("\n").filter((l) => /\.innerHTML\s*[+|]*=(?!=)/.test(l));
    expect(sinks).toHaveLength(2); // the fragment swap and the header-lines/banners swap
    expect(CLIENT).not.toMatch(/insertAdjacentHTML|outerHTML\s*=|document\.write|\beval\(/);
  });
});
