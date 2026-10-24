/* RouteFlow Control client: vanilla, no build. Swaps server-rendered fragments, posts confirmed
 * write-back events, drives drawer/toasts/theme/keys. Data text goes through textContent only.
 * Deferred: timeline-row undo and drawer event history (timeline entries carry no payload). */
(() => {
  "use strict";
  var doc = document;
  var $ = (s, r) => (r || doc).querySelector(s);
  var $$ = (s, r) => Array.prototype.slice.call((r || doc).querySelectorAll(s));
  var attr = (n, k) => n.getAttribute("data-" + k);
  var meta = (n) => {
    var m = $('meta[name="' + n + '"]');
    return (m && m.getAttribute("content")) || "";
  };
  var version = meta("control-version");
  var csrf = meta("csrf-token");
  var writeback = meta("control-writeback") !== "off"; // the server's switch (CONTROL_WRITEBACK)
  var VIEW_ONLY = "View only: changes are switched off on this dashboard";
  var viewOnly = () => toast(VIEW_ONLY + ".", { error: true }) || false; // a refusal, not a retry
  var live = true;
  var etag = null; // of the last /api/state.json, for If-None-Match
  var pollTimer = null;
  var pulling = null; // the in-flight refresh promise
  var again = false; // a refresh was requested while one was in flight
  var lastAnnounce = 0;
  var lastFocus = null; // what to refocus when the drawer closes
  var drawerTask = null;
  var backoff = 1000;
  var dismissed = {};
  var PRIO = ["P0", "P1", "P2", "P3"]; // the posted values; the words below are display only
  var PRIO_WORD = { P0: "Urgent", P1: "High", P2: "Normal", P3: "Low" };
  var word = (m, k, d) => (Object.hasOwn(m, k) ? m[k] : d); // own keys only: "constructor" falls back
  /* "in-progress" reads "In progress"; only the two names that differ from that are listed */
  var STATUS_WORD = { "code-complete": "Code finished", reconsider: "Being reconsidered" };
  var statusWord = (s) => {
    var plain = (s || "unknown").replace(/-/g, " ");
    return word(STATUS_WORD, s, plain.charAt(0).toUpperCase() + plain.slice(1));
  };
  var SUP = { id: "pr", num: 1, req: 1 };
  var el = (tag, cls, text) =>
    Object.assign(doc.createElement(tag), { className: cls || "", textContent: text || "" });
  var btn = (label, fn) =>
    Object.assign(el("button", "btn", label), { type: "button", onclick: fn });
  var store = (k, v) => {
    try {
      var ls = window.localStorage; // may throw when storage is blocked
      if (v === undefined) return ls.getItem(k);
      if (v === null) ls.removeItem(k);
      else ls.setItem(k, v);
    } catch (e) {
      return null;
    }
  };
  /* ---------------------------------------------------------------- toasts + announcements */
  function toast(msg, o) {
    o = o || {};
    var t = el("div", "toast" + (o.error ? " error" : ""));
    var timer = null;
    var close = () => {
      clearTimeout(timer);
      t.remove();
    };
    var arm = () => {
      clearTimeout(timer);
      if (!o.sticky) timer = setTimeout(close, 20000); // long enough to read and reach Undo
    };
    var undo = o.undo
      ? btn("Undo", () => {
          close();
          o.undo();
        })
      : null;
    $("#toasts").setAttribute("aria-live", "polite");
    t.append(el("span", "", msg));
    if (undo) t.append(undo);
    if (o.sticky) t.append(btn("Dismiss", close));
    ["mouseover", "focusin"].forEach((e) => t.addEventListener(e, () => clearTimeout(timer)));
    ["mouseout", "focusout"].forEach((e) => t.addEventListener(e, arm));
    arm();
    $("#toasts").append(t);
    if (undo) undo.focus();
  }
  /* ---------------------------------------------------------------- refresh from the server */
  var sig = (n) => ["act", "task", "key", "lane"].map((k) => attr(n, k)).join("|");
  function applyFragments(frags) {
    $$("[data-panel]").forEach((sec) => {
      var html = frags[attr(sec, "panel")];
      if (typeof html !== "string") return;
      var open = {};
      $$("details[data-fold]", sec).forEach((d) => {
        open[attr(d, "fold")] = d.open;
      });
      var a = doc.activeElement;
      var had = a && sec.contains(a) && (a.hasAttribute("data-act") || attr(a, "task")) && sig(a);
      sec.innerHTML = html; // server-rendered, escaped fragment
      $$("details[data-fold]", sec).forEach((d) => {
        if (attr(d, "fold") in open) d.open = open[attr(d, "fold")];
      });
      var back = had && $$("[data-act], .tid", sec).find((b) => sig(b) === had);
      if (back) back.focus();
    });
  }
  /* header lines + banners are not panels: take them from the freshly rendered page */
  async function swapChrome() {
    var r = await fetch("/", { credentials: "same-origin", headers: { Accept: "text/html" } });
    if (r.status === 401) return location.assign("/login");
    if (!r.ok) return;
    var next = new DOMParser().parseFromString(await r.text(), "text/html");
    [".lines", "#banners"].forEach((s) => {
      if ($(s, next) && $(s)) $(s).innerHTML = $(s, next).innerHTML;
    });
    $$("#banners [data-banner]").forEach((b) => {
      if (dismissed[b.textContent]) b.remove();
    });
  }
  function setLive(on) {
    var chip = $("#live");
    live = on;
    if (!chip) return;
    chip.setAttribute("data-live", on ? "on" : "off");
    chip.textContent = on ? "Live — updates automatically" : "Reconnecting…";
  }
  /* rebuild the open drawer from fresh values, unless the owner is mid-edit in it */
  function syncDrawer() {
    var src = drawerTask && $('.tid[data-task="' + drawerTask + '"]');
    if (
      $("#drawer").hidden ||
      !src ||
      $$("#drawer-body [id^=f-]").some((c) => c.value !== c.dataset.init)
    )
      return;
    var focused = $("#drawer").contains(doc.activeElement) ? doc.activeElement.id : "";
    renderDrawer(src);
    if (focused && $("#" + focused)) $("#" + focused).focus();
  }
  async function pull() {
    var r = await fetch("/api/state.json", {
      credentials: "same-origin",
      headers: etag ? { "If-None-Match": etag } : {},
    });
    if (r.status === 401) return location.assign("/login");
    if (r.status === 304 || !r.ok) return;
    etag = r.headers.get("ETag");
    var j = await r.json();
    applyFragments(j.fragments || {});
    version = j.version || (j.state && j.state.version) || version;
    if ($('meta[name="control-version"]'))
      $('meta[name="control-version"]').setAttribute("content", version);
    setLive(live);
    await swapChrome();
    if ($("#sr") && Date.now() - lastAnnounce > 30000) {
      $("#sr").textContent = "State updated"; // at most one announcement per 30 s
      lastAnnounce = Date.now();
    }
    syncDrawer();
  }
  /* one pull at a time; a request made mid-pull runs one more pull before everyone resumes, so a
   * write that awaits refresh() never carries a stale expectedVersion (no false 409) */
  function refresh() {
    if (pulling) {
      again = true;
      return pulling;
    }
    pulling = (async () => {
      do {
        again = false;
        try {
          await pull();
        } catch (e) {
          /* network blip: the next event or poll retries */
        }
      } while (again);
    })().finally(() => {
      pulling = null;
    });
    return pulling;
  }
  function connect() {
    var es = new EventSource("/api/stream");
    es.addEventListener("version", refresh);
    es.onopen = () => {
      backoff = 1000;
      setLive(true);
      clearInterval(pollTimer);
      pollTimer = null;
      refresh(); // anything missed while the stream was down
    };
    es.onerror = () => {
      setLive(false);
      pollTimer = pollTimer || setInterval(refresh, 60000); // polling covers the gap
      if (es.readyState === 2) {
        setTimeout(connect, backoff); // closed for good: the browser will not retry, so we do
        backoff = Math.min(backoff * 2, 30000);
      }
    };
  }
  /* ---------------------------------------------------------------- confirmed write-back */
  function busy(ctl, on) {
    if (!ctl) return;
    ctl.disabled = on;
    ctl.classList.toggle("busy", on); // CSS draws the spinner
    ctl.setAttribute("aria-busy", String(on));
  }
  function fail(ctl, msg) {
    if (ctl && ctl.parentNode) {
      $$(".err", ctl.parentNode).forEach((e) => e.remove());
      var e = el("span", "err", msg);
      e.setAttribute("role", "alert");
      ctl.after(e);
    }
    toast(msg, { error: true, sticky: true });
    return false;
  }
  /* the plain-words reason a write was refused; for a 422 it is the server's own reason */
  async function why(r) {
    if (r.status === 429) return "too many changes in a short time. Wait a minute and try again.";
    if (!r.status) return "the server could not be reached, so nothing was changed.";
    var j = r.status === 422 ? await r.json().catch(() => null) : null;
    var s = j && typeof j.reason === "string" ? j.reason : "";
    return s || "the server refused the change (error " + r.status + ").";
  }
  /* No optimistic update: the page changes only when the server's new fragments arrive. */
  async function post(payload, ctl) {
    if (!writeback) return viewOnly(); // off: never reaches the network
    busy(ctl, true);
    var r;
    try {
      r = await fetch("/api/event", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-Control-Token": csrf },
        body: JSON.stringify(Object.assign({}, payload, { expectedVersion: version })),
      });
    } catch (e) {
      r = { status: 0, ok: false };
    }
    if (r.status === 401) return location.assign("/login");
    busy(ctl, false);
    if (r.status === 409) {
      toast("Someone changed this at the same time, so the page was refreshed. Please try again.", {
        error: true,
      });
      etag = null;
      await refresh();
      return "conflict";
    }
    var off = r.status === 403 && (await r.json().catch(() => null));
    if (off && off.error === "writeback_off") return viewOnly();
    if (!r.ok) return fail(ctl, "Not saved: " + (await why(r)));
    busy(ctl, true);
    etag = null;
    await refresh();
    busy(ctl, false);
    return true;
  }
  /* write, then confirm with a toast carrying Undo = the compensating event.
   * Resolves true (saved), "conflict" (409, state reloaded) or false (not saved). */
  async function write(payload, ctl, msg, inverse) {
    var res = await post(payload, ctl);
    if (res !== true) return res;
    var undo = null;
    if (inverse)
      undo = async () => {
        if (await post(inverse, null)) toast("Undone: " + msg);
      };
    toast(msg, { undo: undo });
    return true;
  }
  /* ---------------------------------------------------------------- drawer */
  var focusables = (root) =>
    $$("button, select, textarea, input, a[href]", root).filter((n) => !n.disabled);
  var lines = (n) => (n.match(/\S[^\n]*/g) || []).map((x) => x.trim());
  var setInert = (on) =>
    $$("header, nav, main, footer, #banners").forEach((n) => n.toggleAttribute("inert", on));
  /* a lane's name as its card shows it; the id when no card is on the page */
  var laneName = (id) => {
    var card = $$(".lane[data-lane]").find((a) => attr(a, "lane") === id);
    var n = card && $(".lane-h strong", card);
    return n ? n.textContent : id;
  };
  /* what a waste row calls itself, e.g. "PR #308 — Draft left unfinished": read from the row's
   * heading (else its first <strong>), never parsed from the key; the glyph is dropped */
  var rowLabel = (row) => {
    var n = row && ($(".w-head", row) || $("strong", row));
    return n ? n.textContent.replace(/^\W+/, "").replace(/\s+/g, " ").trim() : "";
  };
  /* the success sentence for each kind of write: (task or PR, new value) */
  var SAY = {
    "task.priority": (t, n) => "Priority of " + t + " changed to " + word(PRIO_WORD, n, n) + ".",
    "task.release": (t, n) =>
      n ? t + " moved to release " + n + "." : t + " removed from its release.",
    "task.lane": (t, n) =>
      n ? t + " now belongs to " + laneName(n) + "." : t + " is no longer assigned to a lane.",
    "task.next": (t, n) => t + " is now the next task for " + laneName(n) + ".",
    "task.reconsider": (t) => t + " was put up for reconsideration.",
    "task.areas": (t) => "The list of files for " + t + " was updated.",
    "pr.superseded": (t, n) => "PR #" + t + " marked as replaced by PR #" + n + ".",
  };
  /* one declarative field list feeds every drawer form; the inverse event swaps new and old.
   * A task with no priority posts no prev: the schema requires one, so the server says so inline. */
  function build(f, n, o) {
    var p = { type: f.type };
    p[f.id || "task"] = f.ref;
    p[f.key] = f.area ? lines(n) : f.num ? Number(n) : n || null;
    if (f.prev && (o || f.key !== "priority")) p.prev = o || null;
    return p;
  }
  function control(f) {
    var c = f.vals ? el("select") : f.area ? el("textarea") : el("input");
    if (!f.vals && !f.area) c.type = f.num ? "number" : "text";
    (f.blank ? [""] : []).concat(f.vals || []).forEach((v) => {
      var o = el("option", "", v ? (f.word ? f.word(v) : v) : f.req ? "Choose…" : "None");
      o.value = v; // what is posted: the raw id, never the display word
      c.append(o);
    });
    c.value = c.dataset.init = f.old || "";
    return c;
  }
  var lockSaves = (body) =>
    $$(".fld button", body).forEach((b) =>
      Object.assign(b, { disabled: true, title: VIEW_ONLY }).setAttribute("aria-disabled", "true"),
    );
  function showDrawer(title, info, fields, note) {
    var body = $("#drawer-body");
    body.textContent = "";
    $("#drawer-title").textContent = title;
    body.append(el("p", "info", info));
    if (note) body.append(el("p", "hint", note));
    fields.forEach((f, i) => {
      var box = el("div", "fld");
      var c = control(f);
      var label = el("label", "", f.l);
      c.id = "f-" + i;
      label.setAttribute("for", c.id);
      box.append(label, c);
      box.append(
        btn("Save", async (ev) => {
          var n = c.value.trim();
          var b = ev.currentTarget;
          if (n === (f.old || "").trim() && f.old !== undefined) return;
          if (!n && f.req) return fail(b, "Not saved: choose a value first");
          var inv = f.inv ? f.inv(n) : f.req ? null : build(f, f.old || "", n);
          if (f.key === "priority" && !f.old) inv = null; // nothing valid to restore
          var res = await write(build(f, n, f.old), b, SAY[f.type](f.ref, n), inv);
          if (res === true) return;
          c.value = f.old || ""; // not saved: show the stored value again
          if (res === "conflict")
            syncDrawer(); // fresh state: rebuild the form
          else b.focus(); // plain failure: keep the form and its inline error, focus stays here
        }),
      );
      body.append(box);
    });
    if (!writeback) lockSaves(body);
    setInert(true);
    $("#scrim").hidden = false;
    $("#drawer").hidden = false;
  }
  var fld = (l, type, key, ref, more) => Object.assign({ l, type, key, ref }, more);
  function renderDrawer(b) {
    var d = b.dataset;
    var list = (k) => (attr($("#drawer"), k) || "").split(",").filter(Boolean);
    var nexts = {};
    list("nexts").forEach((p) => (nexts[p.split(":")[0]] = p.split(":")[1] || null));
    var f = (l, type, key, more) => fld(l, type, key, d.task, more);
    var lanes = list("lanes");
    var rels = list("releases");
    var info = [
      "Status: " + statusWord(d.status),
      "Priority: " + word(PRIO_WORD, d.priority, "None"),
      "Release: " + (d.release || "None"),
      "Lane: " + (d.lane ? laneName(d.lane) : "Not assigned"),
    ];
    if (d.pr) info.push("Pull request: #" + d.pr);
    var inv = (n) => ({ type: "task.next", task: nexts[n] || null, targetLane: n });
    var opt = (p) => word(PRIO_WORD, p, p) + " (" + p + ")"; // "Urgent (P0)": the value posted is P0
    var next = "Make this the next task for lane";
    var files = "Files this task touches (one pattern per line, like apps/api/**)";
    showDrawer(
      d.task + " — " + d.title,
      info.join(" · "),
      [
        f("Priority", "task.priority", "priority", {
          prev: 1,
          old: d.priority,
          vals: PRIO,
          word: opt,
        }),
        f("Release", "task.release", "release", { prev: 1, old: d.release, vals: rels, blank: 1 }),
        f("Lane", "task.lane", "toLane", { old: d.lane, vals: lanes, blank: 1, word: laneName }),
        f(next, "task.next", "targetLane", { req: 1, vals: lanes, blank: 1, word: laneName, inv }),
        f("Put up for reconsideration — why?", "task.reconsider", "why", { req: 1 }),
        f(files, "task.areas", "areas", { old: d.areas, area: 1 }),
      ],
      d.alt && "Where these values came from: " + d.alt,
    );
  }
  function openDrawer(b) {
    lastFocus = b;
    drawerTask = attr(b, "task");
    renderDrawer(b);
    focusables($("#drawer"))[1].focus();
  }
  function closeDrawer() {
    $("#drawer").hidden = true;
    $("#scrim").hidden = true;
    setInert(false);
    var back =
      lastFocus && doc.contains(lastFocus) ? lastFocus : $('.tid[data-task="' + drawerTask + '"]');
    drawerTask = null;
    if (back) back.focus();
  }
  function openSuperseded(b) {
    var pr = Number(attr(b, "pr"));
    lastFocus = b;
    drawerTask = null;
    showDrawer("PR #" + pr + " was replaced", "Which pull request replaces it? (number)", [
      fld("Replacing pull request number", "pr.superseded", "supersededBy", pr, SUP),
    ]);
    focusables($("#drawer"))[1].focus();
  }
  /* ---------------------------------------------------------------- theme, folds, events */
  function applyTheme(t) {
    if (t === "light" || t === "dark") doc.documentElement.setAttribute("data-theme", t);
    else doc.documentElement.removeAttribute("data-theme");
  }
  function legend() {
    if ($("#legend").open) $("#legend").close();
    else $("#legend").showModal();
  }
  function act(t) {
    var a = attr(t, "act");
    var task = attr(t, "task");
    var lane = attr(t, "lane");
    var key = attr(t, "key");
    var ev = (type, more) => ({ type, task, ...more });
    if (a === "ack") {
      var until = new Date().toISOString().slice(0, 19) + "Z"; // schema dates carry no millis
      var what = rowLabel(t.parentNode.closest(".waste, li"));
      var said = what ? "Dismissed: " + what : "Warning dismissed.";
      write({ type: "waste.ack", key }, t, said, { type: "waste.ack", key, until });
    } else if (a === "next" && !lane) openDrawer($('.tid[data-task="' + task + '"]') || t);
    else if (a === "next") {
      var back = { targetLane: lane, task: attr(t, "prev") || null };
      var go = ev("task.next", { targetLane: lane });
      write(go, t, SAY["task.next"](task, lane), ev("task.next", back));
    } else if (a === "assign") {
      var was = { toLane: attr(t, "prev-lane") || null };
      var give = ev("task.lane", { toLane: lane });
      write(give, t, SAY["task.lane"](task, lane), ev("task.lane", was));
    } else if (a === "superseded") openSuperseded(t);
    else if (a === "close-drawer") closeDrawer();
    else if (a === "legend") legend();
    else if (a === "close-legend") $("#legend").close();
    else if (a === "theme") {
      var cur = doc.documentElement.getAttribute("data-theme");
      var next = cur === "dark" ? "light" : cur === "light" ? null : "dark";
      applyTheme(next);
      store("control-theme", next);
      toast("Colour theme: " + (next || "follows your system"));
    } else if (a === "dismiss") {
      var b = t.closest("[data-banner]");
      dismissed[b.textContent] = true;
      b.remove();
    }
  }
  doc.addEventListener("click", (e) => {
    var t = e.target.closest ? e.target.closest("[data-act], .tid[data-task]") : null;
    if (!t) return e.target.id === "scrim" ? closeDrawer() : undefined;
    if (t.hasAttribute("data-act")) act(t);
    else openDrawer(t);
  });
  doc.addEventListener("keydown", (e) => {
    var d = $("#drawer");
    var f = focusables(d);
    if (!d.hidden && e.key === "Escape") return closeDrawer();
    if (!d.hidden && e.key === "Tab" && f.length) {
      var edge = e.shiftKey ? f[0] : f[f.length - 1];
      if (!d.contains(doc.activeElement) || doc.activeElement === edge) {
        e.preventDefault();
        (e.shiftKey ? f[f.length - 1] : f[0]).focus();
      }
      return;
    }
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) || e.ctrlKey || e.metaKey) return;
    if (e.key === "/") {
      e.preventDefault();
      $(".jump details").open = true;
      $(".jump summary").focus();
    } else if (e.key === "?") legend();
  });

  applyTheme(store("control-theme"));
  if (window.matchMedia && window.matchMedia("(max-width: 480px)").matches)
    $$("details.fold[data-fold]:not(.sub)").forEach((d) => {
      d.open = false; // tier 3 collapses on phones
    });
  connect();
})();
