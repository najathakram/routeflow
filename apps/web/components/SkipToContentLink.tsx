"use client";

/**
 * "Skip to content" link for the dashboard shell. A plain `href="#main-content"` writes the hash
 * into the URL as a new history entry, so Back needs two presses. The click handler cancels the
 * navigation and moves focus to the main region itself (`tabIndex={-1}`), leaving the URL alone.
 * When the page has a search field it takes the focus instead (the /products list: 30 Tabs otherwise).
 * `href` stays so the link still works with JS disabled.
 */
export function SkipToContentLink() {
  return (
    <a
      href="#main-content"
      onClick={(e) => {
        e.preventDefault();
        const main = document.getElementById("main-content");
        // K12 F10: a list page's search is its first real job, so land there when it exists.
        (main?.querySelector<HTMLElement>('input[type="search"]') ?? main)?.focus();
      }}
      className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-brand-500 focus:px-4 focus:py-2 focus:text-white focus:shadow-lg"
    >
      Skip to content
    </a>
  );
}
