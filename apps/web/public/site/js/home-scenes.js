/* The four small scenes of the owner's motion sketch (stores, counter, delivery, owner), ported scene for scene:
   same people, same moves, same timings, same eases. Each scene sits at rest until its own board is on screen, then plays once
   from the start every time it comes back into view. Motion is always on (no reduced-motion gate). Colours live in
   css/home-scenes.css; this file moves parts and never sets a colour. */
(function () {
  var W = window, d = document, g = W.gsap, ST = W.ScrollTrigger;
  if (!g || !ST) return;
  g.registerPlugin(ST);
  var NS = "http://www.w3.org/2000/svg", GY = 206, IO = "power2.inOut", OUT = "power3.out", IN = "power2.in", SW = "sine.inOut";

  function person(c) {
    return '<g class="bob">' +
      '<g class="legB pp-opaque"><rect class="pp-pants" x="-8" y="-36" width="10" height="34" rx="5"/><rect class="pp-shoe" x="-9" y="-6" width="15" height="7" rx="3.5"/></g>' +
      '<g class="armB"><path class="pp-dark-s" d="M-1 -76v27" stroke-width="9" stroke-linecap="round"/><circle class="pp-skin" cx="-1" cy="-46" r="5"/></g>' +
      '<g class="legF"><rect class="pp-pants" x="-2" y="-36" width="10" height="34" rx="5"/><rect class="pp-shoe" x="-3" y="-6" width="15" height="7" rx="3.5"/></g>' +
      '<rect class="pp-shirt" x="-13" y="-82" width="26" height="50" rx="11"/>' +
      (c.apron ? '<rect class="pp-apron" x="-9" y="-66" width="20" height="34" rx="4"/>' : "") +
      '<g class="head"><rect class="pp-skin" x="-3" y="-88" width="8" height="9"/>' + (c.bun ? '<circle class="pp-hair" cx="-10" cy="-108" r="6"/>' : "") +
      '<circle class="pp-skin" cx="1" cy="-97" r="13"/><path class="pp-hair" d="M-12 -98A13 13 0 0 1 14 -98L14 -101Q1 -117 -12 -101Z"/>' +
      (c.cap ? '<path class="pp-cap" d="M-12 -102a13 11 0 0 1 26 0z"/><rect class="pp-brim" x="2" y="-104" width="19" height="5" rx="2.5"/>' : "") +
      '<circle class="pp-eye" cx="7" cy="-96" r="1.6"/><circle class="pp-eye" cx="-1" cy="-96" r="1.6"/>' +
      (c.smile ? '<path class="mFlat pp-mouth" d="M1 -90h6"/><path class="mSmile pp-mouth" d="M0 -91q4 4 8 0"/>'
               : '<path class="pp-mouth" d="M1 -91q3 2.500 6 0"/>') + "</g>" +
      '<g class="carry"><rect class="sc-f-box" x="13" y="-76" width="26" height="22" rx="3"/><rect class="sc-f-tape" x="23" y="-76" width="6" height="22"/></g>' +
      '<g class="armF"><path class="pp-shirt-s" d="M2 -76v27" stroke-width="9" stroke-linecap="round"/><circle class="pp-skin" cx="2" cy="-46" r="5"/>' +
        '<g class="phone"><rect class="pp-phone" x="-4" y="-50" width="12" height="20" rx="3"/><rect class="scr pp-scr" x="-2" y="-47" width="8" height="13" rx="1.500"/><rect class="scrOn pp-scr-on" x="-2" y="-47" width="8" height="13" rx="1.500"/></g></g>' +
    "</g>";
  }
  var CAST = { store: { bun: true }, clerk: { apron: true }, walkin: {}, driver: { cap: true }, owner: { smile: true } };

  function rig(el, key, x, dir) {
    el.innerHTML = person(CAST[key]);
    var q = function (s) { return el.querySelector(s); };
    var R = { root: el, bob: q(".bob"), legF: q(".legF"), legB: q(".legB"), armF: q(".armF"), armB: q(".armB"), head: q(".head"), carry: q(".carry"),
      phone: q(".phone"), scr: q(".scr"), scrOn: q(".scrOn"), mFlat: q(".mFlat"), mSmile: q(".mSmile") };
    g.set(R.root, { svgOrigin: "0 0", x: x, y: GY, scaleX: dir || 1 }); g.set(R.legF, { svgOrigin: "3 -36" }); g.set(R.legB, { svgOrigin: "-3 -36" });
    g.set(R.armF, { svgOrigin: "2 -76" }); g.set(R.armB, { svgOrigin: "-1 -76" }); g.set(R.head, { svgOrigin: "1 -84" }); g.set(R.bob, { svgOrigin: "0 0" });
    g.set([R.carry, R.phone, R.scrOn], { autoAlpha: 0 }); if (R.mSmile) g.set(R.mSmile, { autoAlpha: 0 });
    return R;
  }
  function swing(tl, target, amp, t, dur, n) {
    var step = dur / n;
    tl.to(target, { rotation: amp, duration: step / 2, ease: "sine.out" }, t);
    if (n > 1) tl.to(target, { rotation: -amp, duration: step, ease: SW, yoyo: true, repeat: n - 2 }, t + step / 2);
    tl.to(target, { rotation: 0, duration: step / 2, ease: "sine.in" }, t + dur - step / 2);
  }
  function walk(tl, R, toX, t, dur, carrying) {
    var n = Math.max(2, Math.round(dur / 0.3));
    tl.to(R.root, { x: toX, duration: dur, ease: "power1.inOut" }, t);
    swing(tl, R.legF, 24, t, dur, n); swing(tl, R.legB, -24, t, dur, n);
    if (!carrying) { swing(tl, R.armF, -18, t, dur, n); swing(tl, R.armB, 18, t, dur, n); }
    tl.to(R.bob, { y: -2.2, duration: dur / (2 * n), ease: SW, yoyo: true, repeat: 2 * n - 1 }, t);
  }
  function hold(tl, R, on, t) {
    if (on) tl.set(R.carry, { autoAlpha: 1 }, t).to([R.armF, R.armB], { rotation: -72, duration: 0.18, ease: OUT }, t);
    else tl.set(R.carry, { autoAlpha: 0 }, t).to([R.armF, R.armB], { rotation: 0, duration: 0.25, ease: IO }, t);
  }
  function phoneUp(tl, R, t) {
    tl.set(R.phone, { autoAlpha: 1 }, t).to(R.armF, { rotation: -128, duration: 0.3, ease: OUT }, t).to(R.head, { rotation: 8, duration: 0.25, ease: OUT }, t + 0.05)
      .to(R.armF, { rotation: -122, duration: 0.09, ease: SW, yoyo: true, repeat: 1 }, t + 0.42).to(R.scrOn, { autoAlpha: 1, duration: 0.12 }, t + 0.5);
  }
  function phoneDown(tl, R, t) {
    tl.to(R.armF, { rotation: 0, duration: 0.28, ease: IO }, t).to(R.head, { rotation: 0, duration: 0.25, ease: IO }, t).set(R.phone, { autoAlpha: 0 }, t + 0.2);
  }
  function at(el, x, y, extra) { g.set(el, Object.assign({ svgOrigin: "0 0", x: x, y: y }, extra || {})); }
  function chipIn(tl, el, t) { tl.to(el, { autoAlpha: 1, scale: 1, duration: 0.28, ease: OUT }, t); }

  /* One board: built paused, plays from the start when it comes on screen, goes back to rest when it leaves. */
  function board(name, build) {
    var root = d.querySelector('[data-board="' + name + '"]');
    if (!root) return;
    var q = function (s) { return root.querySelector(s); }, qa = function (s) { return g.utils.toArray(root.querySelectorAll(s)); };
    var tl = g.timeline({ paused: true, defaults: { ease: IO } });
    build(q, qa, tl);
    var go = function () { tl.restart(); }, rest = function () { tl.pause(0); };
    ST.create({ trigger: root, start: "top 72%", end: "bottom 18%", onEnter: go, onEnterBack: go });
    ST.create({ trigger: root, start: "top bottom", end: "bottom top", onLeave: rest, onLeaveBack: rest });
    root.classList.add("is-set");
  }

  board("stores", function (q, qa, tl) {
    var items = q(".items"), n = 0;
    [92, 140, 188].forEach(function (y, row) {
      for (var i = 0; i < 4; i++) {
        if (row === 1 && i === 1) continue;
        var e = d.createElementNS(NS, "rect"), h = 22 + ((i + row) % 3) * 5;
        e.setAttribute("x", 208 + i * 33); e.setAttribute("y", y - h - 1.5); e.setAttribute("width", 22); e.setAttribute("height", h); e.setAttribute("rx", 3);
        e.setAttribute("class", "sc-i" + (n++ % 6)); items.appendChild(e);
      }
    });
    at(q(".lowTag"), 252, 118); at(q(".gapBox"), 252, 60, { autoAlpha: 0 }); at(q(".tile"), 40, 46); at(q(".sent"), 176, 96, { autoAlpha: 0, scale: 0.7 }); at(q(".end"), 269, 26, { autoAlpha: 0, scale: 0.8 });
    var P = rig(q('[data-person="store"]'), "store", -34, 1);
    walk(tl, P, 150, 0.15, 1.3); tl.to(P.head, { rotation: -10, duration: 0.25, ease: OUT }, 1.5).to(q(".lowTag"), { scale: 1.25, duration: 0.16, yoyo: true, repeat: 1 }, 1.6);
    phoneUp(tl, P, 1.95);
    tl.to(q(".sent"), { autoAlpha: 1, scale: 1, duration: 0.2, ease: OUT }, 2.5).to(q(".sent"), { x: 62, y: 62, duration: 0.6 }, 2.75).to(q(".sent"), { autoAlpha: 0, scale: 0.5, duration: 0.15, ease: IN }, 3.3)
      .to(q(".tile"), { scale: 1.16, duration: 0.15, yoyo: true, repeat: 1 }, 3.35);
    phoneDown(tl, P, 3.35); tl.set(P.root, { scaleX: -1 }, 3.7); walk(tl, P, -40, 3.75, 1.2);
    tl.to(q(".gapBox"), { autoAlpha: 1, duration: 0.1 }, 4.9).to(q(".gapBox"), { y: 139, duration: 0.45, ease: OUT }, 4.9).to(q(".lowTag"), { autoAlpha: 0, y: 108, duration: 0.25, ease: IN }, 5.1);
    chipIn(tl, q(".end"), 5.35);
  });

  board("counter", function (q, qa, tl) {
    var ps = qa("[data-person]"), C = rig(ps[0], "clerk", -34, 1), K = rig(ps[1], "walkin", 400, -1);
    at(q(".sbox"), 274, 152, { autoAlpha: 0 }); at(q(".ok"), 274, 112, { scale: 0.4, autoAlpha: 0 }); at(q(".end"), 170, 44, { autoAlpha: 0, scale: 0.8 }); g.set(q(".beam"), { autoAlpha: 0 }); g.set(q(".receipt"), { y: 14 });
    g.set(K.carry, { autoAlpha: 1 }); g.set([K.armF, K.armB], { rotation: -72 });
    walk(tl, C, 152, 0.15, 1.2); walk(tl, K, 300, 0.3, 1.2, true);
    tl.set(q(".sbox"), { autoAlpha: 1 }, 1.6); hold(tl, K, false, 1.6);
    tl.to(C.armF, { rotation: -74, duration: 0.25, ease: OUT }, 1.85)
      .to(q(".beam"), { autoAlpha: 1, duration: 0.07, ease: "none" }, 2.15).to(q(".beam"), { autoAlpha: 0, duration: 0.07, ease: "none" }, 2.3)
      .to(q(".beam"), { autoAlpha: 1, duration: 0.07, ease: "none" }, 2.42).to(q(".beam"), { autoAlpha: 0, duration: 0.1, ease: "none" }, 2.56)
      .to(q(".ok"), { scale: 1, autoAlpha: 1, duration: 0.22, ease: OUT }, 2.6).to(q(".ok"), { autoAlpha: 0, duration: 0.2 }, 3.4)
      .to(C.armF, { rotation: 0, duration: 0.25 }, 2.75).to(q(".receipt"), { y: -12, duration: 0.45, ease: OUT }, 2.9);
    tl.set(q(".sbox"), { autoAlpha: 0 }, 3.5); hold(tl, K, true, 3.5); tl.set(K.root, { scaleX: 1 }, 3.75); walk(tl, K, 420, 3.8, 1.2, true);
    tl.set(C.root, { scaleX: -1 }, 3.9); walk(tl, C, -40, 3.95, 1.2);
    chipIn(tl, q(".end"), 5.0);
  });

  board("delivery", function (q, qa, tl) {
    var T = q(".truck"), tw = qa(".tw"), D = rig(q('[data-person="driver"]'), "driver", 142, 1);
    at(T, -130, GY); at(tw[0], -34, -10); at(tw[1], 30, -10); at(q(".gbox"), 263, GY, { autoAlpha: 0 }); at(q(".end"), 307, 32, { autoAlpha: 0, scale: 0.8 }); g.set(D.root, { autoAlpha: 0 });
    tl.to(T, { x: 76, duration: 1.1, ease: OUT }, 0.15).to(tw, { rotation: 540, duration: 1.1, ease: OUT }, 0.15);
    tl.set(D.carry, { autoAlpha: 1 }, 1.2).set([D.armF, D.armB], { rotation: -72 }, 1.2).to(D.root, { autoAlpha: 1, duration: 0.15, ease: "none" }, 1.25);
    walk(tl, D, 236, 1.4, 1.2, true);
    tl.set(q(".gbox"), { autoAlpha: 1 }, 2.7); hold(tl, D, false, 2.7);
    phoneUp(tl, D, 3.0); chipIn(tl, q(".end"), 3.55); phoneDown(tl, D, 3.75);
    tl.set(D.root, { scaleX: -1 }, 4.1); walk(tl, D, 142, 4.15, 1.1); tl.to(D.root, { autoAlpha: 0, duration: 0.15, ease: "none" }, 5.2);
    tl.to(T, { x: 500, duration: 1.3, ease: IN }, 5.45).to(tw, { rotation: 1500, duration: 1.3, ease: IN }, 5.45);
  });

  board("owner", function (q, qa, tl) {
    var O = rig(q('[data-person="owner"]'), "owner", 140, 1), th = qa(".th");
    at(th[0], 92, 44, { rotation: -6 }); at(th[1], 146, 24, { rotation: 5 }); at(th[2], 206, 40, { rotation: 4 }); at(q(".end"), 206, 66, { autoAlpha: 0, scale: 0.8 });
    g.set(q(".lapWheel"), { autoAlpha: 0 });
    th.forEach(function (e, i) {
      tl.to(e, { x: 206, y: 126, scale: 0.15, rotation: 0, duration: 0.45, ease: IN }, 0.5 + i * 0.32).to(e, { autoAlpha: 0, duration: 0.08, ease: "none" }, 0.9 + i * 0.32);
    });
    tl.to(q(".lapWheel"), { autoAlpha: 1, duration: 0.3, ease: OUT }, 1.75)
      .to(O.mFlat, { autoAlpha: 0, duration: 0.12 }, 1.9).to(O.mSmile, { autoAlpha: 1, duration: 0.12 }, 1.9).to(O.head, { rotation: 6, duration: 0.2, ease: OUT }, 1.9).to(O.head, { rotation: 0, duration: 0.2 }, 2.2);
    chipIn(tl, q(".end"), 2.2); walk(tl, O, 420, 2.6, 1.5);
  });

  /* The story, as the sketch has it: one wheel, drawn here, is both the opening picture and the story. Texts, price notes, a
     bill and a ledger fall into it; it opens, brings Orders to the front and turns for Delivery, Invoices and Payments while
     one order goes by as an order sheet, a box and bottles, a truck, an invoice and a check; then it closes and ripples.
     Scrubbed by the scroll over the tall section, with the sketch's moves and eases. */
  (function story() {
    var sec = d.getElementById("story");
    if (!sec || !d.documentElement.classList.contains("js-motion")) return;
    var NS = "http://www.w3.org/2000/svg", RAD = Math.PI / 180;
    var q = function (s) { return sec.querySelector(s); }, qa = function (s) { return g.utils.toArray(sec.querySelectorAll(s)); };
    var ICON = {"purchases": "<path d=\"M8 17l16-9 16 9v15l-16 9-16-9z\"/><path d=\"M8 17l16 9 16-9M24 26v15\"/>", "bills": "<path d=\"M12 6h24v36l-4-3.5-4 3.5-4-3.5-4 3.5-4-3.5-4 3.5z\"/><path d=\"M18 15h12M18 22h12M18 29h7\"/>", "inventory": "<rect x=\"7\" y=\"26\" width=\"16\" height=\"14\" rx=\"2.5\"/><rect x=\"25\" y=\"26\" width=\"16\" height=\"14\" rx=\"2.5\"/><rect x=\"16\" y=\"9\" width=\"16\" height=\"14\" rx=\"2.5\"/>", "orders": "<rect x=\"11\" y=\"7\" width=\"26\" height=\"35\" rx=\"4\"/><path d=\"M18 17h12M18 24h12M18 31h7\"/>", "routes": "<circle cx=\"12\" cy=\"37\" r=\"4\"/><circle cx=\"36\" cy=\"11\" r=\"4\"/><path d=\"M16 37h15a7 7 0 0 0 0-14H17a6 6 0 0 1 0-12h15\"/>", "delivery": "<path d=\"M9 35H4V12h25v23H17M29 19h8l7 8v8h-5M31 35h-2\"/><circle cx=\"13\" cy=\"36\" r=\"4\"/><circle cx=\"35\" cy=\"36\" r=\"4\"/>", "invoices": "<path d=\"M13 6h15l9 9v27H13z\"/><path d=\"M28 6v9h9M19 24h12M19 31h12\"/>", "payments": "<circle cx=\"24\" cy=\"24\" r=\"17\"/><path d=\"M16 24.5l6 6 11-12\"/>", "customers": "<path d=\"M8 20l3-11h26l3 11M8 20a5.3 5.3 0 0 0 10.7 0 5.3 5.3 0 0 0 10.6 0 5.3 5.3 0 0 0 10.7 0M11 25v15h26V25M21 40v-9h6v9\"/>", "reports": "<path d=\"M7 41h34\"/><rect x=\"11\" y=\"25\" width=\"7\" height=\"11\" rx=\"1.5\"/><rect x=\"21\" y=\"16\" width=\"7\" height=\"20\" rx=\"1.5\"/><rect x=\"31\" y=\"8\" width=\"7\" height=\"28\" rx=\"1.5\"/>", "boxpiece": "<path d=\"M6 16l13-7 13 7v13l-13 7-13-7zM6 16l13 7 13-7M19 23v13\"/><rect x=\"33\" y=\"30\" width=\"10\" height=\"10\" rx=\"2\"/>", "price": "<path d=\"M8 8h15l17 17-15 15L8 23z\"/><circle cx=\"16\" cy=\"16\" r=\"2.5\"/>", "store": "<rect x=\"14\" y=\"5\" width=\"20\" height=\"38\" rx=\"4.5\"/><path d=\"M21 37h6\"/>", "counter": "<path d=\"M6 13V9h6M36 9h6v4M42 35v4h-6M12 39H6v-4M13 16v16M19 16v16M25 16v16M30 16v16M35 16v16\"/>", "returns": "<path d=\"M18 11L8 21l10 10\"/><path d=\"M8 21h23a9 9 0 0 1 0 18h-8\"/>"};
    var OUTER = [["purchases", "Purchases"], ["bills", "Supplier bills"], ["inventory", "Inventory"], ["orders", "Orders"], ["routes", "Routes"], ["delivery", "Delivery"], ["invoices", "Invoices"], ["payments", "Payments"], ["customers", "Customers"], ["reports", "Reports"]];
    var INNER = [["boxpiece", "Box or piece"], ["price", "Each buyer’s price"], ["store", "Store ordering"], ["counter", "Counter sales"], ["returns", "Returns"]];
    function el(tag, attrs, parent, html) { var e = d.createElementNS(NS, tag); for (var k in attrs) e.setAttribute(k, attrs[k]); if (html != null) e.innerHTML = html; if (parent) parent.appendChild(e); return e; }
    function arc(r0, r1, a0, a1) {
      var p = function (r, a) { return (r * Math.cos(a * RAD)).toFixed(2) + " " + (r * Math.sin(a * RAD)).toFixed(2); };
      return "M" + p(r0, a0) + "L" + p(r1, a0) + "A" + r1 + " " + r1 + " 0 0 1 " + p(r1, a1) + "L" + p(r0, a1) + "A" + r0 + " " + r0 + " 0 0 0 " + p(r0, a0) + "Z";
    }
    var pcs = {}, tops = [], walls = [], icr = { o: [], i: [] }, ics = [];
    var ringO = q(".ringO"), ringI = q(".ringI"), wallO = q(".wallO"), wallI = q(".wallI"), tilt = q(".tilt"), tiltW = q(".tiltW");
    function ring(list, topG, wallG, r0, r1, angOf, span, key, inner) {
      list.forEach(function (dd, k) {
        var a = angOf(k), dp = arc(r0, r1, a - span / 2 + 1.1, a + span / 2 - 1.1), rm = (r0 + r1) / 2, cls = inner ? " i" : "";
        var w = el("g", {}, wallG); el("path", { d: dp, "class": "rg-wall" + cls }, w);
        var t = el("g", { "data-part": dd[1] }, topG); el("path", { d: dp, "class": "rg-top" }, t);
        var c = el("path", { d: dp, "class": "rg-col" + cls, opacity: "0" }, t);
        var pos = el("g", { transform: "translate(" + (rm * Math.cos(a * RAD)).toFixed(2) + " " + (rm * Math.sin(a * RAD)).toFixed(2) + ")" }, t);
        var rot = el("g", {}, pos), sc = el("g", {}, rot);
        var at = "translate(-12 -12) scale(.5)";
        var ic = el("g", { transform: at, "class": "rg-ic" }, sc, ICON[dd[0]]);
        var icl = el("g", { transform: at, "class": "rg-ic lit", opacity: "0" }, sc, ICON[dd[0]]);
        g.set([rot, sc], { svgOrigin: "0 0" });
        pcs[dd[0]] = { top: t, wall: w, col: c, ic: ic, icl: icl, a: a, rm: rm };
        tops.push(t); walls.push(w); icr[key].push(rot); ics.push(sc);
      });
    }
    ring(OUTER, ringO, wallO, 98, 150, function (k) { return 90 + (k - 5) * 36; }, 36, "o", false);
    ring(INNER, ringI, wallI, 44, 92, function (j) { return -90 + j * 72; }, 72, "i", true);

    var caps = qa(".stx-cap"), steps = qa(".stx-steps li"), progB = q(".stx-prog b"), pillT = q(".pillT"), bts = qa(".bt"), tws = qa(".oTruck .tw");
    var O = { svgOrigin: "0 0" };
    var wide = W.innerWidth >= 1000 && W.innerHeight > 560;
    var R0 = { x: 200, y: 222, s: wide ? 1.04 : 0.9 }, OP = { x: 200, y: 152 }, FRONT_O = OP.y + 0.5 * (124 + 26), FRONT_I = OP.y + 0.5 * (68 + 12);
    function place(sel, x, y, extra) { g.set(sel, Object.assign({ svgOrigin: "0 0", x: x, y: y }, extra || {})); }
    g.set(caps.slice(1), { autoAlpha: 0, y: 16 });
    g.set([ringO, ringI, wallO, wallI], { svgOrigin: "0 0", rotation: 0 });
    g.set(tops.concat(walls), O);
    place(tilt, R0.x, R0.y, { scaleX: R0.s, scaleY: R0.s }); place(tiltW, R0.x, R0.y, { scaleX: R0.s, scaleY: R0.s, autoAlpha: 0 });
    place(q(".ripple"), R0.x, R0.y, { scale: R0.s, autoAlpha: 0 });
    place(q(".pill"), 200, FRONT_O + 24, { autoAlpha: 0 });
    place(q(".oshadow"), 200, FRONT_O, { autoAlpha: 0 });
    qa(".stx-svg .obj").forEach(function (o) { place(o, 200, FRONT_O - 22, { autoAlpha: 0 }); });
    bts.forEach(function (b) { place(b, -32, -6, { scale: 0.5, autoAlpha: 0 }); });
    place(tws[0], -28, -8); place(tws[1], 26, -8);
    place(q(".mBub"), 470, 40, { autoAlpha: 0, rotation: 8 }); place(q(".mNotes"), 470, 360, { autoAlpha: 0, rotation: 14 });
    place(q(".mBill"), -70, 380, { autoAlpha: 0, rotation: -16 }); place(q(".mBook"), -90, 60, { autoAlpha: 0, rotation: -8 });
    function restXY(k) { var p = pcs[k]; return { x: R0.x + R0.s * p.rm * Math.cos(p.a * RAD), y: R0.y + R0.s * p.rm * Math.sin(p.a * RAD) }; }
    var lastFront = -1;
    function sync() {
      var ro = g.getProperty(ringO, "rotation"), ri = g.getProperty(ringI, "rotation"), sx = g.getProperty(tilt, "scaleX"), sy = g.getProperty(tilt, "scaleY");
      g.set(icr.o, { rotation: -ro }); g.set(icr.i, { rotation: -ri }); g.set(ics, { scaleY: sx / sy });
      var f = ((Math.round(5 - ro / 36) % 10) + 10) % 10; if (f !== lastFront) { lastFront = f; pillT.textContent = OUTER[f][1]; }
    }
    sync();
    var tl = g.timeline({ defaults: { ease: IO, duration: 0.4 }, onUpdate: function () { sync(); hud(); } });
    function cap(n, t) { tl.to(caps[n - 1], { autoAlpha: 0, y: -16, duration: 0.16, ease: IN }, t).to(caps[n], { autoAlpha: 1, y: 0, duration: 0.24, ease: OUT }, t + 0.14); }
    function turnO(deg, t, dur) { tl.to([ringO, wallO], { rotation: deg, duration: dur, ease: IO }, t); }
    function turnI(deg, t, dur) { tl.to([ringI, wallI], { rotation: deg, duration: dur, ease: IO }, t); }
    function objIn(sel, y, t) { tl.fromTo(sel, { y: y - 20, autoAlpha: 0 }, { y: y, autoAlpha: 1, duration: 0.22, ease: OUT, immediateRender: false }, t); }
    function objOut(sel, t, extra) { tl.to(sel, Object.assign({ y: "-=14", autoAlpha: 0, duration: 0.14, ease: IN }, extra || {}), t); }
    function lit(p, t, on) { tl.to(p.col, { opacity: on ? 1 : 0, duration: on ? 0.25 : 0.24, ease: on ? OUT : IO }, t).to(p.icl, { opacity: on ? 1 : 0, duration: on ? 0.25 : 0.24, ease: on ? OUT : IO }, t); }

    // 1 - the mess falls in, each piece lands in its own segment
    cap(1, 0.1);
    function mess(sel, hx, hy, key, t) {
      var p = restXY(key), pc = pcs[key];
      tl.to(sel, { x: hx, y: hy, rotation: "*=.3", autoAlpha: 1, duration: 0.22, ease: OUT }, t)
        .to(sel, { x: p.x, y: p.y, scale: 0.2, rotation: 0, duration: 0.3, ease: IN }, t + 0.36)
        .to(sel, { autoAlpha: 0, duration: 0.07, ease: "none" }, t + 0.59);
      lit(pc, t + 0.62, true); lit(pc, t + 0.74, false);
    }
    mess(q(".mBub"), 296, 96, "orders", 0.18); mess(q(".mNotes"), 336, 340, "price", 0.5); mess(q(".mBill"), 58, 344, "invoices", 0.82); mess(q(".mBook"), 84, 98, "payments", 1.14);

    // 2 - open, name, bring Orders to the front
    cap(2, 2.05);
    tl.to(tilt, { x: OP.x, y: OP.y, scaleX: 1, scaleY: 0.5, duration: 0.55 }, 2.1)
      .to(tiltW, { x: OP.x, y: OP.y + 9, scaleX: 1, scaleY: 0.5, duration: 0.55 }, 2.1).to(tiltW, { autoAlpha: 1, duration: 0.2, ease: "none" }, 2.3)
      .to(q(".hub"), { y: -16, duration: 0.4, ease: OUT }, 2.35).to(q(".hubW"), { autoAlpha: 0, duration: 0.2 }, 2.3);
    OUTER.forEach(function (dd, k) { var p = pcs[dd[0]]; tl.to([p.top, p.wall], { x: 26 * Math.cos(p.a * RAD), y: 26 * Math.sin(p.a * RAD), duration: 0.45, ease: OUT }, 2.3 + k * 0.02); lit(p, 2.34 + k * 0.03, true); });
    INNER.forEach(function (dd, k) { var p = pcs[dd[0]]; tl.to([p.top, p.wall], { x: 12 * Math.cos(p.a * RAD), y: 12 * Math.sin(p.a * RAD), duration: 0.45, ease: OUT }, 2.42 + k * 0.03); lit(p, 2.46 + k * 0.04, true); });
    turnO(72, 2.75, 0.5);
    tl.to(q(".pill"), { autoAlpha: 1, duration: 0.15 }, 2.85).to(q(".pill"), { autoAlpha: 0, duration: 0.12 }, 3.28);

    // 3 - Orders
    cap(3, 3.3);
    tl.to(q(".oshadow"), { autoAlpha: 1, duration: 0.2 }, 3.4); objIn(q(".oSheet"), FRONT_O, 3.38);

    // 4 - Box or piece (inner ring)
    cap(4, 4.4); objOut(q(".oSheet"), 4.4);
    turnI(180, 4.42, 0.5);
    tl.to(q(".oshadow"), { y: FRONT_I, scaleX: 1.5, duration: 0.3 }, 4.5).set([q(".oBox"), q(".oBottles")], { x: 214, y: FRONT_I - 22 }, 4.5);
    objIn(q(".oBox"), FRONT_I, 4.86); tl.set(q(".oBottles"), { y: FRONT_I, autoAlpha: 1 }, 4.9).to(q(".oBox .flapL"), { y: -8, autoAlpha: 0, duration: 0.16, ease: OUT }, 5.02);
    bts.forEach(function (b, k) { var col = k % 3, row = k < 3 ? 0 : 1; tl.to(b, { x: 14 + col * 13 + row * 5, y: row ? 2 : -9, scale: 1, autoAlpha: 1, duration: 0.26, ease: OUT }, 5.06 + k * 0.04); });

    // 5 - Delivery (the ring turns two pieces under the truck)
    cap(5, 5.6);
    tl.to(bts, { x: -32, y: -6, scale: 0.5, autoAlpha: 0, duration: 0.16, ease: IN, stagger: 0.01 }, 5.6); objOut(q(".oBox"), 5.7);
    tl.to(q(".oshadow"), { y: FRONT_O, scaleX: 1.7, duration: 0.3 }, 5.74);
    objIn(q(".oTruck"), FRONT_O + 8, 5.84);
    turnO(0, 5.9, 0.7); tl.to(tws, { rotation: -720, duration: 0.7, ease: IO }, 5.9)
      .to(q(".pill"), { autoAlpha: 1, duration: 0.1 }, 6.12).to(q(".pill"), { autoAlpha: 0, duration: 0.1 }, 6.4);

    // 6 - Invoices
    cap(6, 6.8);
    tl.to(q(".oTruck"), { x: 290, autoAlpha: 0, duration: 0.26, ease: IN }, 6.82).to(tws, { rotation: -1000, duration: 0.26, ease: IN }, 6.82);
    turnO(-36, 6.9, 0.45); tl.to(q(".oshadow"), { scaleX: 1, duration: 0.2 }, 7.0); objIn(q(".oInv"), FRONT_O, 7.3);

    // 7 - Payments
    cap(7, 8.0);
    turnO(-72, 8.06, 0.45);
    tl.fromTo(q(".oCheck"), { x: 214, y: FRONT_O - 150, rotation: 16, autoAlpha: 0 }, { y: FRONT_O - 30, rotation: -8, autoAlpha: 1, duration: 0.3, ease: IN, immediateRender: false }, 8.44);

    // 8 - the ring finishes the circle
    cap(8, 9.25); objOut([q(".oInv"), q(".oCheck")], 9.24); tl.to(q(".oshadow"), { autoAlpha: 0, duration: 0.15 }, 9.24);
    turnO(-360, 9.32, 1.7);
    tl.to(q(".pill"), { autoAlpha: 1, duration: 0.12 }, 9.48).to(q(".pill"), { autoAlpha: 0, duration: 0.12 }, 10.72);

    // 9 - one system: the wheel closes and ripples
    OUTER.concat(INNER).forEach(function (dd, k) { var p = pcs[dd[0]]; tl.to([p.top, p.wall], { x: 0, y: 0, duration: 0.5, ease: IO }, 10.7 + k * 0.012); lit(p, 10.95 + k * 0.012, false); });
    tl.to(q(".hub"), { y: 0, duration: 0.4, ease: IO }, 10.8)
      .to(tiltW, { autoAlpha: 0, duration: 0.2, ease: "none" }, 10.95)
      .to([tilt, tiltW], { x: R0.x, y: R0.y, scaleX: R0.s, scaleY: R0.s, duration: 0.55 }, 10.95)
      .fromTo(q(".ripple"), { autoAlpha: 0.9, scale: R0.s }, { autoAlpha: 0, scale: R0.s * 1.32, duration: 0.5, ease: OUT, immediateRender: false }, 11.5)
      .to({}, { duration: 0.5 }, 11.7);

    var marks = [0.2, 2.15, 3.4, 4.5, 5.7, 6.9, 8.1, 9.35], last = -1;
    function hud() {
      var t = tl.time(), n = 0; marks.forEach(function (x) { if (t >= x) n++; });
      g.set(progB, { scaleX: tl.progress() });
      if (n !== last) { last = n; steps.forEach(function (li, k) { var s = k + 3; li.className = n === s ? "on" : (n > s ? "done" : ""); }); q(".stx-steps").style.opacity = (n >= 2 && n <= 8) ? 1 : 0; }
    }
    hud();
    ST.create({ trigger: sec, start: function () { return "top " + (d.querySelector(".site-header, header") ? d.querySelector(".site-header, header").offsetHeight : 64); }, end: "bottom bottom", scrub: 0.5, animation: tl });
  })();
})();
