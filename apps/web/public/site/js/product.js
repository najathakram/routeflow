/* The Product page's one moment: the loop runs once. A dot goes round and each step lights as it passes, then the picture rests.
   Transform and opacity only. It always runs; with no JS the still picture is all there is. */
(function () {
  "use strict";
  if (!window.gsap) return;
  gsap.matchMedia().add("all", function () {
    var icons = gsap.utils.toArray(".lp-ic"), run = document.querySelector(".lp-run"), dot = document.querySelector(".lp-dot");
    if (!icons.length || !run || !dot) return;
    var tl = gsap.timeline({ delay: 0.25 });
    tl.set(dot, { opacity: 1 }, 0)
      .fromTo(run, { rotation: 0, svgOrigin: "200 200" }, { rotation: 360, svgOrigin: "200 200", duration: 3.2, ease: "power1.inOut" }, 0);
    icons.forEach(function (ic, i) {
      tl.fromTo(ic, { scale: 1 }, { scale: 1.14, duration: 0.2, yoyo: true, repeat: 1, ease: "power2.out" }, 0.05 + i * 0.8);
    });
    tl.to(dot, { opacity: 0, duration: 0.3 }, 3.1);
    return function () { tl.kill(); gsap.set(icons.concat([run, dot]), { clearProps: "all" }); };
  });
})();
