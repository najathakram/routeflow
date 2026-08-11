import { ScrollViewStyleReset } from "expo-router/html";
import { type PropsWithChildren } from "react";

/**
 * Root HTML template for the Expo web bundle. Native ignores this file.
 *
 * Includes accessibility + print baseline that the deep-audit 2026-05-02
 * flagged as systemic gaps:
 *   - BUG-XR2-1: focus-visible outline restored on every interactive element
 *     (RN-Web strips outlines; without :focus-visible, keyboard users see
 *     no focus indicator, failing WCAG 2.4.7).
 *   - BUG-XR2-4: print stylesheet hides non-content chrome on /invoices/:id
 *     so File -> Print produces a clean invoice page.
 */
export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no" />

        <ScrollViewStyleReset />

        <style dangerouslySetInnerHTML={{ __html: globalCss }} />
      </head>
      <body>{children}</body>
    </html>
  );
}

const globalCss = `
/* react-native-web renders <TextInput> as a real <input>. RNW's base style
   declares no width, so the element carries the UA \`size=20\` intrinsic width
   (~180px) and \`min-width: auto\` — neither of which exists on native, where
   Yoga sizes a TextInput to its text. An input that is a plain flex item can
   then refuse to shrink and squeeze its siblings to a few pixels, at which
   point RNW's \`word-wrap: break-word\` on <Text> renders one character per
   line. This neutralises the min-width half for UNSTYLED inputs.

   It is an element selector (0-0-1) and RNW emits classes (0-1-0), so any
   RN-declared minWidth still wins — which is the precedence we want. Note this
   does NOT fix the qty steppers: their pill is flexShrink:0, so no deficit ever
   reaches the input. Those need definite widths — see lib/row-layout.ts. */
input:not([type="checkbox"]):not([type="radio"]):not([type="range"]),
textarea,
select { min-width: 0; }

/* BUG-XR2-1: keyboard focus indicator on every interactive element. */
*:focus { outline: none; }
*:focus-visible {
  outline: 2px solid #0A84FF;
  outline-offset: 2px;
  border-radius: 4px;
}

/* BUG-XR2-4: print stylesheet — hide PWA chrome and clamp invoice content
   to full width so File -> Print on an invoice page yields a clean page. */
@media print {
  /* Suppress fixed bottom-tab and floating PWA prompts. */
  [role="tablist"],
  [data-pwa-prompt],
  [data-bottom-nav] {
    display: none !important;
  }
  /* Force white background and full-width content. */
  html, body {
    background: white !important;
    color: black !important;
  }
  /* Avoid clipping at the phone-frame width on desktop print. */
  body > div > div {
    max-width: none !important;
    width: 100% !important;
  }
}
`;
