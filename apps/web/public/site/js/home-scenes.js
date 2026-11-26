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

  /* The story (sketch story section, objects only): the mess falls into one app, then one order goes by as an order sheet,
     a box and bottles, a truck, an invoice and a check. Scrubbed by the scroll over the tall section; same moves and eases
     as the sketch. The wheel is the page's own hero wheel, so it is not drawn again here. */
  (function story() {
    var sec = d.getElementById("story");
    if (!sec || !d.documentElement.classList.contains("js-motion")) return;
    var q = function (s) { return sec.querySelector(s); }, qa = function (s) { return g.utils.toArray(sec.querySelectorAll(s)); };
    var caps = qa(".stx-cap"), steps = qa(".stx-steps li"), progB = q(".stx-prog b"), pillT = q(".pillT"), bts = qa(".bt"), tws = qa(".oTruck .tw");
    var FRONT = 250, HUB = { x: 200, y: 120 };
    g.set(caps.slice(1), { autoAlpha: 0, y: 16 });
    g.set(".stx-svg .obj", { svgOrigin: "0 0", x: 200, y: FRONT - 22, autoAlpha: 0 });
    g.set(q(".oshadow"), { svgOrigin: "0 0", x: 200, y: FRONT, autoAlpha: 0 });
    g.set(q(".pill"), { svgOrigin: "0 0", x: 200, y: FRONT + 32, autoAlpha: 0 });
    bts.forEach(function (b) { g.set(b, { svgOrigin: "0 0", x: -32, y: -6, scale: 0.5, autoAlpha: 0 }); });
    g.set(tws[0], { svgOrigin: "0 0", x: -28, y: -8 }); g.set(tws[1], { svgOrigin: "0 0", x: 26, y: -8 });
    g.set(q(".mBub"), { svgOrigin: "0 0", x: 470, y: 40, autoAlpha: 0, rotation: 8 }); g.set(q(".mNotes"), { svgOrigin: "0 0", x: 470, y: 330, autoAlpha: 0, rotation: 14 });
    g.set(q(".mBill"), { svgOrigin: "0 0", x: -70, y: 340, autoAlpha: 0, rotation: -16 }); g.set(q(".mBook"), { svgOrigin: "0 0", x: -90, y: 60, autoAlpha: 0, rotation: -8 });
    g.set(q(".hub"), { svgOrigin: "200 120" });
    var tl = g.timeline({ defaults: { ease: IO, duration: 0.4 }, onUpdate: hud });
    function cap(n, t) { tl.to(caps[n - 1], { autoAlpha: 0, y: -16, duration: 0.16, ease: IN }, t).to(caps[n], { autoAlpha: 1, y: 0, duration: 0.24, ease: OUT }, t + 0.14); }
    function objIn(sel, y, t) { tl.fromTo(sel, { y: y - 20, autoAlpha: 0 }, { y: y, autoAlpha: 1, duration: 0.22, ease: OUT, immediateRender: false }, t); }
    function objOut(sel, t, extra) { tl.to(sel, Object.assign({ y: "-=14", autoAlpha: 0, duration: 0.14, ease: IN }, extra || {}), t); }
    function mess(sel, hx, hy, t) {
      tl.to(sel, { x: hx, y: hy, rotation: "*=.3", autoAlpha: 1, duration: 0.22, ease: OUT }, t)
        .to(sel, { x: HUB.x, y: HUB.y, scale: 0.2, rotation: 0, duration: 0.3, ease: IN }, t + 0.36)
        .to(sel, { autoAlpha: 0, duration: 0.07, ease: "none" }, t + 0.59)
        .to(q(".hub"), { scale: 1.12, duration: 0.08, ease: OUT }, t + 0.62).to(q(".hub"), { scale: 1, duration: 0.24, ease: IO }, t + 0.74);
    }
    mess(q(".mBub"), 296, 96, 0.18); mess(q(".mNotes"), 336, 240, 0.5); mess(q(".mBill"), 58, 244, 0.82); mess(q(".mBook"), 84, 98, 1.14);
    cap(1, 1.7);
    tl.to(q(".oshadow"), { autoAlpha: 1, duration: 0.2 }, 1.8).to(q(".pill"), { autoAlpha: 1, duration: 0.15 }, 1.8);
    objIn(q(".oSheet"), FRONT, 1.78);
    cap(2, 2.8); objOut(q(".oSheet"), 2.8);
    tl.set([q(".oBox"), q(".oBottles")], { x: 214, y: FRONT - 22 }, 2.9);
    objIn(q(".oBox"), FRONT, 3.0); tl.set(q(".oBottles"), { y: FRONT, autoAlpha: 1 }, 3.04).to(q(".oBox .flapL"), { y: -8, autoAlpha: 0, duration: 0.16, ease: OUT }, 3.2);
    bts.forEach(function (b, k) { var col = k % 3, row = k < 3 ? 0 : 1; tl.to(b, { x: 14 + col * 13 + row * 5, y: row ? 2 : -9, scale: 1, autoAlpha: 1, duration: 0.26, ease: OUT }, 3.24 + k * 0.04); });
    cap(3, 4.0);
    tl.to(bts, { x: -32, y: -6, scale: 0.5, autoAlpha: 0, duration: 0.16, ease: IN, stagger: 0.01 }, 4.0); objOut(q(".oBox"), 4.1);
    tl.to(q(".oshadow"), { scaleX: 1.7, duration: 0.3 }, 4.14);
    objIn(q(".oTruck"), FRONT + 8, 4.24); tl.to(tws, { rotation: -720, duration: 0.7, ease: IO }, 4.3);
    cap(4, 5.2);
    tl.to(q(".oTruck"), { x: 290, autoAlpha: 0, duration: 0.26, ease: IN }, 5.22).to(tws, { rotation: -1000, duration: 0.26, ease: IN }, 5.22);
    tl.to(q(".oshadow"), { scaleX: 1, duration: 0.2 }, 5.4); objIn(q(".oInv"), FRONT, 5.6);
    cap(5, 6.4); objOut(q(".oInv"), 6.4);
    tl.fromTo(q(".oCheck"), { x: 214, y: FRONT - 150, rotation: 16, autoAlpha: 0 }, { y: FRONT - 30, rotation: -8, autoAlpha: 1, duration: 0.3, ease: IN, immediateRender: false }, 6.8);
    tl.to({}, { duration: 0.6 }, 7.4);
    var marks = [1.8, 2.9, 4.1, 5.3, 6.5], names = ["Orders", "Box or piece", "Delivery", "Invoices", "Payments"], last = -1;
    function hud() {
      var t = tl.time(), n = 0; marks.forEach(function (x) { if (t >= x) n++; });
      g.set(progB, { scaleX: tl.progress() });
      if (n !== last) { last = n; if (n) pillT.textContent = names[n - 1]; steps.forEach(function (li, k) { li.className = n === k + 1 ? "on" : (n > k + 1 ? "done" : ""); }); }
    }
    hud();
    ST.create({ trigger: sec, start: function () { return "top " + (d.querySelector(".site-header, header") ? d.querySelector(".site-header, header").offsetHeight : 64); }, end: "bottom bottom", scrub: 0.5, animation: tl, invalidateOnRefresh: true });
  })();
})();
