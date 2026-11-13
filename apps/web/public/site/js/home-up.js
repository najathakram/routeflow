/* RouteFlow home (index.html), the wheel in the hero. Replaces js/site.js on this page only. Edited by hand.
   Chrome first (prices, tracking, header, menu), then motion.
   Motion: GSAP + ScrollTrigger. One init per section: initX(scope) builds that section inside gsap.matchMedia(scope)
   and returns a cleanup (gsap.context style), so each one ports to useGSAP({ scope }) as it is.
   Rules kept here: transforms and opacity only; triggers are made top to bottom; no layout reads in onUpdate; will-change
   only while a trigger is active. The motion always runs (owner ruling 2026-11-03: no reduced-motion setting, no switch); only no-JS
   and a window under 600 px tall fall back to the HTML, which is the final state.
   Stop scrolling and the screen is finished: anything that is not a pinned object reveals once on enter, on the clock, never
   on scroll position (ST.batch once, or toggleActions "play none none none"). Scrub is only for the desktop's pinned objects.
   Phones have one pin, the answer card: CSS position:sticky with ScrollTrigger only watching, so it can't jump or fight the
   browser's own scrolling. The wheel is the hero: graphics/rf-wheel-up.js loads first and has mounted by the time this runs, so everything here is made
   top to bottom after it. */
