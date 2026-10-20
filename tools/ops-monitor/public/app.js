// RouteFlow ops monitor UI. Vanilla JS, no framework, no CDN. All data reaches the DOM through
// textContent / setAttribute only (never innerHTML), so snapshot strings cannot inject markup.
(() => {
  "use strict";

  // ---------- tiny helpers ----------
  const SEV_ORDER = ["critical", "high", "medium", "low"];
  const STATUS_BUCKETS = [
    ["To do", ["idea", "planned", "spec"]],
    ["Building", ["building"]],
    ["Review / ready", ["review", "ready", "shipping"]],
    ["Shipped", ["live", "verified"]],
  ];
  const DONE = new Set(["live", "verified", "parked", "dropped"]);
  const LAYERS = [
    ["api", "API"],
    ["web", "Web"],
    ["mobile", "Mobile"],
    ["pkg", "Pkg"],
    ["infra", "Infra"],
  ];
  const TREE_CAP = 300;
  const SILENT_MIN = 30;

  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === "class") n.className = v;
        else if (k === "text") n.textContent = v;
        else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
        else n.setAttribute(k, v === true ? "" : String(v));
      }
    }
    for (const kid of kids.flat()) {
      if (kid === null || kid === undefined || kid === false) continue;
      n.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return n;
  }
  const clear = (n) => {
    while (n.firstChild) n.removeChild(n.firstChild);
    return n;
  };
  const short = (sha) => (sha ? String(sha).slice(0, 7) : "?");
  const safeUrl = (u) => (typeof u === "string" && /^https:\/\//.test(u) ? u : null);
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

  // ---------- plain-language labels (business layer) ----------
  const STATUS_WORD = {
    idea: "Idea",
    planned: "Planned",
    spec: "Being specified",
    building: "Being built",
    review: "In review",
    ready: "Ready to ship",
    shipping: "Shipping",
    live: "Fixed",
    verified: "Fixed",
    parked: "Parked",
    dropped: "Dropped",
  };
  const PRIO_WORD = { P0: "Urgent", P1: "High", P2: "Normal", P3: "Low" };
  const statusWord = (s) => STATUS_WORD[s] ?? String(s ?? "");
  // The owner-facing word for an item: the server's label (Answered/Booked for decisions) wins.
  const itemStatus = (it) => it?.statusLabel ?? statusWord(it?.status);
  const prioWord = (p) => PRIO_WORD[p] ?? String(p ?? "");
  const MONTHS = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  // A real date arrives as etaAt (ISO); show it in the viewer's local zone, with a relative age.
  // Anything else is free text and is shown exactly as written.
  function etaWords(eta, etaAt) {
    const at = etaAt ? new Date(etaAt) : null;
    if (!at || Number.isNaN(at.getTime())) return eta ? String(eta) : null;
    const h = at.getHours();
    const part = h < 12 ? "morning" : h < 17 ? "afternoon" : "evening";
    const diff = at.getTime() - now();
    const rel = sinceWords(Math.abs(diff));
    const relText =
      rel === "moments ago" ? "now" : diff > 0 ? "in " + rel.replace(" ago", "") : rel;
    return `about ${MONTHS[at.getMonth()]} ${at.getDate()}, ${part} (${relText})`;
  }
  // "Oct 19, 14:05" in the viewer's local zone.
  function localStamp(iso) {
    const d = iso ? new Date(iso) : null;
    if (!d || Number.isNaN(d.getTime())) return iso ?? "";
    const p = (n) => String(n).padStart(2, "0");
    return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function sinceWords(ms) {
    if (ms === null || ms === undefined || Number.isNaN(ms)) return null;
    const m = Math.round(ms / 60000);
    if (m < 2) return "moments ago";
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 48) return `${h} h ago`;
    return `${Math.round(h / 24)} d ago`;
  }
  function firstSentence(t) {
    const s = String(t ?? "").trim();
    const m = /^(.+?[.!?])(\s|$)/.exec(s);
    return m ? m[1] : s;
  }
  const JARGON = /[:/_`]|\b[A-Z]{2,}\b|[a-z][A-Z]|\d/;
  // "Routeflow Mac mini lane" -> "the Mac mini lane".
  function laneName(id) {
    if (!id) return null;
    const l = (snap?.lanes ?? []).find((x) => x.id === id);
    let n =
      String(l?.title ?? id)
        .replace(/^route\s?flow\s+/i, "")
        .trim() || String(id);
    if (!/lane/i.test(n)) n += " lane";
    return "the " + n;
  }
  const recommended = (gate) => {
    const m = /recommended:\s*(.+)$/i.exec(String(gate ?? ""));
    return m ? m[1].trim() : null;
  };

  // Clock: use the server's clock when the browser clock disagrees (fixture mode, skew).
  let skew = 0;
  let skewSet = false;
  const now = () => Date.now() + skew;

  function ago(ms) {
    if (ms === null || ms === undefined || Number.isNaN(ms)) return "never";
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 90) return `${s}s ago`;
    const m = Math.round(s / 60);
    if (m < 90) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 48) return `${h}h ago`;
    return `${Math.round(h / 24)}d ago`;
  }
  const agoIso = (iso) => (iso ? ago(now() - Date.parse(iso)) : "never");

  function pill(text, kind, title) {
    return el("span", { class: `pill ${kind ?? ""}`, text, title });
  }
  const checkKind = (c) =>
    c === "SUCCESS" ? "ok" : c === "FAILURE" || c === "ERROR" ? "err" : c ? "warn" : "";
  const checkLabel = (c) =>
    c === "SUCCESS"
      ? "checks pass"
      : c === "FAILURE" || c === "ERROR"
        ? "checks fail"
        : c
          ? "checks " + String(c).toLowerCase()
          : "no checks";
  // Master: the gate (verify / e2e) is judged apart from the probes (everything else).
  function gateInfo(m) {
    const priv = snap?.ci?.visibility === "PRIVATE";
    switch (m?.gate) {
      case "success":
        return { label: "gate passes", kind: "ok" };
      case "failure":
        return { label: "gate fails", kind: "err" };
      case "pending":
        return { label: "gate running", kind: "warn" };
      case "skipped":
        return { label: priv ? "gate skipped (private)" : "gate skipped", kind: "info" };
      case "none":
        return { label: "no gate runs", kind: "info" };
      default:
        return { label: checkLabel(m?.checks), kind: checkKind(m?.checks) };
    }
  }
  const sevKind = (s) => (s === "error" ? "err" : s === "warn" ? "warn" : "info");
  const sevLabel = (s) => (s === "error" ? "ERROR" : s === "warn" ? "WARN" : "INFO");
  // Severity never relies on colour alone: a label plus a distinct shape.
  const sevGlyph = (s) => (s === "error" ? "\u25B2" : s === "warn" ? "\u25C6" : "\u25CF");

  // ---------- state ----------
  let snap = null;
  const view = {
    area: null,
    text: "",
    lane: "",
    status: "",
    type: "",
    showAll: false,
    bugSel: null,
    bugFix: "",
  };
  let authEnabled = null; // last known; null until a snapshot carries it
  const openNodes = new Set();
  const panels = {};

  // ---------- panel shells (built once) ----------
  const main = document.getElementById("main");
  const nav = document.getElementById("nav");
  function makePanel(key, title, cls, sources, navLabel, blurb) {
    const age = el("span", { class: "age", "data-srcs": sources.join(",") });
    const body = el("div", { class: "pbody" });
    const sec = el(
      "section",
      { class: `panel ${cls ?? ""}`, id: `p-${key}`, "aria-labelledby": `h-${key}` },
      [
        el(
          "header",
          null,
          el("h2", { id: `h-${key}`, text: title }),
          el("span", { class: "blurb", text: blurb }),
          age,
        ),
        body,
      ],
    );
    nav.append(el("a", { class: "navlink", href: `#p-${key}`, text: navLabel }));
    panels[key] = { sec, body, age, sources };
    main.append(sec);
    return panels[key];
  }
  clear(main);
  makePanel(
    "alarms",
    "Drift & problems",
    "",
    ["specs", "github", "branches"],
    "Drift",
    "What is off right now",
  );
  makePanel("ci", "CI & deploy", "", ["github", "railway"], "CI", "Master, visibility and deploys");
  makePanel(
    "lanes",
    "Lanes now / next",
    "",
    ["specs"],
    "Lanes",
    "Who is doing what, and what is next",
  );
  makePanel(
    "map",
    "System map",
    "wide",
    ["areas", "bugs", "github", "branches", "specs"],
    "Map",
    "Where the activity is. Tap an area to filter.",
  );
  makePanel(
    "releases",
    "Releases",
    "wide",
    ["specs"],
    "Releases",
    "What each release delivers and how far along it is",
  );
  makePanel("owner", "Owner queue", "", ["specs"], "Owner", "Waiting on a decision");
  makePanel(
    "prs",
    "PRs & branches",
    "span2",
    ["github", "branches"],
    "PRs",
    "Open pull requests and live branches",
  );
  makePanel(
    "tree",
    "Item tree",
    "wide",
    ["specs", "github", "bugs"],
    "Items",
    "Every item, filterable",
  );
  makePanel("bugs", "Bugs", "wide", ["bugs", "areas"], "Bugs", "Open bugs by area and severity");

  // The item tree keeps its controls across re-renders so typing is never interrupted.
  const treeControls = el("div", { class: "controls" });
  const treeList = el("div", { class: "tree" });
  panels.tree.body.append(treeControls, treeList);
  const treeFilter = el("div");
  panels.tree.body.prepend(treeFilter);

  // ---------- theme ----------
  const root = document.documentElement;
  function storage(op, k, v) {
    try {
      return op === "get" ? localStorage.getItem(k) : localStorage.setItem(k, v);
    } catch {
      return null;
    }
  }
  const savedTheme = storage("get", "rf-ops-theme");
  if (savedTheme === "light" || savedTheme === "dark") root.setAttribute("data-theme", savedTheme);
  document.getElementById("theme").addEventListener("click", () => {
    const dark =
      root.getAttribute("data-theme") === "dark" ||
      (!root.hasAttribute("data-theme") && matchMedia("(prefers-color-scheme: dark)").matches);
    const next = dark ? "light" : "dark";
    root.setAttribute("data-theme", next);
    storage("set", "rf-ops-theme", next);
  });

  // ---------- derived helpers ----------
  const byId = () => new Map(snap.items.map((i) => [i.id, i]));
  function itemAreas() {
    const m = new Map();
    const add = (id, areas) => {
      if (!id) return;
      const s = m.get(id) ?? new Set();
      for (const a of areas ?? []) s.add(a);
      m.set(id, s);
    };
    for (const p of snap.prs?.open ?? []) add(p.item, p.areas);
    for (const b of snap.branches ?? []) add(b.item, b.areas);
    for (const i of snap.items) if (i.area && !i.area.startsWith("domain:")) add(i.id, [i.area]);
    return m;
  }
  const SOURCE_WORD = {
    event: "recorded",
    recorded: "recorded",
    commit: "pushed",
    push: "pushed",
    pushed: "pushed",
    handoff: "handoff note",
    "handoff note": "handoff note",
  };
  const trainEta = (t) => etaWords(t.eta, t.etaAt ?? byId().get(t.id)?.etaAt);
  const trainNum = (id) => Number((/^R(\d+)/.exec(id) ?? [])[1] ?? 99);

  function sourceState(name) {
    const s = snap.sources?.[name];
    if (!s) return { kind: "red", text: "missing", s: null };
    const at = s.at ? Date.parse(s.at) : null;
    const age = at === null ? null : Math.max(0, (now() - at) / 1000);
    const iv = s.intervalSec || 60;
    let kind = "ok";
    if (!s.ok || age === null || s.stale || age > iv * 3) kind = "red";
    else if (age >= iv * 2) kind = "amber";
    return { kind, age, s };
  }
  const KIND_WORD = { ok: "fresh", amber: "ageing", red: "stale" };

  // ---------- header ----------
  function renderHeader() {
    const meta = clear(document.getElementById("hdr-meta"));
    const m = snap.ci?.master;
    if (m) {
      meta.append(
        el(
          "span",
          null,
          el("span", { class: "muted", text: "master " }),
          el("code", { text: short(m.sha) }),
        ),
        pill(gateInfo(m).label, gateInfo(m).kind),
      );
      // (DOM append(null) would print the word "null", so only append a real node.)
      if (m.probesFailing?.length)
        meta.append(
          pill(
            plural(m.probesFailing.length, "probe") + " failing",
            "warn",
            m.probesFailing.join(", "),
          ),
        );
    } else meta.append(el("span", { class: "muted", text: "master unknown" }));
    const vis = snap.ci?.visibility;
    meta.append(
      vis === "PUBLIC"
        ? pill("REPO PUBLIC", "solid-err", "The repo is public right now")
        : vis === "PRIVATE"
          ? pill("private", "ok")
          : pill("visibility ?", "warn"),
    );
    if (snap.machine) meta.append(el("span", { class: "muted", text: `on ${snap.machine}` }));

    const chips = clear(document.getElementById("chips"));
    for (const name of Object.keys(snap.sources ?? {})) {
      const st = sourceState(name);
      const tip = st.s?.error ? `${name}: ${st.s.error}` : `${name} every ${st.s?.intervalSec}s`;
      chips.append(
        el(
          "span",
          { class: `chip ${st.kind}`, title: tip },
          el("i", { class: "dot" }),
          `${name} ${st.age === null || st.age === undefined ? "never" : ago(st.age * 1000)}`,
          el("span", { class: "sr-only", text: ` (${KIND_WORD[st.kind]})` }),
        ),
      );
    }
  }

  // ---------- the big picture: three plain columns, then one quiet health line ----------
  const openerBtn = (id, text, cls) =>
    el(
      "button",
      {
        type: "button",
        class: `linkbtn ${cls ?? ""}`,
        "data-item": id,
        onclick: (e) => {
          e.preventDefault();
          e.stopPropagation();
          openItem(id, e.currentTarget);
        },
      },
      text,
    );
  const problemLine = (it) => (it?.problem ? firstSentence(it.problem) : (it?.title ?? ""));
  // A release in words: its own solution/problem, else its members' problem lines.
  function memberLines(t, items) {
    return (t.members ?? [])
      .map((id) => items.get(id))
      .filter(Boolean)
      .map(problemLine)
      .filter(Boolean);
  }
  function deliversText(t, items) {
    const ri = items.get(t.id);
    const own = ri?.solution ?? ri?.problem;
    return own ? firstSentence(own) : null;
  }
  const openReleases = () =>
    (snap.trains ?? [])
      .filter((t) => !DONE.has(t.status))
      .sort((a, b) => trainNum(a.id) - trainNum(b.id));

  function bandEntry(id, main, sub, note) {
    return el(
      "button",
      {
        type: "button",
        class: "bentry",
        "data-item": id,
        onclick: (e) => openItem(id, e.currentTarget),
      },
      el("span", { class: "bmain", text: main }),
      sub ? el("span", { class: "bsub", text: sub }) : null,
      note ? el("span", { class: "bnote", text: note }) : null,
    );
  }
  function bandColumn(kind, title, blurb, entries, emptyText) {
    return el(
      "section",
      { class: `bcol ${kind}`, "aria-label": title },
      el("h2", { text: title }),
      el("p", { class: "bblurb", text: blurb }),
      entries.length
        ? el("div", { class: "blist" }, entries)
        : el("p", { class: "bempty", text: emptyText }),
    );
  }

  function renderSummary() {
    const box = clear(document.getElementById("summary"));
    const items = byId();
    const alarms = snap.alarms ?? [];

    // 1. Hurting customers or money now: open urgent items and incidents.
    const hurt = new Map();
    for (const id of snap.problems ?? [])
      if (items.get(id) && !DONE.has(items.get(id).status)) hurt.set(id, items.get(id));
    for (const i of snap.items)
      if (!DONE.has(i.status) && (i.priority === "P0" || i.type === "incident")) hurt.set(i.id, i);
    const hurtEntries = [...hurt.values()].map((i) =>
      bandEntry(
        i.id,
        problemLine(i),
        [prioWord(i.priority), itemStatus(i), i.blocked ? "Blocked" : null]
          .filter(Boolean)
          .join(" \u00B7 "),
        i.impact ? firstSentence(i.impact) : null,
      ),
    );

    // 2. Shipping next: the next one or two releases, in plain words.
    const nextEntries = openReleases()
      .slice(0, 2)
      .map((t) => {
        const lines = memberLines(t, items);
        const desc =
          deliversText(t, items) ??
          (lines.length
            ? lines.slice(0, 2).join("; ") + (lines.length > 2 ? `; +${lines.length - 2} more` : "")
            : t.title);
        const members = (t.members ?? []).map((id) => items.get(id)).filter(Boolean);
        const done = members.filter((m) => m.status === "live" || m.status === "verified").length;
        const when = trainEta(t);
        return bandEntry(
          t.id,
          desc,
          [
            `Release ${t.id}`,
            when ?? "no date yet",
            members.length ? `${done} of ${members.length} done` : null,
          ]
            .filter(Boolean)
            .join(" \u00B7 "),
          null,
        );
      });

    // 3. Waiting on you: each question with the team's recommended answer.
    const askEntries = (snap.ownerQueue ?? [])
      .filter((o) => o.state !== "booked")
      .map((o) => {
        const it = items.get(o.id);
        const rec = recommended(o.gate ?? it?.gate);
        return bandEntry(
          o.id,
          it?.ownerAsk ?? it?.problem ?? o.title,
          rec ? `Recommended: ${rec}` : (o.gate ?? null),
          o.eta || it?.etaAt ? `Needed ${etaWords(o.eta ?? it?.eta, it?.etaAt)}` : null,
        );
      });

    box.append(
      el(
        "div",
        { class: "bands" },
        bandColumn(
          "hurt",
          "Hurting customers or money now",
          "Open urgent problems",
          hurtEntries,
          "Nothing urgent right now.",
        ),
        bandColumn(
          "next",
          "Shipping next",
          "What the next releases fix or add",
          nextEntries,
          "No release is planned.",
        ),
        bandColumn(
          "ask",
          "Waiting on you",
          "Decisions only you can make",
          askEntries,
          "Nothing needs you right now.",
        ),
      ),
    );

    // One quiet line for system health, linking to Drift.
    const errs = alarms.filter((a) => a.severity === "error").length;
    const warns = alarms.filter((a) => a.severity === "warn").length;
    const srcs = Object.keys(snap.sources ?? {}).map((k) => sourceState(k).kind);
    const behind = srcs.filter((k) => k !== "ok").length;
    const parts = [behind ? `${plural(behind, "source")} behind` : "Everything up to date"];
    if (errs) parts.push(`${plural(errs, "error")} for the team`);
    if (warns) parts.push(`${plural(warns, "warning")} for the team`);
    box.append(
      el(
        "a",
        {
          class: `healthline ${errs ? "err" : warns || behind ? "warn" : "ok"}`,
          href: "#p-alarms",
        },
        el("i", { class: "dot" }),
        parts.join(" \u00B7 "),
      ),
    );
  }

  // Panel header ages: the oldest of the sources the panel reads.
  function tickAges() {
    if (!snap) return;
    for (const p of Object.values(panels)) {
      let worst = "ok";
      let oldest = 0;
      let any = false;
      for (const name of p.sources) {
        const st = sourceState(name);
        any = true;
        if (st.age !== null && st.age !== undefined) oldest = Math.max(oldest, st.age);
        if (st.kind === "red") worst = "red";
        else if (st.kind === "amber" && worst !== "red") worst = "amber";
      }
      p.age.textContent = any
        ? `data ${ago(oldest * 1000)}${worst === "red" ? " (stale)" : ""}`
        : "";
      p.age.className = `age ${worst === "ok" ? "" : worst}`;
    }
    const gen = Date.parse(snap.generatedAt);
    document.getElementById("updated").textContent = `updated ${ago(now() - gen)}`;
    for (const t of document.querySelectorAll("[data-sw]")) {
      t.textContent = sinceWords(now() - Date.parse(t.getAttribute("data-sw")));
    }
    for (const t of document.querySelectorAll("[data-at]")) {
      t.textContent = agoIso(t.getAttribute("data-at"));
    }
  }

  // ---------- copy button ----------
  function copyButton(text) {
    const b = el("button", {
      type: "button",
      class: "btn",
      "aria-label": `Copy command ${text}`,
      text: "Copy",
    });
    b.addEventListener("click", async () => {
      let ok = false;
      try {
        await navigator.clipboard.writeText(text);
        ok = true;
      } catch {
        try {
          const ta = el("textarea", { "aria-hidden": "true" });
          ta.value = text;
          document.body.append(ta);
          ta.select();
          ok = document.execCommand("copy");
          ta.remove();
        } catch {
          ok = false;
        }
      }
      b.textContent = ok ? "Copied" : "Copy failed";
      setTimeout(() => (b.textContent = "Copy"), 1500);
    });
    return b;
  }

  // ---------- panels ----------
  function alarmDrill(ids) {
    const d = el("details", { class: "drill" }, el("summary", { text: `Show ${ids.length}` }));
    const ul = el("ul", { class: "drill-list" });
    for (const id of ids) {
      const b = (snap.bugs ?? []).find((x) => x.id === id);
      const btn = el("button", {
        type: "button",
        class: "linklike",
        text: b ? `${id} · ${b.title}` : id,
      });
      btn.addEventListener("click", (e) => openItem(id, e.currentTarget));
      ul.append(el("li", {}, btn));
    }
    d.append(ul);
    return d;
  }

  function renderAlarms() {
    const body = clear(panels.alarms.body);
    const items = byId();
    const alarms = snap.alarms ?? [];
    if (!alarms.length) body.append(el("div", { class: "empty", text: "No drift detected." }));
    for (const sev of ["error", "warn", "info"]) {
      const list = alarms.filter((a) => a.severity === sev);
      if (!list.length) continue;
      body.append(el("div", { class: "subhead", text: `${sevLabel(sev)} (${list.length})` }));
      for (const a of list) {
        body.append(
          el(
            "div",
            { class: "alarm" },
            pill(`${sevGlyph(a.severity)} ${sevLabel(a.severity)}`, sevKind(a.severity)),
            el("div", { class: "msg", text: a.message }),
            a.suggest
              ? el("div", { class: "cmd" }, el("code", { text: a.suggest }), copyButton(a.suggest))
              : null,
            // Aggregated alarms (e.g. unowned bug backlog by severity x area) carry the ids.
            Array.isArray(a.items) && a.items.length ? alarmDrill(a.items) : null,
          ),
        );
      }
    }
    body.append(
      el("div", { class: "subhead", text: `Live problems (${(snap.problems ?? []).length})` }),
    );
    if (!(snap.problems ?? []).length)
      body.append(el("div", { class: "empty", text: "None open." }));
    for (const id of snap.problems ?? []) {
      const it = items.get(id);
      body.append(
        el(
          "div",
          { class: "alarm" },
          pill(prioWord(it?.priority ?? "P0"), "solid-err", it?.priority ?? "P0"),
          el(
            "div",
            { class: "msg" },
            it ? openerBtn(id, problemLine(it)) : el("code", { text: id }),
            " ",
            it ? pill(itemStatus(it), "") : null,
          ),
        ),
      );
    }
  }

  function renderCi() {
    const body = clear(panels.ci.body);
    const ci = snap.ci ?? {};
    const m = ci.master;
    if (m) {
      body.append(
        el(
          "div",
          { class: "ci-row" },
          el("strong", { text: "master" }),
          el("code", { text: short(m.sha) }),
          pill(gateInfo(m).label, gateInfo(m).kind),
          el("span", { class: "grow muted", text: m.headline }),
        ),
      );
      if (m.gate !== undefined) {
        const failing = m.probesFailing ?? [];
        body.append(
          el(
            "div",
            { class: "ci-row" },
            el("strong", { text: "probes" }),
            failing.length
              ? pill(plural(failing.length, "probe") + " failing", "warn")
              : pill("none failing", "ok"),
            failing.length
              ? el("span", { class: "grow", text: failing.join(", ") })
              : el("span", { class: "grow" }),
          ),
        );
        if ((m.runs ?? []).length) {
          const kindOf = (r) =>
            r.state === "success"
              ? "ok"
              : r.state === "failure"
                ? "err"
                : r.state === "skipped"
                  ? "info"
                  : "warn";
          body.append(
            el(
              "details",
              { class: "tech" },
              el("summary", { text: `All checks (${m.runs.length})` }),
              m.runs.map((r) =>
                el(
                  "div",
                  { class: "ci-row" },
                  el("span", { class: "grow", text: r.name }),
                  el("span", { class: "muted", text: r.kind === "gate" ? "gate" : "probe" }),
                  pill(
                    r.state === "skipped" && snap.ci?.visibility === "PRIVATE"
                      ? "skipped (private)"
                      : r.state,
                    kindOf(r),
                  ),
                ),
              ),
            ),
          );
        }
      }
    } else body.append(el("div", { class: "empty", text: "No master info yet." }));
    body.append(
      el(
        "div",
        { class: "ci-row" },
        el("strong", { text: "visibility" }),
        ci.visibility === "PUBLIC"
          ? pill("PUBLIC", "solid-err")
          : pill(ci.visibility ?? "unknown", ci.visibility ? "ok" : "warn"),
      ),
    );
    const deploys = ci.deploys ?? [];
    if (!deploys.length) {
      const st = sourceState("railway");
      body.append(
        el("div", {
          class: "ci-row muted",
          text: st.s?.error ? `Deploys unavailable: ${st.s.error}` : "No deploys reported.",
        }),
      );
    }
    for (const d of deploys) {
      const match = m && d.sha === m.sha;
      const kind =
        d.status === "SUCCESS"
          ? "ok"
          : d.status === "FAILED" || d.status === "CRASHED"
            ? "err"
            : "warn";
      body.append(
        el(
          "div",
          { class: "ci-row" },
          el("strong", { text: String(d.service).replace(/^@routeflow\//, "") }),
          pill(d.status, kind),
          el("code", { text: short(d.sha) }),
          el("span", {
            class: `grow ${match ? "" : "muted"}`,
            text: match ? "matches master" : "differs from master",
          }),
          el("span", { class: "muted", "data-at": d.createdAt, text: agoIso(d.createdAt) }),
        ),
      );
    }
  }

  function heatLevel(n) {
    return n <= 0 ? 0 : n === 1 ? 1 : n <= 3 ? 2 : n <= 6 ? 3 : 4;
  }
  function worstBug(b) {
    for (const s of SEV_ORDER) if (b?.[s]) return s;
    return null;
  }

  function renderMap() {
    const body = clear(panels.map.body);
    if (view.area) {
      body.append(
        el(
          "div",
          { class: "filterbar" },
          el("span", null, "Filtering items and PRs to area ", el("code", { text: view.area })),
          el("button", {
            type: "button",
            class: "btn",
            text: "Clear filter",
            onclick: () => setArea(null),
          }),
        ),
      );
    }
    const legend = el(
      "div",
      { class: "legend" },
      el("span", { text: "Activity (items + PRs + branches):" }),
    );
    ["0", "1", "2-3", "4-6", "7+"].forEach((label, i) => {
      legend.append(el("span", null, el("i", { class: `sw sw${i}` }), ` ${label}`));
    });
    legend.append(el("span", { text: "Dot = worst open bug:" }));
    for (const s of SEV_ORDER) legend.append(el("span", { class: `bdot ${s}` }, el("i"), ` ${s}`));
    body.append(legend);

    const grid = el("div", { class: "map" });
    for (const d of snap.map?.domains ?? []) {
      const tile = el("div", { class: "tile" });
      const totals = d.areas.reduce((n, a) => n + a.items + a.prs + a.branches, 0);
      tile.append(
        el(
          "h3",
          null,
          d.label,
          el("span", {
            class: "pill info badge",
            title: "Items attached to this domain without a specific area",
            text: `${d.items} domain-level`,
          }),
        ),
      );
      tile.append(
        el("div", { class: "muted", text: `${plural(d.areas.length, "area")}, ${totals} active` }),
      );
      for (const [layer, label] of LAYERS) {
        const areas = d.areas.filter((a) => a.layer === layer);
        if (!areas.length) continue;
        const row = el("div", { class: "layer" }, el("span", { class: "lname", text: label }));
        for (const a of areas) {
          const heat = a.items + a.prs + a.branches;
          const wb = worstBug(a.bugs);
          const nBugs = SEV_ORDER.reduce((n, s) => n + (a.bugs?.[s] ?? 0), 0);
          const label2 = `${a.area}: ${plural(a.items, "item")}, ${plural(a.prs, "PR")}, ${plural(a.branches, "branch")}, ${a.files} files${nBugs ? `, ${plural(nBugs, "open bug")} (worst ${wb})` : ""}`;
          row.append(
            el(
              "button",
              {
                type: "button",
                class: `achip h${heatLevel(heat)}`,
                title: label2,
                "aria-label": label2,
                "aria-pressed": view.area === a.area ? "true" : "false",
                onclick: () => setArea(view.area === a.area ? null : a.area),
              },
              a.name,
              heat ? el("span", { class: "cnt", text: String(heat) }) : null,
              nBugs ? el("span", { class: `bdot ${wb}` }, el("i"), String(nBugs)) : null,
            ),
          );
        }
        tile.append(row);
      }
      grid.append(tile);
    }
    body.append(grid);
  }

  function setArea(a) {
    view.area = a;
    view.showAll = false;
    renderMap();
    renderTree();
    renderPrs();
  }

  function renderReleases() {
    const body = clear(panels.releases.body);
    const items = byId();
    const trains = [...(snap.trains ?? [])].sort((a, b) => trainNum(a.id) - trainNum(b.id));
    if (!trains.length) body.append(el("div", { class: "empty", text: "No releases defined." }));
    for (const t of trains) {
      const members = t.members.map(
        (id) =>
          items.get(id) ?? { id, title: "(not in item list)", status: "planned", missing: true },
      );
      const done = members.filter((m) => m.status === "live" || m.status === "verified").length;
      const when = trainEta(t);
      const box = el("div", { class: "train" });
      box.append(
        el(
          "div",
          { class: "thead" },
          items.get(t.id)
            ? openerBtn(t.id, t.title, "title")
            : el("span", { class: "title", text: t.title }),
          pill(statusWord(t.status), DONE.has(t.status) ? "ok" : ""),
          el("span", { class: "muted", text: when ?? "no date yet" }),
        ),
      );
      // What it delivers, in one line, else the members' own problem lines.
      const delivers = deliversText(t, items);
      const info = el("div", { class: "tinfo" });
      if (delivers) info.append(el("p", { class: "delivers", text: delivers }));
      else {
        const lines = memberLines(t, items);
        if (lines.length) {
          info.append(
            el("p", { class: "delivers-h muted", text: "What it delivers" }),
            el(
              "ul",
              { class: "delivers-list" },
              lines.slice(0, 4).map((l) => el("li", { text: l })),
            ),
          );
          if (lines.length > 4)
            info.append(el("p", { class: "muted", text: `+${lines.length - 4} more` }));
        }
      }
      info.append(
        el(
          "div",
          { class: "tprog" },
          el("progress", {
            max: Math.max(members.length, 1),
            value: done,
            "aria-label": `${done} of ${members.length} done`,
          }),
          el("span", {
            class: "muted",
            text: members.length ? `${done} of ${members.length} done` : "No members yet",
          }),
        ),
      );
      box.append(info);
      const cols = el("div", { class: "cols" });
      for (const [label, statuses] of STATUS_BUCKETS) {
        const col = el("div", { class: "col" }, el("h4", { text: label }));
        const here = members.filter((m) => statuses.includes(m.status));
        if (!here.length) col.append(el("div", { class: "muted", text: "-" }));
        for (const m of here) {
          const sub = [
            prioWord(m.priority),
            itemStatus(m),
            m.lane ? laneName(m.lane).replace(/^the /, "") : null,
            m.blocked ? "Blocked" : null,
          ]
            .filter(Boolean)
            .join(" · ");
          col.append(
            m.missing
              ? el("div", { class: "card" }, el("span", { class: "id", text: m.id }), " ", m.title)
              : el(
                  "button",
                  {
                    type: "button",
                    class: "card cardbtn",
                    "data-item": m.id,
                    onclick: (e) => openItem(m.id, e.currentTarget),
                  },
                  el("span", { class: "ctitle", text: m.title }),
                  el("span", { class: "sub", text: sub }),
                ),
          );
        }
        cols.append(col);
      }
      box.append(cols);
      body.append(box);
    }
  }

  function renderLanes() {
    const body = clear(panels.lanes.body);
    const items = byId();
    for (const l of snap.lanes ?? []) {
      const actAt = l.lastActivityAt ?? l.lastEventAt;
      const actSrc = SOURCE_WORD[l.lastActivitySource] ?? l.lastActivitySource ?? "recorded";
      const silent = actAt ? Math.round((now() - Date.parse(actAt)) / 60000) : null;
      const isSilent = (l.now?.length ?? 0) > 0 && silent !== null && silent > SILENT_MIN;
      const box = el("div", { class: "lane" });
      box.append(
        el(
          "div",
          { class: "lh" },
          el("span", { class: "title", text: l.title ?? l.id }),
          l.machine ? el("span", { class: "muted", text: l.machine }) : null,
          el(
            "span",
            { class: "muted", title: actAt ? localStamp(actAt) : "No activity seen" },
            actAt ? `${actSrc} ` : "no activity seen",
            actAt
              ? el("span", { "data-sw": actAt, text: sinceWords(now() - Date.parse(actAt)) })
              : null,
          ),
          isSilent ? pill(`SILENT ${silent}m`, "warn", "Holds work but has been quiet") : null,
        ),
      );
      const nowList = el("ul");
      for (const id of l.now ?? []) {
        const it = items.get(id);
        nowList.append(el("li", null, it ? openerBtn(id, it.title) : el("code", { text: id })));
      }
      box.append(el("div", { class: "subhead", text: "Now" }));
      box.append(
        (l.now ?? []).length ? nowList : el("div", { class: "muted", text: "Nothing claimed." }),
      );
      box.append(el("div", { class: "subhead", text: "Next" }));
      box.append(
        l.next
          ? el(
              "div",
              null,
              openerBtn(l.next.id, l.next.title),
              el("div", { class: "muted", text: l.next.reason }),
            )
          : el("div", { class: "muted", text: "No pickable item." }),
      );
      body.append(box);
    }
    if (!(snap.lanes ?? []).length) body.append(el("div", { class: "empty", text: "No lanes." }));
  }

  function renderOwner() {
    const body = clear(panels.owner.body);
    const q = snap.ownerQueue ?? [];
    const items = byId();
    const ordered = [
      ...q.filter((o) => o.state !== "booked"),
      ...q.filter((o) => o.state === "booked"),
    ];
    if (!q.length)
      body.append(el("div", { class: "empty", text: "Nothing waiting on the owner." }));
    for (const o of ordered) {
      const it = items.get(o.id);
      const booked = o.state === "booked";
      const needed = o.eta || it?.etaAt ? etaWords(o.eta ?? it?.eta, it?.etaAt) : null;
      body.append(
        el(
          "div",
          { class: "alarm" },
          pill(booked ? "Booked" : "Your call", booked ? "ok" : "info"),
          el(
            "div",
            { class: "msg" },
            openerBtn(o.id, it?.ownerAsk ?? o.title),
            o.gate ? el("div", { class: "muted", text: o.gate }) : null,
            needed ? el("div", { class: "muted", text: `Needed ${needed}` }) : null,
          ),
        ),
      );
    }
    const done = snap.answeredRecently;
    if (Array.isArray(done)) {
      if (done.length) {
        const d = el("details", { class: "tech answered" });
        d.append(el("summary", { text: `Answered recently (${done.length})` }));
        for (const a of done) {
          d.append(
            el(
              "div",
              { class: "ci-row" },
              el(
                "span",
                { class: "grow" },
                items.get(a.id) ? openerBtn(a.id, a.title ?? a.id) : (a.title ?? a.id),
                a.answer ? el("div", { class: "muted", text: `Answer: ${a.answer}` }) : null,
              ),
              a.answeredAt
                ? el("span", {
                    class: "muted",
                    "data-at": a.answeredAt,
                    text: agoIso(a.answeredAt),
                  })
                : null,
            ),
          );
        }
        body.append(d);
      }
      return;
    }
    const dec = (snap.decisions ?? []).slice(-5).reverse();
    if (dec.length) {
      const d = el("details", { class: "tech answered" });
      d.append(el("summary", { text: `Answered recently (${dec.length})` }));
      for (const x of dec) {
        d.append(
          el(
            "div",
            { class: "ci-row" },
            el(
              "span",
              { class: "grow" },
              el("strong", { text: x.item ?? "-" }),
              " ",
              x.question,
              el("div", { class: "muted", text: `Answer: ${x.answer}` }),
            ),
            el("span", { class: "muted", "data-at": x.ts, text: agoIso(x.ts) }),
          ),
        );
      }
      body.append(d);
    }
  }

  // ---------- item tree ----------
  function buildControls() {
    clear(treeControls);
    const search = el("input", {
      type: "search",
      placeholder: "Search id, title, tag",
      "aria-label": "Search items",
      value: view.text,
    });
    search.addEventListener("input", () => {
      view.text = search.value;
      view.showAll = false;
      renderTree();
    });
    treeControls.append(search);
    const sel = (key, label, values) => {
      const s = el(
        "select",
        { "aria-label": label },
        el("option", { value: "", text: `${label}: all` }),
        values.map((v) => el("option", { value: v, text: key === "status" ? statusWord(v) : v })),
      );
      s.value = view[key];
      s.addEventListener("change", () => {
        view[key] = s.value;
        view.showAll = false;
        renderTree();
      });
      return s;
    };
    const uniq = (f) => [...new Set(snap.items.map(f).filter(Boolean))].sort();
    treeControls.append(
      sel(
        "lane",
        "Lane",
        uniq((i) => i.lane),
      ),
      sel(
        "status",
        "Status",
        uniq((i) => i.status),
      ),
      sel(
        "type",
        "Type",
        uniq((i) => i.type),
      ),
    );
  }

  function renderTree() {
    clear(treeFilter);
    if (view.area) {
      treeFilter.append(
        el(
          "div",
          { class: "filterbar" },
          el("span", null, "Area ", el("code", { text: view.area })),
          el("button", {
            type: "button",
            class: "btn",
            text: "Clear",
            onclick: () => setArea(null),
          }),
        ),
      );
    }
    const list = clear(treeList);
    const areas = itemAreas();
    const items = snap.items.filter((i) => i.type !== "release");
    const ids = new Set(items.map((i) => i.id));
    const kids = new Map();
    for (const i of items) {
      if (i.parent && ids.has(i.parent)) {
        const a = kids.get(i.parent) ?? [];
        a.push(i);
        kids.set(i.parent, a);
      }
    }
    const text = view.text.trim().toLowerCase();
    const own = (i) => {
      if (view.lane && i.lane !== view.lane) return false;
      if (view.status && i.status !== view.status) return false;
      if (view.type && i.type !== view.type) return false;
      if (view.area && !areas.get(i.id)?.has(view.area)) return false;
      if (
        text &&
        !`${i.id} ${i.title} ${i.problem ?? ""} ${(i.tags ?? []).join(" ")}`
          .toLowerCase()
          .includes(text)
      )
        return false;
      return true;
    };
    const memo = new Map();
    const keep = (i) => {
      if (memo.has(i.id)) return memo.get(i.id);
      memo.set(i.id, false);
      const r = own(i) || (kids.get(i.id) ?? []).some(keep);
      memo.set(i.id, r);
      return r;
    };
    const roots = items.filter((i) => !(i.parent && ids.has(i.parent)) && keep(i));
    const groups = new Map();
    for (const r of roots) {
      const k = r.train ?? "";
      groups.set(k, [...(groups.get(k) ?? []), r]);
    }
    const trainTitle = new Map((snap.trains ?? []).map((t) => [t.id, t.title]));
    const order = [...groups.keys()].sort((a, b) =>
      a === "" ? 1 : b === "" ? -1 : trainNum(a) - trainNum(b),
    );
    let rows = 0;
    let total = 0;
    const count = (i) => 1 + (kids.get(i.id) ?? []).filter(keep).reduce((n, c) => n + count(c), 0);
    for (const r of roots) total += count(r);
    const prio = { P0: 0, P1: 1, P2: 2, P3: 3 };
    const sortItems = (a, b) =>
      (prio[a.priority] ?? 9) - (prio[b.priority] ?? 9) ||
      String(a.id).localeCompare(String(b.id), undefined, { numeric: true });
    const cap = view.showAll ? Infinity : TREE_CAP;
    const renderNode = (i) => {
      if (rows >= cap) return null;
      rows++;
      const children = (kids.get(i.id) ?? []).filter(keep).sort(sortItems);
      const meta = el(
        "span",
        { class: "meta" },
        pill(
          prioWord(i.priority),
          i.priority === "P0" ? "err" : i.priority === "P1" ? "warn" : "",
          i.priority,
        ),
        pill(itemStatus(i), DONE.has(i.status) ? "ok" : "", i.status),
        i.type !== "feature" ? el("span", { class: "muted", text: i.type }) : null,
        i.blocked ? pill("BLOCKED", "err", `Blocked by ${i.blocked.by}`) : null,
        i.claimedBy
          ? el("span", { class: "muted", text: `@${i.claimedBy}` })
          : i.lane
            ? el("span", { class: "muted", text: laneName(i.lane).replace(/^the /, "") })
            : null,
        i.eta || i.etaAt
          ? el("span", { class: "muted", text: `ETA ${etaWords(i.eta, i.etaAt)}` })
          : null,
        ...(i.links?.prs ?? []).map((n) => pill(`#${n}`, "info")),
      );
      const head = [
        children.length
          ? el("span", { class: "caret", "aria-hidden": "true", text: ">" })
          : el("span", { class: "caret" }),
        el("span", { class: "id", text: i.id }),
        el("span", { class: "ttl" }, openerBtn(i.id, i.title, "ttlbtn")),
        meta,
      ];
      if (!children.length) return el("div", { class: "node" }, el("div", { class: "row" }, head));
      const d = el("details", null, el("summary", { class: "row" }, head));
      if (openNodes.has(i.id) || text || view.area) d.open = true;
      d.addEventListener("toggle", () => (d.open ? openNodes.add(i.id) : openNodes.delete(i.id)));
      const wrap = el("div", { class: "children" });
      for (const c of children) {
        const n = renderNode(c);
        if (n) wrap.append(n);
      }
      d.append(wrap);
      return el("div", { class: "node" }, d);
    };
    for (const k of order) {
      const g = el(
        "div",
        { class: "tgroup" },
        el(
          "h3",
          null,
          k ? `${k} ` : "No train",
          k ? el("span", { class: "muted", text: trainTitle.get(k) ?? "" }) : null,
        ),
      );
      for (const r of groups.get(k).sort(sortItems)) {
        const n = renderNode(r);
        if (n) g.append(n);
      }
      list.append(g);
    }
    if (!roots.length) list.append(el("div", { class: "empty", text: "No items match." }));
    if (rows >= cap && total > rows) {
      list.append(
        el("button", {
          type: "button",
          class: "btn",
          text: `Show all ${total} (showing ${rows})`,
          onclick: () => {
            view.showAll = true;
            renderTree();
          },
        }),
      );
    }
  }

  // ---------- bugs ----------
  const FIX_STATES = [
    ["none", "No PR"],
    ["branch", "Branch"],
    ["pr-open", "PR open"],
    ["in-release", "In release"],
    ["merged", "Merged"],
    ["deployed", "Deployed"],
  ];
  const fixState = (b) => b.fix?.state ?? "none";
  const fixLabel = (b) => FIX_STATES.find(([k]) => k === fixState(b))?.[1] ?? fixState(b);
  const fixKind = (b) => {
    const s = fixState(b);
    if (s === "merged" || s === "deployed") return "ok";
    if (s === "none") return b.severity === "critical" || b.severity === "high" ? "warn" : "";
    return "info";
  };
  const sevPill = (s) => pill(s, s === "critical" ? "err" : s === "high" ? "warn" : "");
  const fixChip = (b) => pill(fixLabel(b), fixKind(b));
  const prLink = (b) => {
    if (!b.fix?.pr) return null;
    const url = safeUrl(b.fix.prUrl);
    return url
      ? el("a", { href: url, target: "_blank", rel: "noopener noreferrer", text: "#" + b.fix.pr })
      : el("code", { text: "#" + b.fix.pr });
  };
  const PENDING_TEXT = "Filed, not on master yet";
  const viaText = (f) => (f.via ? " (landed through train PR #" + f.via + ")" : "");
  function fixSentence(b) {
    const f = b.fix ?? {};
    const pr = f.pr ? "PR #" + f.pr : "The PR";
    const lines = [];
    switch (fixState(b)) {
      case "branch":
        lines.push("A fix is in progress on branch " + (f.branch ?? "(unknown)") + "; no PR yet.");
        break;
      case "pr-open":
        lines.push(pr + " is open with a fix.");
        break;
      case "in-release":
        lines.push(
          pr + " is in release " + (b.release ?? f.branch ?? "(unknown)") + ", not on master yet.",
        );
        break;
      case "merged":
        lines.push(pr + " is merged" + viaText(f) + "; it has not been deployed yet.");
        break;
      case "deployed":
        lines.push(pr + " is merged" + viaText(f) + " and deployed.");
        break;
      default:
        lines.push("No fix yet: no branch and no pull request.");
    }
    if (b.pending) lines.push("The bug was filed on a branch and is not on master yet.");
    return lines.join(" ");
  }
  // A bug the register has no item for still opens the item card.
  function bugAsItem(b) {
    const pr = { critical: "P0", high: "P1", medium: "P2", low: "P3" };
    return {
      id: b.id,
      type: "bug",
      title: b.title,
      priority: pr[b.severity] ?? "P2",
      status: b.ledgerState ?? b.state,
      statusLabel: b.ledgerState ?? b.state,
      area: b.area,
      domain: b.domain,
      links: { prs: [], branches: [], urls: [] },
      tags: [],
      _bug: true,
    };
  }

  // Bugs whose record carries a verified "ALREADY FIXED ... PR #n" note: fixed on master, but the
  // registry close is owed (scripts/campaign/bugs.mjs has no close verb yet; register row 642).
  function fixedByNoteList() {
    const list = snap.bugsFixedByNote ?? [];
    if (!list.length) return null;
    const d = el("details", { class: "tech answered" });
    d.append(el("summary", { text: `Fixed, registry close owed (${list.length})` }));
    d.append(
      el("div", {
        class: "muted",
        text: "These bug records say ALREADY FIXED on master, but the registry still shows them open. bugs.mjs has no close verb yet (register row 642), so the close is owed.",
      }),
    );
    for (const b of list) {
      const url = safeUrl(b.prUrl);
      d.append(
        el(
          "div",
          { class: "bugrow" },
          el(
            "div",
            { class: "bugmain" },
            el("code", { text: b.id }),
            el("span", { class: "grow", text: b.title }),
          ),
          el(
            "div",
            { class: "bugmeta" },
            sevPill(b.severity),
            b.pr
              ? url
                ? el("a", {
                    href: url,
                    target: "_blank",
                    rel: "noopener noreferrer",
                    text: "#" + b.pr,
                  })
                : el("code", { text: "#" + b.pr })
              : el("span", { class: "muted", text: "PR unknown" }),
            b.sha ? el("code", { text: short(b.sha) }) : null,
          ),
        ),
      );
    }
    return d;
  }

  function renderBugs() {
    const body = clear(panels.bugs.body);
    const bugs = snap.bugs ?? [];
    if (!bugs.length) {
      body.append(el("div", { class: "empty", text: "No open bugs." }));
      const only = fixedByNoteList();
      if (only) body.append(only);
      return;
    }
    const labels = new Map((snap.map?.domains ?? []).map((d) => [d.id, d.label]));
    const fixBar = el("div", {
      class: "fixbar",
      role: "group",
      "aria-label": "Filter by fix state",
    });
    for (const [k, label] of FIX_STATES) {
      const n = bugs.filter((b) => fixState(b) === k).length;
      fixBar.append(
        el("button", {
          type: "button",
          class: "fixchip",
          "aria-pressed": view.bugFix === k ? "true" : "false",
          text: label + " " + n,
          onclick: () => {
            view.bugFix = view.bugFix === k ? "" : k;
            renderBugs();
          },
        }),
      );
    }
    const pendingN = bugs.filter((b) => b.pending).length;
    if (pendingN)
      fixBar.append(
        el("span", { class: "pill info", text: pendingN + " filed, not on master yet" }),
      );
    body.append(fixBar);
    const dom = new Map();
    for (const b of bugs) {
      const dk = b.domain ?? "";
      const ak = b.area ?? "";
      const d = dom.get(dk) ?? new Map();
      const cell = d.get(ak) ?? [];
      cell.push(b);
      d.set(ak, cell);
      dom.set(dk, d);
    }
    const table = el(
      "table",
      null,
      el(
        "thead",
        null,
        el(
          "tr",
          null,
          el("th", { text: "Domain / area" }),
          SEV_ORDER.map((s) => el("th", { class: "num", text: s })),
          el("th", { class: "num", text: "total" }),
        ),
      ),
    );
    const tb = el("tbody");
    const cellBtn = (label, list, sev) => {
      const n = list.filter((b) => b.severity === sev).length;
      if (!n) return el("td", { class: "num" }, el("span", { class: "sevcell zero", text: "0" }));
      const key = `${label}|${sev}`;
      return el(
        "td",
        { class: "num" },
        el("button", {
          type: "button",
          class: "sevcell",
          "aria-pressed": view.bugSel?.key === key ? "true" : "false",
          "aria-label": `${n} ${sev} bugs in ${label}`,
          text: String(n),
          onclick: () => {
            view.bugSel =
              view.bugSel?.key === key
                ? null
                : {
                    key,
                    label,
                    sev,
                    list: list.filter((b) => b.severity === sev).map((b) => b.id),
                  };
            renderBugs();
          },
        }),
      );
    };
    const dorder = (snap.map?.domains ?? []).map((d) => d.id);
    const rank = (k) => (k === "" ? 999 : dorder.indexOf(k) < 0 ? 998 : dorder.indexOf(k));
    for (const [dk, areas] of [...dom].sort((a, b) => rank(a[0]) - rank(b[0]))) {
      const all = [...areas.values()].flat();
      const dl = dk ? (labels.get(dk) ?? dk) : "Masked / no area";
      tb.append(
        el(
          "tr",
          { class: "dhead" },
          el("td", { text: dl }),
          SEV_ORDER.map((s) => cellBtn(dl, all, s)),
          el("td", { class: "num", text: String(all.length) }),
        ),
      );
      if (dk) {
        for (const [ak, list] of [...areas].sort()) {
          const al = ak || "(no area)";
          tb.append(
            el(
              "tr",
              null,
              el("td", { class: "muted", text: `  ${al}` }),
              SEV_ORDER.map((s) => cellBtn(al, list, s)),
              el("td", { class: "num", text: String(list.length) }),
            ),
          );
        }
      }
    }
    table.append(tb);
    body.append(el("div", { class: "scroll" }, table));
    if (view.bugSel || view.bugFix) {
      const sel = view.bugSel;
      const set = sel ? new Set(sel.list) : null;
      const fixW = FIX_STATES.find(([k]) => k === view.bugFix)?.[1];
      const head = [
        sel ? sel.sev + " bugs in " + sel.label : "All bugs",
        fixW ? "fix state: " + fixW : null,
      ]
        .filter(Boolean)
        .join(" \u00B7 ");
      const list = bugs.filter(
        (x) => (!set || set.has(x.id)) && (!view.bugFix || fixState(x) === view.bugFix),
      );
      body.append(el("div", { class: "subhead", text: head + " (" + list.length + ")" }));
      if (!list.length) body.append(el("div", { class: "empty", text: "None." }));
      for (const b of list) {
        const links = (b.items ?? []).filter((id) => id !== b.id);
        body.append(
          el(
            "div",
            { class: "bugrow" },
            el(
              "div",
              { class: "bugmain" },
              openerBtn(b.id, b.id, "idbtn"),
              el("span", { class: "grow", text: b.title }),
            ),
            el(
              "div",
              { class: "bugmeta" },
              sevPill(b.severity),
              fixChip(b),
              prLink(b),
              b.pending ? pill(PENDING_TEXT, "info") : null,
              b.area ? el("span", { class: "muted", text: b.area }) : null,
              links.length
                ? el(
                    "span",
                    { class: "muted" },
                    "register: ",
                    links.map((id) =>
                      byId().get(id) ? openerBtn(id, id, "idbtn") : el("code", { text: id }),
                    ),
                  )
                : null,
            ),
          ),
        );
      }
    }
    const owed = fixedByNoteList();
    if (owed) body.append(owed);
  }

  // ---------- PRs & branches ----------
  function renderPrs() {
    const body = clear(panels.prs.body);
    const open = (snap.prs?.open ?? []).filter(
      (p) => !view.area || (p.areas ?? []).includes(view.area),
    );
    const branches = (snap.branches ?? []).filter(
      (b) => !view.area || (b.areas ?? []).includes(view.area),
    );
    if (view.area)
      body.append(
        el(
          "div",
          { class: "filterbar" },
          el("span", null, "Area ", el("code", { text: view.area })),
          el("button", {
            type: "button",
            class: "btn",
            text: "Clear",
            onclick: () => setArea(null),
          }),
        ),
      );
    body.append(el("div", { class: "subhead", text: `Open PRs (${open.length})` }));
    if (!open.length) body.append(el("div", { class: "empty", text: "None." }));
    else {
      const tb = el("tbody");
      for (const p of open) {
        const url = safeUrl(p.url);
        tb.append(
          el(
            "tr",
            null,
            el(
              "td",
              null,
              url
                ? el("a", {
                    href: url,
                    target: "_blank",
                    rel: "noopener noreferrer",
                    text: `#${p.number}`,
                  })
                : `#${p.number}`,
              p.draft ? el("div", { class: "muted", text: "draft" }) : null,
            ),
            el("td", { text: p.title }),
            el("td", null, pill(checkLabel(p.checks), checkKind(p.checks))),
            el("td", null, p.item ? openerBtn(p.item, p.item, "idbtn") : pill("untracked", "warn")),
            el("td", { class: "muted", text: (p.areas ?? []).join(", ") }),
            el(
              "td",
              { class: "muted" },
              el("span", { "data-at": p.updatedAt, text: agoIso(p.updatedAt) }),
            ),
          ),
        );
      }
      body.append(
        el(
          "div",
          { class: "scroll" },
          el(
            "table",
            { class: "wide-table" },
            el(
              "thead",
              null,
              el(
                "tr",
                null,
                ["PR", "Title", "Checks", "Item", "Areas", "Updated"].map((h) =>
                  el("th", { text: h }),
                ),
              ),
            ),
            tb,
          ),
        ),
      );
    }
    body.append(
      el("div", { class: "subhead", text: `Branches without a PR (${branches.length})` }),
    );
    if (!branches.length) body.append(el("div", { class: "empty", text: "None." }));
    for (const b of branches) {
      body.append(
        el(
          "div",
          { class: "ci-row" },
          el("code", { class: "grow", text: b.branch }),
          b.item ? openerBtn(b.item, b.item, "idbtn") : pill("untracked", "info"),
          el("span", { class: "muted", "data-at": b.date, text: agoIso(b.date) }),
        ),
      );
    }
    const merged = (snap.prs?.merged ?? []).slice(0, 5);
    if (merged.length && !view.area) {
      body.append(el("div", { class: "subhead", text: "Recently merged" }));
      for (const p of merged) {
        const url = safeUrl(p.url);
        body.append(
          el(
            "div",
            { class: "ci-row" },
            url
              ? el("a", {
                  href: url,
                  target: "_blank",
                  rel: "noopener noreferrer",
                  text: `#${p.number}`,
                })
              : `#${p.number}`,
            el("span", { class: "grow", text: p.title }),
            p.item ? el("code", { text: p.item }) : null,
            el("span", { class: "muted", "data-at": p.mergedAt, text: agoIso(p.mergedAt) }),
          ),
        );
      }
    }
  }

  // ---------- item card: a side sheet (full-height on phones) ----------
  const sheet = document.getElementById("sheet");
  const sheetBody = document.getElementById("sheet-body");
  const scrim = document.getElementById("scrim");
  const sheetClose = document.getElementById("sheet-close");
  const BEHIND = ["top", "summary", "main"].map((id) => document.getElementById(id));
  let sheetId = null;
  let opener = null;
  let hashHandled = false;
  let techOpen = false;
  let lastSig = "";

  function sentenceWhere(it) {
    const done = it.status === "live" || it.status === "verified";
    const gone = it.status === "parked" || it.status === "dropped";
    const parts = [];
    const lane = laneName(
      it.claimedBy && (snap.lanes ?? []).some((l) => l.id === it.claimedBy)
        ? it.claimedBy
        : it.lane,
    );
    const since = it.claimedAt ? sinceWords(now() - Date.parse(it.claimedAt)) : null;
    if (it.blocked) {
      parts.push(
        `Blocked: waiting for ${it.blocked.unblocker === "owner" ? "an owner decision" : it.blocked.by || "another item"}.`,
      );
    } else if (it.type === "release") {
      const t = (snap.trains ?? []).find((x) => x.id === it.id);
      const members = (t?.members ?? []).map((id) => byId().get(id)).filter(Boolean);
      const d = members.filter((m) => m.status === "live" || m.status === "verified").length;
      parts.push(`${itemStatus(it)}. ${d} of ${members.length} items done.`);
    } else {
      switch (it.status) {
        case "idea":
          parts.push("Still an idea; nobody has started.");
          break;
        case "planned":
          parts.push(
            it.lane === "owner"
              ? "Waiting for your decision."
              : lane
                ? `Planned for ${lane}; not started yet.`
                : "Planned; nobody has started yet.",
          );
          break;
        case "spec":
          parts.push(
            lane
              ? `Being written up by ${lane} before building.`
              : "Being written up before building.",
          );
          break;
        case "building":
          parts.push(
            lane ? `Being built by ${lane}${since ? ` since ${since}` : ""}.` : "Being built.",
          );
          break;
        case "review":
          parts.push(
            lane ? `In review, from ${lane}${since ? ` (claimed ${since})` : ""}.` : "In review.",
          );
          break;
        case "ready":
          parts.push("Built and ready to ship.");
          break;
        case "shipping":
          parts.push("Shipping now.");
          break;
        case "live":
          parts.push("Live.");
          break;
        case "verified":
          parts.push("Live and verified.");
          break;
        case "parked":
          parts.push("Parked for now.");
          break;
        case "dropped":
          parts.push("Dropped; it will not be built.");
          break;
        default:
          parts.push(`${statusWord(it.status)}.`);
      }
    }
    if (!done && !gone && it.type !== "release") {
      const t = it.train ? (snap.trains ?? []).find((x) => x.id === it.train) : null;
      const when = it.eta || it.etaAt ? etaWords(it.eta, it.etaAt) : t ? trainEta(t) : null;
      if (it.train) parts.push(`Ships with release ${it.train}${when ? `, target ${when}` : ""}.`);
      else if (when) parts.push(`Target ${when}.`);
    } else if (it.type === "release" && !done && !gone) {
      const when = etaWords(it.eta, it.etaAt);
      if (when) parts.push(`Target ${when}.`);
    }
    // Pull requests, in words.
    const pr = [];
    for (const n of it.links?.prs ?? []) {
      const open = (snap.prs?.open ?? []).find((p) => p.number === n);
      const merged = (snap.prs?.merged ?? []).find((p) => p.number === n);
      if (open) {
        const st = open.draft
          ? "still a draft"
          : open.checks === "SUCCESS"
            ? "open, waiting for review"
            : open.checks === "FAILURE" || open.checks === "ERROR"
              ? "open, but its checks are failing"
              : "open, checks still running";
        pr.push(`PR #${n} is ${st}`);
      } else if (merged) pr.push(`PR #${n} is merged`);
    }
    if (pr.length) parts.push(pr.join("; ") + ".");
    if (!done && !gone && !it.blocked) {
      const asks = it.ownerAsk || (snap.ownerQueue ?? []).some((o) => o.id === it.id);
      parts.push(asks ? "Needs your answer, see below." : "Nothing needed from you.");
    }
    return parts.join(" ");
  }

  const section = (title, node, cls) =>
    el("section", { class: `sec ${cls ?? ""}` }, el("h3", { text: title }), node);
  const para = (t) => el("p", { text: t });
  const unwritten = () => el("p", { class: "muted", text: "Not written up yet." });

  function teamDetails(it) {
    const rows = [];
    const row = (k, v) =>
      v !== null &&
      v !== undefined &&
      v !== "" &&
      rows.push(el("dt", { text: k }), el("dd", null, v));
    const code = (t) => el("code", { text: t });
    row("Id", code(it.id));
    row("Type", it.type);
    row("Priority", `${prioWord(it.priority)} (${it.priority})`);
    row("Status", `${itemStatus(it)} (${it.status})`);
    row("Gate", it.gate);
    row("Lane", it.lane);
    row(
      "Claimed by",
      it.claimedBy
        ? `${it.claimedBy}${it.claimedAt ? `, ${sinceWords(now() - Date.parse(it.claimedAt))}` : ""}`
        : null,
    );
    row("Release", it.train);
    row("Area", it.area);
    row("Domain", it.domain);
    if (it.blocked)
      row(
        "Blocked by",
        `${it.blocked.by}${it.blocked.unblocker ? ` (unblocker: ${it.blocked.unblocker})` : ""}`,
      );
    row("ETA (raw)", it.eta);
    row("Tags", (it.tags ?? []).join(", "));
    const idList = (ids) =>
      ids?.length
        ? el(
            "span",
            { class: "idlist" },
            ids.map((id) => (byId().get(id) ? openerBtn(id, id, "idbtn") : code(id))),
          )
        : null;
    row("Part of", it.parent ? idList([it.parent]) : null);
    row("Includes", idList(it.children));
    row("Members", idList(it.members));
    row("Related", idList(it.related));
    const prs = (it.links?.prs ?? []).map((n) => {
      const p = [...(snap.prs?.open ?? []), ...(snap.prs?.merged ?? [])].find(
        (x) => x.number === n,
      );
      const url = safeUrl(p?.url);
      return url
        ? el("a", { href: url, target: "_blank", rel: "noopener noreferrer", text: `#${n}` })
        : code(`#${n}`);
    });
    row("PRs", prs.length ? el("span", { class: "idlist" }, prs) : null);
    row("Branches", (it.links?.branches ?? []).join(", "));
    const urls = (it.links?.urls ?? []).map(safeUrl).filter(Boolean);
    row(
      "Links",
      urls.length
        ? el(
            "span",
            { class: "idlist" },
            urls.map((u) =>
              el("a", { href: u, target: "_blank", rel: "noopener noreferrer", text: u }),
            ),
          )
        : null,
    );
    row("Created", localStamp(it.createdAt));
    row("Updated", localStamp(it.updatedAt));
    const hist =
      Array.isArray(it.history) && it.history.length
        ? el(
            "ol",
            { class: "hist" },
            it.history.map((h) =>
              el("li", {
                class: "mono",
                text: [localStamp(h.ts), h.kind, h.status, h.lane, h.actor]
                  .filter(Boolean)
                  .join("  "),
              }),
            ),
          )
        : null;
    const d = el(
      "details",
      { class: "tech" },
      el("summary", { text: "Details for the team" }),
      el("dl", { class: "kv" }, rows),
      hist ? el("div", { class: "subhead", text: "History" }) : null,
      hist,
    );
    d.open = techOpen;
    d.addEventListener("toggle", () => (techOpen = d.open));
    return d;
  }

  function renderSheet(id) {
    const bug = (snap.bugs ?? []).find((b) => b.id === id) ?? null;
    const it = byId().get(id) ?? (bug ? bugAsItem(bug) : null);
    const sig = JSON.stringify([
      it,
      bug,
      snap.prs?.open?.filter((p) => (it?.links?.prs ?? []).includes(p.number)),
      snap.ownerQueue?.some((o) => o.id === id),
      (snap.lanes ?? []).map((l) => l.title),
    ]);
    if (sig === lastSig && sheetBody.firstChild) return;
    lastSig = sig;
    const top = sheetBody.scrollTop;
    clear(sheetBody);
    if (!it) {
      sheetBody.append(
        el("h2", { id: "sheet-title", class: "sheet-title", text: "Item not found" }),
        el("p", {
          class: "muted",
          text: `Nothing on the board has the id ${id}. It may have been removed.`,
        }),
      );
      return;
    }
    const written = Boolean(it.problem || it.impact || it.solution);
    const jargon = !it._bug && it.problem && JARGON.test(it.title);
    const head = jargon ? firstSentence(it.problem) : it.title;
    sheetBody.append(
      ...[
        el("h2", { id: "sheet-title", class: "sheet-title", text: head }),
        jargon ? el("p", { class: "realtitle", text: it.title }) : null,
        el(
          "div",
          { class: "sheet-tags" },
          bug
            ? null
            : pill(
                prioWord(it.priority),
                it.priority === "P0" ? "err" : it.priority === "P1" ? "warn" : "",
                it.priority,
              ),
          bug && it._bug ? null : pill(itemStatus(it), DONE.has(it.status) ? "ok" : "", it.status),
          bug ? sevPill(bug.severity) : null,
          bug ? fixChip(bug) : null,
          bug?.area ? pill(bug.area, "") : null,
          bug?.pending ? pill(PENDING_TEXT, "info") : null,
          it.blocked ? pill("Blocked", "err") : null,
          it.summaryDraft ? pill("Draft summary", "info") : null,
        ),
        it.summaryDraft
          ? el("p", {
              class: "draftnote muted",
              text: "Written from the register; the team will confirm it.",
            })
          : null,
      ].filter(Boolean),
    );
    if (it._bug) sheetBody.append(section("What's wrong", para(it.title)));
    else if (!written) sheetBody.append(section("What's wrong", unwritten()));
    else {
      sheetBody.append(
        section("What's wrong", it.problem ? para(it.problem) : unwritten()),
        section("What it's causing", it.impact ? para(it.impact) : unwritten()),
        section("How we're solving it", it.solution ? para(it.solution) : unwritten()),
      );
    }
    if (bug) {
      const pl = prLink(bug);
      const links = (bug.items ?? []).filter((x) => x !== id);
      sheetBody.append(
        section(
          "Where it is now",
          el(
            "div",
            null,
            para(fixSentence(bug)),
            pl ? el("p", null, "Pull request ", pl) : null,
            links.length
              ? el(
                  "p",
                  { class: "muted" },
                  "Register items: ",
                  links.map((x) =>
                    byId().get(x) ? openerBtn(x, x, "idbtn") : el("code", { text: x }),
                  ),
                )
              : null,
            it._bug ? null : para(sentenceWhere(it)),
          ),
        ),
      );
    } else sheetBody.append(section("Where it is now", para(sentenceWhere(it))));
    if (it.ownerAsk) {
      const rec = recommended(it.gate);
      sheetBody.append(
        section(
          "What we need from you",
          el(
            "div",
            null,
            para(it.ownerAsk),
            rec ? el("p", { class: "muted", text: `Recommended: ${rec}` }) : null,
          ),
          "ask",
        ),
      );
    }
    if (!it._bug) sheetBody.append(teamDetails(it));
    sheetBody.scrollTop = top;
  }

  function focusables() {
    return [
      ...sheet.querySelectorAll(
        "button, a[href], summary, input, select, textarea, [tabindex]:not([tabindex='-1'])",
      ),
    ].filter((n) => !n.disabled && n.offsetParent !== null);
  }

  function showSheet(id) {
    if (!snap) return; // applied once the first snapshot arrives
    const wasOpen = sheetId !== null;
    sheetId = id;
    lastSig = "";
    renderSheet(id);
    sheet.classList.add("open");
    scrim.classList.add("open");
    sheet.setAttribute("aria-hidden", "false");
    for (const n of BEHIND) n?.setAttribute("inert", "");
    if (!wasOpen) {
      sheetBody.scrollTop = 0;
      sheetClose.focus({ preventScroll: true });
    } else sheetBody.scrollTop = 0;
  }

  function hideSheet(stripHash) {
    if (sheetId === null) return;
    sheetId = null;
    sheet.classList.remove("open");
    scrim.classList.remove("open");
    sheet.setAttribute("aria-hidden", "true");
    for (const n of BEHIND) n?.removeAttribute("inert");
    if (stripHash && /^#item=/.test(location.hash)) {
      try {
        history.replaceState(null, "", location.pathname + location.search);
      } catch {
        /* ignore */
      }
    }
    // Return focus to the opener; the lists re-render, so fall back to its replacement by item id.
    let back = opener;
    if (!back || !back.isConnected) {
      const id = back?.getAttribute?.("data-item");
      back = id ? document.querySelector(`[data-item="${CSS.escape(id)}"]`) : null;
    }
    opener = null;
    if (back) back.focus({ preventScroll: true });
  }

  function syncHash() {
    const m = /^#item=(.+)$/.exec(location.hash);
    if (m) {
      let id = m[1];
      try {
        id = decodeURIComponent(id);
      } catch {
        /* keep raw */
      }
      showSheet(id);
    } else if (sheetId !== null) hideSheet(false);
  }

  function openItem(id, from) {
    if (sheetId === null && from) opener = from;
    const h = "#item=" + encodeURIComponent(id);
    if (location.hash === h) showSheet(id);
    else location.hash = h;
  }

  addEventListener("hashchange", syncHash);
  sheetClose.addEventListener("click", () => hideSheet(true));
  scrim.addEventListener("click", () => hideSheet(true));
  document.addEventListener("keydown", (e) => {
    if (sheetId === null) return;
    if (e.key === "Escape") {
      e.preventDefault();
      hideSheet(true);
    } else if (e.key === "Tab") {
      const f = focusables();
      if (!f.length) return e.preventDefault();
      const first = f[0];
      const last = f[f.length - 1];
      if (!sheet.contains(document.activeElement)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });

  // ---------- render all ----------
  let controlsKey = "";
  function renderAll() {
    renderHeader();
    renderSummary();
    renderAlarms();
    renderCi();
    renderLanes();
    renderMap();
    renderReleases();
    renderOwner();
    renderPrs();
    const key =
      JSON.stringify([...new Set(snap.items.map((i) => i.lane))].sort()) + snap.items.length;
    if (key !== controlsKey) {
      controlsKey = key;
      buildControls();
    }
    renderTree();
    renderBugs();
    tickAges();
  }

  function apply(next) {
    if (!next || !Array.isArray(next.items)) return;
    if (!skewSet) {
      const gen = Date.parse(next.generatedAt);
      if (Number.isFinite(gen) && Math.abs(gen - Date.now()) > 5 * 60000) skew = gen - Date.now();
      skewSet = true;
    }
    if (typeof next.authEnabled === "boolean") authEnabled = next.authEnabled;
    document.querySelector(".logout")?.toggleAttribute("hidden", authEnabled !== true);
    snap = next;
    renderAll();
    if (!hashHandled) {
      hashHandled = true;
      syncHash();
    } else if (sheetId) renderSheet(sheetId);
  }

  // ---------- transport ----------
  const conn = document.getElementById("conn");
  function setConn(kind, text) {
    conn.className = `conn ${kind}`;
    conn.querySelector("span").textContent = text;
  }
  let pollTimer = null;
  // A 401 means the session ended (or never began): the login page is the only way back in.
  function toLogin() {
    location.href = "/login";
  }
  async function poll() {
    try {
      const r = await fetch("/api/snapshot", { cache: "no-store" });
      if (r.status === 401) return toLogin();
      apply(await r.json());
      setConn("amber", "polling");
    } catch {
      setConn("red", "offline");
    }
  }
  function startPolling() {
    if (pollTimer) return;
    poll();
    pollTimer = setInterval(poll, 30000);
  }
  // The first snapshot over HTTP carries authEnabled; SSE frames may not, so ask once up front.
  async function prime() {
    try {
      const r = await fetch("/api/snapshot", { cache: "no-store" });
      if (r.status === 401) return toLogin();
      const j = await r.json();
      if (typeof j.authEnabled === "boolean") {
        authEnabled = j.authEnabled;
        document.querySelector(".logout")?.toggleAttribute("hidden", authEnabled !== true);
      }
      if (!snap) apply(j);
    } catch {
      /* the stream or the poller will report the problem */
    }
  }
  function connect() {
    prime();
    if (typeof EventSource === "undefined") return startPolling();
    const es = new EventSource("/sse");
    es.addEventListener("snapshot", (ev) => {
      try {
        apply(JSON.parse(ev.data));
        setConn("ok", "live");
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
      } catch {
        setConn("red", "bad data");
      }
    });
    es.addEventListener("error", () => {
      setConn("amber", "reconnecting");
      // EventSource hides the HTTP status, so ask the snapshot endpoint (it answers 401 when logged out).
      fetch("/api/snapshot", { cache: "no-store" }).then(
        (r) => r.status === 401 && toLogin(),
        () => {},
      );
      startPolling();
    });
  }

  // Scroll-edge: the header gains its hairline only once content moves under it.
  const onScroll = () => root.toggleAttribute("data-scrolled", window.scrollY > 4);
  addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  setInterval(tickAges, 1000);
  connect();
})();
