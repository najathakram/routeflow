/* RouteFlow Control client: vanilla, no build. The server renders every panel; this file swaps those
 * fragments, posts confirmed write-back events, and drives drawer/toasts/theme/keys. Data text is set
 * via textContent only; fragments are escaped server-side and never built from data here. */
(() => {
  "use strict";
  var doc = document;
  var $ = (s, r) => (r || doc).querySelector(s);
  var $$ = (s, r) => Array.prototype.slice.call((r || doc).querySelectorAll(s));
  var meta = (n) => {
    var m = $('meta[name="' + n + '"]');
    return (m && m.getAttribute("content")) || "";
  };
  var version = meta("control-version");
  var csrf = meta("csrf-token");
  var etag = null;
  var live = true;
  var pollTimer = null;
  var refreshing = null;
  var lastAnnounce = 0;
  var dismissed = {};
  var lastFocus = null;
  var drawerTask = null;
  var PRIO = ["P0", "P1", "P2", "P3"];

  var el = (tag, cls, text) =>
    Object.assign(doc.createElement(tag), { className: cls || "", textContent: text || "" });
  var btn = (label, fn) =>
    Object.assign(el("button", "btn", label), { type: "button", onclick: fn });
  var store = (k, v) => {
    try {
      var ls = window.localStorage; // may throw when storage is blocked
      return v === undefined ? ls.getItem(k) : v === null ? ls.removeItem(k) : ls.setItem(k, v);
    } catch (e) {
      return null;
    }
  };
  /* ---------------------------------------------------------------- toasts + announcements */
  function toast(msg, o) {
    o = o || {};
    var box = $("#toasts");
    box.setAttribute("aria-live", "polite");
    var t = el("div", "toast" + (o.error ? " error" : ""));
    var timer = null;
    var close = () => {
      clearTimeout(timer);
      if (t.parentNode) t.parentNode.removeChild(t);
    };
    t.appendChild(el("span", "", msg));
    if (o.undo)
      t.appendChild(
        btn("Undo", () => {
          close();
          o.undo();
        }),
      );
    if (o.sticky) t.appendChild(btn("Dismiss", close));
    else timer = setTimeout(close, 10000);
    box.appendChild(t);
  }
  function announce() {
    var sr = $("#sr");
    if (!sr || Date.now() - lastAnnounce < 30000) return;
    lastAnnounce = Date.now();
    sr.textContent = "State updated";
  }
  /* ---------------------------------------------------------------- refresh from the server */
  function applyFragments(frags) {
    $$("[data-panel]").forEach((sec) => {
      var html = frags[sec.getAttribute("data-panel")];
      if (typeof html !== "string") return;
      var open = {};
      $$("details[data-fold]", sec).forEach((d) => {
        open[d.getAttribute("data-fold")] = d.open;
      });
      var sig = (n) => n.cloneNode(false).outerHTML;
      var a = doc.activeElement;
      var had = a && sec.contains(a) && sig(a);
      sec.innerHTML = html; // server-rendered, escaped fragment
      $$("details[data-fold]", sec).forEach((d) => {
        var k = d.getAttribute("data-fold");
        if (k in open) d.open = open[k];
      });
      var again = had && $$("button", sec).find((b) => sig(b) === had);
      if (again) again.focus();
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
      if (dismissed[b.textContent]) b.parentNode.removeChild(b);
    });
  }
  function setLive(on) {
    var chip = $("#live");
    live = on;
    if (!chip) return;
    chip.setAttribute("data-live", on ? "on" : "off");
    chip.textContent = on ? "live ●" : "live ◌ reconnecting";
  }
  async function pull() {
    var r = await fetch("/api/state.json", {
      credentials: "same-origin",
      headers: etag ? { "If-None-Match": etag } : {},
    });
    if (r.status === 401) return location.assign("/login");
    if (r.status === 304 || !r.ok) return r.status === 304;
    etag = r.headers.get("ETag");
    var j = await r.json();
    applyFragments(j.fragments || {});
    version = j.version || (j.state && j.state.version) || version;
    if ($('meta[name="control-version"]'))
      $('meta[name="control-version"]').setAttribute("content", version);
    setLive(live);
    await swapChrome();
    announce();
    var open = drawerTask && $('.tid[data-task="' + drawerTask + '"]');
    if (open && !$("#drawer").hidden) renderDrawer(open); // fresh values, drawer stays open
    return true;
  }
  function refresh() {
    refreshing =
      refreshing ||
      pull()
        .catch(() => false)
        .finally(() => {
          refreshing = null;
        });
    return refreshing;
  }
  function startPoll() {
    if (!pollTimer) pollTimer = setInterval(refresh, 60000);
  }
  function connect() {
    var es = new EventSource("/api/stream");
    es.addEventListener("version", refresh);
    es.onopen = () => {
      setLive(true);
      clearInterval(pollTimer);
      pollTimer = null;
    };
    es.onerror = () => {
      setLive(false);
      startPoll(); // EventSource reconnects by itself; polling covers the gap
    };
  }
  /* ---------------------------------------------------------------- confirmed write-back */
  function busy(ctl, on) {
    if (!ctl) return;
    ctl.disabled = on;
    ctl.setAttribute("aria-busy", String(on));
    var s = $(".spin", ctl);
    if (on && !s) ctl.appendChild(el("span", "spin"));
    if (!on && s) ctl.removeChild(s);
  }
  function fail(ctl, msg) {
    if (ctl && ctl.parentNode) {
      if ($(".err", ctl.parentNode)) $(".err", ctl.parentNode).remove();
      var e = el("span", "err", msg);
      e.setAttribute("role", "alert");
      ctl.parentNode.insertBefore(e, ctl.nextSibling);
    }
    toast(msg, { error: true, sticky: true });
    return false;
  }
  /* No optimistic update: the page changes only when the server's new fragments arrive. */
  async function post(payload, ctl) {
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
      toast("State changed elsewhere — reloaded", { error: true });
      etag = null;
      await refresh();
      return false;
    }
    if (!r.ok) {
      var why =
        r.status === 429
          ? "rate limited (429)"
          : r.status
            ? "server refused it (" + r.status + ")"
            : "network error, nothing changed";
      return fail(ctl, "Not saved: " + why);
    }
    busy(ctl, true);
    etag = null;
    await refresh();
    busy(ctl, false);
    return true;
  }
  /* write, then confirm with a toast carrying Undo = the compensating event */
  async function write(payload, ctl, msg, inverse) {
    if (!(await post(payload, ctl))) return false;
    toast(msg, {
      undo: inverse
        ? async () => {
            if (await post(inverse, null)) toast("Undone: " + msg);
          }
        : null,
    });
    return true;
  }
  /* ---------------------------------------------------------------- drawer */
  function focusables(root) {
    return $$("button, select, textarea, input, a[href]", root).filter((n) => !n.disabled);
  }
  var lines = (n) => (n.match(/\S[^\n]*/g) || []).map((x) => x.trim());
  /* one declarative field list feeds every drawer form; the inverse event swaps new and old */
  function build(f, n, o) {
    var p = { type: f.type };
    p[f.id || "task"] = f.ref;
    p[f.key] = f.area ? lines(n) : f.num ? Number(n) : n || null;
    if (f.prev) p.prev = o || null;
    return p;
  }
  function control(f) {
    var c = f.vals ? el("select") : f.area ? el("textarea") : el("input");
    if (!f.vals && !f.area) c.type = f.num ? "number" : "text";
    (f.vals ? (f.blank ? [""] : []).concat(f.vals) : []).forEach((v) => {
      var o = el("option", "", v || "(none)");
      o.value = v;
      c.appendChild(o);
    });
    c.value = f.old || "";
    return c;
  }
  function showDrawer(title, info, fields) {
    var body = $("#drawer-body");
    body.textContent = "";
    $("#drawer-title").textContent = title;
    body.appendChild(el("p", "mut", info));
    fields.forEach((f, i) => {
      var box = el("div", "fld");
      var c = control(f);
      var label = el("label", "", f.l);
      c.id = "f-" + i;
      label.setAttribute("for", c.id);
      [label, c].forEach((n) => {
        box.appendChild(n);
      });
      box.appendChild(
        btn("Save", (ev) => {
          var n = c.value.trim();
          var b = ev.currentTarget;
          if (n === (f.old || "").trim() && f.old !== undefined) return;
          if (!n && f.noundo) return fail(b, "Not saved: choose a value first");
          var msg =
            f.ref + " " + f.l.toLowerCase() + ": " + (f.noundo ? n : (f.old || "none") + " → " + n);
          write(build(f, n, f.old), b, msg, f.noundo ? null : build(f, f.old || "", n));
        }),
      );
      body.appendChild(box);
    });
    $("#scrim").hidden = false;
    $("#drawer").hidden = false;
  }
  var fld = (l, type, key, ref, more) => Object.assign({ l, type, key, ref }, more);
  function renderDrawer(b) {
    var d = b.dataset;
    var list = (k) => ($("#drawer").getAttribute(k) || "").split(",").filter(Boolean);
    var f = (l, type, key, more) => fld(l, type, key, d.task, more);
    var lanes = list("data-lanes");
    var rels = list("data-releases");
    showDrawer(d.task, "Status " + d.status + " · " + d.title + (d.pr ? " · PR #" + d.pr : ""), [
      f("Priority", "task.priority", "priority", { prev: 1, old: d.priority, vals: PRIO }),
      f("Release", "task.release", "release", { prev: 1, old: d.release, vals: rels, blank: 1 }),
      f("Lane", "task.lane", "toLane", { old: d.lane, vals: lanes, blank: 1 }),
      f("Set as next for lane", "task.next", "targetLane", { noundo: 1, vals: lanes, blank: 1 }),
      f("Reconsider (why)", "task.reconsider", "why", { noundo: 1 }),
      f("Areas (one glob per line)", "task.areas", "areas", { old: d.areas, area: 1 }),
    ]);
  }
  function openDrawer(b) {
    lastFocus = b;
    drawerTask = b.getAttribute("data-task");
    renderDrawer(b);
    focusables($("#drawer"))[1].focus();
  }
  function closeDrawer() {
    $("#drawer").hidden = true;
    $("#scrim").hidden = true;
    var back =
      lastFocus && doc.contains(lastFocus) ? lastFocus : $('.tid[data-task="' + drawerTask + '"]');
    drawerTask = null;
    if (back) back.focus();
  }
  function openSuperseded(b) {
    var pr = Number(b.getAttribute("data-pr"));
    lastFocus = b;
    drawerTask = null;
    showDrawer("PR #" + pr + " superseded", "Name the PR that replaces it.", [
      fld("Superseding PR number", "pr.superseded", "supersededBy", pr, {
        id: "pr",
        num: 1,
        noundo: 1,
      }),
    ]);
    focusables($("#drawer"))[1].focus();
  }
  /* ---------------------------------------------------------------- theme, folds, events */
  function applyTheme(t) {
    if (t === "light" || t === "dark") doc.documentElement.setAttribute("data-theme", t);
    else doc.documentElement.removeAttribute("data-theme");
  }
  function act(t) {
    var [a, task, lane, key] = ["act", "task", "lane", "key"].map((k) =>
      t.getAttribute("data-" + k),
    );
    var ev = (type, more) => ({ type, task, ...more });
    if (a === "ack") {
      var now = new Date().toISOString();
      write({ type: "waste.ack", key }, t, "Acknowledged " + key, {
        type: "waste.ack",
        key,
        until: now,
      });
    } else if (a === "next" && !lane) openDrawer($('.tid[data-task="' + task + '"]') || t);
    else if (a === "next") {
      var back = { targetLane: lane, task: t.getAttribute("data-prev") || null };
      write(
        ev("task.next", { targetLane: lane }),
        t,
        task + " is next for " + lane,
        ev("task.next", back),
      );
    } else if (a === "assign")
      write(
        ev("task.lane", { toLane: lane }),
        t,
        task + " assigned to " + lane,
        ev("task.lane", { toLane: null }),
      );
    else if (a === "superseded") openSuperseded(t);
    else if (a === "close-drawer") closeDrawer();
    else if (a === "legend") $("#legend").showModal();
    else if (a === "close-legend") $("#legend").close();
    else if (a === "theme") {
      var cur = doc.documentElement.getAttribute("data-theme");
      var next = cur === "dark" ? "light" : cur === "light" ? null : "dark";
      applyTheme(next);
      store("control-theme", next);
      toast("Theme: " + (next || "follow system"));
    } else if (a === "dismiss") {
      var b = t.closest("[data-banner]");
      dismissed[b.textContent] = true;
      b.parentNode.removeChild(b);
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
    } else if (e.key === "?") $("#legend").showModal();
  });

  applyTheme(store("control-theme"));
  if (window.matchMedia && window.matchMedia("(max-width: 480px)").matches)
    $$("details.fold[data-fold]:not(.sub)").forEach((d) => {
      d.open = false; // tier 3 collapses on phones
    });
  connect();
})();
