/* The first visit's source, kept for this tab (the sign-up form reads it). No cookie, no network. Written once, never overwritten.
   Added to every page by the page renderer (lib/static-site-page.ts). */
(function () {
  "use strict";
  try {
    var FT = "rf_first_touch";
    if (window.sessionStorage.getItem(FT)) return;
    var q = new URLSearchParams(location.search), rec = {}, any = false, rh = "";
    ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "fbclid", "msclkid"].forEach(function (k) {
      var v = q.get(k); if (v) { rec[k] = v; any = true; }
    });
    if (document.referrer) {
      try {
        var ru = new URL(document.referrer);
        if ((ru.protocol === "http:" || ru.protocol === "https:") && ru.host !== location.host) rh = ru.hostname;
      } catch (e) {}
    }
    if (any || rh) {
      rec.landingPath = location.pathname;
      if (rh) rec.referrerHost = rh;
      rec.firstSeenAt = new Date().toISOString();
      window.sessionStorage.setItem(FT, JSON.stringify(rec));
    }
  } catch (e) {}
})();
