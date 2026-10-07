"use client";

/**
 * "Skip to content" link for the dashboard shell. A plain `href="#main-content"` writes the hash
 * into the URL as a new history entry, so Back needs two presses. The click handler cancels the
 * navigation and moves focus to the main region itself (`tabIndex={-1}`), leaving the URL alone.
 * `href` stays so the link still works with JS disabled.
 */
export function SkipToContentLink() {
  return (
    <a
      href="#main-content"
      onClick={(e) => {
        e.preventDefault();
        document.getElementById("main-content")?.focus();
      }}
      className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-brand-500 focus:px-4 focus:py-2 focus:text-white focus:shadow-lg"
    >
      Skip to content
    </a>
  );
}
