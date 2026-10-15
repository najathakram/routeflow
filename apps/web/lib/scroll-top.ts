/**
 * Puts the page back at its top: the dashboard shell scrolls `#main-content` (not the window) and a phone may scroll either,
 * so both are reset. Used when a new view replaces the one the clerk had scrolled (CQ-33: the receipt after Complete).
 */
export function scrollPageToTop(): void {
  if (typeof document === "undefined") return;
  const main = document.getElementById("main-content");
  if (main) main.scrollTop = 0;
  const root = document.scrollingElement ?? document.documentElement;
  if (root) root.scrollTop = 0;
}
