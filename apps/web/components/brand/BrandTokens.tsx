import { loadPalette, paletteCss } from "@routeflow/types/brand";

/**
 * The palette as `<style id="brand-tokens">:root{--brand-*}`, the same element the ready-made pages
 * get from lib/static-site-page.ts. A server component: the React pages mount it once (lanes 2.6 and
 * B1); the CSS reads colour only through `var(--brand-*)`. Nothing here can carry markup: the reader
 * allows only hyphenated lower-case keys and hex values.
 */
export function BrandTokens() {
  return (
    <style id="brand-tokens" dangerouslySetInnerHTML={{ __html: paletteCss(loadPalette()) }} />
  );
}
