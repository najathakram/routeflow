/* Sends one Umami pageview for a ready-made page. Added to the page (with Umami's own script) only
   when the build has a site ID: see apps/web/lib/static-site-page.ts. The tracker is told not to
   follow the page, so this sends the pageview itself, with the five fields the Privacy Policy names
   and nothing else, the bare path with no query string, and an outside referrer as a bare origin.
   Mirrors apps/web/components/UmamiScript.tsx (umamiPageview, referringSite). */
(function () {
  var tag = document.currentScript;
  if (!tag) return;
  var path = tag.getAttribute("data-path") || "/";
  var own = tag.getAttribute("data-own-domain") || "";
  var sent = false;

  function referringSite(referrer) {
    if (!referrer) return "";
    try {
      var url = new URL(referrer, location.origin);
      var ours = url.hostname === own || url.hostname.slice(-(own.length + 1)) === "." + own;
      return ours || url.protocol.indexOf("http") !== 0 ? "" : url.origin;
    } catch (e) {
      return "";
    }
  }

  function send() {
    var umami = window.umami;
    if (sent || !umami || typeof umami.track !== "function") return;
    sent = true;
    try {
      umami.track(function (tracker) {
        return {
          website: tracker.website,
          hostname: tracker.hostname,
          screen: tracker.screen,
          url: path,
          referrer: referringSite(tracker.referrer),
        };
      });
    } catch (e) {
      /* Analytics never takes a page down with it. */
    }
  }

  /* Deferred scripts run in page order, so Umami's tag (just before this one) has normally run. If
     it has not, wait for it; if it never loads (blocked), nothing is sent. */
  send();
  if (!sent) {
    var tracker = document.querySelector("script[data-website-id]");
    if (tracker) tracker.addEventListener("load", send);
  }
})();
