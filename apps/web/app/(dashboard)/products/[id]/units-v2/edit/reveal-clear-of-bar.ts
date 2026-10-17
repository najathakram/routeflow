/**
 * K11-13: scroll a price box that just took focus into view, to its nearest edge, once the save bar has measured its
 * height. The bar sets `scroll-padding-bottom` on the page scroller (`#main-content`) when it has a height, and a
 * `scrollIntoView` before that scrolls the box only to the bare edge, where the bar then covers it. Frames are waited
 * for (up to ~330 ms) rather than guessed at; with no scroller on the page, or no bar to measure, it goes on the next
 * frame. A box that lost focus or left the page in the meantime is left alone. A no-op where scrollIntoView does not
 * exist (jsdom).
 */
export function revealClearOfBar(el: HTMLElement | null): void {
  if (!el || typeof requestAnimationFrame === "undefined") return;
  let frames = 0;
  const step = () => {
    const main = document.getElementById("main-content");
    const measured = !main || main.style.getPropertyValue("scroll-padding-bottom") !== "";
    if (!measured && ++frames <= 20) {
      requestAnimationFrame(step);
      return;
    }
    if (el.isConnected && document.activeElement === el) el.scrollIntoView?.({ block: "nearest" });
  };
  requestAnimationFrame(step);
}