(function () {
  "use strict";
  var d = document, html = d.documentElement, W = window;
  var $ = function (s, r) { return (r || d).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || d).querySelectorAll(s)); };
  /* No `once` option on a trigger that is built after its start has passed (a visitor who arrives already scrolled: an anchor, a reload,
     a scroll before the scripts ran). ScrollTrigger kills a `once` trigger inside its own first refresh, and a later trigger's refresh walks
     the same list by index, so the kill shifts the list under it and it throws on a missing entry (reading 'end'); everything built after
     that stays hidden. "play none none none" plays the same single time and never removes itself. */
  var refreshSoon = null; // set once ScrollTrigger is known to exist

  /* ---------- chrome ---------- */
  var P = W.RF_PRICES;
  if (P) {
    $$("[data-plan][data-field]").forEach(function (el) {
      var pl = P.plans[el.dataset.plan], v = pl && pl[el.dataset.field];
      if (v != null) el.textContent = typeof v === "number" ? v.toLocaleString("en-US") : v;
    });
    $$("[data-addon][data-field]").forEach(function (el) {
      var ad = P.addons && P.addons[el.dataset.addon], v = ad && ad[el.dataset.field];
      if (v != null) el.textContent = v;
    });
  }
  /* Analytics hook: names only. Nothing is sent anywhere. */
  W.dataLayer = W.dataLayer || [];
  d.addEventListener("click", function (e) {
    var el = e.target.closest && e.target.closest("[data-track]");
    if (el) W.dataLayer.push({ event: el.getAttribute("data-track"), where: el.getAttribute("data-where") || "", page: location.pathname });
  });
  var header = $(".site-header");
  if (header) {
    var onS = function () { header.classList.toggle("scrolled", W.scrollY > 8); };
    onS(); W.addEventListener("scroll", onS, { passive: true });
  }
  var mBtn = $(".menu-btn"), menu = $("#mobile-menu");
  if (mBtn && menu) {
    var mUse = $("use", mBtn);
    var setOpen = function (open) {
      mBtn.setAttribute("aria-expanded", String(open)); mBtn.setAttribute("aria-label", open ? "Close menu" : "Open menu");
      if (mUse) mUse.setAttribute("href", open ? "#i-x" : "#i-menu");
      menu.classList.toggle("open", open); d.body.classList.toggle("menu-open", open);
    };
    mBtn.addEventListener("click", function () { setOpen(mBtn.getAttribute("aria-expanded") !== "true"); });
    menu.addEventListener("click", function (e) { if (e.target.closest && e.target.closest("a")) setOpen(false); });
    d.addEventListener("keydown", function (e) { if (e.key === "Escape") setOpen(false); });
    W.addEventListener("resize", function () { if (W.innerWidth > 1080) setOpen(false); });
  }
  /* Phones: while the hero button is on screen, the header offers Pricing instead of a second Start free trial. */
  var heroBtn = $(".hx-cta .btn"), siteHead = $(".site-header");
  if (heroBtn && siteHead && "IntersectionObserver" in W) {
    new W.IntersectionObserver(function (es) { siteHead.classList.toggle("hero-btn-in", es[es.length - 1].isIntersecting); }, { rootMargin: "-68px 0px 0px 0px" }).observe(heroBtn);
  }
  /* The header turns dark over a dark section. A thin strip at header height decides; no scroll reads. */
  var darks = $$(".pb, .end");
  if (header && darks.length && "IntersectionObserver" in W) {
    var under = new IntersectionObserver(function (en) {
      en.forEach(function (e) { e.target.__rfUnder = e.isIntersecting; });
      header.classList.toggle("on-dark", darks.some(function (x) { return x.__rfUnder; }));
    }, { rootMargin: "-30px 0px -92% 0px" });
    darks.forEach(function (x) { under.observe(x); });
  }
  /* Founder: about 50 words first; the button swaps in the full note, which is unchanged. */
  var fdMore = $(".fd-more");
  if (fdMore) fdMore.addEventListener("click", function () {
    var fd = fdMore.closest(".fd"), note = $(".fd-note", fd);
    fd.classList.add("open"); fdMore.setAttribute("aria-expanded", "true");
    if (note) note.focus({ preventScroll: true });
    if (W.gsap && note && html.classList.contains("js-motion")) W.gsap.from(note, { opacity: 0, y: 12, duration: 0.5, clearProps: "all" });
    if (refreshSoon) refreshSoon();
  });
  /* Use cases: on a wide screen everything is open and there is nothing to tap. On a phone, the names first; a tap opens one.
     Without JS the details stay open, so nothing is ever out of reach. */
  var ucs = $$(".inc details"), wide = W.matchMedia("(min-width: 900px)");
  var setUc = function () {
    ucs.forEach(function (x) { x.open = wide.matches; var sm = $("summary", x); if (sm) sm.tabIndex = wide.matches ? -1 : 0; });
  };
  setUc();
  if (wide.addEventListener) wide.addEventListener("change", setUc);
  $$(".inc summary").forEach(function (sm) { sm.addEventListener("click", function (e) { if (wide.matches) e.preventDefault(); }); });
  /* A question opened or closed: everything below it moved. */
  d.addEventListener("toggle", function (e) { if (e.target.matches && e.target.matches("details") && refreshSoon) refreshSoon(); }, true);

  /* ---------- motion ---------- */
  var g = W.gsap, ST = W.ScrollTrigger;
  if (!g || !ST) { html.classList.remove("js-motion"); return; }
  g.registerPlugin(ST); // once, before any ScrollTrigger is made
  g.defaults({ ease: "power3.out", duration: 0.8 }); // the house ease and duration
  ST.config({ ignoreMobileResize: true });
  /* ScrollTrigger.refresh() scrolls to the top to measure, then back (scrollTo(0,0), scrollTo(0,y)). With the site's
     `scroll-behavior: smooth` both calls are animated, so a question or card opened after scrolling down made the page
     swoop toward the top, and on a phone a touch or momentum in that window left the person there. Every refresh, whoever
     asks for it (a details toggle, fonts, images, resize), runs with instant scrolling and puts the setting back after. */
  var smoothHeld = 0, smoothWas = "";
  ST.addEventListener("refreshInit", function () { if (!smoothHeld++) { smoothWas = html.style.scrollBehavior; html.style.scrollBehavior = "auto"; } });
  ST.addEventListener("refresh", function () { if (smoothHeld && !--smoothHeld) html.style.scrollBehavior = smoothWas; });

  /* paper:start */
  /* Print: the page is its own final state. Motion is screen-only (every condition above starts with `screen`), so when print starts
     GSAP reverts every tween and pin; js-motion comes off with it so the CSS hides nothing. Back on screen the sections rebuild and
     js-motion returns. Each ScrollTrigger refresh records the scroll place, scrolls to the top to measure, puts the place back and then
     reports "refresh"; the first refresh after the rebuild recorded the place of the print layout, which has no pins. So for the one
     frame after leaving print, each "refresh" report puts the saved place back (all the media-change handlers and GSAP's own rebuild
     refreshes run before that frame; later refreshes record the restored place). Print turns off overflow-anchor (css/site.css), so
     entering print does not shift the page before the place is read. A real print fires both the media change and beforeprint,
     hence the idempotent toggle. */
  var paperOn = false, paperMotion = false, paperY = 0, paperBack = false;
  ST.addEventListener("refresh", function () {
    if (paperBack && Math.abs(W.scrollY - paperY) > 1) { W.scrollTo({ top: paperY, behavior: "instant" }); ST.update(); }
  });
  var paper = function (on) {
    if (on === paperOn) return;
    paperOn = on;
    if (on) { paperY = W.scrollY; paperMotion = html.classList.contains("js-motion"); html.classList.remove("js-motion"); return; }
    html.classList.toggle("js-motion", paperMotion);
    paperBack = true;
    W.requestAnimationFrame(function () { paperBack = false; });
  };
  var printQ = W.matchMedia("print");
  var onPrint = function (e) { paper(e.matches); };
  if (printQ.addEventListener) printQ.addEventListener("change", onPrint); else if (printQ.addListener) printQ.addListener(onPrint);
  W.addEventListener("beforeprint", function () { paper(true); });
  W.addEventListener("afterprint", function () { paper(false); });
  /* paper:end */

  /* desk: the pinned scenes, on a screen with room for them. mob: everything else, phones on their side too.
     pin: a phone or tablet held upright, the only place the answer card pins. */
  var Q = {
    desk: "screen and (min-width: 900px) and (min-height: 600px)",
    mob: "screen and (max-width: 899.98px), screen and (max-height: 599.98px)",
    pin: "screen and (max-width: 899.98px) and (min-height: 600px)"
  };
  var SCRUB = 0.8, BELOW = -2; // BELOW: refreshPriority for sections under the wheel (everything above it, and the wheel, is 0)
  var EDGE = "top 104%"; // just under the screen, so everything on a stopped screen has already been told to appear
  var money = function (v) { return "$" + (Math.round(v * 100) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ","); };
  /* will-change only while the trigger is active */
  var wc = function (els) {
    return function (self) { var v = self.isActive ? "transform, opacity" : ""; for (var i = 0; i < els.length; i++) if (els[i]) els[i].style.willChange = v; };
  };
  /* Anything that is, holds or sits in an h1/h2 is moved by page motion, never faded: it must read on a screenshot, a print or a stalled trigger. */
  var isHead = function (el) { return el.matches("h1,h2") || !!el.querySelector("h1,h2") || !!el.closest("h1,h2"); };
  var isShown = function (el) { return !!el && el.getClientRects().length > 0; };
  var shown = function (list) { return list.filter(isShown); };

  /* One section: matchMedia branches, scoped.
     build(c, scope, keep) returns its own cleanup; keep(el) restores an element's final text on revert. */
  var curCtx = null; // the section's GSAP context while build runs; revealOnce keeps it for tweens made later, in trigger callbacks
  function section(scope, build) {
    var mm = g.matchMedia(scope);
    mm.add(Q, function (ctx) {
      var c = ctx.conditions;
      html.classList.add("js-motion");
      var kept = [];
      var keep = function (el) { if (el) kept.push([el, el.textContent]); return el; };
      curCtx = ctx;
      var done = build(c, scope, keep);
      curCtx = null;
      return function () { if (done) done(); kept.forEach(function (k) { k[0].textContent = k[1]; }); };
    }, scope);
    return function () { mm.revert(); };
  }
  /* A running total that steps as lines arrive: every frame shows the sum of the lines on screen, never an in-between
     number. Writes the same value to every element in els (a subtotal and its balance, say). */
  function stepSum(keep, els, sums, duration) {
    els = els.filter(Boolean); els.forEach(keep);
    var o = { i: 0 }, n = sums.length - 1;
    var write = function () { var v = money(sums[Math.round(o.i)]); for (var k = 0; k < els.length; k++) els[k].textContent = v; };
    write();
    return g.to(o, { i: n, duration: duration, ease: "steps(" + n + ")", onUpdate: write });
  }
  /* One play per element per page life (a print return replays nothing). Whatever is already above its start line when a section is
     built is marked played at once, so it stays at rest instead of blanking and fading back on a first paint or a return. */
  var played = [], settled = [];
  /* A trigger reached by a jump (an anchor, a reload) rather than by scrolling to it has its start well behind the scroll already: the
     animation never starts and its content stays as it is, instead of blinking out and back. (Jumping a never-started tween to its end
     would leave it unable to revert, so it is simply not played.) Otherwise the animation plays once, as toggleActions "play" would. */
  var jumped = function (self) { return self.scroll() - self.start > W.innerHeight * 0.15; };
  var go = function (self) { if (!jumped(self)) self.animation.play(); };
  var above = function (el, pct) { return el.getBoundingClientRect().top < W.innerHeight * pct / 100; };
  /* A group that rises into place once, on the clock, the first time it comes near the screen. It starts visible: nothing is hidden
     until the batch fires, so a stalled trigger or a print leaves the words as they are. Each element plays one time (a played list,
     not `once`, which removes the trigger and shifts the list under later refreshes). The tween is made inside the section's context
     so a print revert undoes it. */
  function revealOnce(items, rp, y, each) {
    items = shown(items);
    if (!items.length) return;
    var cx = curCtx, rise = y == null ? 20 : y;
    items.forEach(function (el) { if (above(el, 104) && played.indexOf(el) < 0) played.push(el); });
    ST.batch(items, { start: EDGE, interval: 0.06, refreshPriority: rp || 0,
      onEnter: function (b) {
        var fresh = b.filter(function (el) { return played.indexOf(el) < 0; });
        if (!fresh.length) return;
        fresh.forEach(function (el) { played.push(el); });
        fresh = fresh.filter(function (el) { return !above(el, 89); }); // reached by a jump, not a scroll: already at rest
        if (!fresh.length) return;
        var play = function () {
          g.from(fresh, { y: rise, opacity: function (i, el) { return isHead(el) ? 1 : 0; }, stagger: { each: each || 0.07 }, overwrite: true });
        };
        if (cx) cx.add(play); else play();
      } });
  }
  /* A big line that scales down and settles as it arrives. Once, on the clock. It starts as it is (nothing applies before the trigger
     fires) and a heading only scales, never fades. */
  function settle(el, rp, from, start) {
    var m = /top (\d+)%/.exec(start || "top 96%");
    if (!isShown(el)) return;
    var done = settled.indexOf(el) >= 0 || above(el, m ? +m[1] : 96); // played, or already past its start: at rest, trigger kept (same trigger count as a fresh load)
    var a = { scale: from || 1.14, transformOrigin: "50% 60%" }, b = { scale: 1, ease: "power2.out", duration: 1, immediateRender: false, onStart: function () { settled.push(el); } };
    if (!isHead(el)) { a.opacity = 0; b.opacity = 1; }
    b.scrollTrigger = { trigger: el, start: start || "top 96%", onEnter: go, toggleActions: "none none none none", refreshPriority: rp || 0 };
    if (done) { settled.push(el); b.scrollTrigger.onEnter = function () {}; }
    g.fromTo(el, a, b);
  }

  /* ---------- 1. Hero: on load, not scroll. The wheel settles itself. ---------- */
  function initHero(s) {
    return section(s, function (c, s) {
      g.from($$(".hx-kick, .hx-l, .hx-lede, .hx-cta, .hx-note", s), { y: 24, opacity: 0, stagger: { each: 0.08 }, duration: 1.2, ease: "expo.out" });
    });
  }

  /* ---------- 2. Problem ---------- */
  function initProblem(s) {
    return section(s, function (c, s) {
      var pin = $(".pb-pin", s), lines = $$(".pb-l", s), objs = $$(".pb-obj", s), big = $(".pb-big", s);
      if (c.desk) {
        /* Pinned: each line lights its object, in order. Then the one line that matters. */
        var tl = g.timeline({ defaults: { duration: 1, ease: "power2.out" }, scrollTrigger: { trigger: pin, start: "top top", end: "+=170%", pin: true, scrub: SCRUB, onToggle: wc(objs.concat([big])) } });
        lines.forEach(function (l, i) {
          tl.fromTo(l, { opacity: 0.16 }, { opacity: 1 }, i * 1.1)
            .fromTo(objs[i], { opacity: 0.1, y: 28, scale: 0.94 }, { opacity: 1, y: 0, scale: 1 }, i * 1.1);
        });
        tl.to($(".pb-lines", s), { opacity: 0, duration: 0.45, ease: "power1.in" }, 3.5)
          .to($(".pb-art", s), { opacity: 0.08, duration: 0.8, ease: "power1.inOut" }, 3.5)
          .fromTo(big, { opacity: 0, scale: 1.22 }, { opacity: 1, scale: 1, duration: 1.2, ease: "power3.out" }, 3.75)
          .to({}, { duration: 0.5 });
      } else {
        revealOnce(lines.concat(objs), 0, 24, 0.09);
        settle(big, 0, 1.06);
      }
    });
  }

  /* ---------- 3. The answer: one order, start to finish ---------- */
  function initJourney(s) {
    return section(s, function (c, s, keep) {
      settle($(".jr-head h2", s), 0, c.desk ? 1.12 : 1.05, c.desk ? "top 92%" : EDGE);
      if (c.desk) return journeyDesk(s, keep);
      if (c.pin) return answerCard(s, keep);
      revealOnce($$(".ans-i, .jr-p", s));
    });
  }
  function journeyDesk(s, keep) {
    var pin = $(".jr-pin", s), track = $(".jr-track", s), panels = $$(".jr-p", s), bar = $(".jr-bar", s), rtLine = $(".rt-l", s), rtDots = $$(".rt-d", s);
    var figs = panels.map(function (p) { return $(".jr-fig", p); });
    var ordTot = $(".jr-p:nth-child(1) .a-sum b", s), invTots = $$(".jr-p:nth-child(2) .a-tots p > :last-child", s);
    var paid = $$(".jr-pd .a-tots p > :last-child", s), paidPill = $(".jr-pd .a-pill", s), payRow = $(".jr-pd .a-pay", s), chk = $(".jr-pd .chk, .jr-paid .chk", s);
    var phone = $(".dv", s);
    var rowsOf = function (i) { return $$(".a-r:not(.a-rh)", panels[i]); };
    /* Payments received and the balance always add up to the invoice, on every frame. */
    var payCount = function () {
      var o = { v: 0 };
      keep(paid[1]); keep(paid[2]);
      var write = function () { var c = Math.round(o.v * 100); paid[1].textContent = money(c / 100); paid[2].textContent = money((11100 - c) / 100); };
      write();
      return g.to(o, { v: 111, duration: 0.5, ease: "power2.inOut", onUpdate: write });
    };
    /* What happens inside each step, built once; the step decides when it plays. */
    var step = [
      function (tl) {
        tl.fromTo(figs[0], { opacity: 0, y: 40 }, { opacity: 1, y: 0 }, 0)
          .fromTo(rowsOf(0), { opacity: 0, y: 10 }, { opacity: 1, y: 0, stagger: { each: 0.14 }, duration: 0.3 }, 0.25)
          .add(stepSum(keep, [ordTot], [0, 45, 81, 111], 0.42), 0.2);
      },
      function (tl) {
        tl.fromTo(figs[1], { opacity: 0, y: 40 }, { opacity: 1, y: 0 }, 0)
          .fromTo(rowsOf(1), { opacity: 0, y: 10 }, { opacity: 1, y: 0, stagger: { each: 0.14 }, duration: 0.3 }, 0.25)
          .add(stepSum(keep, invTots, [0, 45, 81, 111], 0.42), 0.2);
      },
      function (tl) {
        tl.fromTo(phone, { opacity: 0, y: 60 }, { opacity: 1, y: 0 }, 0)
          .fromTo(rtLine, { strokeDashoffset: 1 }, { strokeDashoffset: 0, duration: 0.6, ease: "none" }, 0.1)
          .fromTo(rtDots, { scale: 0, transformOrigin: "50% 50%" }, { scale: 1, duration: 0.18, stagger: { each: 0.14 } }, 0.1);
      },
      function (tl) {
        tl.fromTo(chk, { opacity: 0, x: -50, rotation: -9 }, { opacity: 1, x: 0, rotation: -4 }, 0)
          .add(payCount(), 0.45)
          .fromTo(payRow, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.3 }, 0.8)
          .fromTo(paidPill, { opacity: 0, scale: 0.8 }, { opacity: 1, scale: 1, duration: 0.3 }, 0.95);
      }
    ];
    var view = $(".jr-view", s);
    /* Each figure fits the height the pin leaves it. Runs on refresh, never during scroll. */
    var fitFigs = function () { var h = view.clientHeight - 8; figs.forEach(function (f) { g.set(f, { scale: Math.min(1, h / f.offsetHeight) }); }); };
    fitFigs();
    ST.addEventListener("refreshInit", fitFigs);
    var dist = function () { return Math.max(0, track.scrollWidth - W.innerWidth); };
    /* The track moves with the scroll, ease none; everything inside rides on it (containerAnimation). */
    var move = g.to(track, { x: function () { return -dist(); }, ease: "none",
      scrollTrigger: { trigger: pin, start: "top top", end: function () { return "+=" + dist(); }, pin: true, scrub: SCRUB, invalidateOnRefresh: true, onToggle: wc([track, bar]) } });
    g.fromTo(bar, { x: 0 }, { x: function () { return bar.offsetWidth * 3; }, ease: "none",
      scrollTrigger: { trigger: pin, start: "top top", end: function () { return "+=" + dist(); }, scrub: SCRUB, invalidateOnRefresh: true } });
    /* No tween that waits on a toggleActions trigger hides its target before the trigger fires (immediateRender false in each timeline's
     defaults); only the scrubbed scenes, whose progress is the scroll, set their start state. Step 1 plays once as the section arrives; steps 2-4 as each one slides in. */
    step[0](g.timeline({ defaults: { immediateRender: false, ease: "power2.out", duration: 0.6 }, scrollTrigger: { trigger: s, start: "top 60%", onEnter: go, toggleActions: "none none none none" } }));
    for (var i = 1; i < 4; i++) step[i](g.timeline({ defaults: { ease: "power2.out", duration: 0.6 }, scrollTrigger: { trigger: panels[i], containerAnimation: move, start: "left 78%", end: "left 22%", scrub: SCRUB } }));
    /* One step in focus: the panels either side stay dim. Opacity only, riding on the track. */
    panels.forEach(function (p, i) {
      var fade = g.timeline({ defaults: { ease: "none", duration: 1 }, scrollTrigger: { trigger: p, containerAnimation: move, start: "left right", end: "right left", scrub: SCRUB } });
      if (i) fade.fromTo(p, { opacity: 0.14 }, { opacity: 1 }, 0.2);
      if (i < 3) fade.fromTo(p, { opacity: 1 }, { opacity: 0.14, immediateRender: false }, 2.4);
      fade.to({}, { duration: 0.2 }, 3.4);
    });
    return function () { ST.removeEventListener("refreshInit", fitFigs); };
  }
  /* Phones, upright: one card that changes in place. The scroll only picks the state (three bands of the pin); the change
     itself plays on the clock from wherever it is, so it can stop, reverse or skip a state without ever showing half of one. */
  function answerCard(s, keep) {
    var ans = $(".ans", s), items = $$(".ans-i", ans), steps = $$(".ans-steps li", ans), fill = $(".ans-fill", ans);
    var part = function (i) { var it = items[i]; return { bar: $(".ans-bar", it), head: $(".ans-h", it), foot: $(".ans-f", it), cap: $(".ans-cap", it) }; };
    var A = part(0), B = part(1), C = part(2), rows = $$(".ans-r", items[0]), sweep = $(".ans-sweep", items[0]), chk = $(".chk", items[2]), bal = $(".ans-f b", items[2]);
    keep(bal);
    var o = { v: 111 }, writeBal = function () { bal.textContent = money(o.v); };
    writeBal();
    g.set(fill, { scaleX: 0.17, transformOrigin: "0% 50%" });
    var tl = g.timeline({ paused: true, defaults: { ease: "power2.inOut", duration: 0.35 } });
    tl.addLabel("s0", 0)
      .to([A.bar, A.foot, A.cap], { autoAlpha: 0, duration: 0.22, ease: "power1.in" }, 0)
      .to(A.head, { autoAlpha: 0, y: -8, duration: 0.22, ease: "power1.in" }, 0)
      .fromTo([B.bar, B.foot, B.cap], { autoAlpha: 0 }, { autoAlpha: 1, ease: "power1.out" }, 0.2)
      .fromTo(B.head, { autoAlpha: 0, y: 10 }, { autoAlpha: 1, y: 0, ease: "power1.out" }, 0.2)
      .fromTo(sweep, { xPercent: -100, autoAlpha: 1 }, { xPercent: 100, duration: 0.7, ease: "power1.inOut" }, 0.05)
      .to(fill, { scaleX: 0.5, duration: 0.6 }, 0.1)
      .addLabel("s1", 0.9)
      .to(rows, { autoAlpha: 0, y: -6, stagger: { each: 0.04 }, duration: 0.2, ease: "power1.in" }, 0.95)
      .fromTo(chk, { autoAlpha: 0, x: -60, y: 24, rotation: -14 }, { autoAlpha: 1, x: 0, y: 0, rotation: -3, duration: 0.55, ease: "power3.out" }, 1)
      .to(B.foot, { autoAlpha: 0, duration: 0.01 }, 1)
      .fromTo(C.foot, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.01 }, 1)
      .to([B.bar, B.cap], { autoAlpha: 0, duration: 0.22 }, 1.05)
      .to(B.head, { autoAlpha: 0, y: -8, duration: 0.22 }, 1.05)
      .fromTo([C.bar, C.cap], { autoAlpha: 0 }, { autoAlpha: 1 }, 1.25)
      .fromTo(C.head, { autoAlpha: 0, y: 10 }, { autoAlpha: 1, y: 0 }, 1.25)
      .to(o, { v: 0, duration: 0.6, onUpdate: writeBal }, 1.35)
      .to(fill, { scaleX: 1, duration: 0.6 }, 1)
      .addLabel("s2", 2);
    var L = ["s0", "s1", "s2"], cur = 0;
    var setStep = function (i) { steps.forEach(function (li, k) { li.classList.toggle("on", k === i); }); };
    var go = function (i) { if (i === cur) return; cur = i; setStep(i); tl.tweenTo(L[i], { duration: 0.8, ease: "power1.inOut", overwrite: true }); };
    var idx = function (p) { return p < 1 / 3 ? 0 : p < 2 / 3 ? 1 : 2; };
    /* start and end match the CSS sticky range: the section's top at the header, its bottom at the screen's bottom. */
    ST.create({ trigger: s, start: "top 68px", end: "bottom bottom", onUpdate: function (x) { go(idx(x.progress)); }, onRefresh: function (x) { go(idx(x.progress)); } });
  }

  /* ---------- the real Orders screen: wide screens only, after the pain and the answer ---------- */
  function initShot(s) {
    return section(s, function (c, s, keep) {
      if (!c.desk) return;
      var pin = $(".hx-pin", s), win = $(".win", s), scrim = $(".a-scrim", s), mod = $(".a-mod", s), lines = $$(".a-mod .a-line", s), tot = $(".a-tot b", s), newBtn = $(".a-head .a-btn--p", s);
      var hdr = function () { return header ? header.offsetHeight : 64; };
      var fit = function () { return Math.min(1, (W.innerHeight - hdr() - 52) / win.offsetHeight); };
      g.set(win, { transformPerspective: 2000, transformOrigin: "50% 0%" });
      /* Pinned: the Orders screen lies flat, then New order opens the order. It fades in fast and settles slower, so the table never shows through it. */
      g.timeline({
        defaults: { ease: "power2.inOut", duration: 0.4 },
        scrollTrigger: { trigger: pin, start: "top top", end: "+=115%", pin: true, scrub: SCRUB, invalidateOnRefresh: true, onToggle: wc([win, mod]) }
      })
        .fromTo(win, { rotationX: 16, scale: function () { return fit() * 0.9; } }, { rotationX: 0, scale: fit, duration: 0.36, ease: "power1.out" }, 0)
        .to(newBtn, { scale: 0.93, duration: 0.03, ease: "power1.inOut", yoyo: true, repeat: 1 }, 0.46)
        .fromTo(scrim, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.08, ease: "none" }, 0.5)
        .fromTo(mod, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.035, ease: "none" }, 0.52)
        .fromTo(mod, { y: 40, scale: 0.97 }, { y: 0, scale: 1, duration: 0.14, ease: "power3.out" }, 0.52)
        .fromTo(lines, { autoAlpha: 0, y: 14 }, { autoAlpha: 1, y: 0, stagger: { each: 0.07 }, duration: 0.08, ease: "power2.out" }, 0.66)
        .add(stepSum(keep, [tot], [0, 45, 81, 111], 0.21), 0.63)
        .to({}, { duration: 0.12 });
    });
  }

  /* ---------- 4. Fits how you sell ---------- */
  function initSell(s) {
    return section(s, function (c, s, keep) {
      var pin = $(".sl-pin", s), art = $(".sl-art", s), copy = $(".sl-copy", s), line = $(".sl-line", s), boxes = [$(".sb1", s), $(".sb2", s)], cans = $$(".sl-can", s), floor = $(".sl-floor", s), math = $(".sl-math", s);
      /* These groups sit where their transform attribute puts them. Read that y, land back on it. */
      var yOf = function (el) { return g.getProperty(el, "y"); }, by = boxes.map(yOf), cy = cans.map(yOf);
      var fall = c.desk ? 170 : 80;
      var drop = function (tl) {
        return tl.fromTo(floor, { opacity: 0 }, { opacity: 1, duration: 0.4 }, 0.1)
          .fromTo(boxes[0], { y: by[0] - fall, opacity: 0 }, { y: by[0], opacity: 1 }, 0.3)
          .fromTo(boxes[1], { y: by[1] - fall, opacity: 0 }, { y: by[1], opacity: 1 }, 0.8);
      };
      if (!c.desk) {
        /* Phones: two boxes, then six cans, once, and the one number is already there. */
        var tlm = g.timeline({ defaults: { immediateRender: false, ease: "power3.out", duration: 0.45 }, scrollTrigger: { trigger: art, start: EDGE, onEnter: go, toggleActions: "none none none none" } });
        drop(tlm).fromTo(cans, { y: function (i) { return cy[i] - 44; }, opacity: 0 }, { y: function (i) { return cy[i]; }, opacity: 1, duration: 0.3, stagger: { each: 0.09 } }, 1.1);
        revealOnce($$(".sl-big, .tier, .sl-prod, .sl-line", s), 0, 16);
        return;
      }
      var qf = $$(".sl-line .a-qf", s), pcs = $(".sl-line .a-help span", s), amt = $(".sl-line .a-amt", s), boxW = qf[0].nextSibling, pcW = qf[1].nextSibling;
      [qf[0], qf[1], pcs, amt, boxW, pcW].forEach(keep);
      var st = { b: 0, c: 0 };
      var paint = function () {
        var b = Math.round(st.b), n = Math.round(st.c);
        qf[0].textContent = b; qf[1].textContent = n; pcs.textContent = 12 * b + n; amt.textContent = money(18 * b + 1.5 * n);
        boxW.textContent = b === 1 ? " box + " : " boxes + "; pcW.textContent = n === 1 ? " pc" : " pcs";
      };
      paint();
      /* The copy moves as a block; only what is not a heading fades with it. Starts visible: nothing applies before the trigger fires. */
      var copyKids = Array.prototype.filter.call(copy.children, function (k) { return !isHead(k); });
      g.timeline({ defaults: { ease: "power2.out" }, scrollTrigger: { trigger: s, start: "top 80%", onEnter: go, toggleActions: "none none none none" } })
        .fromTo(copy, { y: 36 }, { y: 0, immediateRender: false }, 0)
        .fromTo(copyKids, { opacity: 0 }, { opacity: 1, immediateRender: false }, 0)
        .fromTo(line, { opacity: 0, y: 48 }, { opacity: 1, y: 0, immediateRender: false }, 0.12);
      /* Pinned: two boxes, then six loose cans, each from above. The count fields and the line total keep up. */
      var tl = g.timeline({ defaults: { ease: "power3.out", duration: 0.5 }, scrollTrigger: { trigger: pin, start: "top top", end: "+=85%", pin: true, scrub: SCRUB, onToggle: wc(boxes.concat(cans, [line])) } });
      drop(tl).to(st, { b: 2, duration: 1, ease: "steps(2)", onUpdate: paint }, 0.3)
        .fromTo(cans, { y: function (i) { return cy[i] - 110; }, opacity: 0 }, { y: function (i) { return cy[i]; }, opacity: 1, duration: 0.3, stagger: { each: 0.18 } }, 1.35)
        .to(st, { c: 6, duration: 1.08, ease: "steps(6)", onUpdate: paint }, 1.35)
        .fromTo(math, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.4 }, 2.5)
        .to({}, { duration: 0.35 });
      /* Three stores arrive in order, once. The piece price counts up and the box of 12 follows it exactly. */
      var tiers = $$(".tier", s), tl2 = g.timeline({ defaults: { immediateRender: false, ease: "power2.out" }, scrollTrigger: { trigger: $(".sl-tiers", s), start: "top 88%", onEnter: go, toggleActions: "none none none none" } });
      tiers.forEach(function (t, i) {
        var b = $(".tier-p b", t), box = $(".tier-b", t), to = parseFloat(b.dataset.count), o = { v: 0 }, boxText = box.textContent;
        keep(b); keep(box);
        var write = function () { var cents = Math.round(o.v * 100); b.textContent = money(cents / 100); box.textContent = boxText.replace(/^\$[\d.,]+/, money((cents * 12) / 100)); };
        write();
        tl2.fromTo(t, { opacity: 0, y: 50 }, { opacity: 1, y: 0, duration: 0.6 }, i * 0.22)
          .to(o, { v: to, duration: 0.6, onUpdate: write }, i * 0.22);
      });
    });
  }

  /* ---------- 5. Stores ---------- */
  function initStores(s) {
    return section(s, function (c, s) {
      var vis = $(".st-vis", s), shop = $(".st-shop", s), phone = $(".st-phone", s), tiles = $$(".b-tile", s), rows = $$(".sp-r", s), all = $(".sp-all", s), head = $(".st-head h2", s);
      var wideShop = isShown(shop);
      if (c.desk) settle(head, 0, 1.1, "top 92%"); else revealOnce($$(".st-head h2, .st-head .sub", s), 0, 16);
      var tl = g.timeline({ defaults: { immediateRender: false, ease: "power2.out", duration: 0.8 }, scrollTrigger: { trigger: vis, start: c.desk ? "top 88%" : EDGE, onEnter: go, toggleActions: "none none none none" } });
      if (wideShop) {
        tl.fromTo(shop, { opacity: 0, y: 80, scale: 0.96 }, { opacity: 1, y: 0, scale: 1, duration: 1 }, 0)
          .fromTo(tiles, { opacity: 0, y: 24 }, { opacity: 1, y: 0, stagger: { each: 0.12 }, duration: 0.5 }, 0.35)
          .fromTo(phone, { opacity: 0, y: 140 }, { opacity: 1, y: 0, duration: 0.9 }, 0.6)
          .fromTo(all, { opacity: 0, scale: 0.96 }, { opacity: 1, scale: 1, duration: 0.4 }, 1.05)
          .fromTo(rows, { opacity: 0, y: 16 }, { opacity: 1, y: 0, stagger: { each: 0.14 }, duration: 0.4 }, 1.1);
      } else {
        tl.fromTo(phone, { opacity: 0, y: 36 }, { opacity: 1, y: 0, duration: 0.6 }, 0)
          .fromTo(all, { opacity: 0, x: -8 }, { opacity: 1, x: 0, duration: 0.35 }, 0.25)
          .fromTo(rows, { opacity: 0, y: 12 }, { opacity: 1, y: 0, stagger: { each: 0.1 }, duration: 0.35 }, 0.32);
      }
    });
  }

  /* ---------- 6. Counter ---------- */
  function initCounter(s) {
    return section(s, function (c, s, keep) {
      var vis = $(".ct-vis", s), win = $(".ct-win", s), lines = $$(".c-line", s), total = $(".c-big b", s), sub = $(".c-right .c-t > :last-child", s), paper = $(".rc-paper", s), rc = $(".rc", s);
      var pay = $$(".c-tend, .c-quick, .c-right .c-t:nth-of-type(5), .c-chg", s);
      var wideWin = isShown(win);
      if (!c.desk) revealOnce($$(".ct-copy h2, .ct-copy .sub, .ct-note", s), 0, 16);
      var tl = g.timeline({ defaults: { immediateRender: false, ease: "power2.out", duration: 0.6 }, scrollTrigger: { trigger: vis, start: wideWin ? "top 85%" : EDGE, onEnter: go, toggleActions: "none none none none" } });
      if (wideWin) {
        tl.fromTo(win, { opacity: 0, y: 60 }, { opacity: 1, y: 0, duration: 0.8 }, 0)
          .fromTo(lines, { opacity: 0, y: 14 }, { opacity: 1, y: 0, stagger: { each: 0.3 }, duration: 0.3 }, 0.35)
          .add(stepSum(keep, [sub, total], [0, 18, 21], 0.6), 0.2)
          .fromTo(pay, { opacity: 0, y: 10 }, { opacity: 1, y: 0, stagger: { each: 0.1 }, duration: 0.3 }, 0.9)
          .fromTo(rc, { opacity: 0, y: 30 }, { opacity: 1, y: 0, duration: 0.5 }, 1.25)
          .fromTo(paper, { yPercent: 100 }, { yPercent: 0, duration: 0.9, ease: "power2.out" }, 1.45);
      } else {
        /* Phones: the receipt prints, once. */
        tl.fromTo(rc, { opacity: 0 }, { opacity: 1, duration: 0.3 }, 0)
          .fromTo(paper, { yPercent: 100 }, { yPercent: 0, duration: 1, ease: "power2.out" }, 0.1);
      }
    });
  }

  /* ---------- refreshPriority -2 for what has no pin under it ---------- */
  function initGo(s) {
    return section(s, function (c, s) { revealOnce($$(".sy-go > *", s), BELOW, 16); });
  }
  /* The sample cards the wheel no longer stops on. Each rises once, then the one thing that matters on it happens, as it did on the wheel. */
  function closer(items, keep) {
    var marks = [];
    items.forEach(function (it) {
      var card = $(".uc-card", it), ticks = $$(".rfw-tk path", it), pill = $("[data-was]", it), nums = $$("[data-to]", it);
      var tl = g.timeline({ defaults: { immediateRender: false, ease: "power2.out", duration: 0.6 }, scrollTrigger: { trigger: it, start: EDGE, onEnter: go, toggleActions: "none none none none", refreshPriority: BELOW } });
      tl.fromTo(it, { opacity: 0, y: 28 }, { opacity: 1, y: 0, duration: 0.7, ease: "power3.out" }, 0)
        .fromTo(card, { y: 18 }, { y: 0, duration: 0.8, ease: "power3.out" }, 0.08);
      if (ticks.length) tl.fromTo(ticks, { strokeDashoffset: 1 }, { strokeDashoffset: 0, duration: 0.36, ease: "power2.inOut", stagger: 0.14 }, 0.45);
      nums.forEach(function (e) {
        keep(e);
        var to = +e.dataset.to, from = +e.dataset.from, o = { v: from }, fin = e.textContent, w = function () { e.textContent = money(o.v); };
        tl.fromTo(o, { v: from }, { v: to, duration: 0.95, ease: "power2.inOut", onStart: w, onUpdate: w, onComplete: function () { e.textContent = fin; } }, 0.4);
        e.textContent = money(from);
      });
      if (pill) {
        keep(pill); marks.push(pill);
        var fin = pill.textContent;
        pill.textContent = pill.dataset.was; pill.classList.add("was");
        tl.call(function () { pill.textContent = fin; pill.classList.remove("was"); }, null, 1.15);
      }
    });
    return function () { marks.forEach(function (m) { m.classList.remove("was"); }); };
  }
  function initUseCases(s) {
    return section(s, function (c, s, keep) {
      settle($(".inc-head h2", s), BELOW, c.desk ? 1.1 : 1.05, c.desk ? "top 92%" : EDGE);
      revealOnce($$(".inc-head .kick, .inc-head .sub, .inc-grid .inc-i, .inc-more .inc-i, .inc-label", s), BELOW, 18, 0.04);
      return closer($$(".uc-i", s), keep);
    });
  }
  function initFounder(s) {
    return section(s, function (c, s) {
      /* The block only moves (its heading is never faded; the lines under it fade through revealOnce below). Starts visible. */
      g.fromTo($(".fd-in", s), { y: 64 }, { y: 0, immediateRender: false, duration: 1, ease: "power3.out", scrollTrigger: { trigger: s, start: EDGE, onEnter: go, toggleActions: "none none none none", refreshPriority: BELOW } });
      settle($(".fd-q", s), BELOW, c.desk ? 1.08 : 1.05, c.desk ? "top 88%" : EDGE);
      revealOnce($$(".fd .kick, .fd-short p, .fd-more, .fd-note p, .fd-sig", s), BELOW, 18, 0.1);
    });
  }
  function initPricing(s) {
    return section(s, function (c, s, keep) {
      revealOnce($$(".reveal", s), BELOW, 16, 0.08);
      revealOnce($$(".pl-all h3, .pl-all li", s), BELOW, 14, 0.04);
      if (!c.desk) { revealOnce($$(".pl tbody tr", s), BELOW, 12, 0.08); return; }
      var cards = shown($$(".pcard", s));
      if (!cards.length) return;
      /* Each card rises in order, then its bar fills. The customer count never counts up: a contract number reads right at every moment. Once, on the clock. */
      var tl = g.timeline({ defaults: { immediateRender: false }, scrollTrigger: { trigger: $(".pgrid", s), start: "top 88%", onEnter: go, toggleActions: "none none none none", refreshPriority: BELOW } });
      cards.forEach(function (card, i) {
        var at = i * 0.13, bar = $(".pm-bar i", card);
        tl.fromTo(card, { opacity: 0, y: 44 }, { opacity: 1, y: 0, immediateRender: false, duration: 0.8, ease: "power3.out" }, at);
        tl.fromTo(bar, { scaleX: 0 }, { scaleX: 1, duration: 1.05, ease: "power2.inOut" }, at + 0.3);
      });
    });
  }
  function initFaq(s) {
    return section(s, function (c, s) { revealOnce($$(".faq details", s), BELOW, 14, 0.05); });
  }
  function initEnd(s) {
    return section(s, function (c, s) {
      settle($("h2", s), BELOW, c.desk ? 1.18 : 1.06, c.desk ? "top 92%" : EDGE);
      revealOnce($$(".end-mark, .end .btn, .end-mail", s), BELOW, 16, 0.1);
    });
  }

  /* ---------- run, in page order ---------- */
  var cleanups = [];
  var run = function (pair) { var el = $(pair[0]); if (el) cleanups.push(pair[1](el)); };
  [["#top", initHero], ["#one-system", initGo], ["#problem", initProblem], ["#journey", initJourney], ["#shot", initShot], ["#sell", initSell], ["#stores", initStores], ["#counter", initCounter], ["#use-cases", initUseCases], ["#founder", initFounder], ["#pricing", initPricing], ["#faq", initFaq], ["#start", initEnd]].forEach(run);
  var queued = 0;
  refreshSoon = function () { if (queued) return; queued = W.requestAnimationFrame(function () { queued = 0; ST.refresh(); }); };
  refreshSoon();
  if (d.fonts && d.fonts.ready) d.fonts.ready.then(refreshSoon);
  W.addEventListener("load", function () {
    Promise.all($$("main img").map(function (im) { return im.decode ? im.decode().catch(function () {}) : null; })).then(refreshSoon);
  });
  /* Exposed for testing and for a React port: RFHome.revert() undoes every section. */
  W.RFHome = { revert: function () { cleanups.forEach(function (f) { f(); }); cleanups = []; } };
})();
