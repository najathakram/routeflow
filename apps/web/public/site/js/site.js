/* RouteFlow site behaviour, design preview 2026-11-01. Shared by every page.
   Menu, prices, and GSAP motion (ported from the Grok baseline's M1/M2/M4 patterns).
   Rules: transform + opacity only; one matchMedia; no-JS shows the final state (the motion always runs, owner ruling 2026-11-03); pins only >= 900px; no snap. */
(function () {
  "use strict";
  var doc = document.documentElement;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  /* Prices come from window.RF_PRICES (js/prices.js). The HTML holds the same numbers for no-JS. */
  (function () {
    var P = window.RF_PRICES; if (!P) return;
    $$("[data-plan][data-field]").forEach(function (el) {
      var pl = P.plans[el.dataset.plan]; if (!pl) return;
      var v = pl[el.dataset.field]; if (v != null) el.textContent = typeof v === "number" ? v.toLocaleString("en-US") : v;
    });
  })();

  $$("[data-addon][data-field]").forEach(function (el) {
    var A = (window.RF_PRICES || {}).addons; var ad = A && A[el.dataset.addon]; if (!ad) return;
    if (ad[el.dataset.field] != null) el.textContent = ad[el.dataset.field];
  });

  /* Analytics hook: names only. Nothing is sent anywhere. */
  window.dataLayer = window.dataLayer || [];
  document.addEventListener("click", function (e) {
    var el = e.target.closest("[data-track]");
    if (el) window.dataLayer.push({ event: el.getAttribute("data-track"), page: location.pathname });
  });

  /* Header shadow, mobile menu */
  var header = $(".site-header");
  if (header) { var onS = function () { header.classList.toggle("scrolled", window.scrollY > 8); }; onS(); window.addEventListener("scroll", onS, { passive: true }); }
  var btn = $(".menu-btn"), menu = $("#mobile-menu");
  if (btn && menu) {
    var mUse = $("use", btn);
    var setOpen = function (open) {
      btn.setAttribute("aria-expanded", String(open)); btn.setAttribute("aria-label", open ? "Close menu" : "Open menu");
      if (mUse) mUse.setAttribute("href", open ? "#i-x" : "#i-menu");
      menu.classList.toggle("open", open); document.body.classList.toggle("menu-open", open);
    };
    btn.addEventListener("click", function () { setOpen(btn.getAttribute("aria-expanded") !== "true"); });
    menu.addEventListener("click", function (e) { if (e.target.closest("a")) setOpen(false); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") setOpen(false); });
    window.addEventListener("resize", function () { if (window.innerWidth > 1080) setOpen(false); });
  }

  /* Sticky mobile CTA (landing) */
  var sticky = $(".sticky-cta"), heroEl = $(".hero");
  if (sticky && heroEl && "IntersectionObserver" in window) new IntersectionObserver(function (en) { sticky.classList.toggle("show", !en[0].isIntersecting); }).observe(heroEl);

  if (!window.gsap) { doc.classList.remove("js-motion"); return; }
  gsap.registerPlugin.apply(gsap, [window.ScrollTrigger, window.SplitText, window.DrawSVGPlugin, window.MotionPathPlugin].filter(Boolean));
  var ST = window.ScrollTrigger, started = performance.now();

  /* Route draws and a truck follows. Final state = the static SVG. */
  var routeDraw = function (rd, dur) {
    var tl = gsap.timeline(), line = $(".rd-line", rd), truck = $(".rd-truck", rd), stops = $$(".rd-stop", rd), messy = $(".rd-messy", rd);
    if (!line) return tl; dur = dur || 2;
    if (messy && rd.hasAttribute("data-route-plan")) tl.fromTo(messy, { autoAlpha: 0 }, { autoAlpha: 0.7, duration: 0.5, immediateRender: true }, 0);
    var t0 = messy && rd.hasAttribute("data-route-plan") ? 0.6 : 0;
    tl.fromTo(line, { drawSVG: "0%" }, { drawSVG: "100%", duration: dur, ease: "power1.inOut", immediateRender: true }, t0);
    if (stops.length) tl.fromTo(stops, { scale: 0.3, autoAlpha: 0, transformOrigin: "50% 50%" }, { scale: 1, autoAlpha: 1, duration: 0.35, ease: "back.out(2)", stagger: dur / Math.max(1, stops.length), immediateRender: true }, t0);
    if (truck && window.MotionPathPlugin) tl.to(truck, { duration: dur, ease: "power1.inOut", motionPath: { path: line, align: line, alignOrigin: [0.5, 0.5] } }, t0);
    return tl;
  };

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
    if (paperBack && Math.abs(window.scrollY - paperY) > 1) { window.scrollTo({ top: paperY, behavior: "instant" }); ST.update(); }
  });
  var paper = function (on) {
    if (on === paperOn) return;
    paperOn = on;
    if (on) { paperY = window.scrollY; paperMotion = doc.classList.contains("js-motion"); doc.classList.remove("js-motion"); return; }
    doc.classList.toggle("js-motion", paperMotion);
    paperBack = true;
    window.requestAnimationFrame(function () { paperBack = false; });
  };
  var printQ = window.matchMedia("print");
  var onPrint = function (e) { paper(e.matches); };
  if (printQ.addEventListener) printQ.addEventListener("change", onPrint); else if (printQ.addListener) printQ.addListener(onPrint);
  window.addEventListener("beforeprint", function () { paper(true); });
  window.addEventListener("afterprint", function () { paper(false); });
  /* paper:end */

  var mm = gsap.matchMedia();
  /* `screen` matches every screen width, so on screen this still runs at every width (it is what takes js-motion off); `desk` only adds
     the desktop scenes. In print nothing matches and GSAP reverts everything. (Never name a key `all`: GSAP treats that key as always matching.) */
  mm.add({ screen: "screen", desk: "screen and (min-width: 900px)" }, function (ctx) {
    var desk = ctx.conditions.desk, cleanups = [];

    /* Hero: plays once (about 2 s) and ends on the still frame. Headline lines rise, route draws, truck follows, cards settle. */
    var heroScene = $("[data-scene='hero']");
    var h = $("[data-split]");
    if (h && window.SplitText && performance.now() - started < 1500) {
      document.fonts.ready.then(function () {
        if (performance.now() - started > 2500) return;
        SplitText.create(h, { type: "lines", mask: "lines", autoSplit: true, onSplit: function (self) {
          return gsap.from(self.lines, { yPercent: 105, duration: 0.7, stagger: 0.08, ease: "expo.out", onComplete: function () { self.revert(); } });
        } });
      });
    }
    if (heroScene && $("[data-rd]", heroScene)) {
      var rd = $("[data-rd]", heroScene), chips = $$(".hchip", heroScene), cards = $$(".hero-card, .hero-store", heroScene), dash = $("[data-hero-dash]", heroScene);
      var htl = gsap.timeline({ delay: 0.2 });
      htl.from(cards.filter(function (c) { return !c.classList.contains("hero-card--invoice"); }), { autoAlpha: 0, y: 14, duration: 0.5, ease: "power2.out", stagger: 0.12, transformOrigin: "50% 50%" }, 0)
         .from(chips.filter(function (c) { return !c.classList.contains("hchip--invoice"); }), { autoAlpha: 0, y: 8, duration: 0.4, stagger: 0.15 }, 0.15)
         .add(routeDraw(rd, 1.3), 0.3);
      if (dash) htl.fromTo(dash, { drawSVG: "0%" }, { drawSVG: "100%", duration: 0.4, ease: "none" }, 1.5);
      htl.from($(".hero-card--invoice", heroScene), { autoAlpha: 0, scale: 0.9, y: 10, duration: 0.45, ease: "back.out(1.6)", transformOrigin: "50% 50%" }, 1.55)
         .from($(".hchip--invoice", heroScene), { autoAlpha: 0, y: 8, duration: 0.35 }, 1.7);
    }

    /* Reveals, once. Title blocks and cards rise 16px. They start visible: nothing is hidden until the batch fires, and each element plays
       one time through a played list (not the `once` option, which removes the trigger). The tween is made inside this context so a print
       revert undoes it. */
    var rev = $$(".reveal"), played = [];
    if (rev.length) {
      ST.batch(rev, { start: "top 104%", onEnter: function (b) {
        var fresh = b.filter(function (el) { return played.indexOf(el) < 0; });
        if (!fresh.length) return;
        played = played.concat(fresh);
        ctx.add(function () { gsap.from(fresh, { autoAlpha: 0, y: 16, duration: 0.7, ease: "power2.out", stagger: 0.09, overwrite: true }); });
      } });
    }
    doc.classList.remove("js-motion");

    /* One scroll-driven section: one order, start to finish. Desktop only, no snap. Phones: stacked, each route draws on entry. */
    $$("[data-journey]").forEach(function (jr) {
      var rows = $$(".jr-row", jr), dots = $$(".jr-dots li", jr);
      var setDots = function (i) { dots.forEach(function (d, k) { d.classList.toggle("on", k <= i); }); };
      if (desk && rows.length > 1) {
        jr.classList.add("jr--pin"); cleanups.push(function () { jr.classList.remove("jr--pin"); });
        gsap.set(rows.slice(1), { autoAlpha: 0 }); setDots(0);
        var tl = gsap.timeline({ defaults: { ease: "power2.inOut", duration: 0.5 } });
        rows.forEach(function (r, i) {
          if (i > 0) {
            tl.to(rows[i - 1], { autoAlpha: 0, y: -28 }, ">0.25").fromTo(r, { autoAlpha: 0, y: 28 }, { autoAlpha: 1, y: 0 }, "<0.1");
          }
          var rdr = $("[data-rd]", r); if (rdr) tl.add(routeDraw(rdr, 1.1), ">");
          tl.to({}, { duration: 0.3 });
        });
        var step = 1 / rows.length;
        ST.create({ trigger: jr, start: "center center", end: "+=" + rows.length * 70 + "%", pin: true, scrub: 0.7, animation: tl, anticipatePin: 1,
          onUpdate: function (s) { setDots(Math.min(rows.length - 1, Math.floor(s.progress / step))); } });
      } else {
        dots.forEach(function (d) { d.classList.add("on"); });
        rows.forEach(function (r) { var rdr = $("[data-rd]", r); if (rdr) { var t = routeDraw(rdr, 1.6); t.pause(); ST.create({ trigger: rdr, start: "top 80%", animation: t, toggleActions: "play none none none" }); } });
      }
    });

    /* Route sections outside the hero and the journey. */
    $$("[data-rd]").forEach(function (rdr) {
      if (rdr.closest("[data-journey]") || rdr.closest("[data-scene='hero']")) return;
      var t = routeDraw(rdr, 2.2); t.pause();
      ST.create({ trigger: rdr, start: "top 78%", animation: t, toggleActions: "play none none none" });
    });

    return function () { cleanups.forEach(function (f) { f(); }); };
  });
})();
