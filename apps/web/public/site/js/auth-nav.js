/* Signed-in visitors see "Open dashboard" where "Sign in" was. No redirect: the page is home for everyone.
   Reads the presence cookies the app sets (apps/web/lib/presence-cookies.ts). Same rule the old "/" redirect used:
   one session goes to its own place; with both, the one used last wins, and the seller dashboard is the default. */
(function () {
  "use strict";
  var COOKIES = { op: "rf-op-auth", buyer: "rf-buyer-auth", last: "rf-last-portal" };

  function read(cookie, name) {
    var parts = String(cookie || "").split(";");
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].replace(/^\s+/, "");
      if (p.indexOf(name + "=") === 0) return p.slice(name.length + 1);
    }
    return "";
  }

  function target(cookie) {
    var op = read(cookie, COOKIES.op) === "1";
    var buyer = read(cookie, COOKIES.buyer) === "1";
    if (op && buyer) return read(cookie, COOKIES.last) === "buyer" ? "/buyer/portal" : "/dashboard";
    if (op) return "/dashboard";
    if (buyer) return "/buyer/portal";
    return null;
  }

  if (typeof module !== "undefined" && module.exports) module.exports = { target: target, COOKIES: COOKIES };
  if (typeof document === "undefined") return;

  var to = target(document.cookie);
  if (!to) return;
  var links = document.querySelectorAll("a[data-signin]");
  for (var i = 0; i < links.length; i++) {
    links[i].textContent = "Open dashboard";
    links[i].setAttribute("href", to);
  }
})();
