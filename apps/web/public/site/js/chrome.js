/* The page chrome, one file for every page: the analytics hook, the header shadow, the phone menu, and the phones header pill.
   Page motion lives in js/site.js and js/home-up.js, never here.
   Each block runs only when its element is on the page, so a page without a header or a menu gets only the hook. */
(function () {
  "use strict";
  var $ = function (s, r) {
    return (r || document).querySelector(s);
  };
  var $$ = function (s, r) {
    return Array.prototype.slice.call((r || document).querySelectorAll(s));
  };

  /* Analytics hook: names only. Nothing is sent anywhere. */
  window.dataLayer = window.dataLayer || [];
  document.addEventListener("click", function (e) {
    var el = e.target.closest && e.target.closest("[data-track]");
    if (el)
      window.dataLayer.push({
        event: el.getAttribute("data-track"),
        where: el.getAttribute("data-where") || "",
        page: location.pathname,
      });
  });

  /* Header shadow, mobile menu */
  var header = $(".site-header");
  if (header) {
    var onS = function () {
      header.classList.toggle("scrolled", window.scrollY > 8);
    };
    onS();
    window.addEventListener("scroll", onS, { passive: true });
  }
  var btn = $(".menu-btn"),
    menu = $("#mobile-menu");
  if (btn && menu) {
    var mUse = $("use", btn);
    var setOpen = function (open) {
      btn.setAttribute("aria-expanded", String(open));
      btn.setAttribute("aria-label", open ? "Close menu" : "Open menu");
      if (mUse) mUse.setAttribute("href", open ? "#i-x" : "#i-menu");
      menu.classList.toggle("open", open);
      document.body.classList.toggle("menu-open", open);
    };
    btn.addEventListener("click", function () {
      setOpen(btn.getAttribute("aria-expanded") !== "true");
    });
    menu.addEventListener("click", function (e) {
      if (e.target.closest && e.target.closest("a")) setOpen(false);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") setOpen(false);
    });
    window.addEventListener("resize", function () {
      if (window.innerWidth > 1080) setOpen(false);
    });
  }

  /* Phones: while any other trial button is on screen, the header offers Pricing instead of a second one.
     The wheel's button keeps its own signal (rfw-go-in, read by site.css). */
  (function () {
    var head = $(".site-header");
    var btns = $$('a.btn[href^="/signup"]').filter(function (b) {
      return !b.closest(".site-header, #mobile-menu, .rfw");
    });
    if (!head) return;
    if (!btns.length || !("IntersectionObserver" in window)) {
      /* Nothing to watch: the header may start with the class in its markup, and it must not stay hidden. */
      head.classList.remove("hero-btn-in");
      return;
    }
    /* "In view" is geometry: below the header's bottom edge. The header height is read live, once, never typed. */
    var headH = head.getBoundingClientRect().height;
    var seen = new Set();
    var io = new IntersectionObserver(
      function (en) {
        en.forEach(function (e) {
          if (e.isIntersecting) seen.add(e.target);
          else seen.delete(e.target);
        });
        head.classList.toggle("hero-btn-in", seen.size > 0);
      },
      { rootMargin: "-" + headH + "px 0px 0px 0px" },
    );
    btns.forEach(function (b) {
      io.observe(b);
    });
  })();
})();
