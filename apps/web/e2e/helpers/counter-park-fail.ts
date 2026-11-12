import type { Page } from "@playwright/test";

/**
 * W-1184: leaving the counter parks the open sale instead of asking "Discard this sale?". The old question is now the
 * fallback when the park fails, so specs that drive that dialog make the park POST fail first. Nothing reaches the server.
 */
export async function failParks(page: Page): Promise<void> {
  await page.route("**/orders/counter-sale/parked", (route) =>
    route.request().method() === "POST" ? route.abort("failed") : route.continue(),
  );
}
