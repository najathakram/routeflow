/**
 * RF-203: /customers/create alias.
 *
 * When the Expo web bundle is served at a URL like /customers/create (e.g.
 * shared link or browser back-forward), Expo Router falls through to the [id]
 * dynamic segment which treats "create" as a customer ID and fires an API
 * lookup that returns 404. Because the detail screen renders a spinner until
 * data resolves, the user sees an infinite spinner.
 *
 * Placing an explicit create.tsx at this path intercepts the route *before*
 * [id] gets a chance, and renders the real New Customer form immediately — no
 * fetch, no spinner.
 */
export { default } from "./new";
