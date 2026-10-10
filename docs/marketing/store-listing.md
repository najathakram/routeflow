# App Store + Google Play listing and review notes

Epic #2307 · #2313. Build config and the release runbook: #2312 /
[`docs/runbooks/mobile-store-release.md`](../runbooks/mobile-store-release.md).

Draft content for the owner to paste into App Store Connect and the Play Console. **No credentials
here, ever:** reviewer logins are typed into the store consoles only. Screenshots are produced into
`local-assets/store/` (gitignored), never committed.

## 1. Listing text

| Field                        | Limit | Draft                                                                                                                         |
| ---------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------- |
| App name (both stores)       | 30    | RouteFlow                                                                                                                     |
| Subtitle (App Store)         | 30    | Wholesale orders & deliveries                                                                                                 |
| Short description (Play)     | 80    | Orders, routes, deliveries and invoices for wholesale distributors and their buyers.                                          |
| Category                     | —     | Business                                                                                                                      |
| Keywords (App Store)         | 100   | wholesale,distributor,delivery,route,driver,invoice,orders,B2B,dispatch,proof of delivery                                     |
| Promotional text (App Store) | 170   | Run your wholesale business from your phone: take orders, plan routes, deliver, and get paid. Your buyers reorder in seconds. |

**Description (both stores):**

> RouteFlow is the operating app for wholesale distributors and the businesses they supply.
>
> For distributors: take and edit orders, build delivery routes, record payments and credits,
> scan products by barcode, and keep invoices, returns and inventory in one place.
>
> For drivers: see today's route and stops, navigate on the map, confirm deliveries at the door,
> take payment, and log returns. While you run a route, dispatch sees your live location.
>
> For buyers: browse your supplier's catalog, reorder favorites and standing orders, track
> deliveries, and view invoices and payments.
>
> RouteFlow requires an account with a distributor that uses RouteFlow.

## 2. Screenshots (capture plan)

Capture from the **`routeflow-demo`** tenant only (fictional customers and data), never a live
tenant. Output to `local-assets/store/<device>/`.

| Store / device         | Pixel size (portrait)        | Count  |
| ---------------------- | ---------------------------- | ------ |
| App Store iPhone 6.9"  | 1320 × 2868 (or 1290 × 2796) | 5      |
| App Store iPhone 6.5"  | 1284 × 2778 (or 1242 × 2688) | 5      |
| App Store iPad 13"     | 2064 × 2752 (or 2048 × 2732) | 5      |
| Play phone             | 9:16, 1080 × 1920 or larger  | 5      |
| Play 7" and 10" tablet | 9:16, tablet resolution      | 4 each |

Suggested screens, one role each:

1. Operator: today's orders list.
2. Operator: order detail with line items and totals.
3. Driver: route map with stops.
4. Driver: stop, confirm delivery / take payment.
5. Buyer: catalog / reorder favorites.
6. Buyer: invoices and payments (tablet sets).

iPad shots come after the iPad layout pass (#2311). The first release is portrait, full screen
(`UIRequiresFullScreen`, #2312).

## 3. Privacy answers

What the **native** app collects, from the code on master:

- **Sentry: not collected in the store builds.** `apps/mobile/lib/sentry.ts` initializes Sentry
  only on the web export (it returns early on iOS and Android). Declare nothing for it unless
  native Sentry is added later, and update this section when it is.
- No advertising SDKs, no third-party analytics, **no tracking** (App Tracking Transparency not
  needed).
- No in-app card payments: payments are recorded against invoices by the business, not collected
  by the app.

### Apple App Privacy label

| Data type                                    | Collected                                                        | Linked to user | Tracking | Purpose                                                          |
| -------------------------------------------- | ---------------------------------------------------------------- | -------------- | -------- | ---------------------------------------------------------------- |
| Contact info: name, email, phone             | Yes                                                              | Yes            | No       | App functionality (account)                                      |
| Precise location                             | Yes (drivers, including in the background during a delivery run) | Yes            | No       | App functionality (dispatch sees active runs)                    |
| User content: photos                         | Yes (receipts, bills, product images the user attaches)          | Yes            | No       | App functionality                                                |
| Purchase history / other financial info      | Yes (B2B orders, invoices, payment records)                      | Yes            | No       | App functionality                                                |
| Identifiers: user ID                         | Yes                                                              | Yes            | No       | App functionality                                                |
| Push token (expo-notifications / FCM / APNs) | Used only to deliver notifications                               | —              | No       | Confirm in the console whether Apple's current label asks for it |
| Diagnostics / crash data                     | No (see Sentry above)                                            | —              | —        | —                                                                |

Maps (react-native-maps): map tiles are loaded from Google Maps (Android) / Apple or Google Maps
(iOS) to render the driver and route maps. RouteFlow does not send user data to the map provider
beyond what rendering requires.

### Google Play Data Safety

| Category                          | Collected / shared                 | Notes                                                                                                                         |
| --------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Location: precise                 | Collected, not shared              | Drivers only; **background location** during delivery runs, so the Background Location declaration (with a video) is required |
| Personal info: name, email, phone | Collected, not shared              | Account                                                                                                                       |
| Photos                            | Collected, not shared              | Attachments the user chooses                                                                                                  |
| Financial info: purchase history  | Collected, not shared              | B2B orders and invoices                                                                                                       |
| App info and performance          | Not collected in the native app    | See Sentry above                                                                                                              |
| Device or other IDs               | Push token, for notifications only |                                                                                                                               |

- Data is encrypted in transit (HTTPS to the RouteFlow API).
- Users can request deletion. In-app buyer account deletion ships with #2308, and the support
  contact is on `https://www.routeflow.info/privacy`.

## 4. Review notes template (paste into both consoles; fill placeholders in the console only)

```
RouteFlow is a B2B app for wholesale distributors, their drivers and their business buyers.
It sells physical goods between businesses; there is no digital content and no in-app purchase.

Demo account (fictional data on the demo tenant):
  Tenant / company code: routeflow-demo
  Username: <ENTER IN CONSOLE ONLY>
  Password: <ENTER IN CONSOLE ONLY>

What to try:
  1. Operator: Orders → open an order → view lines and totals.
  2. Driver: Today's route → map → open a stop → confirm delivery.
  3. Buyer: Catalog → add a favorite → Orders → Invoices.

Location: the app requests "Always" location for DRIVERS only. Dispatch tracks active delivery
runs only: tracking starts when a driver starts a route and stops when the run ends.

Account deletion: Profile → Delete account (buyer accounts, #2308).
Sign in with Apple is offered alongside the other sign-in options (#2309).
Privacy policy: https://www.routeflow.info/privacy · Terms: https://www.routeflow.info/terms
```

The account-deletion and Sign in with Apple lines depend on #2308 and #2309 landing first. Remove
either line if its feature is not in the submitted build.
